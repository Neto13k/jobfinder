import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { deduplicateJobs, generateJobKey } from "./deduplication.js";
import { filterDeveloperJobs } from "./job-filter.js";
import { prioritizeJobs } from "./job-priority.js";
import {
  classifyJobLocation,
  filterByLocation,
  type JobLocation,
} from "./location-filter.js";
import { filterBySeniority } from "./seniority-filter.js";
import type { Job } from "../types/job.js";

/** Etapa do pipeline que descartou a vaga. */
export type AuditDiscardStage = "developer" | "seniority" | "location";

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
  /** Etapa que descartou a vaga; null quando aprovada nos filtros. */
  discardStage: AuditDiscardStage | null;
  /** Classificação geográfica; null quando a vaga não chegou à etapa de localização. */
  locationClassification: JobLocation | null;
  /** Posição (1-based) na fila de análise; null quando não aprovada. */
  queuePosition: number | null;
}

/** Resumo agregado do relatório de auditoria. */
export interface AuditReport {
  generatedAt: string;
  totalCollected: number;
  collectedByProvider: Record<string, number>;
  duplicates: number;
  discarded: {
    developer: number;
    seniority: number;
    location: number;
  };
  approved: number;
  uniqueJobs: number;
  locationDistribution: Record<JobLocation, number>;
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
  locationClassification: JobLocation | null,
  queuePosition: number | null,
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
    discardStage,
    locationClassification,
    queuePosition,
  };
}

/**
 * Executa a triagem atual (deduplicação, filtros e priorização) sobre as vagas
 * coletadas e monta o relatório de auditoria.
 *
 * Reutiliza as MESMAS funções puras do pipeline, sem alterar nenhuma regra. Não
 * chama a IA, não consulta nem grava históricos e não acessa Supabase ou
 * Telegram. Inclui TODAS as vagas únicas, sem limitar a quantidade de exemplos.
 *
 * @param jobs Todas as vagas coletadas (antes da deduplicação).
 * @param referenceDate Instante de referência da priorização (padrão: agora);
 *   injetável para relatórios determinísticos.
 * @returns Relatório de auditoria pronto para serialização.
 */
export function buildAuditReport(
  jobs: Job[],
  referenceDate: Date = new Date(),
): AuditReport {
  const collectedByProvider: Record<string, number> = {};
  for (const job of jobs) {
    collectedByProvider[job.source] = (collectedByProvider[job.source] ?? 0) + 1;
  }

  // Mesma sequência do pipeline normal, sobre as mesmas funções puras.
  const uniqueJobs = deduplicateJobs(jobs);
  const developerJobs = filterDeveloperJobs(uniqueJobs);
  const seniorityJobs = filterBySeniority(developerJobs);
  const eligibleJobs = filterByLocation(seniorityJobs);
  const prioritizedJobs = prioritizeJobs(eligibleJobs, referenceDate);

  // Conjuntos por identidade de objeto (os filtros preservam as referências).
  const developerSet = new Set(developerJobs);
  const senioritySet = new Set(seniorityJobs);
  const eligibleSet = new Set(eligibleJobs);

  // Posição (1-based) na fila de análise.
  const queuePositions = new Map<Job, number>();
  prioritizedJobs.forEach((job, index) => queuePositions.set(job, index + 1));

  // Classificação geográfica apenas para quem chegou à etapa de localização.
  const locationByJob = new Map<Job, JobLocation>();
  for (const job of seniorityJobs) {
    locationByJob.set(job, classifyJobLocation(job));
  }

  const locationDistribution: Record<JobLocation, number> = {
    allowed: 0,
    blocked: 0,
    unknown: 0,
  };

  const discarded = { developer: 0, seniority: 0, location: 0 };

  const entries: AuditJobEntry[] = uniqueJobs.map((job) => {
    let discardStage: AuditDiscardStage | null = null;

    if (!developerSet.has(job)) {
      discardStage = "developer";
      discarded.developer++;
    } else if (!senioritySet.has(job)) {
      discardStage = "seniority";
      discarded.seniority++;
    } else if (!eligibleSet.has(job)) {
      discardStage = "location";
      discarded.location++;
    }

    const locationClassification = locationByJob.get(job) ?? null;
    if (locationClassification) {
      locationDistribution[locationClassification]++;
    }

    return toEntry(
      job,
      discardStage,
      locationClassification,
      queuePositions.get(job) ?? null,
    );
  });

  return {
    generatedAt: referenceDate.toISOString(),
    totalCollected: jobs.length,
    collectedByProvider,
    duplicates: jobs.length - uniqueJobs.length,
    discarded,
    approved: eligibleJobs.length,
    uniqueJobs: uniqueJobs.length,
    locationDistribution,
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
 * @param options Instante de referência e diretório de saída (injetáveis).
 * @returns O relatório e o caminho do arquivo gravado.
 */
export async function runAudit(
  jobs: Job[],
  options: { referenceDate?: Date; directory?: string } = {},
): Promise<AuditRunResult> {
  const report = buildAuditReport(jobs, options.referenceDate);
  const filePath = await writeAuditReport(report, options.directory);

  return { report, filePath };
}
