// Testes determinísticos do versionamento das análises (Calibragem 6.2).
//
// Uso:   npm run build
//        node scripts/test-analysis-versioning.mjs
//
// Roda em diretório temporário, sem tocar no data/ real e sem chamar a IA.
// Valida que o histórico só reutiliza análises da versão vigente e que a
// reanálise de versões anteriores (ou de registros legados) preserva todo o
// histórico e não afeta a deduplicação de notificações.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();

// Garante o backend JSON (padrão) antes de importar os serviços.
delete process.env.JOBFINDER_STORAGE;

const dedup = await import("../dist/services/deduplication.js");
const history = await import("../dist/services/analysis-history.js");
const { ANALYSIS_CRITERIA_VERSION } = await import(
  "../dist/services/ai-analyzer.js"
);

const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-versioning-"));
process.chdir(tempDir);

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

/** Monta uma vaga mínima com os campos sobrepostos. */
function job(overrides) {
  return {
    id: "1",
    title: "Desenvolvedor",
    company: "Empresa",
    location: "Remoto - Brasil",
    remote: true,
    description: "",
    url: "https://example.com",
    source: "test",
    ...overrides,
  };
}

/** Monta uma análise estruturada mínima com os campos sobrepostos. */
function analysis(overrides) {
  return {
    decision: "compatible",
    score: 80,
    reason: "CLT remoto Brasil",
    locationStatus: "allowed",
    contractStatus: "allowed",
    ...overrides,
  };
}

/**
 * Monta um registro persistido completo; a versão pode ser removida ou
 * substituída para simular versões anteriores e registros legados.
 */
function record(key, overrides) {
  const base = {
    key,
    decision: "compatible",
    score: 80,
    reason: "CLT remoto Brasil",
    locationStatus: "allowed",
    contractStatus: "allowed",
    analyzedAt: "2026-11-18T12:00:00.000Z",
    criteriaVersion: ANALYSIS_CRITERIA_VERSION,
    ...overrides,
  };

  return base;
}

/** Cria um diretório temporário isolado e executa a tarefa nele. */
async function withTempDir(task) {
  const dir = await mkdtemp(join(tmpdir(), "jobfinder-versioning-sub-"));
  process.chdir(dir);
  try {
    await task();
  } finally {
    process.chdir(tempDir);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Grava o histórico JSON com os registros informados. */
async function writeHistory(records) {
  const dir = join(process.cwd(), "data");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "analyzed-jobs.json"),
    `${JSON.stringify(records, null, 2)}\n`,
    "utf8",
  );
}

/** Lê os registros persistidos no histórico JSON. */
async function readHistory() {
  try {
    const content = await readFile(
      join(process.cwd(), "data", "analyzed-jobs.json"),
      "utf8",
    );
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

test("reutiliza análise gravada na versão vigente", async () => {
  await withTempDir(async () => {
    const target = job({ id: "current-1" });
    await history.markJobAsAnalyzed(target, analysis({ score: 90 }));

    // A versão persistida é a vigente.
    const saved = await history.getAnalyzedJob(target);
    assert.equal(saved.criteriaVersion, ANALYSIS_CRITERIA_VERSION);

    // E a análise é reutilizável.
    const reusable = await history.getReusableAnalysis(target);
    assert.ok(reusable, "deveria reutilizar a análise da versão vigente");
    assert.equal(reusable.score, 90);
  });
});

test("não reutiliza análise de versão anterior (força reanálise)", async () => {
  await withTempDir(async () => {
    const target = job({ id: "old-1" });
    const key = dedup.generateJobKey(target);
    await writeHistory([record(key, { criteriaVersion: "2026-11-17.0" })]);

    // O histórico recupera o registro, mas a versão antiga não é reutilizável.
    const stored = await history.getAnalyzedJob(target);
    assert.equal(stored.criteriaVersion, "2026-11-17.0");
    assert.equal(await history.getReusableAnalysis(target), undefined);
  });
});

test("registro legado (sem versão) não é reutilizado", async () => {
  await withTempDir(async () => {
    const target = job({ id: "legacy-1" });
    const key = dedup.generateJobKey(target);

    // Legado gravado sem o campo criteriaVersion.
    const legacy = record(key);
    delete legacy.criteriaVersion;
    await writeHistory([legacy]);

    assert.equal(
      (await history.getAnalyzedJob(target)).criteriaVersion,
      undefined,
    );
    assert.equal(await history.getReusableAnalysis(target), undefined);
  });
});

test("registro legado com versão nula não é reutilizado", async () => {
  await withTempDir(async () => {
    const target = job({ id: "legacy-null-1" });
    const key = dedup.generateJobKey(target);
    await writeHistory([record(key, { criteriaVersion: null })]);

    assert.equal((await history.getAnalyzedJob(target)).criteriaVersion, null);
    assert.equal(await history.getReusableAnalysis(target), undefined);
  });
});

test("preserva a análise anterior e acrescenta a nova versão", async () => {
  await withTempDir(async () => {
    const target = job({ id: "preserve-1" });
    const key = dedup.generateJobKey(target);
    await writeHistory([
      record(key, {
        criteriaVersion: "2026-11-17.0",
        score: 40,
        decision: "incompatible",
        reason: "critério antigo",
        analyzedAt: "2026-11-17T12:00:00.000Z",
      }),
    ]);

    await history.markJobAsAnalyzed(target, analysis({ score: 95 }));
    const after = await readHistory();

    // A versão anterior permanece intacta; um novo registro é acrescentado.
    assert.equal(after.length, 2);

    const oldRecord = after.find(
      (item) => item.criteriaVersion === "2026-11-17.0",
    );
    assert.ok(oldRecord, "a análise da versão anterior deveria ser preservada");
    assert.equal(oldRecord.score, 40);
    assert.equal(oldRecord.decision, "incompatible");
    assert.equal(oldRecord.reason, "critério antigo");
    assert.equal(oldRecord.analyzedAt, "2026-11-17T12:00:00.000Z");

    const newRecord = after.find(
      (item) => item.criteriaVersion === ANALYSIS_CRITERIA_VERSION,
    );
    assert.ok(newRecord, "a análise da versão vigente deveria existir");
    assert.equal(newRecord.score, 95);

    // A versão vigente passa a ser reutilizável.
    const reusable = await history.getReusableAnalysis(target);
    assert.ok(reusable);
    assert.equal(reusable.score, 95);

    // A consulta genérica devolve a versão mais recente (a vigente).
    const latest = await history.getAnalyzedJob(target);
    assert.equal(latest.criteriaVersion, ANALYSIS_CRITERIA_VERSION);
  });
});

test("é idempotente e preserva o resultado na versão vigente", async () => {
  await withTempDir(async () => {
    const target = job({ id: "idem-1" });
    await history.markJobAsAnalyzed(target, analysis({ score: 88 }));

    // Segunda gravação na versão vigente não sobrescreve o resultado existente.
    await history.markJobAsAnalyzed(
      target,
      analysis({ score: 1, decision: "incompatible", reason: "outro" }),
    );

    const stored = await history.getAnalyzedJob(target);
    assert.equal(stored.score, 88);
    assert.equal(stored.decision, "compatible");

    // Histórico preservado: exatamente um registro.
    assert.equal((await readHistory()).length, 1);
  });
});

test("persiste a versão vigente em uma análise nova", async () => {
  await withTempDir(async () => {
    const target = job({ id: "persist-1" });
    await history.markJobAsAnalyzed(target, analysis());

    const [stored] = await readHistory();
    assert.equal(stored.criteriaVersion, ANALYSIS_CRITERIA_VERSION);
  });
});

test("deduplicação de notificação independe da versão da análise", async () => {
  await withTempDir(async () => {
    const target = job({ id: "dedupe-version-1" });
    const key = dedup.generateJobKey(target);

    // A vaga possui apenas análise de versão anterior e já foi notificada.
    await writeHistory([record(key, { criteriaVersion: "2026-11-17.0" })]);
    await dedup.markJobAsNotified(target);

    // Continua notificada mesmo com análise fora da versão vigente: a
    // deduplicação não considera a versão, então a vaga não volta a consumir
    // cota do Gemini nem é reenviada.
    assert.equal(await dedup.isJobNotified(target), true);
    // A análise antiga permanece não reutilizável.
    assert.equal(await history.getReusableAnalysis(target), undefined);
  });
});

test("versionamento não interfere na deduplicação de notificações", async () => {
  await withTempDir(async () => {
    const target = job({ id: "dedupe-1" });

    const first = await dedup.reserveJobNotification(target);
    assert.ok(first, "a primeira reserva deveria ser concedida");
    // Segunda reserva da mesma vaga é negada (sem notificação duplicada).
    assert.equal(await dedup.reserveJobNotification(target), undefined);
    assert.equal(await dedup.confirmJobNotification(first), true);
    assert.equal(await dedup.isJobNotified(target), true);
  });
});
