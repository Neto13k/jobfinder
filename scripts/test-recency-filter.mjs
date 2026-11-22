// Testes determinísticos do filtro de recência (JOBFINDER_RECENCY_CUTOFF_DAYS).
//
// Uso:   npm run build
//        node scripts/test-recency-filter.mjs
//
// Roda sem rede nem estado externo. As funções de recência são puras; o teste
// de integração executa o pipeline com dependências falsas em diretório
// temporário, sem Gemini, Supabase ou Telegram. Cobre datas válidas, antigas,
// ausentes e inválidas, datas futuras, fusos horários, o limite estrito, a
// preservação de vagas sem data e a exclusão antes da análise.

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
delete process.env.JOBFINDER_RECENCY_CUTOFF_DAYS;
process.env.JOBFINDER_MAX_ANALYSES = "5";

const { runPipeline } = await import("../dist/index.js");
const { buildAuditReport } = await import("../dist/services/audit-report.js");
const { generateJobKey } = await import("../dist/services/deduplication.js");
const {
  classifyJobRecency,
  filterByRecency,
  recencyDiscardReason,
  resolveRecencyCutoffDays,
} = await import("../dist/services/recency-filter.js");

const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-recency-"));
process.chdir(tempDir);

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

/** Instante de referência fixo para tornar a recência determinística. */
const REFERENCE = new Date("2026-11-19T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO de N dias antes da referência. */
function daysBefore(days) {
  return new Date(REFERENCE.getTime() - days * DAY_MS).toISOString();
}

/** ISO de N horas antes da referência. */
function hoursBefore(hours) {
  return new Date(REFERENCE.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/** Monta uma vaga mínima com os campos sobrepostos. */
function job(overrides) {
  return {
    id: "1",
    title: "Desenvolvedor Júnior",
    company: "Empresa",
    location: "Remoto - Brasil",
    remote: true,
    description: "",
    url: "https://example.com",
    source: "recency-test",
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

/** Cria um diretório temporário isolado e executa a tarefa nele. */
async function withTempDir(task) {
  const dir = await mkdtemp(join(tmpdir(), "jobfinder-recency-sub-"));
  process.chdir(dir);
  try {
    await task();
  } finally {
    process.chdir(tempDir);
    await rm(dir, { recursive: true, force: true });
  }
}

// --- 1. Configuração -------------------------------------------------------

test("configuração: JOBFINDER_RECENCY_CUTOFF_DAYS usa 30 dias como padrão seguro", () => {
  assert.equal(resolveRecencyCutoffDays(undefined), 30);
  assert.equal(resolveRecencyCutoffDays(""), 30);
  assert.equal(resolveRecencyCutoffDays("   "), 30);
  assert.equal(resolveRecencyCutoffDays("abc"), 30);
  assert.equal(resolveRecencyCutoffDays("-5"), 30);
  assert.equal(resolveRecencyCutoffDays("0"), 30);
});

test("configuração: aceita inteiro positivo e ignora espaços ao redor", () => {
  assert.equal(resolveRecencyCutoffDays("7"), 7);
  assert.equal(resolveRecencyCutoffDays(" 45 "), 45);
  assert.equal(resolveRecencyCutoffDays("365"), 365);
});

// --- 2. Classificação ------------------------------------------------------

test("recência: vaga recente fica dentro do limite padrão de 30 dias", () => {
  const assessment = classifyJobRecency(
    job({ publishedAt: daysBefore(10) }),
    REFERENCE,
    30,
  );
  assert.equal(assessment.classification, "recent");
  assert.equal(assessment.dateState, "valid");
  assert.equal(assessment.ageDays, 10);
});

test("recência: exatamente no limite ainda é recente (comparação estrita)", () => {
  const assessment = classifyJobRecency(
    job({ publishedAt: daysBefore(30) }),
    REFERENCE,
    30,
  );
  assert.equal(assessment.classification, "recent");
  assert.equal(assessment.ageDays, 30);
});

test("recência: pouco acima do limite é excluída", () => {
  const assessment = classifyJobRecency(
    job({ publishedAt: daysBefore(30).replace("12:00", "11:00") }),
    REFERENCE,
    30,
  );
  assert.equal(assessment.classification, "stale");
  assert.equal(assessment.dateState, "valid");
  assert.equal(assessment.ageDays, 31);
});

test("recência: vaga de 2024 é excluída com o limite padrão", () => {
  const assessment = classifyJobRecency(
    job({ publishedAt: "2024-06-01T00:00:00.000Z" }),
    REFERENCE,
  );
  assert.equal(assessment.classification, "stale");
});

test("recência: vaga sem data é preservada como desconhecida", () => {
  const missing = classifyJobRecency(job({ publishedAt: undefined }), REFERENCE);
  assert.equal(missing.classification, "unknown");
  assert.equal(missing.dateState, "missing");
  assert.equal(missing.ageDays, null);

  const empty = classifyJobRecency(job({ publishedAt: "" }), REFERENCE);
  assert.equal(empty.classification, "unknown");
  assert.equal(empty.dateState, "missing");
});

test("recência: data inválida é preservada como desconhecida", () => {
  const assessment = classifyJobRecency(
    job({ publishedAt: "data-invalida" }),
    REFERENCE,
  );
  assert.equal(assessment.classification, "unknown");
  assert.equal(assessment.dateState, "invalid");
  assert.equal(assessment.ageDays, null);
});

test("recência: data futura não é tratada como antiga nem como recente", () => {
  const future = new Date(REFERENCE.getTime() + 5 * DAY_MS).toISOString();
  const assessment = classifyJobRecency(job({ publishedAt: future }), REFERENCE);
  assert.equal(assessment.classification, "unknown");
  assert.equal(assessment.dateState, "invalid");
  assert.equal(assessment.ageDays, null);
});

test("recência: respeita o fuso horário explícito (offset -03:00)", () => {
  // 2026-11-16T12:00:00-03:00 == 2026-11-16T15:00:00Z → 69h antes da referência.
  const stale = classifyJobRecency(
    job({ publishedAt: "2026-11-16T12:00:00-03:00" }),
    REFERENCE,
    1,
  );
  assert.equal(stale.classification, "stale");

  // 2026-11-18T12:00:00-03:00 == 2026-11-18T15:00:00Z → 21h antes: recente.
  const recent = classifyJobRecency(
    job({ publishedAt: "2026-11-18T12:00:00-03:00" }),
    REFERENCE,
    1,
  );
  assert.equal(recent.classification, "recent");
});

test("recência: aceita data somente-dia (ISO sem hora)", () => {
  // 2026-11-05 é 14 dias antes de 2026-11-19.
  const recent = classifyJobRecency(
    job({ publishedAt: "2026-11-05" }),
    REFERENCE,
    30,
  );
  assert.equal(recent.classification, "recent");
});

// --- 3. Filtro -------------------------------------------------------------

test("filtro: preserva recentes, sem data e inválidas, e exclui apenas as antigas", () => {
  const jobs = [
    job({ id: "antiga", publishedAt: daysBefore(365) }),
    job({ id: "recente", publishedAt: hoursBefore(1) }),
    job({ id: "sem-data", publishedAt: undefined }),
    job({ id: "invalida", publishedAt: "nao-e-data" }),
    job({ id: "futura", publishedAt: new Date(REFERENCE.getTime() + DAY_MS).toISOString() }),
  ];

  const result = filterByRecency(jobs, { referenceDate: REFERENCE, cutoffDays: 30 });

  assert.deepEqual(
    result.jobs.map((item) => item.id),
    ["recente", "sem-data", "invalida", "futura"],
  );
  assert.deepEqual(
    result.excluded.map((item) => item.id),
    ["antiga"],
  );
  assert.deepEqual(result.metrics, {
    checked: 5,
    stale: 1,
    missingDate: 1,
    invalidDate: 2,
  });
});

test("filtro: não altera o array nem as vagas originais", () => {
  const original = [
    job({ id: "a", publishedAt: daysBefore(60) }),
    job({ id: "b", publishedAt: hoursBefore(2) }),
  ];
  const snapshot = JSON.parse(JSON.stringify(original));

  const result = filterByRecency(original, { referenceDate: REFERENCE });

  assert.deepEqual(original, snapshot);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.excluded.length, 1);
});

// --- 4. Motivo de descarte -------------------------------------------------

test("motivo: vaga preservada não tem motivo de descarte", () => {
  assert.equal(
    recencyDiscardReason(job({ publishedAt: hoursBefore(1) }), REFERENCE, 30),
    null,
  );
  assert.equal(
    recencyDiscardReason(job({ publishedAt: undefined }), REFERENCE, 30),
    null,
  );
});

test("motivo: vaga antiga descreve a idade e o limite", () => {
  const reason = recencyDiscardReason(
    job({ publishedAt: daysBefore(90) }),
    REFERENCE,
    30,
  );
  assert.match(reason, /antiga/);
  assert.match(reason, /90 dia\(s\)/);
  assert.match(reason, /limite de 30 dia\(s\)/);
});

// --- 5. Integração com o relatório de auditoria ----------------------------

test("auditoria: vaga antiga é descartada na etapa de recência e não é aprovada", () => {
  const stale = job({ id: "antiga", publishedAt: "2024-01-01T00:00:00.000Z" });
  const kept = job({ id: "sem-data", publishedAt: undefined });

  const report = buildAuditReport([stale, kept], REFERENCE, 30);

  assert.equal(report.discarded.recency, 1);
  assert.equal(report.approved, 1);
  assert.deepEqual(report.recencyMetrics, {
    checked: 2,
    stale: 1,
    missingDate: 1,
    invalidDate: 0,
  });

  const entries = new Map(report.jobs.map((entry) => [entry.key, entry]));
  const staleEntry = entries.get(generateJobKey(stale));
  assert.equal(staleEntry.discardStage, "recency");
  assert.match(staleEntry.discardReason, /antiga/);
  assert.equal(staleEntry.queuePosition, null);

  const keptEntry = entries.get(generateJobKey(kept));
  assert.equal(keptEntry.discardStage, null);
  assert.equal(keptEntry.queuePosition, 1);
});

// --- 6. Integração com o pipeline ------------------------------------------

test("pipeline: vaga antiga é excluída antes da análise; a recente é analisada", async () => {
  await withTempDir(async () => {
    const stale = job({
      id: "antiga",
      publishedAt: daysBefore(120),
      url: "https://example.com/antiga",
    });
    const recent = job({
      id: "recente",
      publishedAt: hoursBefore(2),
      url: "https://example.com/recente",
    });

    const analyzed = [];
    const summary = await runPipeline([stale, recent], {
      referenceDate: REFERENCE,
      dependencies: {
        analyzeBatch: async (batchJobs) => {
          for (const item of batchJobs) {
            analyzed.push(item.id);
          }
          return new Map([[generateJobKey(batchJobs[0]), analysis()]]);
        },
        notify: async () => true,
      },
    });

    assert.ok(summary);
    assert.deepEqual(analyzed, ["recente"]);
    assert.equal(summary.analyzed, 1);
  });
});
