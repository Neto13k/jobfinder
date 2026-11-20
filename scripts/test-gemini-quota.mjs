// Testes determinísticos do controle de cota do Gemini (gemini-quota.ts).
//
// Uso:   npm run build
//        node scripts/test-gemini-quota.mjs
//
// Roda em diretório temporário (backend JSON), sem rede, sem Gemini e sem
// Telegram. Valida: (1) a configuração por ambiente e os TETOS operacionais
// (450 RPD, 250k TPM, intervalo mínimo de 6 s em produção); (2) a virada do dia
// de cota e da janela de tokens à meia-noite no fuso America/Los_Angeles;
// (3) a distribuição do orçamento diário entre as execuções e o limite de vagas
// por lote; (4) o intervalo mínimo entre requisições; (5) a reserva atômica
// (inclusive sob concorrência e entre GERENCIADORES) e o esgotamento da cota;
// (6) o controle conservador de TOKENS por minuto (TPM); (7) a interrupção de
// novas chamadas quando a cota, os tokens, o TEMPO (contado desde o início do
// pipeline) esgotam ou o controle falha; (8) o intervalo mínimo compartilhado
// na VIRADA do dia de cota (inclusive entre gerenciadores); (9) a revalidação do
// orçamento de TEMPO a cada tentativa, inclusive após uma espera.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();

// Backend JSON (padrão) no diretório temporário; nenhuma variável de cota
// definida, para exercitar os padrões.
delete process.env.JOBFINDER_STORAGE;
delete process.env.JOBFINDER_GEMINI_DAILY_QUOTA;
delete process.env.JOBFINDER_GEMINI_EXECUTIONS_PER_DAY;
delete process.env.JOBFINDER_GEMINI_MIN_INTERVAL_MS;
delete process.env.JOBFINDER_GEMINI_TPM_LIMIT;
delete process.env.JOBFINDER_GEMINI_TIME_BUDGET_MS;

const quota = await import("../dist/services/gemini-quota.js");
const { GeminiAnalysisError } = await import("../dist/services/ai-analyzer.js");

const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-quota-"));
process.chdir(tempDir);

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

/** Cria um diretório temporário isolado e executa a tarefa nele. */
async function withTempDir(task) {
  const dir = await mkdtemp(join(tmpdir(), "jobfinder-quota-sub-"));
  process.chdir(dir);
  try {
    await task();
  } finally {
    process.chdir(tempDir);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Verifica que a chamada lança GeminiAnalysisError da categoria informada. */
async function expectQuotaError(fn, kind) {
  await assert.rejects(fn, (error) => {
    assert.ok(
      error instanceof GeminiAnalysisError,
      "deve lançar GeminiAnalysisError",
    );
    assert.equal(error.kind, kind);
    return true;
  });
}

/** Lê os registros de cota persistidos no JSON (vazio quando ausente). */
async function readQuotaRecords() {
  const content = await readFile(
    join(process.cwd(), "data", "gemini-quota.json"),
    "utf8",
  );
  return JSON.parse(content);
}

/** Parâmetros de reserva com os campos sobrepostos. */
function reserveParams(overrides) {
  return {
    quotaDay: "2026-11-20",
    dailyLimit: 3,
    nowIso: new Date(5000).toISOString(),
    minIntervalMs: 0,
    tokenMinute: "2026-11-20T00:00",
    tokens: 0,
    tpmLimit: 250000,
    ...overrides,
  };
}

test("resolveGeminiQuotaConfig usa padrões e aplica os tetos operacionais", () => {
  const defaults = quota.resolveGeminiQuotaConfig({});
  assert.equal(defaults.dailyQuota, 450);
  assert.equal(defaults.executionsPerDay, 24);
  assert.equal(defaults.minIntervalMs, 6000);
  assert.equal(defaults.tpmLimit, 250000);
  assert.equal(defaults.timeBudgetMs, 8 * 60 * 1000);
  assert.equal(defaults.timeZone, "America/Los_Angeles");

  // Valores válidos DENTRO dos tetos são respeitados; 0 desativa o intervalo.
  const custom = quota.resolveGeminiQuotaConfig({
    JOBFINDER_GEMINI_DAILY_QUOTA: "300",
    JOBFINDER_GEMINI_EXECUTIONS_PER_DAY: "12",
    JOBFINDER_GEMINI_MIN_INTERVAL_MS: "0",
    JOBFINDER_GEMINI_TPM_LIMIT: "100000",
    JOBFINDER_GEMINI_TIME_BUDGET_MS: "60000",
  });
  assert.equal(custom.dailyQuota, 300);
  assert.equal(custom.executionsPerDay, 12);
  assert.equal(custom.minIntervalMs, 0);
  assert.equal(custom.tpmLimit, 100000);
  assert.equal(custom.timeBudgetMs, 60000);

  // Tetos operacionais seguros: 450 RPD e 250k TPM.
  const capped = quota.resolveGeminiQuotaConfig({
    JOBFINDER_GEMINI_DAILY_QUOTA: "1000",
    JOBFINDER_GEMINI_TPM_LIMIT: "500000",
  });
  assert.equal(capped.dailyQuota, 450);
  assert.equal(capped.tpmLimit, 250000);

  // Em produção, o intervalo mínimo é elevado ao piso de 6 s.
  const production = quota.resolveGeminiQuotaConfig({
    NODE_ENV: "production",
    JOBFINDER_GEMINI_MIN_INTERVAL_MS: "0",
  });
  assert.equal(production.minIntervalMs, 6000);

  // Inválidos recorrem ao padrão (inclusive "0" para a cota diária).
  const invalid = quota.resolveGeminiQuotaConfig({
    JOBFINDER_GEMINI_DAILY_QUOTA: "0",
    JOBFINDER_GEMINI_EXECUTIONS_PER_DAY: "abc",
    JOBFINDER_GEMINI_MIN_INTERVAL_MS: "-3",
    JOBFINDER_GEMINI_TPM_LIMIT: "10.5",
    JOBFINDER_GEMINI_TIME_BUDGET_MS: "3.5",
  });
  assert.equal(invalid.dailyQuota, 450);
  assert.equal(invalid.executionsPerDay, 24);
  assert.equal(invalid.minIntervalMs, 6000);
  assert.equal(invalid.tpmLimit, 250000);
  assert.equal(invalid.timeBudgetMs, 8 * 60 * 1000);
});

test("quotaDayFor e quotaMinuteFor usam o fuso America/Los_Angeles", () => {
  // Novembro é PST (UTC-8): a virada do dia ocorre às 08:00 UTC.
  assert.equal(
    quota.quotaDayFor(new Date("2026-11-20T07:59:59Z")),
    "2026-11-19",
  );
  assert.equal(
    quota.quotaDayFor(new Date("2026-11-20T08:00:00Z")),
    "2026-11-20",
  );
  assert.equal(quota.QUOTA_TIME_ZONE, "America/Los_Angeles");

  // Janela de minuto (TPM): reinicia a cada minuto local.
  assert.equal(
    quota.quotaMinuteFor(new Date("2026-11-20T08:00:00Z")),
    "2026-11-20T00:00",
  );
  assert.equal(
    quota.quotaMinuteFor(new Date("2026-11-20T08:00:59Z")),
    "2026-11-20T00:00",
  );
  assert.equal(
    quota.quotaMinuteFor(new Date("2026-11-20T08:01:00Z")),
    "2026-11-20T00:01",
  );
});

test("planExecutionAllowance distribui o saldo e reaproveita o não utilizado", () => {
  // 450 requisições em 24 execuções: cada uma pode gastar 19.
  assert.equal(
    quota.planExecutionAllowance({
      dailyQuota: 450,
      used: 0,
      previouslyStartedExecutions: 0,
      executionsPerDay: 24,
    }),
    19,
  );

  // Saldo não utilizado é absorvido: se nada foi gasto, a 2ª execução pode 20.
  assert.equal(
    quota.planExecutionAllowance({
      dailyQuota: 450,
      used: 0,
      previouslyStartedExecutions: 1,
      executionsPerDay: 24,
    }),
    20,
  );

  // Cota esgotada: orçamento 0.
  assert.equal(
    quota.planExecutionAllowance({
      dailyQuota: 450,
      used: 450,
      previouslyStartedExecutions: 10,
      executionsPerDay: 24,
    }),
    0,
  );

  // Nunca divide por zero, mesmo além do total previsto de execuções.
  assert.equal(
    quota.planExecutionAllowance({
      dailyQuota: 10,
      used: 0,
      previouslyStartedExecutions: 24,
      executionsPerDay: 24,
    }),
    10,
  );
});

test("planJobBudget converte requisições em vagas conforme o lote", () => {
  assert.equal(quota.planJobBudget(19, 5), 95);
  assert.equal(quota.planJobBudget(0, 5), 0);
  assert.equal(quota.planJobBudget(5, 0), 0);
  assert.equal(quota.planJobBudget(-1, 5), 0);
});

test("computeDelayMs respeita o intervalo mínimo desde a última requisição", () => {
  const last = new Date(1000).toISOString();
  assert.equal(quota.computeDelayMs(null, 5000, 6000), 0);
  assert.equal(quota.computeDelayMs(last, 2000, 6000), 5000);
  assert.equal(quota.computeDelayMs(last, 7000, 6000), 0);
  assert.equal(quota.computeDelayMs(last, 2000, 0), 0);
  assert.equal(quota.computeDelayMs("invalido", 2000, 6000), 0);
});

test("registerExecutionStart e reserveQuotaRequest controlam o dia no JSON", async () => {
  await withTempDir(async () => {
    const day = "2026-11-20";
    const started = await quota.registerExecutionStart(day);
    assert.equal(started.used, 0);
    assert.equal(started.executions, 1);

    // Segunda execução no mesmo dia incrementa as execuções sem zerar o usado.
    const second = await quota.registerExecutionStart(day);
    assert.equal(second.executions, 2);
    assert.equal(second.used, 0);

    const base = reserveParams({ quotaDay: day, dailyLimit: 3 });
    assert.equal((await quota.reserveQuotaRequest(base)).granted, true);
    assert.equal((await quota.reserveQuotaRequest(base)).granted, true);
    assert.equal((await quota.reserveQuotaRequest(base)).granted, true);
    // Quarta reserva com limite 3: recusada (cota do dia esgotada).
    const refused = await quota.reserveQuotaRequest(base);
    assert.equal(refused.granted, false);
    assert.equal(refused.reason, "quota");
    assert.equal(refused.used, 3);
  });
});

test("reserva atômica nunca ultrapassa a cota sob requisições concorrentes", async () => {
  await withTempDir(async () => {
    const day = "2026-11-20";
    await quota.registerExecutionStart(day);

    const base = reserveParams({
      quotaDay: day,
      dailyLimit: 3,
      nowIso: new Date(9000).toISOString(),
    });
    const results = await Promise.all(
      Array.from({ length: 16 }, () => quota.reserveQuotaRequest(base)),
    );

    // A serialização (withStorageLock) garante exatamente o limite concedido.
    assert.equal(results.filter((result) => result.granted).length, 3);
  });
});

test("controle de tokens por minuto recusa o excesso e reinicia na nova janela", async () => {
  await withTempDir(async () => {
    const day = "2026-11-20";
    await quota.registerExecutionStart(day);

    const base = reserveParams({
      quotaDay: day,
      dailyLimit: 10,
      nowIso: new Date(5000).toISOString(),
      tokens: 60,
      tpmLimit: 100,
    });

    // 60 <= 100: concedida.
    const first = await quota.reserveQuotaRequest(base);
    assert.equal(first.granted, true);
    assert.equal(first.tokensUsed, 60);

    // 120 > 100 na MESMA janela: recusada por tokens (não por cota/intervalo).
    const refused = await quota.reserveQuotaRequest(base);
    assert.equal(refused.granted, false);
    assert.equal(refused.reason, "tokens");
    assert.equal(refused.used, 1);

    // Nova janela de minuto reinicia o consumo de tokens.
    const nextWindow = { ...base, tokenMinute: "2026-11-20T00:01" };
    const granted = await quota.reserveQuotaRequest(nextWindow);
    assert.equal(granted.granted, true);
    assert.equal(granted.tokensUsed, 60);
  });
});

test("gerenciadores concorrentes respeitam a cota diária compartilhada", async () => {
  await withTempDir(async () => {
    const config = {
      dailyQuota: 3,
      executionsPerDay: 1,
      minIntervalMs: 0,
      tpmLimit: 250000,
      timeBudgetMs: 8 * 60 * 1000,
      timeZone: quota.QUOTA_TIME_ZONE,
    };
    const managers = await Promise.all(
      Array.from({ length: 5 }, () =>
        quota.createGeminiQuotaManager({
          batchSize: 1,
          config,
          now: () => 1000,
        }),
      ),
    );

    // Cinco execuções simultâneas disputam a MESMA cota diária (3): apenas três
    // conseguem reservar; a reserva atômica compartilhada impede o excesso.
    const results = await Promise.all(
      managers.map((manager) =>
        manager
          .acquire()
          .then(() => true)
          .catch(() => false),
      ),
    );
    assert.equal(results.filter(Boolean).length, 3);

    // Qualquer tentativa extra é recusada (cota diária esgotada).
    await expectQuotaError(() => managers[0].acquire(), "rate_limit");
  });
});

test("virada da meia-noite revalida o dia da cota antes de reservar", async () => {
  await withTempDir(async () => {
    // Começa pouco antes da meia-noite de LA (dia A = 2026-11-19).
    let clock = Date.parse("2026-11-20T07:58:00Z");
    const config = {
      dailyQuota: 2,
      executionsPerDay: 1,
      minIntervalMs: 0,
      tpmLimit: 250000,
      timeBudgetMs: 8 * 60 * 1000,
      timeZone: quota.QUOTA_TIME_ZONE,
    };
    const manager = await quota.createGeminiQuotaManager({
      batchSize: 1,
      config,
      now: () => clock,
    });
    assert.equal(manager.snapshot.quotaDay, "2026-11-19");

    await manager.acquire(); // dia A: used 1

    // Avança para depois da meia-noite de LA (08:00 UTC): o dia muda para B.
    clock = Date.parse("2026-11-20T08:00:01Z");
    await manager.acquire(); // revalida o dia e reserva no dia B, não no dia A

    const records = await readQuotaRecords();
    const dayA = records.find((record) => record.quotaDay === "2026-11-19");
    const dayB = records.find((record) => record.quotaDay === "2026-11-20");
    // A cota é contabilizada de forma independente por dia.
    assert.equal(dayA.used, 1);
    assert.equal(dayB.used, 1);
  });
});

test("GeminiQuotaManager concede o orçamento e para ao esgotá-lo", async () => {
  await withTempDir(async () => {
    const config = {
      dailyQuota: 3,
      executionsPerDay: 1,
      minIntervalMs: 0,
      tpmLimit: 250000,
      timeBudgetMs: 8 * 60 * 1000,
      timeZone: quota.QUOTA_TIME_ZONE,
    };
    const manager = await quota.createGeminiQuotaManager({
      batchSize: 2,
      config,
      now: () => 1000,
    });

    // Orçamento = ceil(3/1) = 3 requisições; vagas = 3 × 2 = 6.
    assert.equal(manager.snapshot.allowance, 3);
    assert.equal(manager.snapshot.jobBudget, 6);
    assert.equal(manager.snapshot.tpmLimit, 250000);

    await manager.acquire();
    await manager.acquire();
    await manager.acquire();
    assert.equal(manager.requestsConsumed, 3);

    // Orçamento da execução esgotado: interrompe novas chamadas.
    await expectQuotaError(() => manager.acquire(), "rate_limit");
  });
});

test("GeminiQuotaManager para quando a cota DIÁRIA esgota", async () => {
  await withTempDir(async () => {
    const config = {
      dailyQuota: 2,
      executionsPerDay: 1,
      minIntervalMs: 0,
      tpmLimit: 250000,
      timeBudgetMs: 8 * 60 * 1000,
      timeZone: quota.QUOTA_TIME_ZONE,
    };
    const manager = await quota.createGeminiQuotaManager({
      batchSize: 5,
      config,
      now: () => 1000,
    });
    const day = manager.snapshot.quotaDay;

    // Consome a cota diária por fora (simula execuções anteriores/simultâneas).
    const base = reserveParams({ quotaDay: day, dailyLimit: 2 });
    assert.equal((await quota.reserveQuotaRequest(base)).granted, true);
    assert.equal((await quota.reserveQuotaRequest(base)).granted, true);

    // O orçamento da execução (2) ainda permitiria, mas a cota do dia acabou.
    await assert.rejects(() => manager.acquire(), (error) => {
      assert.ok(error instanceof GeminiAnalysisError);
      assert.equal(error.kind, "rate_limit");
      assert.match(error.message, /Cota diária/);
      return true;
    });
  });
});

test("GeminiQuotaManager para quando os TOKENS por minuto esgotam", async () => {
  await withTempDir(async () => {
    const config = {
      dailyQuota: 10,
      executionsPerDay: 1,
      minIntervalMs: 0,
      tpmLimit: 100,
      timeBudgetMs: 8 * 60 * 1000,
      timeZone: quota.QUOTA_TIME_ZONE,
    };
    const manager = await quota.createGeminiQuotaManager({
      batchSize: 5,
      config,
      now: () => 1000,
    });

    // Consome os tokens da janela de minuto com uma reserva grande o bastante
    // para esgotar o limite de 100 TPM.
    await manager.acquire(60);

    // Outra requisição grande excede os 100 TPM da janela: interrompe chamadas.
    await assert.rejects(() => manager.acquire(60), (error) => {
      assert.ok(error instanceof GeminiAnalysisError);
      assert.equal(error.kind, "rate_limit");
      assert.match(error.message, /tokens/i);
      return true;
    });
  });
});

test("GeminiQuotaManager respeita o intervalo mínimo entre requisições", async () => {
  await withTempDir(async () => {
    let clock = 1000;
    const sleeps = [];
    const config = {
      dailyQuota: 10,
      executionsPerDay: 1,
      minIntervalMs: 6000,
      tpmLimit: 250000,
      timeBudgetMs: 8 * 60 * 1000,
      timeZone: quota.QUOTA_TIME_ZONE,
    };
    const manager = await quota.createGeminiQuotaManager({
      batchSize: 5,
      config,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    await manager.acquire();
    // 2 s após a primeira requisição: faltam 4 s para o intervalo de 6 s.
    clock = 3000;
    await manager.acquire();

    assert.deepEqual(sleeps, [4000]);
  });
});

test("GeminiQuotaManager interrompe as chamadas quando o controle falha", async () => {
  await withTempDir(async () => {
    // Controle de cota corrompido: o início falha, mas a execução não cai.
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    await writeFile(
      join(process.cwd(), "data", "gemini-quota.json"),
      "corrompido",
      "utf8",
    );

    const manager = await quota.createGeminiQuotaManager({ batchSize: 5 });

    // Orçamento nulo e nenhuma chamada permitida (categoria "unavailable").
    assert.equal(manager.snapshot.jobBudget, 0);
    await expectQuotaError(() => manager.acquire(), "unavailable");
  });
});

test("orçamento de tempo conta desde o INÍCIO do pipeline (coleta e espera)", async () => {
  await withTempDir(async () => {
    const config = {
      dailyQuota: 100,
      executionsPerDay: 1,
      minIntervalMs: 0,
      tpmLimit: 250000,
      timeBudgetMs: 8 * 60 * 1000,
      timeZone: quota.QUOTA_TIME_ZONE,
    };

    // O pipeline começou em 0; já se passaram 440 s. Somados à margem de 45 s,
    // ultrapassa o orçamento de 8 min (480 s): nenhuma nova chamada é permitida.
    const withPipelineStart = await quota.createGeminiQuotaManager({
      batchSize: 5,
      config,
      pipelineStartedAtMs: 0,
      now: () => 440_000,
    });
    await expectQuotaError(() => withPipelineStart.acquire(), "rate_limit");

    // Sem o instante de início do pipeline, o orçamento começa na criação do
    // gerenciador: o mesmo instante ainda cabe no orçamento e a chamada é aceita.
    const analysisOnly = await quota.createGeminiQuotaManager({
      batchSize: 5,
      config,
      now: () => 440_000,
    });
    await analysisOnly.acquire();
    assert.equal(analysisOnly.requestsConsumed, 1);
  });
});

test("intervalo mínimo compartilhado permanece válido na VIRADA do dia", async () => {
  // Novembro é PST (UTC-8): 07:59:59Z ainda é o dia A (2026-11-19); 08:00:01Z já
  // é o dia B (2026-11-20).
  const lastDayA = Date.parse("2026-11-20T07:59:59Z");
  const iso = (ms) => new Date(ms).toISOString();

  await withTempDir(async () => {
    // Última requisição do dia A.
    const first = await quota.reserveQuotaRequest(
      reserveParams({
        quotaDay: "2026-11-19",
        dailyLimit: 5,
        nowIso: iso(lastDayA),
        minIntervalMs: 6000,
      }),
    );
    assert.equal(first.granted, true);

    // Já no dia B, 2 s depois: o intervalo de 6 s ainda não passou. Um controle
    // por dia (registro do dia B vazio) zeraria o intervalo; deve recusar.
    const withinInterval = await quota.reserveQuotaRequest(
      reserveParams({
        quotaDay: "2026-11-20",
        dailyLimit: 5,
        nowIso: iso(lastDayA + 2000),
        minIntervalMs: 6000,
      }),
    );
    assert.equal(withinInterval.granted, false);
    assert.equal(withinInterval.reason, "interval");

    // Passados os 6 s desde a última requisição, o dia B é liberado.
    const afterInterval = await quota.reserveQuotaRequest(
      reserveParams({
        quotaDay: "2026-11-20",
        dailyLimit: 5,
        nowIso: iso(lastDayA + 6000),
        minIntervalMs: 6000,
      }),
    );
    assert.equal(afterInterval.granted, true);
  });

  await withTempDir(async () => {
    // Verificação entre gerenciadores: a 2ª chamada, já no dia B, aguarda o
    // intervalo restante contado a partir da requisição do dia A.
    let clock = lastDayA;
    const sleeps = [];
    const config = {
      dailyQuota: 10,
      executionsPerDay: 1,
      minIntervalMs: 6000,
      tpmLimit: 250000,
      timeBudgetMs: 8 * 60 * 1000,
      timeZone: quota.QUOTA_TIME_ZONE,
    };
    const manager = await quota.createGeminiQuotaManager({
      batchSize: 1,
      config,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    await manager.acquire(); // dia A: registra a requisição
    // 2 s depois, já no dia B: deve aguardar os 4 s restantes do intervalo.
    clock = Date.parse("2026-11-20T08:00:01Z");
    await manager.acquire();
    assert.deepEqual(sleeps, [4000]);

    const records = await readQuotaRecords();
    const dayA = records.find((record) => record.quotaDay === "2026-11-19");
    const dayB = records.find((record) => record.quotaDay === "2026-11-20");
    assert.equal(dayA.used, 1);
    assert.equal(dayB.used, 1);
  });
});

test("orçamento de tempo é revalidado a cada tentativa, inclusive após espera", async () => {
  await withTempDir(async () => {
    const budget = 8 * 60 * 1000; // 480 s
    const margin = quota.CALL_RESERVE_MS; // 45 s reservados para a chamada
    // O pipeline começou em 0. Posiciona o relógio de modo que a 1ª chamada
    // caiba no orçamento, mas a espera do intervalo empurre a 2ª tentativa para
    // além do orçamento somado à margem.
    let clock = budget - margin - 35_000; // 400000 ms
    const sleeps = [];
    const config = {
      dailyQuota: 10,
      executionsPerDay: 1,
      minIntervalMs: 60_000, // 60 s: força uma espera longa
      tpmLimit: 250000,
      timeBudgetMs: budget,
      timeZone: quota.QUOTA_TIME_ZONE,
    };
    const manager = await quota.createGeminiQuotaManager({
      batchSize: 1,
      config,
      pipelineStartedAtMs: 0,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    // 1ª chamada dentro do orçamento (400000 + 45000 = 445000 <= 480000).
    await manager.acquire();
    assert.equal(manager.requestsConsumed, 1);

    // 2ª chamada: o intervalo de 60 s obriga uma espera; a próxima tentativa
    // cai em 460000 ms e, somada à margem (505000 > 480000), excede o orçamento.
    // O orçamento é revalidado ANTES da nova tentativa: a chamada é recusada.
    await assert.rejects(() => manager.acquire(), (error) => {
      assert.ok(error instanceof GeminiAnalysisError);
      assert.equal(error.kind, "rate_limit");
      assert.match(error.message, /tempo/i);
      return true;
    });
    assert.deepEqual(sleeps, [60_000]);
  });
});
