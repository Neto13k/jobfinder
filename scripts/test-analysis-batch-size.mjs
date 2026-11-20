// Testes de regressão do dimensionamento do lote e do limite por execução.
//
// Uso:   npm run build
//        node scripts/test-analysis-batch-size.mjs
//
// Roda em diretório temporário (backend JSON), sem rede, sem Gemini e sem
// Telegram: a análise em lote e a notificação são injetadas como dependências
// falsas. Valida três pontos: (1) limites que NÃO são múltiplos do tamanho do
// lote, garantindo que MAX_ANALYSES jamais seja ultrapassado; (2) histórico
// intercalado, que resolve o lote pendente antes de uma vaga recuperada,
// preservando a ordem de prioridade; e (3) a configuração INDEPENDENTE de
// JOBFINDER_ANALYSIS_BATCH_SIZE em relação a JOBFINDER_MAX_ANALYSES.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();

// Configuração lida no carregamento do pipeline: precisa vir antes do import.
delete process.env.JOBFINDER_STORAGE;
delete process.env.JOBFINDER_SEND_NOTIFICATIONS;
delete process.env.JOBFINDER_SEND_REVIEWS;
// Limite NÃO múltiplo do tamanho do lote e configuração independente:
// 7 análises por execução, lotes de 3 vagas por requisição.
process.env.JOBFINDER_MAX_ANALYSES = "7";
process.env.JOBFINDER_ANALYSIS_BATCH_SIZE = "3";

const { processJobs } = await import("../dist/index.js");
const history = await import("../dist/services/analysis-history.js");
const dedup = await import("../dist/services/deduplication.js");

const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-batch-size-"));
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
    source: "batch-size-test",
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
  const dir = await mkdtemp(join(tmpdir(), "jobfinder-batch-size-sub-"));
  process.chdir(dir);
  try {
    await task();
  } finally {
    process.chdir(tempDir);
    await rm(dir, { recursive: true, force: true });
  }
}

test("limite não múltiplo do tamanho do lote nunca ultrapassa MAX_ANALYSES", async () => {
  await withTempDir(async () => {
    const jobs = Array.from({ length: 12 }, (_, index) =>
      job({ id: `limit-${index}` }),
    );
    const batchSizes = [];

    const summary = await processJobs(jobs, {
      analyzeBatch: async (batchJobs) => {
        batchSizes.push(batchJobs.length);
        return new Map(
          batchJobs.map((current) => [
            dedup.generateJobKey(current),
            analysis(),
          ]),
        );
      },
      notify: async () => true,
    });

    // Limite 7, lote 3: os lotes são 3 + 3 + 1 (o último limitado ao saldo),
    // totalizando exatamente MAX_ANALYSES tentativas — sem ultrapassá-lo.
    assert.deepEqual(batchSizes, [3, 3, 1]);
    assert.equal(
      batchSizes.reduce((total, size) => total + size, 0),
      7,
    );
    assert.equal(summary.analyzed, 7);
    // As vagas restantes nem chegam a ser percorridas (sem notificações ativas).
    assert.equal(summary.unscannedByLimit, 5);
    assert.equal(summary.unanalyzedByLimit, 0);
  });
});

test("histórico intercalado resolve o lote pendente antes da vaga recuperada", async () => {
  await withTempDir(async () => {
    // Uma vaga com análise salva da versão vigente, intercalada entre as novas.
    const saved = job({ id: "saved" });
    await history.markJobAsAnalyzed(saved, analysis({ score: 77 }));

    const jobs = [
      job({ id: "n0" }),
      job({ id: "n1" }),
      saved,
      job({ id: "n3" }),
      job({ id: "n4" }),
      job({ id: "n5" }),
      job({ id: "n6" }),
      job({ id: "n7" }),
    ];
    const batchSizes = [];

    const summary = await processJobs(jobs, {
      analyzeBatch: async (batchJobs) => {
        batchSizes.push(batchJobs.length);
        return new Map(
          batchJobs.map((current) => [
            dedup.generateJobKey(current),
            analysis(),
          ]),
        );
      },
      notify: async () => true,
    });

    // Ao encontrar a vaga recuperada, o lote pendente (2 vagas) é enviado
    // antes de avaliá-la: 2 + 3 + 2, preservando a ordem de prioridade.
    assert.deepEqual(batchSizes, [2, 3, 2]);
    assert.equal(summary.recovered, 1);
    assert.equal(summary.analyzed, 7);
    assert.equal(summary.unscannedByLimit, 0);
  });
});
