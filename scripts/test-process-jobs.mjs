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
// persistida ou notificada. Valida também as notificações múltiplas por
// execução: TODAS as compatíveis antes das de revisão manual (na ordem de
// prioridade), o limite de JOBFINDER_MAX_NOTIFICATIONS, o aproveitamento de
// análises novas e recuperadas sem duplicar candidatas e o isolamento de
// falhas individuais de envio. Valida ainda que o limite de análises NÃO
// interrompe a consulta ao histórico: candidatas compatíveis posteriores,
// revisões recuperadas e substitutas de envio falho/recusado continuam sendo
// recuperadas.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();

// Configuração lida no carregamento do pipeline: precisa vir antes do import.
delete process.env.JOBFINDER_STORAGE;
process.env.JOBFINDER_SEND_NOTIFICATIONS = "true";
// Revisões habilitadas para exercitar a prioridade compatível × revisão.
process.env.JOBFINDER_SEND_REVIEWS = "true";
// Limite de notificações por execução exercitado pelos testes.
process.env.JOBFINDER_MAX_NOTIFICATIONS = "3";
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

test("prioriza todas as compatíveis antes das revisões e respeita o limite", async () => {
  await withTempDir(async () => {
    // Intercaladas na entrada; a prioridade (compatível antes de revisão) é da
    // política de notificação, não da ordem de chegada.
    const jobs = [
      job({ id: "rev-a" }),
      job({ id: "comp-a" }),
      job({ id: "rev-b" }),
      job({ id: "comp-b" }),
      job({ id: "comp-c" }),
    ];
    const notified = [];

    const summary = await processJobs(jobs, {
      analyzeBatch: async (batch) => {
        const map = new Map();
        for (const item of batch) {
          const isReview = item.id.startsWith("rev-");
          map.set(
            dedup.generateJobKey(item),
            analysis({
              decision: isReview ? "review" : "compatible",
              score: isReview ? 50 : 90,
            }),
          );
        }
        return map;
      },
      notify: async (candidate, kind) => {
        notified.push({ id: candidate.job.id, kind });
        return true;
      },
    });

    // As compatíveis (na ordem de prioridade) preenchem o limite de 3; as
    // revisões ficam de fora pelo limite por execução.
    assert.deepEqual(notified, [
      { id: "comp-a", kind: "compatible" },
      { id: "comp-b", kind: "compatible" },
      { id: "comp-c", kind: "compatible" },
    ]);
    assert.equal(summary.sentCompatible, 3);
    assert.equal(summary.sentReview, 0);
  });
});

test("envia compatíveis antes de revisões quando o limite não é preenchido por compatíveis", async () => {
  await withTempDir(async () => {
    const jobs = [
      job({ id: "rev-a" }),
      job({ id: "comp-a" }),
      job({ id: "rev-b" }),
    ];
    const notified = [];

    const summary = await processJobs(jobs, {
      analyzeBatch: async (batch) => {
        const map = new Map();
        for (const item of batch) {
          map.set(
            dedup.generateJobKey(item),
            analysis({
              decision: item.id.startsWith("rev-") ? "review" : "compatible",
            }),
          );
        }
        return map;
      },
      notify: async (candidate, kind) => {
        notified.push({ id: candidate.job.id, kind });
        return true;
      },
    });

    // A compatível vem primeiro; as revisões ocupam as vagas restantes do
    // limite, na ordem de prioridade.
    assert.deepEqual(notified, [
      { id: "comp-a", kind: "compatible" },
      { id: "rev-a", kind: "manual_review" },
      { id: "rev-b", kind: "manual_review" },
    ]);
    assert.equal(summary.sentCompatible, 1);
    assert.equal(summary.sentReview, 2);
  });
});

test("falha individual de envio não impede as demais notificações", async () => {
  await withTempDir(async () => {
    const jobs = [
      job({ id: "comp-a" }),
      job({ id: "comp-b" }),
      job({ id: "comp-c" }),
    ];
    const attempted = [];

    const summary = await processJobs(jobs, {
      analyzeBatch: async (batch) => {
        const map = new Map();
        for (const item of batch) {
          map.set(dedup.generateJobKey(item), analysis());
        }
        return map;
      },
      notify: async (candidate) => {
        attempted.push(candidate.job.id);
        // A falha da segunda vaga é isolada: não consome o limite nem impede
        // as demais candidatas elegíveis.
        if (candidate.job.id === "comp-b") {
          throw new Error("falha simulada de envio");
        }
        return true;
      },
    });

    // As três candidatas são tentadas, em ordem; a falha não interrompe o laço.
    assert.deepEqual(attempted, ["comp-a", "comp-b", "comp-c"]);
    assert.equal(summary.sentCompatible, 2);
  });
});

test("considera análises novas e recuperadas do histórico sem duplicar candidatas", async () => {
  await withTempDir(async () => {
    const saved = job({ id: "saved" });
    await history.markJobAsAnalyzed(saved, analysis({ score: 88 }));

    const fresh = job({ id: "fresh" });
    const notified = [];

    const summary = await processJobs([fresh, saved], {
      analyzeBatch: async (batch) => {
        const map = new Map();
        for (const item of batch) {
          map.set(dedup.generateJobKey(item), analysis({ score: 70 }));
        }
        return map;
      },
      notify: async (candidate, kind) => {
        notified.push({ id: candidate.job.id, kind });
        return true;
      },
    });

    // Cada vaga vira candidata uma única vez; a nova e a recuperada convivem.
    assert.deepEqual(notified, [
      { id: "fresh", kind: "compatible" },
      { id: "saved", kind: "compatible" },
    ]);
    assert.equal(summary.analyzed, 1);
    assert.equal(summary.recovered, 1);
    assert.equal(summary.sentCompatible, 2);
  });
});

test("recupera compatível posterior mesmo com o limite de análises esgotado", async () => {
  await withTempDir(async () => {
    // Dez vagas NOVAS em revisão esgotam o limite de análises (10) sem gerar
    // nenhuma compatível.
    const reviews = Array.from({ length: 10 }, (_, index) =>
      job({ id: `rev-${index}` }),
    );
    // Vaga compatível já salva no histórico, posicionada DEPOIS das revisões.
    const savedCompatible = job({ id: "comp-saved" });
    await history.markJobAsAnalyzed(savedCompatible, analysis({ score: 95 }));

    const jobs = [...reviews, savedCompatible];
    const notified = [];

    const summary = await processJobs(jobs, {
      analyzeBatch: async (batch) => {
        const map = new Map();
        for (const item of batch) {
          map.set(
            dedup.generateJobKey(item),
            analysis({ decision: "review", score: 40 }),
          );
        }
        return map;
      },
      notify: async (candidate, kind) => {
        notified.push({ id: candidate.job.id, kind });
        return true;
      },
    });

    // Mesmo com o limite de análises esgotado e três candidatas já coletadas, a
    // compatível recuperada (posição posterior) é encontrada e notificada ANTES
    // das revisões, na ordem de prioridade.
    assert.deepEqual(notified, [
      { id: "comp-saved", kind: "compatible" },
      { id: "rev-0", kind: "manual_review" },
      { id: "rev-1", kind: "manual_review" },
    ]);
    assert.equal(summary.recovered, 1);
    assert.equal(summary.sentCompatible, 1);
    assert.equal(summary.sentReview, 2);
  });
});

test("envio recusado libera vaga para candidata recuperada do histórico", async () => {
  await withTempDir(async () => {
    // Três compatíveis novas; as sete vagas incompatíveis esgotam o limite de
    // análises (10) sem gerar candidatas.
    const compatibles = ["comp-a", "comp-b", "comp-c"].map((id) => job({ id }));
    const incompatibles = Array.from({ length: 7 }, (_, index) =>
      job({ id: `no-${index}` }),
    );
    // Quarta candidata recuperada do histórico, posicionada DEPOIS do limite.
    const savedCompatible = job({ id: "comp-saved" });
    await history.markJobAsAnalyzed(savedCompatible, analysis({ score: 93 }));

    const jobs = [...compatibles, ...incompatibles, savedCompatible];
    const notified = [];

    const summary = await processJobs(jobs, {
      analyzeBatch: async (batch) => {
        const map = new Map();
        for (const item of batch) {
          const isIncompatible = item.id.startsWith("no-");
          map.set(
            dedup.generateJobKey(item),
            analysis({
              decision: isIncompatible ? "incompatible" : "compatible",
              score: isIncompatible ? 10 : 90,
            }),
          );
        }
        return map;
      },
      notify: async (candidate, kind) => {
        notified.push({ id: candidate.job.id, kind });
        // O segundo envio é recusado (já reservado/notificado): não consome o
        // limite e a candidata recuperada assume a terceira notificação.
        if (candidate.job.id === "comp-b") {
          return false;
        }
        return true;
      },
    });

    // Três envios bem-sucedidos, sem duplicação: comp-a e comp-c (novas) mais a
    // recuperada comp-saved ocupam o limite após a recusa de comp-b.
    assert.deepEqual(notified, [
      { id: "comp-a", kind: "compatible" },
      { id: "comp-b", kind: "compatible" },
      { id: "comp-c", kind: "compatible" },
      { id: "comp-saved", kind: "compatible" },
    ]);
    assert.equal(summary.sentCompatible, 3);
    assert.equal(summary.recovered, 1);
  });
});

test("revisão recuperada do histórico continua elegível após esgotar o limite", async () => {
  await withTempDir(async () => {
    // Dez vagas novas INCOMPATÍVEIS esgotam o limite de análises (10) sem gerar
    // nenhuma candidata.
    const incompatibles = Array.from({ length: 10 }, (_, index) =>
      job({ id: `no-${index}` }),
    );
    // Revisão já salva no histórico, posicionada DEPOIS do limite. Com a
    // modalidade de revisão ativa, o laço não encerra cedo por limite.
    const savedReview = job({ id: "rev-saved" });
    await history.markJobAsAnalyzed(
      savedReview,
      analysis({ decision: "review", score: 60 }),
    );

    const jobs = [...incompatibles, savedReview];
    const notified = [];
    let batchCalls = 0;

    const summary = await processJobs(jobs, {
      analyzeBatch: async (batch) => {
        batchCalls++;
        const map = new Map();
        for (const item of batch) {
          map.set(
            dedup.generateJobKey(item),
            analysis({ decision: "incompatible", score: 10 }),
          );
        }
        return map;
      },
      notify: async (candidate, kind) => {
        notified.push({ id: candidate.job.id, kind });
        return true;
      },
    });

    // O laço segue consultando o histórico mesmo com o limite esgotado: a
    // revisão recuperada (posição posterior) permanece elegível e é notificada.
    assert.equal(summary.unscannedByLimit, 0);
    assert.equal(summary.recovered, 1);
    assert.deepEqual(notified, [{ id: "rev-saved", kind: "manual_review" }]);
    assert.equal(summary.sentReview, 1);
    // Nenhuma análise adicional ao Gemini após o limite: só dois lotes de 5.
    assert.equal(batchCalls, 2);
    assert.equal(summary.analyzed, 10);
  });
});
