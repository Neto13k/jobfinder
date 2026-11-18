import { BOARD_JOB_SOURCES, type JobSource } from "./config/job-sources.js";
import { fetchAshbyJobs } from "./providers/ashby.js";
import { fetchGreenhouseJobs } from "./providers/greenhouse.js";
import { fetchLeverJobs } from "./providers/lever.js";
import { fetchLinkedInJobs } from "./providers/linkedin.js";
import { fetchIndeedJobs } from "./providers/indeed.js";
import { analyzeJob, type JobAnalysis } from "./services/ai-analyzer.js";
import {
  getReusableAnalysis,
  markJobAsAnalyzed,
} from "./services/analysis-history.js";
import { deduplicateJobs, isJobNotified } from "./services/deduplication.js";
import { filterDeveloperJobs } from "./services/job-filter.js";
import { prioritizeJobs } from "./services/job-priority.js";
import {
  classifyJobLocation,
  filterByLocation,
  type JobLocation,
} from "./services/location-filter.js";
import {
  notifyWithReservation,
  type NotificationCandidate,
} from "./services/notification-dispatch.js";
import { classifyNotification } from "./services/notification-policy.js";
import { filterBySeniority } from "./services/seniority-filter.js";
import {
  LINKEDIN_TOTAL_BATCHES,
  selectLinkedInBatch,
  type LinkedInBatch,
} from "./services/linkedin-search-rotation.js";
import {
  INDEED_TOTAL_BATCHES,
  selectIndeedBatch,
  type IndeedBatch,
} from "./services/indeed-search-rotation.js";
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

/** Máximo de exemplos de vagas exibidos por categoria nos logs de filtros. */
const MAX_LOG_EXAMPLES = 5;

/** Totais exibidos no resumo final da execução. */
interface RunSummary {
  analyzed: number;
  recovered: number;
  compatible: number;
  incompatible: number;
  review: number;
  sentCompatible: number;
  sentReview: number;
  // Vagas barradas pelo limite de análises, separadas por histórico consultado.
  unanalyzedByLimit: number;
  unscannedByLimit: number;
}

/** Motivo pelo qual uma vaga analisada não gerou notificação. */
type SkipReason =
  | "incompatible"
  | "review_not_eligible"
  | "location"
  | "contract"
  | "notifications_disabled"
  | "reviews_disabled"
  | "already_notified"
  | "run_limit";

/** Rótulos, em português, de cada motivo de não notificação. */
const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  incompatible: "incompatibilidade",
  review_not_eligible: "revisão não elegível para notificação",
  location: "localização indefinida ou bloqueada",
  contract: "contratação indefinida ou bloqueada",
  notifications_disabled: "notificações desativadas",
  reviews_disabled: "alertas de revisão desativados",
  already_notified: "vaga já notificada ou reservada",
  run_limit: "limite de notificações por execução",
};

/**
 * Descreve uma fonte para os logs, cobrindo as fontes sem `identifier`.
 */
function describeSource(source: JobSource): string {
  if (source.provider === "linkedin" || source.provider === "indeed") {
    const location = source.location ? ` @ ${source.location}` : "";
    return `${source.provider} (${source.searchTerm}${location})`;
  }

  return `${source.provider} (${source.identifier})`;
}

/**
 * Descreve uma vaga para os logs.
 *
 * Expõe apenas metadados de seleção (título, empresa, fonte, localização e data
 * de publicação); nunca credenciais nem a descrição completa da vaga.
 */
function describeJob(job: Job): string {
  const location = job.location ? job.location : "localização não informada";
  const published = job.publishedAt
    ? ` | publicado em ${job.publishedAt}`
    : "";

  return `${job.title} (${job.company}) | fonte ${job.source} | ${location}${published}`;
}

/**
 * Registra a quantidade de vagas de um grupo e até {@link MAX_LOG_EXAMPLES}
 * exemplos, para evidenciar os gargalos de cada etapa sem poluir o log.
 */
function logJobGroup(header: string, jobs: Job[]): void {
  console.log(`${header}: ${jobs.length}`);

  for (const job of jobs.slice(0, MAX_LOG_EXAMPLES)) {
    console.log(`  - ${describeJob(job)}`);
  }
}

/**
 * Registra o lote do LinkedIn selecionado (número, termos e local de cada pesquisa).
 */
function logLinkedInBatch(batch: LinkedInBatch): void {
  const terms = batch.searches
    .map(
      (search) =>
        `"${search.searchTerm}" @ ${search.location ?? "sem localização"}`,
    )
    .join("; ");

  console.log(
    `Lote LinkedIn ${batch.batchNumber}/${LINKEDIN_TOTAL_BATCHES}: ${terms}`,
  );
}

/**
 * Registra o lote do Indeed selecionado (número, termos e local de cada pesquisa).
 */
function logIndeedBatch(batch: IndeedBatch): void {
  const terms = batch.searches
    .map(
      (search) =>
        `"${search.searchTerm}" @ ${search.location ?? "sem localização"}`,
    )
    .join("; ");

  console.log(
    `Lote Indeed ${batch.batchNumber}/${INDEED_TOTAL_BATCHES}: ${terms}`,
  );
}

/**
 * Coleta as vagas de uma fonte, isolando a falha para não derrubar as demais.
 */
async function fetchJobsFromSource(source: JobSource): Promise<Job[]> {
  const label = describeSource(source);

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
      case "linkedin":
        jobs = await fetchLinkedInJobs(source);
        break;
      case "indeed":
        jobs = await fetchIndeedJobs(source);
        break;
    }

    console.log(`${label}: ${jobs.length} vagas coletadas`);

    return jobs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Falha ao coletar da fonte ${label}: ${message}`);
    return [];
  }
}

/**
 * Coleta as pesquisas de um lote uma por vez.
 *
 * A execução é sequencial de propósito: as buscas concorreriam na mesma sessão
 * da biblioteca ts-jobspy e a rotação só precisa de uma por vez. A falha de uma
 * pesquisa é isolada por {@link fetchJobsFromSource} e não interrompe as demais.
 */
async function fetchSearchBatch(
  searches: readonly JobSource[],
): Promise<Job[]> {
  const collected: Job[] = [];

  for (const search of searches) {
    collected.push(...(await fetchJobsFromSource(search)));
  }

  return collected;
}

/**
 * Coleta os lotes rotativos do LinkedIn e do Indeed em sequência.
 *
 * Os dois lotes usam a mesma biblioteca ts-jobspy, então são executados um após
 * o outro (e cada lote, uma pesquisa por vez) para que nunca haja duas
 * pesquisas disputando a biblioteca ao mesmo tempo. As rotações são
 * independentes: cinco pesquisas do LinkedIn e cinco do Indeed por execução.
 */
async function fetchRotatedBatches(
  linkedinSearches: readonly JobSource[],
  indeedSearches: readonly JobSource[],
): Promise<Job[]> {
  const linkedinJobs = await fetchSearchBatch(linkedinSearches);
  const indeedJobs = await fetchSearchBatch(indeedSearches);

  return [...linkedinJobs, ...indeedJobs];
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
    recovered: 0,
    compatible: 0,
    incompatible: 0,
    review: 0,
    sentCompatible: 0,
    sentReview: 0,
    unanalyzedByLimit: 0,
    unscannedByLimit: 0,
  };

  // Contagem por motivo de não notificação, para o resumo do funil.
  const skipCounts: Record<SkipReason, number> = {
    incompatible: 0,
    review_not_eligible: 0,
    location: 0,
    contract: 0,
    notifications_disabled: 0,
    reviews_disabled: 0,
    already_notified: 0,
    run_limit: 0,
  };

  /** Contabiliza e registra o motivo pelo qual a vaga não gera notificação. */
  const registerSkip = (job: Job, reason: SkipReason): void => {
    skipCounts[reason]++;
    console.log(
      `Sem notificação: ${job.title} (${job.company}) | ` +
        `motivo: ${SKIP_REASON_LABELS[reason]}`,
    );
  };

  // Candidatos pendentes, na ordem de prioridade em que aparecem.
  let compatibleCandidate: NotificationCandidate | undefined;
  let reviewCandidate: NotificationCandidate | undefined;

  // Vagas cuja iteração já começou; usado para medir o que sobra no break.
  let processed = 0;

  for (const job of jobs) {
    // Limite de análises atingido: só continua se ainda houver envio pendente.
    if (summary.analyzed >= MAX_ANALYSES) {
      if (!SEND_NOTIFICATIONS || compatibleCandidate) {
        // As vagas restantes nem chegam a ter o histórico consultado.
        summary.unscannedByLimit = jobs.length - processed;
        break;
      }
    }

    processed++;

    // Vaga já notificada/reservada: não é analisada nem notificada de novo.
    if (await isJobNotified(job)) {
      skipCounts.already_notified++;
      continue;
    }

    // Reaproveita a análise salva apenas se ela for da versão vigente dos
    // critérios; análises antigas ou legadas são refeitas.
    let analysis: JobAnalysis | undefined = await getReusableAnalysis(job);
    let origin: "nova" | "recuperada" = "recuperada";

    if (!analysis) {
      // Sem resultado salvo e limite atingido: não chama o Gemini.
      if (summary.analyzed >= MAX_ANALYSES) {
        // Histórico consultado, mas a vaga fica efetivamente sem análise.
        summary.unanalyzedByLimit++;
        continue;
      }

      origin = "nova";
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
    } else {
      summary.recovered++;
    }

    const published = job.publishedAt
      ? ` | publicado em ${job.publishedAt}`
      : "";

    console.log(
      `Resultado da IA: ${job.title} (${job.company}) | fonte ${job.source}${published} | ` +
        `origem ${origin} | ${analysis.decision} | score ${analysis.score} | ` +
        `localização ${analysis.locationStatus} | contratação ${analysis.contractStatus} | ` +
        `motivo: ${analysis.reason}`,
    );

    const kind = classifyNotification(analysis);

    // Compatível tem prioridade; revisão só conta quando habilitada.
    if (kind === "compatible") {
      if (!SEND_NOTIFICATIONS) {
        registerSkip(job, "notifications_disabled");
      } else if (compatibleCandidate) {
        // Já há uma compatível escolhida nesta execução: limite de envio.
        registerSkip(job, "run_limit");
      } else {
        compatibleCandidate = { job, analysis };
      }
    } else if (kind === "manual_review") {
      // Sem o envio geral, o motivo raiz é "notificações desativadas": o envio
      // de revisão só é considerado quando o envio geral está ligado.
      if (!SEND_NOTIFICATIONS) {
        registerSkip(job, "notifications_disabled");
      } else if (!SEND_REVIEWS) {
        registerSkip(job, "reviews_disabled");
      } else if (reviewCandidate) {
        registerSkip(job, "run_limit");
      } else {
        reviewCandidate = { job, analysis };
      }
    } else if (analysis.decision === "review") {
      // Revisão fora dos critérios do aviso (localização permitida + contratação
      // indefinida): não é uma incompatibilidade real.
      registerSkip(job, "review_not_eligible");
    } else if (analysis.locationStatus !== "allowed") {
      registerSkip(job, "location");
    } else if (analysis.contractStatus !== "allowed") {
      registerSkip(job, "contract");
    } else {
      registerSkip(job, "incompatible");
    }
  }

  // Uma notificação por execução: compatível antes de revisão manual.
  if (compatibleCandidate) {
    const { job } = compatibleCandidate;
    if (await notifyWithReservation(compatibleCandidate, "compatible")) {
      summary.sentCompatible++;
      console.log(`Notificação enviada: ${job.title} (${job.company})`);
    } else {
      registerSkip(job, "already_notified");
    }

    // A revisão não é enviada quando já há uma compatível nesta execução.
    if (reviewCandidate) {
      registerSkip(reviewCandidate.job, "run_limit");
    }
  } else if (reviewCandidate) {
    const { job } = reviewCandidate;
    if (await notifyWithReservation(reviewCandidate, "manual_review")) {
      summary.sentReview++;
      console.log(`Notificação de revisão enviada: ${job.title} (${job.company})`);
    } else {
      registerSkip(job, "already_notified");
    }
  }

  // Resumo dos motivos de não notificação, na ordem declarada em SkipReason.
  const skipEntries = (Object.keys(skipCounts) as SkipReason[])
    .filter((reason) => skipCounts[reason] > 0)
    .map((reason) => `${SKIP_REASON_LABELS[reason]}: ${skipCounts[reason]}`);

  if (skipEntries.length > 0) {
    console.log(`Motivos de não notificação: ${skipEntries.join(" | ")}`);
  }

  return summary;
}

/**
 * Coleta das fontes, filtra, prioriza, analisa as vagas novas e (opcionalmente)
 * notifica no máximo uma vaga por execução.
 */
async function main() {
  try {
    const linkedinBatch = selectLinkedInBatch();
    logLinkedInBatch(linkedinBatch);

    const indeedBatch = selectIndeedBatch();
    logIndeedBatch(indeedBatch);

    // Quadros públicos em paralelo (comportamento original); os lotes rotativos
    // do LinkedIn e do Indeed rodam em sequência (uma pesquisa por vez cada) para
    // não concorrerem pela mesma biblioteca ts-jobspy.
    const [boardCollected, rotatedCollected] = await Promise.all([
      Promise.all(BOARD_JOB_SOURCES.map(fetchJobsFromSource)),
      fetchRotatedBatches(linkedinBatch.searches, indeedBatch.searches),
    ]);

    // Lista unificada; a deduplicação por "source:id" mantém fontes distintas.
    const jobs = [...boardCollected.flat(), ...rotatedCollected];
    const uniqueJobs = deduplicateJobs(jobs);
    const developerJobs = filterDeveloperJobs(uniqueJobs);
    const seniorityJobs = filterBySeniority(developerJobs);
    const eligibleJobs = filterByLocation(seniorityJobs);
    // Ordena por prioridade geográfica sem descartar vagas elegíveis.
    const prioritizedJobs = prioritizeJobs(eligibleJobs);

    // Grupos descartados por etapa, derivados por identidade de objeto (os
    // filtros preservam as referências), sem alterar as regras de elegibilidade.
    const developerSet = new Set(developerJobs);
    const senioritySet = new Set(seniorityJobs);
    const discardedByDedupe = jobs.length - uniqueJobs.length;
    const discardedByDeveloper = uniqueJobs.filter((job) => !developerSet.has(job));
    const discardedBySeniority = developerJobs.filter((job) => !senioritySet.has(job));
    // Classificação da localização apenas para observabilidade (função pura).
    const locationByJob = new Map<Job, JobLocation>();
    for (const job of seniorityJobs) {
      locationByJob.set(job, classifyJobLocation(job));
    }
    const blockedByLocation = seniorityJobs.filter(
      (job) => locationByJob.get(job) === "blocked",
    );
    const unknownLocationJobs = seniorityJobs.filter(
      (job) => locationByJob.get(job) === "unknown",
    );

    console.log(`Coletadas: ${jobs.length} | após dedupe: ${uniqueJobs.length}`);
    console.log(`Desenvolvimento: ${developerJobs.length}`);
    console.log(`Após senioridade: ${seniorityJobs.length}`);
    console.log(`Após localização: ${eligibleJobs.length}`);
    console.log(`Armazenamento: ${getStorageBackend()}`);
    console.log(`Limite de novas análises nesta execução: ${MAX_ANALYSES}`);

    // Detalhamento dos descartes de cada filtro, com exemplos.
    console.log(`Duplicadas descartadas: ${discardedByDedupe}`);
    logJobGroup("Descartadas por desenvolvimento", discardedByDeveloper);
    logJobGroup("Descartadas por senioridade", discardedBySeniority);
    logJobGroup("Bloqueadas por localização", blockedByLocation);
    logJobGroup("Localização indefinida", unknownLocationJobs);

    const summary = await processJobs(prioritizedJobs);

    console.log(
      `Resumo: ${summary.analyzed} nova(s) análise(s) | ` +
        `${summary.recovered} recuperada(s) do histórico | ` +
        `${summary.compatible} compatível(is) | ${summary.incompatible} incompatível(is) | ` +
        `${summary.review} em revisão | ` +
        `${summary.sentCompatible} notificação(ões) compatível(is) | ` +
        `${summary.sentReview} notificação(ões) de revisão | ` +
        `${summary.unanalyzedByLimit} não analisada(s) por limite (histórico consultado) | ` +
        `${summary.unscannedByLimit} não percorrida(s) por limite (histórico não consultado)`,
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
