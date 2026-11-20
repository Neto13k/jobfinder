// Testes determinísticos da fila de vagas pendentes entre execuções.
//
// Uso:   npm run build
//        node scripts/test-pending-jobs.mjs
//
// Roda em diretório temporário (backend JSON), sem tocar no data/ real, no
// Gemini nem no Telegram: a análise (em lote) e o despacho de notificação são
// injetados como dependências falsas. Valida a RECUPERAÇÃO das pendências de
// execuções anteriores (mesmo sem nova coleta), o registro por motivo
// (limite de análises, indisponibilidade da IA e limite de envios), a
// combinação com as vagas recém-coletadas (com a deduplicação existente), o
// descarte explícito de pendências já notificadas/obsoletas (TTL), o erro
// alto em fila corrompida/vazia (sem fallback silencioso), o TTL, o teto de
// pendências, a serialização de gravações concorrentes, a preservação das
// vagas do PRÓPRIO lote que falhou e das vagas sem resultado válido, a
// reconciliação concorrente (remoção E sobrescrita protegidas por
// `runStartedAtIso` — uma execução antiga que grave depois não apaga nem
// regride uma pendência atualizada por execução mais recente) e a validação dos
// registros do PostgreSQL sem depender de conexão real.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const originalCwd = process.cwd();

// Configuração lida no carregamento do pipeline: precisa vir antes do import.
delete process.env.JOBFINDER_STORAGE;
process.env.JOBFINDER_SEND_NOTIFICATIONS = "true";
process.env.JOBFINDER_SEND_REVIEWS = "true";
process.env.JOBFINDER_MAX_NOTIFICATIONS = "3";
// Piso do limite de análises (5): permite observar vagas barradas por limite.
process.env.JOBFINDER_MAX_ANALYSES = "5";
process.env.JOBFINDER_PENDING_JOBS_ENABLED = "true";
process.env.JOBFINDER_PENDING_JOB_TTL_DAYS = "7";
process.env.JOBFINDER_PENDING_MAX_JOBS = "200";

const { runPipeline } = await import("../dist/index.js");
const { GeminiAnalysisError } = await import("../dist/services/ai-analyzer.js");
const pending = await import("../dist/services/pending-jobs.js");
const dedup = await import("../dist/services/deduplication.js");

const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-pending-"));
process.chdir(tempDir);

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

/** Monta uma vaga de desenvolvimento que passa por todos os filtros de triagem. */
function job(overrides) {
  return {
    id: "1",
    title: "Desenvolvedor Full Stack",
    company: "Empresa",
    location: "Remoto - Brasil",
    remote: true,
    description: "Vaga para desenvolvimento de software com foco em APIs.",
    url: "https://example.com",
    source: "pending-test",
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

/** Dependências falsas de análise/notificação (sem Gemini nem Telegram). */
function deps(analyzeBatch, notify = async () => true) {
  return { analyzeBatch, notify };
}

/** Cria um diretório temporário isolado e executa a tarefa nele. */
async function withTempDir(task) {
  const dir = await mkdtemp(join(tmpdir(), "jobfinder-pending-sub-"));
  process.chdir(dir);
  try {
    await task();
  } finally {
    process.chdir(tempDir);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Lê os registros persistidos na fila JSON (vazio quando ausente). */
async function readPending() {
  try {
    const content = await readFile(
      join(process.cwd(), "data", "pending-jobs.json"),
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

/** Escreve conteúdo bruto na fila JSON (para cenários de corrupção). */
async function writePendingRaw(content) {
  const file = join(process.cwd(), "data", "pending-jobs.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

test("persiste por limite de análises e recupera na execução seguinte sem nova coleta", async () => {
  await withTempDir(async () => {
    const jobs = Array.from({ length: 8 }, (_, index) =>
      job({ id: `lim-${index}` }),
    );

    // Primeira execução: as 5 primeiras vagas são analisadas como incompatíveis
    // (não geram candidatas de notificação); as 3 restantes ficam pendentes pelo
    // limite de análises da execução.
    const run1 = await runPipeline(jobs, {
      dependencies: deps(async (batch) => {
        const map = new Map();
        for (const item of batch) {
          map.set(
            dedup.generateJobKey(item),
            analysis({ decision: "incompatible", score: 10 }),
          );
        }
        return map;
      }),
    });

    assert.equal(run1.analyzed, 5);
    assert.equal(run1.unanalyzedByLimit, 3);
    assert.equal(run1.pendingJobs.length, 3);
    assert.ok(run1.pendingJobs.every((p) => p.reason === "analysis_limit"));

    const persisted = await readPending();
    assert.equal(persisted.length, 3);
    assert.ok(persisted.every((record) => record.reason === "analysis_limit"));

    // Segunda execução: NENHUMA vaga é coletada de novo — só as pendências.
    const run2 = await runPipeline([], {
      dependencies: deps(async (batch) => {
        const map = new Map();
        for (const item of batch) {
          map.set(dedup.generateJobKey(item), analysis({ score: 90 }));
        }
        return map;
      }),
    });

    assert.equal(run2.analyzed, 3);
    assert.equal(run2.sentCompatible, 3);
    assert.equal(run2.pendingJobs.length, 0);

    // Todas resolvidas: a fila é esvaziada explicitamente (sem descarte silencioso).
    assert.equal((await readPending()).length, 0);
  });
});

test("falha do primeiro lote preserva as 5 vagas do lote e a posterior (6 no total)", async () => {
  await withTempDir(async () => {
    const jobs = Array.from({ length: 6 }, (_, index) =>
      job({ id: `gem-${index}` }),
    );

    const run1 = await runPipeline(jobs, {
      dependencies: deps(async () => {
        // Falha global: interrompe novas chamadas sem parar o laço.
        throw new GeminiAnalysisError("unavailable", "IA fora do ar");
      }),
    });

    // O primeiro lote (5) falha e a sexta vaga é barrada pela IA indisponível:
    // TODAS as 6 ficam pendentes (antes, só a vaga posterior ao bloqueio era
    // preservada — as 5 do próprio lote eram perdidas).
    assert.equal(run1.failedAnalyses, 5);
    assert.equal(run1.unanalyzedByGemini, 1);
    assert.equal(run1.pendingJobs.length, 6);
    assert.ok(run1.pendingJobs.every((p) => p.reason === "gemini_unavailable"));

    const persisted = await readPending();
    assert.equal(persisted.length, 6);
    assert.ok(persisted.every((record) => record.reason === "gemini_unavailable"));

    // Recuperação SEM nova coleta: a fila (6 vagas) é drenada nas execuções
    // seguintes, respeitando o limite de análises por execução (5).
    let analyzed = 0;
    for (let round = 0; round < 3; round++) {
      const run = await runPipeline([], {
        dependencies: deps(async (batch) => {
          const map = new Map();
          for (const item of batch) {
            map.set(
              dedup.generateJobKey(item),
              analysis({ decision: "incompatible", score: 10 }),
            );
          }
          return map;
        }),
      });

      analyzed += run.analyzed;
      if (run.analyzed === 0) {
        break;
      }
    }

    assert.equal(analyzed, 6);
    assert.equal((await readPending()).length, 0);
  });
});

test("resposta parcialmente inválida: vagas sem análise válida permanecem pendentes", async () => {
  await withTempDir(async () => {
    const jobs = Array.from({ length: 3 }, (_, index) =>
      job({ id: `partial-${index}` }),
    );

    const run = await runPipeline(jobs, {
      dependencies: deps(async (batch) => {
        const map = new Map();
        // Só a primeira vaga do lote recebe análise válida; as demais ficam sem
        // resultado (ausentes na resposta) e devem permanecer pendentes.
        const [first] = batch;
        map.set(
          dedup.generateJobKey(first),
          analysis({ decision: "incompatible", score: 10 }),
        );
        return map;
      }),
    });

    assert.equal(run.analyzed, 1);
    assert.equal(run.failedAnalyses, 2);
    assert.equal(run.pendingJobs.length, 2);
    assert.ok(run.pendingJobs.every((p) => p.reason === "gemini_unavailable"));

    const persisted = await readPending();
    assert.equal(persisted.length, 2);
    assert.ok(persisted.every((record) => record.reason === "gemini_unavailable"));
  });
});

test("preserva analisada sem notificação apenas pelo limite de envios", async () => {
  await withTempDir(async () => {
    const jobs = Array.from({ length: 4 }, (_, index) =>
      job({ id: `notif-${index}` }),
    );

    const summary = await runPipeline(jobs, {
      dependencies: deps(async (batch) => {
        const map = new Map();
        for (const item of batch) {
          map.set(dedup.generateJobKey(item), analysis({ score: 80 }));
        }
        return map;
      }),
    });

    // Limite de 3 envios: a quarta compatível fica pendente pelo limite.
    assert.equal(summary.sentCompatible, 3);
    assert.equal(summary.pendingJobs.length, 1);
    assert.equal(summary.pendingJobs[0].reason, "notification_limit");

    const persisted = await readPending();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].reason, "notification_limit");
  });
});

test("deduplica a pendência recuperada com a vaga recém-coletada (a coleta prevalece)", async () => {
  await withTempDir(async () => {
    // Pendência de uma execução anterior para a mesma chave "source:id".
    await pending.savePendingJobs({
      pending: [
        { job: job({ id: "dup", title: "Desenvolvedor Antigo" }), reason: "analysis_limit" },
      ],
      resolvedKeys: [],
    });

    const seen = [];
    const summary = await runPipeline(
      [job({ id: "dup", title: "Desenvolvedor Novo" })],
      {
        dependencies: deps(async (batch) => {
          const map = new Map();
          for (const item of batch) {
            seen.push(item.title);
            map.set(dedup.generateJobKey(item), analysis());
          }
          return map;
        }),
      },
    );

    // Apenas uma vaga (mesma chave) é analisada, com os dados da coleta fresca.
    assert.deepEqual(seen, ["Desenvolvedor Novo"]);
    assert.equal(summary.analyzed, 1);
    // A pendência foi resolvida (analisada/notificada) e removida da fila.
    assert.equal((await readPending()).length, 0);
  });
});

test("descarta pendência já notificada sem recuperá-la", async () => {
  await withTempDir(async () => {
    const notified = job({ id: "already" });
    await dedup.markJobAsNotified(notified);
    await pending.savePendingJobs({
      pending: [{ job: notified, reason: "analysis_limit" }],
      resolvedKeys: [],
    });

    const loaded = await pending.loadPendingJobs();
    assert.equal(loaded.records.length, 0);
    assert.equal(loaded.droppedNotified, 1);
    assert.deepEqual(loaded.droppedKeys, [dedup.generateJobKey(notified)]);
  });
});

test("descarta pendência obsoleta pelo TTL", async () => {
  await withTempDir(async () => {
    const stale = job({ id: "old" });
    const t0 = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await pending.savePendingJobs({
      pending: [{ job: stale, reason: "analysis_limit" }],
      resolvedKeys: [],
      nowMs: t0,
    });

    // Dentro do TTL (7 dias): permanece recuperável.
    const within = await pending.loadPendingJobs({ nowMs: t0 + 1000 });
    assert.equal(within.records.length, 1);

    // Fora do TTL (8 dias > 7): descartada e registrada (não em silêncio).
    const expired = await pending.loadPendingJobs({ nowMs: Date.now() });
    assert.equal(expired.records.length, 0);
    assert.equal(expired.droppedExpired, 1);
    assert.deepEqual(expired.droppedKeys, [dedup.generateJobKey(stale)]);
  });
});

test("fila corrompida, vazia ou com registro inválido lança erro", async () => {
  await withTempDir(async () => {
    await writePendingRaw("isto-nao-e-json");
    await assert.rejects(() => pending.loadPendingJobs(), /corrompida/);

    await writePendingRaw("");
    await assert.rejects(() => pending.loadPendingJobs(), /vazia/);

    // Chave incoerente com a vaga: registro rejeitado.
    await writePendingRaw(
      JSON.stringify([
        {
          key: "outro:chave",
          job: job({ id: "x" }),
          reason: "analysis_limit",
          firstSeenAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    await assert.rejects(() => pending.loadPendingJobs(), /corrompida/);
  });
});

test("execução interrompe se a fila estiver corrompida", async () => {
  await withTempDir(async () => {
    await writePendingRaw("corrompido");

    await assert.rejects(() =>
      runPipeline([job({ id: "any" })], {
        dependencies: deps(async () => new Map()),
      }),
    );
  });
});

test("gravações concorrentes não perdem nem duplicam pendências (JSON serializado)", async () => {
  await withTempDir(async () => {
    const a = job({ id: "conc-a" });
    const b = job({ id: "conc-b" });

    await Promise.all([
      pending.savePendingJobs({
        pending: [{ job: a, reason: "analysis_limit" }],
        resolvedKeys: [],
      }),
      pending.savePendingJobs({
        pending: [{ job: b, reason: "notification_limit" }],
        resolvedKeys: [],
      }),
    ]);

    const loaded = await pending.loadPendingJobs();
    const keys = loaded.records.map((record) => record.key).sort();
    assert.deepEqual(keys, ["pending-test:conc-a", "pending-test:conc-b"]);
  });
});

test("teto de pendências preserva as mais recentes", async () => {
  await withTempDir(async () => {
    const config = { enabled: true, ttlMs: 7 * 24 * 60 * 60 * 1000, maxJobs: 2 };
    const t1 = Date.now() - 10_000;
    const t2 = Date.now();

    await pending.savePendingJobs({
      pending: [{ job: job({ id: "a" }), reason: "analysis_limit" }],
      resolvedKeys: [],
      nowMs: t1,
      config,
    });
    await pending.savePendingJobs({
      pending: [
        { job: job({ id: "b" }), reason: "analysis_limit" },
        { job: job({ id: "c" }), reason: "analysis_limit" },
      ],
      resolvedKeys: [],
      nowMs: t2,
      config,
    });

    const loaded = await pending.loadPendingJobs({ config });
    const keys = loaded.records.map((record) => record.key).sort();
    assert.deepEqual(keys, ["pending-test:b", "pending-test:c"]);
  });
});

test("re-salvar preserva firstSeenAt e atualiza o motivo", async () => {
  await withTempDir(async () => {
    const same = job({ id: "keep" });
    const t1 = Date.now() - 5_000;

    await pending.savePendingJobs({
      pending: [{ job: same, reason: "analysis_limit" }],
      resolvedKeys: [],
      nowMs: t1,
    });
    await pending.savePendingJobs({
      pending: [{ job: same, reason: "gemini_unavailable" }],
      resolvedKeys: [],
      nowMs: Date.now(),
    });

    const loaded = await pending.loadPendingJobs();
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0].reason, "gemini_unavailable");
    // A entrada na fila (base do TTL) NÃO é reiniciada pela atualização.
    assert.equal(Date.parse(loaded.records[0].firstSeenAt), t1);
  });
});

test("reconciliação não remove nem regride pendência atualizada após o início da execução", async () => {
  await withTempDir(async () => {
    const key = dedup.generateJobKey(job({ id: "race" }));
    const runStart = Date.now() - 60_000; // execução "antiga"
    const recent = Date.now(); // atualização concorrente mais recente

    // Registro atualizado por uma execução concorrente (carimbo mais recente).
    await pending.savePendingJobs({
      pending: [{ job: job({ id: "race" }), reason: "analysis_limit" }],
      resolvedKeys: [],
      nowMs: recent,
    });

    // Gravação com carimbo ANTERIOR não regride a atualização mais recente.
    await pending.savePendingJobs({
      pending: [{ job: job({ id: "race" }), reason: "notification_limit" }],
      resolvedKeys: [],
      nowMs: recent - 5_000,
    });

    const preserved = await readPending();
    assert.equal(preserved.length, 1);
    assert.equal(preserved[0].reason, "analysis_limit");
    assert.equal(Date.parse(preserved[0].updatedAt), recent);

    // Execução antiga tenta remover a chave já resolvida: como o registro foi
    // atualizado DEPOIS do início dela, a remoção é protegida.
    const guarded = await pending.savePendingJobs({
      pending: [],
      resolvedKeys: [key],
      runStartedAtIso: new Date(runStart).toISOString(),
      nowMs: recent,
    });

    assert.equal(guarded.removed, 0);
    assert.equal((await readPending()).length, 1);

    // Execução iniciada DEPOIS da atualização: a remoção prossegue normalmente.
    const removed = await pending.savePendingJobs({
      pending: [],
      resolvedKeys: [key],
      runStartedAtIso: new Date(recent + 1_000).toISOString(),
      nowMs: recent + 2_000,
    });

    assert.equal(removed.removed, 1);
    assert.equal((await readPending()).length, 0);
  });
});

test("execução antiga que grava DEPOIS não sobrescreve pendência atualizada por execução mais recente", async () => {
  await withTempDir(async () => {
    const shared = job({ id: "race-overwrite" });

    // Execução A começa PRIMEIRO (runStartedAtIso antigo) e vai gravar só no
    // fim; a execução B, iniciada depois, atualiza a pendência antes disso.
    const runStartA = Date.now() - 120_000; // início de A (mais antigo)
    const updateB = Date.now() - 60_000; // B atualiza a pendência (mais recente)
    const writeA = Date.now(); // A grava DEPOIS de B, em tempo de relógio

    // B grava a pendência da chave compartilhada.
    await pending.savePendingJobs({
      pending: [{ job: shared, reason: "notification_limit" }],
      resolvedKeys: [],
      runStartedAtIso: new Date(runStartA).toISOString(),
      nowMs: updateB,
    });

    // A tenta gravar a MESMA chave depois, mas com início ANTERIOR à atualização
    // de B. Como `updatedAt` de B (recente) é >= início de A (antigo), a escrita
    // de A é ignorada — a guarda antiga `updatedAt > nowIso` NÃO cobria isso.
    const resultA = await pending.savePendingJobs({
      pending: [{ job: shared, reason: "analysis_limit" }],
      resolvedKeys: [],
      runStartedAtIso: new Date(runStartA).toISOString(),
      nowMs: writeA,
    });

    const persisted = await readPending();
    assert.equal(persisted.length, 1);
    // A atualização de B permanece INTACTA: motivo e carimbo preservados, sem
    // regressão para o estado que A tentou gravar.
    assert.equal(persisted[0].reason, "notification_limit");
    assert.equal(Date.parse(persisted[0].updatedAt), updateB);

    // A reconciliação de A manteve a pendência (não a removeu nem a sobrescreveu).
    assert.equal(resultA.kept, 1);
  });
});

test("valida registro do PostgreSQL com o mesmo rigor do JSON (sem conexão real)", async () => {
  const iso = new Date().toISOString();
  const validRow = {
    key: "pending-test:pg",
    job: job({ id: "pg" }),
    reason: "analysis_limit",
    first_seen_at: iso,
    updated_at: iso,
  };

  // Linha válida (timestamps como string) é aceita.
  const record = pending.rowToPendingRecord(validRow);
  assert.ok(record);
  assert.equal(record.key, "pending-test:pg");
  assert.equal(record.reason, "analysis_limit");

  // Aceita também timestamps como Date (retornados pelo driver do PostgreSQL).
  assert.ok(
    pending.rowToPendingRecord({
      ...validRow,
      first_seen_at: new Date(iso),
      updated_at: new Date(iso),
    }),
  );

  // Chave incoerente com a vaga (source:id): rejeitada.
  assert.equal(
    pending.rowToPendingRecord({ ...validRow, key: "outro:chave" }),
    undefined,
  );

  // Motivo não permitido: rejeitado.
  assert.equal(
    pending.rowToPendingRecord({ ...validRow, reason: "desconhecido" }),
    undefined,
  );

  // Objeto Job inválido (falta os campos essenciais): rejeitado.
  assert.equal(
    pending.rowToPendingRecord({ ...validRow, job: { id: "so-id" } }),
    undefined,
  );

  // Datas inválidas: rejeitadas (string não parseável e Date inválido).
  assert.equal(
    pending.rowToPendingRecord({ ...validRow, updated_at: "nao-e-data" }),
    undefined,
  );
  assert.equal(
    pending.rowToPendingRecord({
      ...validRow,
      first_seen_at: new Date("invalido"),
    }),
    undefined,
  );
});
