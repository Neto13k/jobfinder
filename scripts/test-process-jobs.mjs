// Testes determinísticos do processamento de vagas (processJobs do pipeline).
//
// Uso:   npm run build
//        node scripts/test-process-jobs.mjs
//
// Roda em diretório temporário (backend JSON), sem tocar no data/ real, no
// Gemini nem no Telegram: a análise de IA (em lote) e o despacho de notificação
// são injetados como dependências falsas. Valida o COMPORTAMENTO EFETIVO do
// laço: a falha global da IA impede novas chamadas sem interromper o
// processamento, as análises salvas continuam sendo reaproveitadas, o limite é
// contabilizado por tentativas (uma por vaga do lote) e nenhuma falha é
// persistida ou notificada.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();

// Configuração lida no carregamento do pipeline: precisa vir antes do import.
delete process.env.JOBFINDER_STORAGE;
process.env.JOBFINDER_SEND_NOTIFICATIONS = "true";
delete process.env.JOBFINDER_SEND_REVIEWS;
// Dez análises por execução (teto): com lotes de 5 vagas, permite observar dois
// lotes e provar que a falha consome o limite de tentativas por vaga do lote.
process.env.JOBFINDER_MAX_ANALYSES = "10";

const { processJobs } = await import("../dist/index.js");
const { GeminiAnalysisError } = await import("../dist/services/ai-analyzer.js");
const history = await import("../dist/services/analysis-history.js");
const dedup = await import("../dist/services/deduplication.js");

const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-process-"));
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
    source: "process-test",
    ...overrides,
  };
}

/** Monta uma análise estruturada mínima com os campos sobrepostos. */
function analysis(overrides) {
  return {
    decision: "compatible",
    score: 80,
    reason: "CLT remoto Brasil",
    seniorityStatus: "allowed",
    technologiesStatus: "allowed",
    locationStatus: "allowed",
    contractStatus: "allowed",
    ...overrides,
  };
}

/** Cria um diretório temporário isolado e executa a tarefa nele. */
async function withTempDir(task) {
  const dir = await mkdtemp(join(tmpdir(), "jobfinder-process-sub-"));
  process.chdir(dir);
  try {
    await task();
  } finally {
    process.chdir(tempDir);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Lê os registros persistidos no histórico JSON (vazio quando ausente). */
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

test("falha global da IA interrompe novas chamadas sem parar o laço", async () => {
  await withTempDir(async () => {
    const jobs = Array.from({ length: 7 }, (_, index) =>
      job({ id: `job-${index}` }),
    );
    let batchCalls = 0;
    let notifyCalls = 0;

    const summary = await processJobs(jobs, {
      analyzeBatch: async () => {
        batchCalls++;
        // Cota esgotada: falha global, não específica dos dados das vagas.
        throw new GeminiAnalysisError("rate_limit", "cota esgotada");
      },
      notify: async () => {
        notifyCalls++;
        return true;
      },
    });

    // Só o primeiro lote (5 vagas) chega a chamar a IA; as demais são
    // contabilizadas como não analisadas por indisponibilidade, sem interromper
    // o laço. A falha consome as tentativas de todas as vagas do lote.
    assert.equal(batchCalls, 1);
    assert.equal(summary.failedAnalyses, 5);
    assert.equal(summary.unanalyzedByGemini, 2);
    assert.equal(summary.unanalyzedByLimit, 0);
    assert.equal(summary.analyzed, 0);
    assert.equal(notifyCalls, 0);
  });
});

test("análises salvas continuam sendo reaproveitadas após a IA ficar indisponível", async () => {
  await withTempDir(async () => {
    // Vaga com análise salva da versão vigente.
    const savedJob = job({ id: "saved" });
    await history.markJobAsAnalyzed(savedJob, analysis({ score: 77 }));

    const jobs = [job({ id: "fresh" }), savedJob, job({ id: "later" })];
    let batchCalls = 0;

    const summary = await processJobs(jobs, {
      analyzeBatch: async () => {
        batchCalls++;
        throw new GeminiAnalysisError("unavailable", "IA fora do ar");
      },
      notify: async () => true,
    });

    assert.equal(batchCalls, 1);
    assert.equal(summary.failedAnalyses, 1);
    // Mesmo com a IA bloqueada, a análise salva é recuperada do histórico.
    assert.equal(summary.recovered, 1);
    assert.equal(summary.unanalyzedByGemini, 1);
  });
});

test("o limite de análises conta tentativas por vaga, não apenas sucessos", async () => {
  await withTempDir(async () => {
    const jobs = Array.from({ length: 12 }, (_, index) =>
      job({ id: `limit-${index}` }),
    );
    let batchCalls = 0;

    const summary = await processJobs(jobs, {
      analyzeBatch: async () => {
        batchCalls++;
        // Falha específica do lote (resposta inválida): isola o lote e permite
        // seguir para o próximo, mas ainda assim consome as tentativas.
        throw new GeminiAnalysisError("invalid", "resposta inválida");
      },
      notify: async () => true,
    });

    // Dois lotes (5 + 5 = 10 tentativas) esgotam o limite; as duas vagas
    // restantes nem chegam a chamar a IA.
    assert.equal(batchCalls, 2);
    assert.equal(summary.failedAnalyses, 10);
    assert.equal(summary.unanalyzedByLimit, 2);
    assert.equal(summary.analyzed, 0);
  });
});

test("aproveita os resultados válidos e não persiste nem notifica os inválidos", async () => {
  await withTempDir(async () => {
    const failed = job({ id: "fail" });
    const ok = job({ id: "ok" });
    const notified = [];

    const summary = await processJobs([failed, ok], {
      analyzeBatch: async () => {
        // Simula a resposta da IA com apenas o resultado válido: a vaga "fail"
        // fica ausente do mapa (inválida/desconhecida) e é descartada sem
        // invalidar o resultado válido.
        return new Map([[dedup.generateJobKey(ok), analysis({ score: 91 })]]);
      },
      notify: async (candidate, kind) => {
        notified.push({ id: candidate.job.id, kind });
        return true;
      },
    });

    assert.equal(summary.failedAnalyses, 1);
    assert.equal(summary.analyzed, 1);

    // A falha não vira registro no histórico; o sucesso sim.
    const records = await readHistory();
    const keys = records.map((record) => record.key);
    assert.equal(records.length, 1);
    assert.ok(!keys.includes(dedup.generateJobKey(failed)));
    assert.ok(keys.includes(dedup.generateJobKey(ok)));

    // Somente a vaga analisada com sucesso foi notificada.
    assert.deepEqual(notified, [{ id: "ok", kind: "compatible" }]);
  });
});
