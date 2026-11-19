// Testes determinísticos do modo de auditoria (--audit-only).
//
// Uso:   npm run build
//        node scripts/test-audit-report.mjs
//
// Roda em diretório temporário, sem rede, sem Gemini, sem Supabase e sem
// Telegram: o relatório é montado a partir de vagas estáticas e as dependências
// de análise/notificação são falsas. Valida (1) a GERAÇÃO do relatório (contagens,
// etapa de descarte, classificação geográfica, posição na fila e integridade dos
// campos por vaga) e (2) a INTERRUPÇÃO do pipeline antes da análise no modo de
// auditoria, sem consultar nem gravar históricos.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();

// Configuração lida no carregamento do pipeline: precisa vir antes do import.
delete process.env.JOBFINDER_STORAGE;
delete process.env.JOBFINDER_SEND_NOTIFICATIONS;
delete process.env.JOBFINDER_SEND_REVIEWS;
process.env.JOBFINDER_MAX_ANALYSES = "1";

const { runPipeline } = await import("../dist/index.js");
const { buildAuditReport, runAudit } = await import(
  "../dist/services/audit-report.js"
);

const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-audit-"));
process.chdir(tempDir);

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

/** Instante de referência fixo para tornar a priorização determinística. */
const REFERENCE = new Date("2026-11-19T12:00:00.000Z");

/** Nome de arquivo esperado (ISO 8601 com ":" e "." substituídos por "-"). */
const EXPECTED_FILE = `${REFERENCE.toISOString().replace(/[:.]/g, "-")}.json`;

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
    source: "audit-test",
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

// Conjunto estático que exercita cada etapa: uma duplicata, um descarte por
// desenvolvimento, um por senioridade, um por localização e três aprovações.
const duplicate = job({
  source: "greenhouse",
  id: "dup",
  title: "Desenvolvedor Júnior",
  company: "Alpha",
  location: "Remoto - Brasil",
  remote: true,
  description: "Vaga remota para residentes no Brasil.",
  url: "https://alpha.example.com/jobs/dup",
  publishedAt: "2026-11-19T10:00:00.000Z",
});

const rawJobs = [
  duplicate,
  // Cópia idêntica: mesma chave "source:id", removida pela deduplicação.
  { ...duplicate },
  job({
    source: "lever",
    id: "mkt",
    title: "Analista de Marketing",
    company: "Beta",
    location: "Remoto - Brasil",
    url: "https://beta.example.com/jobs/mkt",
  }),
  job({
    source: "ashby",
    id: "senior",
    title: "Desenvolvedor Sênior",
    company: "Gamma",
    location: "Remoto - Brasil",
    url: "https://gamma.example.com/jobs/senior",
  }),
  job({
    source: "inhire",
    id: "us",
    title: "Desenvolvedor Júnior",
    company: "Delta",
    location: "New York, USA",
    remote: false,
    url: "https://delta.example.com/jobs/us",
  }),
  job({
    source: "linkedin",
    id: "ok1",
    title: "Desenvolvedor Júnior",
    company: "Epsilon",
    location: "Remoto - Brasil",
    remote: true,
    description: "Remoto.",
    url: "https://epsilon.example.com/jobs/ok1",
    publishedAt: "2026-11-19T11:00:00.000Z",
  }),
  job({
    source: "indeed",
    id: "ok2",
    title: "Frontend Developer",
    company: "Zeta",
    location: "Remoto",
    remote: false,
    url: "https://zeta.example.com/jobs/ok2",
  }),
];

/** Cria um diretório temporário isolado e executa a tarefa nele. */
async function withTempDir(task) {
  const dir = await mkdtemp(join(tmpdir(), "jobfinder-audit-sub-"));
  process.chdir(dir);
  try {
    await task();
  } finally {
    process.chdir(tempDir);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Falha quando o caminho existir no disco (deve estar ausente). */
async function assertMissing(path) {
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
}

test("relatório de auditoria registra todas as vagas únicas e o desfecho de cada etapa", () => {
  const report = buildAuditReport(rawJobs, REFERENCE);

  // Resumo agregado.
  assert.equal(report.generatedAt, REFERENCE.toISOString());
  assert.equal(report.totalCollected, 7);
  assert.equal(report.uniqueJobs, 6);
  assert.deepEqual(report.collectedByProvider, {
    greenhouse: 2,
    lever: 1,
    ashby: 1,
    inhire: 1,
    linkedin: 1,
    indeed: 1,
  });
  assert.equal(report.duplicates, 1);
  assert.deepEqual(report.discarded, { developer: 1, seniority: 1, location: 1 });
  assert.equal(report.approved, 3);
  assert.deepEqual(report.locationDistribution, {
    allowed: 3,
    blocked: 1,
    unknown: 0,
  });

  // Sem limite de exemplos: todas as vagas únicas entram no relatório.
  assert.equal(report.jobs.length, 6);

  // O relatório expõe apenas os campos previstos (nenhuma credencial/ambiente).
  assert.deepEqual(
    Object.keys(report).sort(),
    [
      "approved",
      "collectedByProvider",
      "discarded",
      "duplicates",
      "generatedAt",
      "jobs",
      "locationDistribution",
      "totalCollected",
      "uniqueJobs",
    ].sort(),
  );

  const byKey = new Map(report.jobs.map((entry) => [entry.key, entry]));

  // Aprovada: sem descarte, classificada e posicionada na fila.
  const ok1 = byKey.get("linkedin:ok1");
  assert.equal(ok1.discardStage, null);
  assert.equal(ok1.locationClassification, "allowed");
  assert.equal(ok1.queuePosition, 1);
  assert.equal(ok1.description, "Remoto.");
  assert.equal(ok1.url, "https://epsilon.example.com/jobs/ok1");
  // Data conhecida é preservada integralmente.
  assert.equal(ok1.publishedAt, "2026-11-19T11:00:00.000Z");
  assert.deepEqual(
    Object.keys(ok1).sort(),
    [
      "additionalLocations",
      "company",
      "contractTypes",
      "description",
      "discardStage",
      "id",
      "key",
      "location",
      "locationClassification",
      "publishedAt",
      "queuePosition",
      "remote",
      "source",
      "title",
      "url",
      "workplaceType",
    ].sort(),
  );

  // Campos estruturados ausentes (a vaga é estática) viram null/[] com a chave
  // presente, preservando a paridade entre memória e disco.
  assert.equal(ok1.workplaceType, null);
  assert.deepEqual(ok1.contractTypes, []);
  assert.deepEqual(ok1.additionalLocations, []);

  const dup = byKey.get("greenhouse:dup");
  assert.equal(dup.discardStage, null);
  assert.equal(dup.locationClassification, "allowed");
  assert.equal(dup.queuePosition, 2);
  assert.equal(dup.description, "Vaga remota para residentes no Brasil.");
  // Data conhecida é preservada integralmente.
  assert.equal(dup.publishedAt, "2026-11-19T10:00:00.000Z");

  const ok2 = byKey.get("indeed:ok2");
  assert.equal(ok2.discardStage, null);
  assert.equal(ok2.locationClassification, "allowed");
  assert.equal(ok2.queuePosition, 3);
  // Data ausente é representada como null, e a chave permanece presente.
  assert.equal(ok2.publishedAt, null);

  // Descartada no filtro de desenvolvimento: não chega à classificação geográfica.
  const mkt = byKey.get("lever:mkt");
  assert.equal(mkt.discardStage, "developer");
  assert.equal(mkt.locationClassification, null);
  assert.equal(mkt.queuePosition, null);

  const senior = byKey.get("ashby:senior");
  assert.equal(senior.discardStage, "seniority");
  assert.equal(senior.locationClassification, null);
  assert.equal(senior.queuePosition, null);

  // Descartada por localização: classificada como bloqueada, fora da fila.
  const us = byKey.get("inhire:us");
  assert.equal(us.discardStage, "location");
  assert.equal(us.locationClassification, "blocked");
  assert.equal(us.queuePosition, null);
});

test("runAudit grava o relatório em data/audit identificado pela data e hora", async () => {
  await withTempDir(async () => {
    const { report, filePath } = await runAudit(rawJobs, {
      referenceDate: REFERENCE,
    });

    // Caminho padrão: <cwd>/data/audit/<timestamp ISO sanitizado>.json
    assert.equal(
      filePath,
      join(process.cwd(), "data", "audit", EXPECTED_FILE),
    );

    const content = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(content, report);

    // Data conhecida sobrevive à serialização como string.
    const writtenOk1 = content.jobs.find((entry) => entry.key === "linkedin:ok1");
    assert.equal(writtenOk1.publishedAt, "2026-11-19T11:00:00.000Z");

    // Data ausente é gravada como null (chave presente), e não omitida.
    const writtenOk2 = content.jobs.find((entry) => entry.key === "indeed:ok2");
    assert.equal(writtenOk2.publishedAt, null);
    assert.ok(
      Object.prototype.hasOwnProperty.call(writtenOk2, "publishedAt"),
      "a chave publishedAt deve permanecer presente no JSON gravado",
    );
  });
});

test("modo de auditoria grava o relatório e interrompe antes da análise", async () => {
  await withTempDir(async () => {
    let analyzeCalls = 0;
    let notifyCalls = 0;

    const result = await runPipeline(rawJobs, {
      auditOnly: true,
      referenceDate: REFERENCE,
      dependencies: {
        analyze: async () => {
          analyzeCalls++;
          throw new Error("a análise não deveria ser chamada na auditoria");
        },
        notify: async () => {
          notifyCalls++;
          return true;
        },
      },
    });

    // Encerra antes da análise e sem notificar.
    assert.equal(result, null);
    assert.equal(analyzeCalls, 0);
    assert.equal(notifyCalls, 0);

    // Relatório gravado no diretório padrão (data/audit), um arquivo por execução.
    const files = await readdir(join(process.cwd(), "data", "audit"));
    assert.deepEqual(files, [EXPECTED_FILE]);

    // Nem o histórico de análises nem o de notificações são consultados/gravados.
    await assertMissing(join(process.cwd(), "data", "analyzed-jobs.json"));
    await assertMissing(join(process.cwd(), "data", "notified-jobs.json"));
  });
});

test("execução normal segue analisando e não é afetada pelo modo de auditoria", async () => {
  await withTempDir(async () => {
    let analyzeCalls = 0;

    const summary = await runPipeline(rawJobs, {
      auditOnly: false,
      dependencies: {
        analyze: async () => {
          analyzeCalls++;
          return analysis({ score: 70 });
        },
        notify: async () => true,
      },
    });

    assert.ok(summary);
    assert.equal(analyzeCalls, 1);
    assert.equal(summary.analyzed, 1);
    assert.equal(summary.compatible, 1);

    // Nenhum relatório de auditoria é gravado fora do modo de auditoria.
    await assert.rejects(readdir(join(process.cwd(), "data", "audit")), {
      code: "ENOENT",
    });
  });
});
