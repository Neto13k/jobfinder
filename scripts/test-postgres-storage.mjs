// Testes de persistência e concorrência no PostgreSQL (Supabase).
//
// Uso:   npm run build
//        DATABASE_URL='...' JOBFINDER_RUN_DB_TESTS=true node scripts/test-postgres-storage.mjs
//
// Requer autorização explícita (JOBFINDER_RUN_DB_TESTS=true) porque grava e
// apaga linhas de teste no banco real. As chaves usam o prefixo "db-test:" e um
// identificador exclusivo por execução (randomUUID), de modo que a limpeza afeta
// apenas os registros criados por esta execução. Sem as variáveis, o script
// apenas informa e não toca no banco.

import { randomUUID } from "node:crypto";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const enabled =
  Boolean(process.env.DATABASE_URL) &&
  process.env.JOBFINDER_RUN_DB_TESTS === "true";

if (!enabled) {
  console.log(
    "Testes PostgreSQL ignorados: defina DATABASE_URL e JOBFINDER_RUN_DB_TESTS=true para executá-los.",
  );
  process.exit(0);
}

process.env.JOBFINDER_STORAGE = "postgres";

const { closePool, query } = await import("../dist/db/postgres.js");
const dedup = await import("../dist/services/deduplication.js");
const history = await import("../dist/services/analysis-history.js");
const { ANALYSIS_CRITERIA_VERSION } = await import(
  "../dist/services/ai-analyzer.js"
);

// Identificador exclusivo desta execução: isola as chaves criadas aqui das de
// qualquer outra execução (inclusive concorrente).
const RUN_ID = randomUUID();

const createdKeys = new Set();

function job(id) {
  return {
    id: `${RUN_ID}:${id}`,
    title: "Desenvolvedor",
    company: "Empresa",
    location: "Remoto - Brasil",
    remote: true,
    description: "",
    url: "https://example.com",
    source: "db-test",
  };
}

function trackKey(target) {
  createdKeys.add(dedup.generateJobKey(target));
}

// Análise base reutilizada pelos testes de versionamento.
function analysis(overrides = {}) {
  return {
    decision: "compatible",
    score: 77,
    reason: "CLT remoto Brasil",
    locationStatus: "allowed",
    contractStatus: "allowed",
    ...overrides,
  };
}

// Insere um registro de análise diretamente, simulando versões anteriores
// (criteriaVersion informado) ou registros legados (criteriaVersion nulo).
async function insertAnalysis(key, { score, criteriaVersion }) {
  await query(
    `insert into public.analyzed_jobs
       (key, decision, score, reason, location_status, contract_status,
        criteria_version)
     values ($1, 'compatible', $2, 'registro de teste', 'allowed', 'allowed', $3)`,
    [key, score, criteriaVersion],
  );
}

after(async () => {
  const keys = [...createdKeys];
  try {
    if (keys.length > 0) {
      await query("delete from public.notified_jobs where key = any($1::text[])", [keys]);
      await query("delete from public.analyzed_jobs where key = any($1::text[])", [keys]);
    }
  } finally {
    // Fecha o pool mesmo se a limpeza falhar.
    await closePool();
  }
});

test("reserva atômica impede duplicidade", async () => {
  const target = job("reserve");
  trackKey(target);

  assert.equal(await dedup.isJobNotified(target), false);
  const reservation = await dedup.reserveJobNotification(target);
  assert.ok(reservation, "deveria obter uma reserva");
  assert.equal(await dedup.reserveJobNotification(target), undefined);
  assert.equal(await dedup.isJobNotified(target), true);
});

test("reserva confirmada é preservada ao liberar", async () => {
  const target = job("confirmed");
  trackKey(target);

  const reservation = await dedup.reserveJobNotification(target);
  assert.ok(reservation, "deveria obter uma reserva");
  assert.equal(await dedup.confirmJobNotification(reservation), true);
  // A liberação só remove reservas pendentes.
  await dedup.releaseJobNotification(reservation);
  assert.equal(await dedup.isJobNotified(target), true);
});

test("apenas a própria execução confirma ou libera a reserva", async () => {
  const target = job("owner");
  trackKey(target);

  const reservation = await dedup.reserveJobNotification(target);
  assert.ok(reservation, "deveria obter uma reserva");
  const other = { key: reservation.key, token: "token-de-outra-execucao" };

  assert.equal(await dedup.confirmJobNotification(other), false);
  assert.equal(await dedup.releaseJobNotification(other), false);
  assert.equal(await dedup.isJobNotified(target), true);

  assert.equal(await dedup.confirmJobNotification(reservation), true);
});

test("reserva pendente é liberada para nova tentativa", async () => {
  const target = job("pending");
  trackKey(target);

  const reservation = await dedup.reserveJobNotification(target);
  assert.ok(reservation, "deveria obter uma reserva");
  assert.equal(await dedup.releaseJobNotification(reservation), true);
  assert.equal(await dedup.isJobNotified(target), false);
  assert.ok(await dedup.reserveJobNotification(target));
});

test("reservas simultâneas concedem apenas uma", async () => {
  const target = job("concurrent");
  trackKey(target);

  const results = await Promise.all([
    dedup.reserveJobNotification(target),
    dedup.reserveJobNotification(target),
    dedup.reserveJobNotification(target),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("histórico de análise grava, recupera e é idempotente", async () => {
  const target = job("analysis");
  trackKey(target);
  const analysis = {
    decision: "compatible",
    score: 77,
    reason: "CLT remoto Brasil",
    locationStatus: "allowed",
    contractStatus: "allowed",
  };

  assert.equal(await history.getAnalyzedJob(target), undefined);
  await history.markJobAsAnalyzed(target, analysis);

  const saved = await history.getAnalyzedJob(target);
  assert.equal(saved.decision, "compatible");
  assert.equal(saved.score, 77);
  assert.equal(await history.isJobAnalyzed(target), true);

  await history.markJobAsAnalyzed(target, { ...analysis, score: 5, decision: "incompatible" });
  const again = await history.getAnalyzedJob(target);
  assert.equal(again.score, 77);
  assert.equal(again.decision, "compatible");
});

test("persiste a versão vigente dos critérios", async () => {
  const target = job("version-persist");
  trackKey(target);

  await history.markJobAsAnalyzed(target, analysis());

  const { rows } = await query(
    "select criteria_version from public.analyzed_jobs where key = $1",
    [dedup.generateJobKey(target)],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].criteria_version, ANALYSIS_CRITERIA_VERSION);
});

test("reutiliza a análise da versão vigente", async () => {
  const target = job("version-reuse");
  trackKey(target);

  await history.markJobAsAnalyzed(target, analysis({ score: 88 }));

  const reusable = await history.getReusableAnalysis(target);
  assert.ok(reusable, "deveria reutilizar a análise da versão vigente");
  assert.equal(reusable.criteriaVersion, ANALYSIS_CRITERIA_VERSION);
  assert.equal(reusable.score, 88);
});

test("não reutiliza análise legada (sem versão)", async () => {
  const target = job("legacy");
  trackKey(target);
  const key = dedup.generateJobKey(target);

  await insertAnalysis(key, { score: 42, criteriaVersion: null });

  assert.equal(await history.getReusableAnalysis(target), undefined);
  const stored = await history.getAnalyzedJob(target);
  assert.ok(stored, "o registro legado deve continuar armazenado");
  assert.equal(stored.criteriaVersion, null);
});

test("não reutiliza análise de versão anterior", async () => {
  const target = job("previous-version");
  trackKey(target);
  const key = dedup.generateJobKey(target);
  const previousVersion = `${ANALYSIS_CRITERIA_VERSION}-anterior`;

  await insertAnalysis(key, { score: 51, criteriaVersion: previousVersion });

  assert.equal(await history.getReusableAnalysis(target), undefined);
  const stored = await history.getAnalyzedJob(target);
  assert.equal(stored.criteriaVersion, previousVersion);
});

test("coexistem versões diferentes da mesma vaga", async () => {
  const target = job("coexist");
  trackKey(target);
  const key = dedup.generateJobKey(target);

  await insertAnalysis(key, { score: 60, criteriaVersion: "versao-antiga" });
  await history.markJobAsAnalyzed(target, analysis({ score: 90 }));

  const { rows } = await query(
    "select criteria_version from public.analyzed_jobs where key = $1",
    [key],
  );
  assert.equal(rows.length, 2);
  const versions = rows.map((row) => row.criteria_version);
  assert.ok(versions.includes("versao-antiga"));
  assert.ok(versions.includes(ANALYSIS_CRITERIA_VERSION));
});

test("idempotência por vaga e versão preserva o resultado", async () => {
  const target = job("idempotent");
  trackKey(target);
  const key = dedup.generateJobKey(target);

  await history.markJobAsAnalyzed(target, analysis({ score: 70 }));
  await history.markJobAsAnalyzed(
    target,
    analysis({ score: 10, decision: "incompatible" }),
  );

  const { rows } = await query(
    "select score, criteria_version from public.analyzed_jobs where key = $1",
    [key],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 70);
  assert.equal(rows[0].criteria_version, ANALYSIS_CRITERIA_VERSION);
});

test("deduplicação de notificação independe da versão da análise", async () => {
  const target = job("dedup-version");
  trackKey(target);
  const key = dedup.generateJobKey(target);

  // Existe apenas uma análise de versão anterior.
  await insertAnalysis(key, { score: 55, criteriaVersion: "versao-antiga" });

  // Ela não é reutilizada pela versão vigente...
  assert.equal(await history.getReusableAnalysis(target), undefined);

  // ...porém a vaga continua deduplicada normalmente ao ser notificada.
  await dedup.markJobAsNotified(target);
  assert.equal(await dedup.isJobNotified(target), true);
});
