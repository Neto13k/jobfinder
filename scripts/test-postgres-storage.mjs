// Testes de persistência e concorrência no PostgreSQL (Supabase).
//
// Uso:   npm run build
//        DATABASE_URL='...' JOBFINDER_RUN_DB_TESTS=true node scripts/test-postgres-storage.mjs
//
// Requer autorização explícita (JOBFINDER_RUN_DB_TESTS=true) porque grava e
// apaga linhas de teste no banco real. Usa chaves com prefixo "db-test:" e
// remove tudo ao final. Sem as variáveis, o script apenas informa e não toca
// no banco.

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

const createdKeys = new Set();

function job(id) {
  return {
    id,
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

after(async () => {
  const keys = [...createdKeys];
  if (keys.length > 0) {
    await query("delete from public.notified_jobs where key = any($1::text[])", [keys]);
    await query("delete from public.analyzed_jobs where key = any($1::text[])", [keys]);
  }
  await closePool();
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
