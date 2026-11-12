import { JOB_SOURCES, type JobSource } from "./config/job-sources.js";
import { fetchAshbyJobs } from "./providers/ashby.js";
import { fetchGreenhouseJobs } from "./providers/greenhouse.js";
import { fetchLeverJobs } from "./providers/lever.js";
import { analyzeJob, type JobAnalysis } from "./services/ai-analyzer.js";
import {
  getAnalyzedJob,
  markJobAsAnalyzed,
} from "./services/analysis-history.js";
import {
  deduplicateJobs,
  isJobNotified,
  markJobAsNotified,
} from "./services/deduplication.js";
import { filterDeveloperJobs } from "./services/job-filter.js";
import { prioritizeJobs } from "./services/job-priority.js";
import { filterByLocation } from "./services/location-filter.js";
import { filterBySeniority } from "./services/seniority-filter.js";
import { sendJobNotification } from "./services/telegram.js";
import type { Job } from "./types/job.js";

// Envio real só quando a variável for exatamente "true"; padrão é modo de teste.
const SEND_NOTIFICATIONS = process.env.JOBFINDER_SEND_NOTIFICATIONS === "true";

// Limite de novas análises por execução: padrão 1, teto de 5.
const DEFAULT_MAX_ANALYSES = 1;
const HARD_MAX_ANALYSES = 5;

/**
 * Lê JOBFINDER_MAX_ANALYSES aceitando apenas inteiro positivo dentro do teto.
 *
 * Valores ausentes ou inválidos recorrem ao padrão seguro.
 */
function parseMaxAnalyses(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? "";

  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_MAX_ANALYSES;
  }

  const value = Number(trimmed);
  if (value < DEFAULT_MAX_ANALYSES) {
    return DEFAULT_MAX_ANALYSES;
  }

  return Math.min(value, HARD_MAX_ANALYSES);
}

const MAX_ANALYSES = parseMaxAnalyses(process.env.JOBFINDER_MAX_ANALYSES);

/** Totais exibidos no resumo final da execução. */
interface RunSummary {
  analyzed: number;
  compatible: number;
  incompatible: number;
  review: number;
  notified: number;
}

/**
 * Coleta as vagas de uma fonte, isolando a falha para não derrubar as demais.
 */
async function fetchJobsFromSource(source: JobSource): Promise<Job[]> {
  try {
    let jobs: Job[];

    switch (source.provider) {
      case "greenhouse":
        jobs = await fetchGreenhouseJobs(source.identifier);
        break;
      case "lever":
        jobs = await fetchLeverJobs(source.identifier);
        break;
      case "ashby":
        jobs = await fetchAshbyJobs(source.identifier);
        break;
    }

    console.log(
      `${source.provider} (${source.identifier}): ${jobs.length} vagas coletadas`,
    );

    return jobs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Falha ao coletar da fonte ${source.provider} (${source.identifier}): ${message}`,
    );
    return [];
  }
}

/**
 * Processa as vagas na ordem recebida.
 *
 * Analisa até MAX_ANALYSES vagas novas, reaproveita análises salvas (sem nova
 * chamada à IA), ignora vagas já notificadas e envia no máximo uma notificação
 * por execução. Cada nova análise é salva imediatamente.
 */
async function processJobs(jobs: Job[]): Promise<RunSummary> {
  const summary: RunSummary = {
    analyzed: 0,
    compatible: 0,
    incompatible: 0,
    review: 0,
    notified: 0,
  };

  for (const job of jobs) {
    // Limite de análises atingido e nenhum envio pendente: encerra o laço.
    if (
      summary.analyzed >= MAX_ANALYSES &&
      (!SEND_NOTIFICATIONS || summary.notified >= 1)
    ) {
      break;
    }

    if (await isJobNotified(job)) {
      continue;
    }

    // Reaproveita a análise salva; só chama a IA quando não houver resultado.
    let analysis: JobAnalysis | undefined = await getAnalyzedJob(job);
    const isReused = analysis !== undefined;

    if (!analysis) {
      // Limite de novas análises atingido: não chama o Gemini, mas segue
      // verificando vagas já analisadas e ainda pendentes de envio.
      if (summary.analyzed >= MAX_ANALYSES) {
        continue;
      }

      console.log(`Analisando: ${job.title} (${job.company})`);
      analysis = await analyzeJob(job);
      // Salva a nova análise imediatamente, inclusive as compatíveis.
      await markJobAsAnalyzed(job, analysis);
      summary.analyzed++;

      if (analysis.decision === "compatible") {
        summary.compatible++;
      } else if (analysis.decision === "incompatible") {
        summary.incompatible++;
      } else {
        summary.review++;
      }
    }

    console.log(
      `Resultado da IA: ${analysis.decision} | score ${analysis.score} | ` +
        `localização ${analysis.locationStatus} | contratação ${analysis.contractStatus}`,
    );

    const isSendable =
      analysis.decision === "compatible" &&
      analysis.locationStatus === "allowed" &&
      analysis.contractStatus === "allowed";

    // Uma notificação por execução; análises aprovadas ficam salvas para depois.
    if (!isSendable || !SEND_NOTIFICATIONS || summary.notified >= 1) {
      continue;
    }

    if (isReused) {
      // Reaproveita o resultado salvo, sem chamar a IA novamente.
      console.log(`Reutilizando análise salva: ${job.title} (${job.company})`);
    }

    // Só registra como notificada após o Telegram confirmar o envio. Uma falha
    // aqui mantém a análise salva, permitindo nova tentativa.
    await sendJobNotification(job, analysis);
    await markJobAsNotified(job);
    summary.notified++;
    console.log(`Notificação enviada: ${job.title} (${job.company})`);
  }

  return summary;
}

/**
 * Coleta das fontes, filtra, prioriza, analisa as vagas novas e (opcionalmente)
 * notifica no máximo uma vaga por execução.
 */
async function main() {
  try {
    const collected = await Promise.all(JOB_SOURCES.map(fetchJobsFromSource));

    // Lista unificada; a deduplicação por "source:id" mantém fontes distintas.
    const jobs = collected.flat();
    const uniqueJobs = deduplicateJobs(jobs);
    const developerJobs = filterDeveloperJobs(uniqueJobs);
    const seniorityJobs = filterBySeniority(developerJobs);
    const eligibleJobs = filterByLocation(seniorityJobs);
    // Ordena por prioridade geográfica sem descartar vagas elegíveis.
    const prioritizedJobs = prioritizeJobs(eligibleJobs);

    console.log(`Coletadas: ${jobs.length} | após dedupe: ${uniqueJobs.length}`);
    console.log(`Desenvolvimento: ${developerJobs.length}`);
    console.log(`Após senioridade: ${seniorityJobs.length}`);
    console.log(`Após localização: ${eligibleJobs.length}`);
    console.log(`Limite de novas análises nesta execução: ${MAX_ANALYSES}`);

    const summary = await processJobs(prioritizedJobs);

    console.log(
      `Resumo: ${summary.analyzed} nova(s) análise(s) | ` +
        `${summary.compatible} compatível(is) | ${summary.incompatible} incompatível(is) | ` +
        `${summary.review} em revisão | ${summary.notified} notificação(ões) enviada(s)`,
    );
  } catch (error) {
    // Loga apenas a mensagem, sem expor tokens ou chaves.
    const message = error instanceof Error ? error.message : String(error);
    console.error("Erro na execução do JobFinder:", message);
  }
}

main();
