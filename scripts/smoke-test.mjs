// Smoke test de integração do JobFinder MVP 1.0.
//
// Uso:    npx tsx scripts/smoke-test.mjs
// Envio real ao Telegram somente com JOBFINDER_SMOKE_SEND=true.
//
// O teste roda em um diretório temporário, sem tocar no histórico real do projeto.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Interrompe o teste com uma mensagem clara quando a condição falhar. */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`[smoke-test] ${message}`);
  }
}

// Vaga fictícia, claramente identificada como TESTE.
const testJob = {
  id: "smoke-test-001",
  title: "TESTE — Desenvolvedor Full Stack Júnior",
  company: "TESTE JobFinder",
  location: "Remoto - Brasil",
  remote: true,
  description: [
    "Vaga fictícia usada apenas no teste de integração (TESTE).",
    "Buscamos pessoa desenvolvedora full stack júnior.",
    "Tecnologias: React, TypeScript, Node.js e PostgreSQL.",
    "Contratação: CLT. Modalidade: remoto, candidatos no Brasil.",
  ].join(" "),
  url: "https://example.com/smoke-test",
  source: "smoke-test",
};

const originalCwd = process.cwd();
const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-smoke-"));

try {
  // O diretório temporário precisa virar o cwd ANTES de importar os serviços que
  // calculam o caminho do histórico com process.cwd().
  process.chdir(tempDir);
  console.log(`Histórico temporário: ${tempDir}`);

  const { deduplicateJobs, isJobNotified, markJobAsNotified } = await import(
    "../dist/services/deduplication.js"
  );
  const { getAnalyzedJob, markJobAsAnalyzed } = await import(
    "../dist/services/analysis-history.js"
  );
  const { filterDeveloperJobs } = await import("../dist/services/job-filter.js");
  const { filterBySeniority } = await import(
    "../dist/services/seniority-filter.js"
  );
  const { filterByLocation } = await import(
    "../dist/services/location-filter.js"
  );
  const { analyzeJob } = await import("../dist/services/ai-analyzer.js");
  const { sendJobNotification } = await import("../dist/services/telegram.js");

  // 1) Deduplicação e filtros existentes sobre a vaga de teste.
  const deduped = deduplicateJobs([testJob, { ...testJob }]);
  assert(deduped.length === 1, "deduplicateJobs deveria manter apenas 1 vaga.");

  const developerJobs = filterDeveloperJobs(deduped);
  assert(
    developerJobs.length === 1,
    "filterDeveloperJobs rejeitou a vaga de teste.",
  );

  const seniorityJobs = filterBySeniority(developerJobs);
  assert(
    seniorityJobs.length === 1,
    "filterBySeniority rejeitou a vaga de teste.",
  );

  const eligibleJobs = filterByLocation(seniorityJobs);
  assert(
    eligibleJobs.length === 1,
    "filterByLocation rejeitou a vaga de teste.",
  );

  // 2) O histórico temporário começa vazio.
  assert(
    (await isJobNotified(testJob)) === false,
    "A vaga não deveria estar notificada no histórico temporário.",
  );
  assert(
    (await getAnalyzedJob(testJob)) === undefined,
    "O histórico temporário de análises deveria começar vazio.",
  );

  // 3) Consulta única ao Gemini e validação da resposta (sem forçar decisão).
  const analysis = await analyzeJob(testJob);
  assert(
    ["compatible", "incompatible", "review"].includes(analysis.decision),
    "decision inválida retornada pela IA.",
  );
  assert(
    Number.isInteger(analysis.score) &&
      analysis.score >= 0 &&
      analysis.score <= 100,
    "score inválido retornado pela IA.",
  );
  console.log(
    `Resposta da IA: ${analysis.decision} | score ${analysis.score} | ` +
      `localização ${analysis.locationStatus} | contratação ${analysis.contractStatus}`,
  );

  // 4) Persistência e recuperação da análise no histórico temporário.
  await markJobAsAnalyzed(testJob, analysis);
  const savedAnalysis = await getAnalyzedJob(testJob);
  assert(
    savedAnalysis !== undefined,
    "Análise não foi recuperada do histórico temporário.",
  );
  assert(
    savedAnalysis.decision === analysis.decision &&
      savedAnalysis.score === analysis.score,
    "Análise recuperada difere da análise salva.",
  );

  // 5) Envio somente se compatível, com localização e contratação "allowed".
  const isSendable =
    analysis.decision === "compatible" &&
    analysis.locationStatus === "allowed" &&
    analysis.contractStatus === "allowed";
  const smokeSend = process.env.JOBFINDER_SMOKE_SEND === "true";

  if (!isSendable) {
    console.log("Envio não realizado: a IA não classificou a vaga como compatível.");
  } else if (!smokeSend) {
    console.log(
      "Envio não realizado: JOBFINDER_SMOKE_SEND != true (modo seguro).",
    );
  } else {
    await sendJobNotification(testJob, analysis);
    await markJobAsNotified(testJob);

    // Garante que a mesma vaga não seria enviada novamente.
    assert(
      (await isJobNotified(testJob)) === true,
      "A vaga deveria constar como notificada após o envio.",
    );
    console.log("Envio confirmado e vaga registrada no histórico temporário.");
    console.log("Verificação: a mesma vaga não seria enviada novamente.");
  }

  console.log("Smoke test concluído com sucesso.");
} catch (error) {
  // Nunca expõe credenciais: apenas a mensagem do erro.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[smoke-test] Falha: ${message}`);
  process.exitCode = 1;
} finally {
  // 6) Limpeza: volta ao cwd original e remove os arquivos temporários.
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
}
