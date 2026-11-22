import type { Job } from "../types/job.js";

// --- Configuração ----------------------------------------------------------

// Limite padrão de recência, em dias. Vagas publicadas há mais que esse limite
// deixam a fila de análise; vagas sem data (ou com data inválida/futura) são
// sempre preservadas.
const DEFAULT_RECENCY_CUTOFF_DAYS = 30;
const MIN_RECENCY_CUTOFF_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lê JOBFINDER_RECENCY_CUTOFF_DAYS aceitando apenas inteiro positivo.
 *
 * Valores ausentes, não numéricos ou abaixo de {@link MIN_RECENCY_CUTOFF_DAYS}
 * recorrem ao padrão seguro ({@link DEFAULT_RECENCY_CUTOFF_DAYS} dias).
 *
 * @param raw Valor bruto da variável de ambiente (padrão: o ambiente atual).
 */
export function resolveRecencyCutoffDays(
  raw: string | undefined = process.env.JOBFINDER_RECENCY_CUTOFF_DAYS,
): number {
  const trimmed = raw?.trim() ?? "";

  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_RECENCY_CUTOFF_DAYS;
  }

  const value = Number(trimmed);
  if (value < MIN_RECENCY_CUTOFF_DAYS) {
    return DEFAULT_RECENCY_CUTOFF_DAYS;
  }

  return value;
}

// --- Classificação ---------------------------------------------------------

/** Desfecho da vaga quanto à recência. */
export type JobRecency = "recent" | "stale" | "unknown";

/**
 * Situação da data de publicação informada pela fonte.
 *
 * - "valid": data interpretável e não futura (base da idade calculada);
 * - "missing": campo ausente ou vazio;
 * - "invalid": data malformada ou no futuro (não interpretável como publicação).
 */
export type RecencyDateState = "valid" | "missing" | "invalid";

/** Avaliação de recência de uma vaga. */
export interface RecencyAssessment {
  /** "stale" apenas quando a data é válida e a idade supera o limite. */
  classification: JobRecency;
  /** Situação da data informada. */
  dateState: RecencyDateState;
  /** Idade em dias (arredondada para cima); null quando a data não é válida. */
  ageDays: number | null;
}

/**
 * Interpreta a data de publicação em um instante (ms desde a época).
 *
 * Aceita formatos ISO 8601, inclusive com fuso horário explícito (`Z` ou
 * `±hh:mm`). Retorna null para valores ausentes ou impossíveis de interpretar.
 */
function parsePublishedAt(publishedAt: string | undefined): number | null {
  if (!publishedAt) {
    return null;
  }

  const trimmed = publishedAt.trim();
  if (trimmed === "") {
    return null;
  }

  const timestamp = Date.parse(trimmed);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/**
 * Classifica a recência de uma vaga em relação a um instante de referência.
 *
 * Datas ausentes, inválidas ou futuras NÃO são tratadas como antigas: caem em
 * "unknown" (preservadas). Uma vaga só é "stale" quando a data é válida e a
 * idade ultrapassa o limite de forma estrita (`idade > limite`), de modo que
 * exatamente no limite a vaga ainda é considerada recente.
 *
 * @param job Vaga avaliada.
 * @param referenceDate Instante de referência da execução (padrão: agora).
 * @param cutoffDays Limite de recência em dias (padrão: configuração atual).
 */
export function classifyJobRecency(
  job: Job,
  referenceDate: Date = new Date(),
  cutoffDays: number = resolveRecencyCutoffDays(),
): RecencyAssessment {
  const timestamp = parsePublishedAt(job.publishedAt);

  if (timestamp === null) {
    return {
      classification: "unknown",
      dateState: job.publishedAt ? "invalid" : "missing",
      ageDays: null,
    };
  }

  const reference = referenceDate.getTime();

  // Data no futuro: não é uma publicação válida; nunca produz descarte.
  if (timestamp > reference) {
    return { classification: "unknown", dateState: "invalid", ageDays: null };
  }

  const ageMs = reference - timestamp;
  const ageDays = Math.ceil(ageMs / DAY_MS);

  if (ageMs > cutoffDays * DAY_MS) {
    return { classification: "stale", dateState: "valid", ageDays };
  }

  return { classification: "recent", dateState: "valid", ageDays };
}

/** Métricas do filtro de recência, para registro e observabilidade. */
export interface RecencyMetrics {
  /** Total de vagas avaliadas. */
  checked: number;
  /** Vagas com data válida e idade acima do limite (excluídas). */
  stale: number;
  /** Vagas sem data de publicação (preservadas). */
  missingDate: number;
  /** Vagas com data inválida, impossível de interpretar ou futura (preservadas). */
  invalidDate: number;
}

/** Resultado do filtro de recência. */
export interface RecencyFilterResult {
  /** Vagas preservadas (recentes, sem data ou com data inválida/futura). */
  jobs: Job[];
  /** Vagas excluídas por serem comprovadamente antigas. */
  excluded: Job[];
  /** Contagens por desfecho. */
  metrics: RecencyMetrics;
}

/** Opções do filtro de recência (injetáveis nos testes). */
export interface RecencyFilterOptions {
  /** Instante de referência da execução (padrão: agora). */
  referenceDate?: Date;
  /** Limite de recência em dias (padrão: configuração atual). */
  cutoffDays?: number;
}

/**
 * Remove da fila de análise as vagas comprovadamente antigas.
 *
 * Exclui apenas vagas com data de publicação VÁLIDA e idade superior ao limite.
 * Vagas sem data, com data inválida ou futura são preservadas — informação
 * ausente ou duvidosa nunca é tratada como antiguidade. A função é pura e não
 * altera as vagas originais; devolve também as excluídas e as métricas.
 *
 * @param jobs Vagas candidatas (recentes, antigas ou sem data).
 * @param options Instante de referência e limite configurável.
 */
export function filterByRecency(
  jobs: Job[],
  options: RecencyFilterOptions = {},
): RecencyFilterResult {
  const referenceDate = options.referenceDate ?? new Date();
  const cutoffDays = options.cutoffDays ?? resolveRecencyCutoffDays();

  const kept: Job[] = [];
  const excluded: Job[] = [];
  const metrics: RecencyMetrics = {
    checked: 0,
    stale: 0,
    missingDate: 0,
    invalidDate: 0,
  };

  for (const job of jobs) {
    const assessment = classifyJobRecency(job, referenceDate, cutoffDays);
    metrics.checked++;

    if (assessment.classification === "stale") {
      metrics.stale++;
      excluded.push(job);
      continue;
    }

    if (assessment.dateState === "missing") {
      metrics.missingDate++;
    } else if (assessment.dateState === "invalid") {
      metrics.invalidDate++;
    }

    kept.push(job);
  }

  return { jobs: kept, excluded, metrics };
}

/**
 * Motivo objetivo do descarte por recência; null quando a vaga é preservada.
 *
 * @param job Vaga avaliada.
 * @param referenceDate Instante de referência da execução (padrão: agora).
 * @param cutoffDays Limite de recência em dias (padrão: configuração atual).
 */
export function recencyDiscardReason(
  job: Job,
  referenceDate: Date = new Date(),
  cutoffDays: number = resolveRecencyCutoffDays(),
): string | null {
  const assessment = classifyJobRecency(job, referenceDate, cutoffDays);

  if (assessment.classification !== "stale") {
    return null;
  }

  const age = assessment.ageDays ?? "?";
  return `vaga antiga: publicada há ${age} dia(s), acima do limite de ${cutoffDays} dia(s)`;
}
