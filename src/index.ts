import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BOARD_JOB_SOURCES, type JobSource } from "./config/job-sources.js";
import { fetchAshbyJobs } from "./providers/ashby.js";
import { BoardTimeoutError } from "./providers/board-http.js";
import { fetchGreenhouseJobs } from "./providers/greenhouse.js";
import { fetchInhireJobs } from "./providers/inhire.js";
import { fetchLeverJobs } from "./providers/lever.js";
import { fetchLinkedInJobs } from "./providers/linkedin.js";
import { fetchIndeedJobs } from "./providers/indeed.js";
import {
  analyzeJobs,
  estimatePromptTokens,
  GeminiAnalysisError,
  resolveBatchSize,
  resolveConfiguredBatchSize,
  type JobAnalysis,
} from "./services/ai-analyzer.js";
import {
  getReusableAnalysis,
  markJobAsAnalyzed,
} from "./services/analysis-history.js";
import { runAudit } from "./services/audit-report.js";
import { classifyJobContract, filterByContract } from "./services/contract-filter.js";
import {
  deduplicateJobs,
  generateJobKey,
  groupEquivalentJobs,
  isJobNotified,
} from "./services/deduplication.js";
import {
  createGeminiQuotaManager,
  type GeminiQuotaManager,
} from "./services/gemini-quota.js";
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
  type NotificationKind,
} from "./services/notification-dispatch.js";
import { classifyNotification } from "./services/notification-policy.js";
import {
  collectSearchBatch,
  RateLimitError,
} from "./services/rate-limit.js";
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

// Modo de auditoria (`--audit-only`): repete a coleta e a triagem atuais, grava
// o relatório em `data/audit/` e encerra antes da análise — sem IA, históricos,
// Supabase ou Telegram. Não altera a execução normal.
const AUDIT_ONLY = process.argv.includes("--audit-only");

// Envio real só quando a variável for exatamente "true"; padrão é modo de teste.
const SEND_NOTIFICATIONS = process.env.JOBFINDER_SEND_NOTIFICATIONS === "true";

// Revisão manual exige o envio geral habilitado; desativada por padrão.
const SEND_REVIEWS =
  SEND_NOTIFICATIONS && process.env.JOBFINDER_SEND_REVIEWS === "true";

// Limite de novas análises por execução: padrão 5, teto de 10.
const DEFAULT_MAX_ANALYSES = 5;
const HARD_MAX_ANALYSES = 10;

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

// Vagas enviadas numa única requisição ao Gemini
// (JOBFINDER_ANALYSIS_BATCH_SIZE; padrão 5, teto de 10). É INDEPENDENTE do
// limite por execução; cada lote é ainda limitado ao saldo de tentativas
// restante, recalculado antes de formar e enviar cada requisição.
const BATCH_SIZE = resolveConfiguredBatchSize();

/** Máximo de exemplos de vagas exibidos por categoria nos logs de filtros. */
const MAX_LOG_EXAMPLES = 5;

/** Totais exibidos no resumo final da execução. */
export interface RunSummary {
  analyzed: number;
  recovered: number;
  compatible: number;
  incompatible: number;
  review: number;
  sentCompatible: number;
  sentReview: number;
  // Análises malsucedidas (cota, indisponibilidade, rede, autenticação ou
  // resposta inválida); nunca registradas como análise válida.
  failedAnalyses: number;
  // Vagas barradas pelo limite de análises, separadas por histórico consultado.
  unanalyzedByLimit: number;
  unscannedByLimit: number;
  // Vagas sem análise porque a IA ficou indisponível nesta execução (falha
  // global), diferenciadas do limite de tentativas e das falhas em si.
  unanalyzedByGemini: number;
}

/** Motivo pelo qual uma vaga analisada não gerou notificação. */
type SkipReason =
  | "incompatible"
  | "location"
  | "contract"
  | "notifications_disabled"
  | "reviews_disabled"
  | "already_notified"
  | "run_limit";

/** Rótulos, em português, de cada motivo de não notificação. */
const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  incompatible: "incompatibilidade",
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
      case "inhire":
        jobs = await fetchInhireJobs(source.identifier);
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
    // Rate limiting é propagado ao orquestrador para interromper apenas as
    // pesquisas restantes deste provider; os demais erros seguem isolados aqui.
    if (error instanceof RateLimitError) {
      throw error;
    }

    // Timeout dos boards públicos é destacado do erro comum nos logs.
    if (error instanceof BoardTimeoutError) {
      console.error(
        `Timeout de ${error.timeoutMs} ms ao coletar da fonte ${label}.`,
      );
      return [];
    }

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
 * pesquisa é isolada por {@link fetchJobsFromSource} e não interrompe as demais,
 * exceto no rate limiting (HTTP 429), que interrompe apenas as pesquisas
 * restantes deste provider preservando as vagas já coletadas.
 */
async function fetchSearchBatch(
  searches: readonly JobSource[],
): Promise<Job[]> {
  return collectSearchBatch(searches, fetchJobsFromSource, describeSource);
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
 * Dependências do processamento, injetáveis nos testes.
 *
 * Permitem substituir a análise de IA e o despacho de notificação sem tocar no
 * Gemini nem no Telegram reais, preservando o restante do fluxo (histórico,
 * deduplicação e limiares) exatamente como em produção.
 */
export interface ProcessDependencies {
  /**
   * Analisa um LOTE de vagas numa única requisição e devolve as análises
   * válidas indexadas pela chave "source:id". Deve lançar GeminiAnalysisError
   * em falha global (cota, indisponibilidade, rede, autenticação).
   */
  analyzeBatch: (jobs: Job[]) => Promise<Map<string, JobAnalysis>>;
  /** Reserva e envia a notificação; devolve false se já estava reservada. */
  notify: (
    candidate: NotificationCandidate,
    kind: NotificationKind,
  ) => Promise<boolean>;
  /**
   * Gerencia a cota do Gemini (reserva atômica, intervalo mínimo e orçamento
   * diário). Opcional: quando ausente (execuções em teste), o limite por
   * execução volta a ser {@link MAX_ANALYSES} e nenhuma reserva é feita. Ao
   * esgotar a cota, o orçamento ou o tempo — ou falhar o controle — `acquire`
   * lança GeminiAnalysisError e novas chamadas são interrompidas.
   */
  quota?: GeminiQuotaManager;
}

/** Dependências reais usadas em produção. */
const DEFAULT_DEPENDENCIES: ProcessDependencies = {
  analyzeBatch: analyzeJobs,
  notify: (candidate, kind) => notifyWithReservation(candidate, kind),
};

/**
 * Processa as vagas na ordem recebida (prioridade geográfica).
 *
 * Analisa até o limite de vagas da execução — ampliado pelo orçamento de
 * requisições da cota do Gemini (orçamento × tamanho do lote), com
 * JOBFINDER_MAX_ANALYSES como piso. Reaproveita análises salvas (inclusive as
 * marcadas como revisão), ignora vagas já notificadas e envia no máximo uma
 * notificação por execução, priorizando as vagas compatíveis.
 *
 * As vagas novas são enviadas ao Gemini em LOTES por `generateContent` (não a
 * Batch API): até BATCH_SIZE vagas por requisição (JOBFINDER_ANALYSIS_BATCH_SIZE;
 * padrão 5, teto de 10), independente do limite por execução. O saldo restante
 * de tentativas é recalculado ANTES de formar e enviar cada lote, de modo que o
 * limite nunca seja ultrapassado — inclusive quando não é múltiplo do tamanho do
 * lote. Antes de cada requisição, a cota é reservada de forma atômica
 * (`quota.acquire`); esgotar a cota, o orçamento da execução ou o tempo — ou
 * falhar o controle — interrompe novas chamadas (falha global). O histórico é
 * consultado ANTES de incluir a vaga no lote, e cada resultado é validado
 * individualmente, aproveitando os válidos mesmo quando faltam, são inválidos,
 * trazem chaves desconhecidas ou duplicam a mesma chave de forma conflitante. O
 * lote pendente é resolvido antes de uma vaga recuperada de prioridade
 * posterior, preservando a ordem de prioridade na escolha do candidato a
 * notificação.
 *
 * Quando a IA fica indisponível (falha global, não específica dos dados da
 * vaga), novas chamadas ao Gemini são interrompidas pelo restante da execução,
 * mas o laço continua: as análises já salvas seguem sendo reaproveitadas e as
 * vagas pendentes serão reprocessadas numa próxima execução.
 *
 * @param jobs Vagas já filtradas e priorizadas.
 * @param deps Dependências do processamento (padrão: implementações reais).
 */
export async function processJobs(
  jobs: Job[],
  deps: ProcessDependencies = DEFAULT_DEPENDENCIES,
): Promise<RunSummary> {
  const summary: RunSummary = {
    analyzed: 0,
    recovered: 0,
    compatible: 0,
    incompatible: 0,
    review: 0,
    sentCompatible: 0,
    sentReview: 0,
    failedAnalyses: 0,
    unanalyzedByLimit: 0,
    unscannedByLimit: 0,
    unanalyzedByGemini: 0,
  };

  // Contagem por motivo de não notificação, para o resumo do funil.
  const skipCounts: Record<SkipReason, number> = {
    incompatible: 0,
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

  // Limite de vagas desta execução. Com a cota gerenciada, ele é ampliado pelo
  // orçamento de requisições da execução (orçamento × tamanho do lote),
  // preservando JOBFINDER_MAX_ANALYSES como PISO — assim, quando a cota esgota
  // (orçamento 0), o laço segue percorrendo as vagas para reaproveitar o
  // histórico salvo. Sem cota (execuções em teste), vale o próprio
  // JOBFINDER_MAX_ANALYSES. O teto EFETIVO de chamadas é a reserva atômica da
  // cota (`acquire`), de modo que o total diário nunca é ultrapassado.
  const jobLimit = deps.quota
    ? Math.max(MAX_ANALYSES, deps.quota.snapshot.jobBudget)
    : MAX_ANALYSES;

  // Chamadas ao Gemini já realizadas nesta execução. Diferente de
  // `summary.analyzed` (que conta só os sucessos), este contador limita as
  // TENTATIVAS: uma falha também consome o limite, impedindo chamadas
  // repetidas quando a API está indisponível ou com cota esgotada.
  let analysesUsed = 0;

  // Estado que impede novas chamadas à IA nesta execução após uma falha global
  // (cota, indisponibilidade, rede ou autenticação). Não interrompe o laço: as
  // análises salvas continuam sendo reaproveitadas e as vagas pendentes ficam
  // elegíveis para a próxima execução.
  let geminiBlocked = false;

  // Vagas acumuladas para a próxima requisição em lote ao Gemini
  // (`generateContent` com múltiplas vagas, não a Batch API).
  let batch: Job[] = [];

  /** Saldo de tentativas ainda disponível nesta execução (nunca negativo). */
  const remainingBalance = (): number =>
    Math.max(0, jobLimit - analysesUsed);

  /**
   * Vagas permitidas no próximo lote: o menor valor entre o tamanho
   * configurado e o saldo restante. Recalculado antes de formar e enviar cada
   * lote para que o limite de vagas da execução (`jobLimit`) nunca seja
   * ultrapassado.
   */
  const batchCapacity = (): number =>
    resolveBatchSize(remainingBalance(), BATCH_SIZE);

  /**
   * Avalia uma vaga já resolvida (nova ou recuperada do histórico): registra o
   * resultado e decide se ela vira candidata a notificação. É chamada em ORDEM
   * de prioridade para preservar a escolha do primeiro compatível.
   */
  const handleResolved = (
    job: Job,
    analysis: JobAnalysis,
    origin: "nova" | "recuperada",
  ): void => {
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
    } else if (analysis.locationStatus !== "allowed") {
      registerSkip(job, "location");
    } else if (analysis.contractStatus !== "allowed") {
      registerSkip(job, "contract");
    } else {
      registerSkip(job, "incompatible");
    }
  };

  /**
   * Envia o lote pendente numa única requisição (`generateContent`) e processa
   * cada vaga individualmente.
   *
   * Antes de enviar, recalcula o saldo restante e limita o lote a ele, de modo
   * que o limite de vagas da execução (`jobLimit`) nunca seja ultrapassado. A
   * cota é reservada de forma atômica antes da requisição. Cada vaga é
   * identificada pela chave "source:id"; resultados ausentes, inválidos, com
   * chave desconhecida ou duplicados conflitantes consomem a tentativa da vaga,
   * mas são descartados sem invalidar os resultados válidos nem o restante da
   * execução. Uma falha global (cota, indisponibilidade, rede ou autenticação)
   * interrompe as próximas requisições, preservando as análises salvas e
   * deixando as vagas pendentes para a próxima execução.
   */
  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) {
      return;
    }

    // Recalcula o saldo ANTES de enviar: o lote nunca ultrapassa jobLimit,
    // mesmo que o tamanho configurado seja maior que o saldo restante.
    const current = batch.slice(0, batchCapacity());
    batch = batch.slice(current.length);
    if (current.length === 0) {
      return;
    }

    for (const job of current) {
      console.log(`Analisando: ${job.title} (${job.company})`);
    }

    // Contabiliza as tentativas antes da chamada, mesmo se ela falhar.
    analysesUsed += current.length;

    let results: Map<string, JobAnalysis>;
    try {
      // Reserva a cota ANTES da requisição: cada TENTATIVA consome uma reserva,
      // inclusive quando a chamada falha depois (falhas e retries contam).
      // Esgotar a cota, o orçamento da execução, o tempo ou os TOKENS de entrada
      // do prompt completo — ou falhar o controle — lança GeminiAnalysisError e
      // cai no tratamento abaixo, que interrompe novas chamadas sem derrubar o
      // laço.
      if (deps.quota) {
        await deps.quota.acquire(estimatePromptTokens(current));
      }

      results = await deps.analyzeBatch(current);
    } catch (error) {
      summary.failedAnalyses += current.length;
      const kind =
        error instanceof GeminiAnalysisError ? error.kind : "unknown";
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Falha na análise do lote de ${current.length} vaga(s) | ` +
          `categoria: ${kind} | ${message}`,
      );

      // Falha específica do lote (resposta vazia/estruturalmente inválida):
      // isola o lote e segue para as vagas seguintes.
      if (kind === "invalid") {
        return;
      }

      // Cota, indisponibilidade, rede ou autenticação: impede novas chamadas
      // ao Gemini nesta execução, sem interromper o laço. As análises salvas
      // seguem sendo reaproveitadas e as vagas pendentes serão reprocessadas
      // na próxima execução. Nenhuma falha é registrada como análise válida.
      if (!geminiBlocked) {
        geminiBlocked = true;
        console.error(
          "Novas análises interrompidas nesta execução (IA indisponível); " +
            "as análises salvas continuam sendo reutilizadas e as vagas " +
            "pendentes serão reprocessadas na próxima execução.",
        );
      }
      return;
    }

    for (const job of current) {
      const analysis = results.get(generateJobKey(job));

      // Resultado ausente, inválido ou com chave não reconhecida: a vaga fica
      // sem análise e será reprocessada numa próxima execução.
      if (!analysis) {
        summary.failedAnalyses++;
        console.error(
          `Análise ausente ou inválida para ${job.title} (${job.company}).`,
        );
        continue;
      }

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

      handleResolved(job, analysis, "nova");
    }
  };

  for (const job of jobs) {
    // Limite de chamadas atingido: só continua se ainda houver envio pendente.
    if (analysesUsed >= jobLimit) {
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
    const analysis = await getReusableAnalysis(job);
    if (analysis) {
      // Preserva a ordem de prioridade: resolve o lote pendente (vagas mais
      // prioritárias) antes de avaliar esta vaga recuperada.
      await flushBatch();
      summary.recovered++;
      handleResolved(job, analysis, "recuperada");
      continue;
    }

    // IA indisponível nesta execução: não faz novas chamadas. A vaga fica
    // pendente e será reprocessada numa próxima execução.
    if (geminiBlocked) {
      summary.unanalyzedByGemini++;
      continue;
    }

    // Sem resultado salvo e limite atingido: não chama o Gemini.
    if (analysesUsed >= jobLimit) {
      // Histórico consultado, mas a vaga fica efetivamente sem análise.
      summary.unanalyzedByLimit++;
      continue;
    }

    // Acumula a vaga para a próxima requisição em lote e envia quando o lote
    // atinge o tamanho permitido: o configurado, limitado ao saldo restante.
    batch.push(job);
    if (batch.length >= batchCapacity()) {
      await flushBatch();
    }
  }

  // Envia o lote final (parcial), se houver.
  await flushBatch();

  // Uma notificação por execução: compatível antes de revisão manual.
  if (compatibleCandidate) {
    const { job } = compatibleCandidate;
    if (await deps.notify(compatibleCandidate, "compatible")) {
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
    if (await deps.notify(reviewCandidate, "manual_review")) {
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

/** Opções do processamento pós-coleta, injetáveis nos testes. */
export interface PipelineOptions {
  /** Grava o relatório de auditoria e encerra antes da análise. */
  auditOnly?: boolean;
  /** Diretório de saída do relatório de auditoria (padrão: `data/audit`). */
  auditDirectory?: string;
  /** Instante de referência da priorização (padrão: agora). */
  referenceDate?: Date;
  /**
   * Instante (ms) do INÍCIO DO PIPELINE (antes da coleta), base do orçamento de
   * tempo da cota do Gemini — que conta a coleta e as esperas. Padrão: instante
   * da criação do gerenciador de cota.
   */
  pipelineStartedAtMs?: number;
  /** Dependências de análise e notificação (padrão: implementações reais). */
  dependencies?: ProcessDependencies;
}

/**
 * Aplica a triagem atual às vagas coletadas e segue para a análise.
 *
 * Em modo de auditoria (`auditOnly`), reutiliza as MESMAS funções puras
 * (deduplicação, filtros e priorização), grava o relatório e encerra ANTES de
 * qualquer análise: não chama a IA, não consulta nem grava históricos, não
 * acessa o Supabase e não envia notificações, devolvendo null. Fora do modo de
 * auditoria, mantém exatamente o comportamento normal.
 *
 * @param jobs Vagas coletadas (antes da deduplicação).
 * @param options Opções injetáveis (auditoria, diretório, dependências).
 * @returns O resumo do processamento normal, ou null quando encerrou na auditoria.
 */
export async function runPipeline(
  jobs: Job[],
  options: PipelineOptions = {},
): Promise<RunSummary | null> {
  // Modo de auditoria: mesma coleta e mesmos filtros, sem IA, históricos,
  // Supabase ou Telegram. Grava o relatório e encerra antes da análise.
  if (options.auditOnly) {
    const { report, filePath } = await runAudit(jobs, {
      referenceDate: options.referenceDate,
      directory: options.auditDirectory,
    });

    console.log(
      `Auditoria: ${report.totalCollected} coletada(s) | ` +
        `${report.uniqueJobs} única(s) | ${report.approved} aprovada(s) nos filtros`,
    );
    console.log(`Relatório de auditoria gravado em: ${filePath}`);

    return null;
  }

  // Lista unificada; a deduplicação por "source:id" mantém fontes distintas e o
  // agrupamento conservador remove anúncios equivalentes (mesma empresa, título,
  // descrição substantiva, modalidade, localidades e contratação).
  const identityUnique = deduplicateJobs(jobs);
  const { jobs: uniqueJobs, groups: equivalentGroups } =
    groupEquivalentJobs(identityUnique);
  const developerJobs = filterDeveloperJobs(uniqueJobs);
  const seniorityJobs = filterBySeniority(developerJobs);
  const locationJobs = filterByLocation(seniorityJobs);
  const contractJobs = filterByContract(locationJobs);
  // Ordena por prioridade geográfica sem descartar vagas elegíveis.
  const prioritizedJobs = prioritizeJobs(contractJobs);

  // Grupos descartados por etapa, derivados por identidade de objeto (os
  // filtros preservam as referências), sem alterar as regras de elegibilidade.
  const developerSet = new Set(developerJobs);
  const senioritySet = new Set(seniorityJobs);
  const groupedByEquivalence = identityUnique.length - uniqueJobs.length;
  const discardedByDedupe = jobs.length - identityUnique.length;
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
  const discardedByContract = locationJobs.filter(
    (job) => classifyJobContract(job) === "blocked",
  );

  // Cota do Gemini: gerenciada apenas na execução real (sem dependências
  // injetadas). Em testes, as dependências falsas substituem a análise e a
  // cota; sem ela, o limite por execução volta a ser JOBFINDER_MAX_ANALYSES. O
  // orçamento de tempo conta desde o INÍCIO do pipeline (coleta e esperas).
  const quota =
    options.dependencies?.quota ??
    (options.dependencies
      ? undefined
      : await createGeminiQuotaManager({
          batchSize: BATCH_SIZE,
          pipelineStartedAtMs: options.pipelineStartedAtMs,
        }));

  // Limite de vagas desta execução, ampliado pelo orçamento de requisições da
  // cota (orçamento × tamanho do lote), com JOBFINDER_MAX_ANALYSES como piso.
  const jobLimit = quota
    ? Math.max(MAX_ANALYSES, quota.snapshot.jobBudget)
    : MAX_ANALYSES;

  console.log(`Coletadas: ${jobs.length} | após dedupe: ${identityUnique.length}`);
  console.log(`Desenvolvimento: ${developerJobs.length}`);
  console.log(`Após senioridade: ${seniorityJobs.length}`);
  console.log(`Após localização: ${locationJobs.length}`);
  console.log(`Após contratação: ${contractJobs.length}`);
  console.log(`Armazenamento: ${getStorageBackend()}`);
  console.log(`Limite de vagas nesta execução: ${jobLimit}`);
  console.log(`Vagas por requisição ao Gemini (lote): ${BATCH_SIZE}`);

  // Detalhamento dos descartes de cada filtro, com exemplos.
  console.log(`Duplicadas descartadas: ${discardedByDedupe}`);
  console.log(`Anúncios agrupados por equivalência: ${groupedByEquivalence}`);
  logJobGroup("Descartadas por desenvolvimento", discardedByDeveloper);
  logJobGroup("Descartadas por senioridade", discardedBySeniority);
  logJobGroup("Bloqueadas por localização", blockedByLocation);
  logJobGroup("Localização indefinida", unknownLocationJobs);
  logJobGroup("Bloqueadas por contratação", discardedByContract);

  // Os grupos de equivalência preservam identificadores e URLs para auditoria.
  for (const group of equivalentGroups) {
    const members = group.members
      .map((member) => `${member.key} (${member.url || "sem URL"})`)
      .join(", ");
    console.log(
      `Anúncios equivalentes de ${group.representativeKey}: ${members}`,
    );
  }

  const baseDependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const dependencies: ProcessDependencies = quota
    ? { ...baseDependencies, quota }
    : baseDependencies;

  const summary = await processJobs(prioritizedJobs, dependencies);

  console.log(
    `Resumo: ${summary.analyzed} nova(s) análise(s) | ` +
      `${summary.recovered} recuperada(s) do histórico | ` +
      `${summary.compatible} compatível(is) | ${summary.incompatible} incompatível(is) | ` +
      `${summary.review} em revisão | ` +
      `${summary.sentCompatible} notificação(ões) compatível(is) | ` +
      `${summary.sentReview} notificação(ões) de revisão | ` +
      `${summary.failedAnalyses} análise(s) malsucedida(s) | ` +
      `${summary.unanalyzedByLimit} não analisada(s) por limite (histórico consultado) | ` +
      `${summary.unanalyzedByGemini} não analisada(s) por indisponibilidade da IA | ` +
      `${summary.unscannedByLimit} não percorrida(s) por limite (histórico não consultado)`,
  );

  return summary;
}

/**
 * Coleta das fontes, filtra, prioriza, analisa as vagas novas e (opcionalmente)
 * notifica no máximo uma vaga por execução.
 *
 * Com `--audit-only`, executa a mesma coleta e triagem, grava o relatório de
 * auditoria em `data/audit/` e encerra antes da análise, sem IA, históricos,
 * Supabase ou Telegram.
 */
async function main() {
  // Marca o início do pipeline ANTES da coleta: o orçamento de tempo da cota do
  // Gemini conta a coleta e as esperas, não apenas a fase de análise.
  const pipelineStartedAtMs = Date.now();

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

    await runPipeline(jobs, { auditOnly: AUDIT_ONLY, pipelineStartedAtMs });
  } catch (error) {
    // Loga apenas a mensagem, sem expor tokens ou chaves.
    const message = error instanceof Error ? error.message : String(error);
    console.error("Erro na execução do JobFinder:", message);
    // Sinaliza a falha para o GitHub Actions e para chamadas manuais.
    process.exitCode = 1;
  }
}

/**
 * Indica se este módulo é o ponto de entrada (`node dist/index.js`).
 *
 * A importação em testes não dispara o pipeline; apenas a execução direta roda
 * `main`. A comparação normaliza caixa para tolerar a grafia da unidade no
 * Windows.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  try {
    return (
      resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
