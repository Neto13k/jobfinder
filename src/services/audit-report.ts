import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  deduplicateJobs,
  generateJobKey,
  groupEquivalentJobs,
} from "./deduplication.js";
import {
  classifyJobContract,
  contractDiscardReason,
  filterByContract,
  type JobContract,
} from "./contract-filter.js";
import { developerDiscardReason, filterDeveloperJobs } from "./job-filter.js";
import {
  prioritizeJobs,
  scoreJob,
  type JobPriorityScore,
} from "./job-priority.js";
import {
  classifyJobLocation,
  filterByLocation,
  locationDiscardReason,
  type JobLocation,
} from "./location-filter.js";
import {
  filterBySeniority,
  seniorityDiscardReason,
} from "./seniority-filter.js";
import {
  filterByRecency,
  recencyDiscardReason,
  resolveRecencyCutoffDays,
  type RecencyMetrics,
} from "./recency-filter.js";
import type { Job, JobWorkplaceType } from "../types/job.js";

/** Etapa do pipeline que descartou a vaga. */
export type AuditDiscardStage =
  | "developer"
  | "seniority"
  | "location"
  | "contract"
  | "recency";

/** Uma vaga única coletada, com o desfecho na triagem atual. */
export interface AuditJobEntry {
  key: string;
  id: string;
  source: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  description: string;
  url: string;
  /** Data de publicação; null quando ausente (serializa igual em memória e disco). */
  publishedAt: string | null;
  /** Modalidade estruturada da fonte; null quando ausente. */
  workplaceType: JobWorkplaceType | null;
  /** Tipos de contratação informados pela fonte; vazio quando ausentes. */
  contractTypes: string[];
  /** Localidades adicionais informadas pela fonte; vazio quando ausentes. */
  additionalLocations: string[];
  /** Etapa que descartou a vaga; null quando aprovada nos filtros. */
  discardStage: AuditDiscardStage | null;
  /** Motivo objetivo do descarte; null quando a vaga não foi descartada. */
  discardReason: string | null;
  /** Classificação geográfica; null quando a vaga não chegou à etapa de localização. */
  locationClassification: JobLocation | null;
  /** Classificação contratual; null quando a vaga não chegou à etapa de contratação. */
  contractClassification: JobContract | null;
  /**
   * Chave "source:id" do anúncio mantido quando esta vaga foi agrupada por
   * equivalência; null quando a vaga é representante ou não foi agrupada.
   */
  equivalentGroup: string | null;
  /** Posição (1-based) na fila de análise; null quando não aprovada. */
  queuePosition: number | null;
  /** Pontuação total de priorização (0–100); null quando não aprovada. */
  priorityScore: number | null;
  /** Pontuação por critério; null quando a vaga não foi aprovada. */
  priorityBreakdown: {
    stack: number;
    seniority: number;
    location: number;
    recency: number;
    contract: number;
  } | null;
}

/** Referência de um anúncio agrupado por equivalência, preservada para auditoria. */
export interface AuditEquivalentMember {
  key: string;
  id: string;
  source: string;
  url: string;
  location: string;
}

/** Grupo de anúncios equivalentes (mesma vaga anunciada em mais de um registro). */
export interface AuditEquivalentGroup {
  /** Chave "source:id" do anúncio mantido como representante do grupo. */
  representativeKey: string;
  /** Anúncios removidos por equivalência com o representante. */
  members: AuditEquivalentMember[];
}

/** Resumo agregado do relatório de auditoria. */
export interface AuditReport {
  generatedAt: string;
  totalCollected: number;
  collectedByProvider: Record<string, number>;
  /** Duplicidades por identidade ("source:id"). */
  duplicates: number;
  /** Anúncios removidos por equivalência (mesma vaga em registros distintos). */
  groupedByEquivalence: number;
  discarded: {
    developer: number;
    seniority: number;
    location: number;
    contract: number;
    recency: number;
  };
  approved: number;
  uniqueJobs: number;
  locationDistribution: Record<JobLocation, number>;
  contractDistribution: Record<JobContract, number>;
  /** Métricas do filtro de recência (verificadas, antigas e preservadas). */
  recencyMetrics: RecencyMetrics;
  /** Grupos de anúncios equivalentes, com identificadores e URLs para auditoria. */
  equivalentGroups: AuditEquivalentGroup[];
  jobs: AuditJobEntry[];
}

/** Resultado de uma auditoria: o relatório e o caminho do arquivo gravado. */
export interface AuditRunResult {
  report: AuditReport;
  filePath: string;
}

/** Diretório padrão dos relatórios, relativo ao cwd (ignorado pelo Git). */
const DEFAULT_AUDIT_DIR = ["data", "audit"];

/**
 * Converte o instante de execução em um nome de arquivo seguro.
 *
 * Substitui `:` e `.` do ISO 8601 por `-`, mantendo a ordenação cronológica.
 */
function auditFileName(date: Date): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}.json`;
}

/** Monta a entrada de uma vaga para o relatório, sem credenciais nem ambiente. */
function toEntry(
  job: Job,
  discardStage: AuditDiscardStage | null,
  discardReason: string | null,
  locationClassification: JobLocation | null,
  contractClassification: JobContract | null,
  queuePosition: number | null,
  equivalentGroup: string | null,
  priority: JobPriorityScore | null,
): AuditJobEntry {
  return {
    key: generateJobKey(job),
    id: job.id,
    source: job.source,
    title: job.title,
    company: job.company,
    location: job.location,
    remote: job.remote,
    description: job.description,
    url: job.url,
    publishedAt: job.publishedAt ?? null,
    // Campos estruturados: null/[] quando ausentes, para manter a chave presente
    // e a serialização idêntica em memória e disco.
    workplaceType: job.workplaceType ?? null,
    contractTypes: job.contractTypes ?? [],
    additionalLocations: job.additionalLocations ?? [],
    discardStage,
    discardReason,
    locationClassification,
    contractClassification,
    equivalentGroup,
    queuePosition,
    // Pontuação registrada apenas para as vagas aprovadas (com posição na fila).
    priorityScore: priority?.total ?? null,
    priorityBreakdown: priority
      ? {
          stack: priority.stack,
          seniority: priority.seniority,
          location: priority.location,
          recency: priority.recency,
          contract: priority.contract,
        }
      : null,
  };
}

/**
 * Executa a triagem atual (deduplicação, agrupamento por equivalência, filtros
 * e priorização) sobre as vagas coletadas e monta o relatório de auditoria.
 *
 * Reutiliza as MESMAS funções puras do pipeline, sem alterar nenhuma regra. Não
 * chama a IA, não consulta nem grava históricos e não acessa Supabase ou
 * Telegram. Inclui TODOS os registros únicos ("source:id"), inclusive os
 * agrupados por equivalência, sem limitar a quantidade de exemplos.
 *
 * @param jobs Todas as vagas coletadas (antes da deduplicação).
 * @param referenceDate Instante de referência da priorização (padrão: agora);
 *   injetável para relatórios determinísticos.
 * @returns Relatório de auditoria pronto para serialização.
 */
export function buildAuditReport(
  jobs: Job[],
  referenceDate: Date = new Date(),
  cutoffDays: number = resolveRecencyCutoffDays(),
): AuditReport {
  const collectedByProvider: Record<string, number> = {};
  for (const job of jobs) {
    collectedByProvider[job.source] = (collectedByProvider[job.source] ?? 0) + 1;
  }

  // Mesma sequência do pipeline normal, sobre as mesmas funções puras.
  const identityUnique = deduplicateJobs(jobs);
  const { jobs: uniqueJobs, groups: equivalenceGroups } =
    groupEquivalentJobs(identityUnique);
  const developerJobs = filterDeveloperJobs(uniqueJobs);
  const seniorityJobs = filterBySeniority(developerJobs);
  const eligibleJobs = filterByLocation(seniorityJobs);
  const contractJobs = filterByContract(eligibleJobs);
  // Recência: mesma regra pura do pipeline, aplicada antes da priorização.
  const { jobs: recentJobs, metrics: recencyMetrics } = filterByRecency(
    contractJobs,
    { referenceDate, cutoffDays },
  );
  const prioritizedJobs = prioritizeJobs(recentJobs, referenceDate);

  // Conjuntos por identidade de objeto (os filtros preservam as referências).
  const developerSet = new Set(developerJobs);
  const senioritySet = new Set(seniorityJobs);
  const eligibleSet = new Set(eligibleJobs);
  const contractSet = new Set(contractJobs);
  const recencySet = new Set(recentJobs);

  // Anúncios agrupados: chave própria → chave do representante do grupo.
  const groupedInto = new Map<string, string>();
  for (const group of equivalenceGroups) {
    for (const member of group.members) {
      groupedInto.set(member.key, group.representativeKey);
    }
  }

  // Posição (1-based) na fila de análise e pontuação de priorização.
  const queuePositions = new Map<Job, number>();
  const scoresByJob = new Map<Job, JobPriorityScore>();
  prioritizedJobs.forEach((job, index) => {
    queuePositions.set(job, index + 1);
    scoresByJob.set(job, scoreJob(job, referenceDate));
  });

  // Classificação geográfica apenas para quem chegou à etapa de localização.
  const locationByJob = new Map<Job, JobLocation>();
  for (const job of seniorityJobs) {
    locationByJob.set(job, classifyJobLocation(job));
  }

  // Classificação contratual apenas para quem chegou à etapa de contratação.
  const contractByJob = new Map<Job, JobContract>();
  for (const job of eligibleJobs) {
    contractByJob.set(job, classifyJobContract(job));
  }

  const locationDistribution: Record<JobLocation, number> = {
    allowed: 0,
    blocked: 0,
    unknown: 0,
  };

  const contractDistribution: Record<JobContract, number> = {
    allowed: 0,
    blocked: 0,
    unknown: 0,
  };

  const discarded = {
    developer: 0,
    seniority: 0,
    location: 0,
    contract: 0,
    recency: 0,
  };

  // Uma entrada por registro único ("source:id"), incluindo os anúncios
  // agrupados por equivalência — nenhum registro original é perdido.
  const entries: AuditJobEntry[] = identityUnique.map((job) => {
    const representativeKey = groupedInto.get(generateJobKey(job)) ?? null;

    // Anúncio agrupado: não percorre os filtros; aponta para o representante.
    if (representativeKey) {
      return toEntry(job, null, null, null, null, null, representativeKey, null);
    }

    let discardStage: AuditDiscardStage | null = null;
    let discardReason: string | null = null;

    if (!developerSet.has(job)) {
      discardStage = "developer";
      discardReason = developerDiscardReason(job);
      discarded.developer++;
    } else if (!senioritySet.has(job)) {
      discardStage = "seniority";
      discardReason = seniorityDiscardReason(job);
      discarded.seniority++;
    } else if (!eligibleSet.has(job)) {
      discardStage = "location";
      discardReason = locationDiscardReason(job);
      discarded.location++;
    } else if (!contractSet.has(job)) {
      discardStage = "contract";
      discardReason = contractDiscardReason(job);
      discarded.contract++;
    } else if (!recencySet.has(job)) {
      discardStage = "recency";
      discardReason = recencyDiscardReason(job, referenceDate, cutoffDays);
      discarded.recency++;
    }

    const locationClassification = locationByJob.get(job) ?? null;
    if (locationClassification) {
      locationDistribution[locationClassification]++;
    }

    const contractClassification = contractByJob.get(job) ?? null;
    if (contractClassification) {
      contractDistribution[contractClassification]++;
    }

    return toEntry(
      job,
      discardStage,
      discardReason,
      locationClassification,
      contractClassification,
      queuePositions.get(job) ?? null,
      null,
      scoresByJob.get(job) ?? null,
    );
  });

  const equivalentAuditGroups: AuditEquivalentGroup[] = equivalenceGroups.map(
    (group) => ({
      representativeKey: group.representativeKey,
      members: group.members.map((member) => ({
        key: member.key,
        id: member.id,
        source: member.source,
        url: member.url,
        location: member.location,
      })),
    }),
  );

  // Consistência: totalCollected = duplicates + groupedByEquivalence +
  // approved + Σ discarded.
  return {
    generatedAt: referenceDate.toISOString(),
    totalCollected: jobs.length,
    collectedByProvider,
    duplicates: jobs.length - identityUnique.length,
    groupedByEquivalence: identityUnique.length - uniqueJobs.length,
    discarded,
    approved: recentJobs.length,
    uniqueJobs: identityUnique.length,
    locationDistribution,
    contractDistribution,
    recencyMetrics,
    equivalentGroups: equivalentAuditGroups,
    jobs: entries,
  };
}

/**
 * Serializa o relatório em `data/audit/` (diretório ignorado pelo Git).
 *
 * @param report Relatório a gravar.
 * @param directory Diretório de saída (padrão: `data/audit` relativo ao cwd).
 * @returns Caminho do arquivo gravado.
 */
export async function writeAuditReport(
  report: AuditReport,
  directory: string = join(process.cwd(), ...DEFAULT_AUDIT_DIR),
): Promise<string> {
  await mkdir(directory, { recursive: true });

  const file = join(directory, auditFileName(new Date(report.generatedAt)));
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return file;
}

/**
 * Executa a auditoria completa: monta o relatório e o grava em `data/audit/`.
 *
 * @param jobs Todas as vagas coletadas.
 * @param options Instante de referência, limite de recência e diretório de saída
 *   (injetáveis nos testes).
 * @returns O relatório e o caminho do arquivo gravado.
 */
export async function runAudit(
  jobs: Job[],
  options: { referenceDate?: Date; directory?: string; cutoffDays?: number } = {},
): Promise<AuditRunResult> {
  const report = buildAuditReport(jobs, options.referenceDate, options.cutoffDays);
  const filePath = await writeAuditReport(report, options.directory);

  return { report, filePath };
}
