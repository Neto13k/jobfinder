import { JOB_SOURCES, type JobSource } from "./config/job-sources.js";
import { fetchAshbyJobs } from "./providers/ashby.js";
import { fetchGreenhouseJobs } from "./providers/greenhouse.js";
import { fetchLeverJobs } from "./providers/lever.js";
import { analyzeJob, type JobAnalysis } from "./services/ai-analyzer.js";
import {
  getAnalyzedJob,
  markJobAsAnalyzed,
} from "./services/analysis-history.js";
import { deduplicateJobs, isJobNotified } from "./services/deduplication.js";
import { filterDeveloperJobs } from "./services/job-filter.js";
import { prioritizeJobs } from "./services/job-priority.js";
import { filterByLocation } from "./services/location-filter.js";
import {
  notifyWithReservation,
  type NotificationCandidate,
} from "./services/notification-dispatch.js";
import { classifyNotification } from "./services/notification-policy.js";
import { filterBySeniority } from "./services/seniority-filter.js";
import { getStorageBackend } from "./services/storage.js";
import type { Job } from "./types/job.js";

// Envio real só quando a variável for exatamente "true"; padrão é modo de teste.
const SEND_NOTIFICATIONS = process.env.JOBFINDER_SEND_NOTIFICATIONS === "true";

// Revisão manual exige o envio geral habilitado; desativada por padrão.
const SEND_REVIEWS =
  SEND_NOTIFICATIONS && process.env.JOBFINDER_SEND_REVIEWS === "true";

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
  sentCompatible: number;
  sentReview: number;
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
 * Processa as vagas na ordem recebida (prioridade geográfica).
 *
 * Analisa até MAX_ANALYSES vagas novas, reaproveita análises salvas (inclusive
 * as marcadas como revisão), ignora vagas já notificadas e envia no máximo uma
 * notificação por execução, priorizando as vagas compatíveis.
 */
async function processJobs(jobs: Job[]): Promise<RunSummary> {
  const summary: RunSummary = {
    analyzed: 0,
    compatible: 0,
    incompatible: 0,
    review: 0,
    sentCompatible: 0,
    sentReview: 0,
  };

  // Candidatos pendentes, na ordem de prioridade em que aparecem.
  let compatibleCandidate: NotificationCandidate | undefined;
  let reviewCandidate: NotificationCandidate | undefined;

  for (const job of jobs) {
    // Limite de análises atingido: só continua se ainda houver envio pendente.
    if (summary.analyzed >= MAX_ANALYSES) {
      if (!SEND_NOTIFICATIONS || compatibleCandidate) {
        break;
      }
    }

    if (await isJobNotified(job)) {
      continue;
    }

    // Reaproveita a análise salva; só chama a IA quando não houver resultado.
    let analysis: JobAnalysis | undefined = await getAnalyzedJob(job);

    if (!analysis) {
      // Sem resultado salvo e limite atingido: não chama o Gemini.
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

    const kind = classifyNotification(analysis);

    // Compatível tem prioridade; revisão só conta quando habilitada.
    if (kind === "compatible" && SEND_NOTIFICATIONS && !compatibleCandidate) {
      compatibleCandidate = { job, analysis };
    } else if (kind === "manual_review" && SEND_REVIEWS && !reviewCandidate) {
      reviewCandidate = { job, analysis };
    }
  }

  // Uma notificação por execução: compatível antes de revisão manual.
  if (compatibleCandidate) {
    const { job } = compatibleCandidate;
    if (await notifyWithReservation(compatibleCandidate, "compatible")) {
      summary.sentCompatible++;
      console.log(`Notificação enviada: ${job.title} (${job.company})`);
    }
  } else if (reviewCandidate) {
    const { job } = reviewCandidate;
    if (await notifyWithReservation(reviewCandidate, "manual_review")) {
      summary.sentReview++;
      console.log(`Notificação de revisão enviada: ${job.title} (${job.company})`);
    }
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
    console.log(`Armazenamento: ${getStorageBackend()}`);
    console.log(`Limite de novas análises nesta execução: ${MAX_ANALYSES}`);

    const summary = await processJobs(prioritizedJobs);

    console.log(
      `Resumo: ${summary.analyzed} nova(s) análise(s) | ` +
        `${summary.compatible} compatível(is) | ${summary.incompatible} incompatível(is) | ` +
        `${summary.review} em revisão | ` +
        `${summary.sentCompatible} notificação(ões) compatível(is) | ` +
        `${summary.sentReview} notificação(ões) de revisão`,
    );
  } catch (error) {
    // Loga apenas a mensagem, sem expor tokens ou chaves.
    const message = error instanceof Error ? error.message : String(error);
    console.error("Erro na execução do JobFinder:", message);
    // Sinaliza a falha para o GitHub Actions e para chamadas manuais.
    process.exitCode = 1;
  }
}

main();
