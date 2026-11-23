import { query } from "../db/postgres.js";
import type { JobAnalysis } from "./ai-analyzer.js";
import { generateJobKey } from "./deduplication.js";
import type { Job } from "../types/job.js";

/** Registro persistido de uma vaga já analisada, com o resultado preservado. */
export interface AnalyzedJobRecord {
  key: string;
  decision: JobAnalysis["decision"];
  score: number;
  reason: string;
  locationStatus: JobAnalysis["locationStatus"];
  contractStatus: JobAnalysis["contractStatus"];
  analyzedAt: string;
}

/** Linha da tabela public.analyzed_jobs. */
interface AnalyzedJobRow {
  [column: string]: unknown;
  key: string;
  decision: string;
  score: number;
  reason: string;
  location_status: string;
  contract_status: string;
  analyzed_at: Date | string;
}

/** Converte uma linha do PostgreSQL no registro de análise. */
function rowToRecord(row: AnalyzedJobRow): AnalyzedJobRecord {
  return {
    key: row.key,
    decision: row.decision as JobAnalysis["decision"],
    score: Number(row.score),
    reason: row.reason,
    locationStatus: row.location_status as JobAnalysis["locationStatus"],
    contractStatus: row.contract_status as JobAnalysis["contractStatus"],
    analyzedAt: new Date(row.analyzed_at).toISOString(),
  };
}

/**
 * Indica se a vaga já foi analisada.
 *
 * @param job Vaga consultada.
 * @returns true quando a chave já consta no histórico de análises.
 */
export async function isJobAnalyzed(job: Job): Promise<boolean> {
  const key = generateJobKey(job);
  const { rowCount } = await query(
    "select 1 from public.analyzed_jobs where key = $1 limit 1",
    [key],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Retorna o resultado preservado da análise, quando existir.
 *
 * Útil para inspecionar vagas incompatíveis ou marcadas para revisão.
 *
 * @param job Vaga consultada.
 * @returns O registro da análise ou undefined se ainda não analisada.
 */
export async function getAnalyzedJob(
  job: Job,
): Promise<AnalyzedJobRecord | undefined> {
  const key = generateJobKey(job);
  const { rows } = await query<AnalyzedJobRow>(
    `select key, decision, score, reason,
            location_status, contract_status, analyzed_at
       from public.analyzed_jobs
      where key = $1
      limit 1`,
    [key],
  );

  return rows[0] ? rowToRecord(rows[0]) : undefined;
}

/**
 * Registra a vaga como analisada, preservando o resultado.
 *
 * Não marca a vaga como notificada; esse registro é separado.
 * A inserção é idempotente: uma análise já existente não é sobrescrita.
 *
 * @param job Vaga analisada.
 * @param analysis Resultado estruturado da análise.
 */
export async function markJobAsAnalyzed(
  job: Job,
  analysis: JobAnalysis,
): Promise<void> {
  const key = generateJobKey(job);

  await query(
    `insert into public.analyzed_jobs
       (key, decision, score, reason, location_status, contract_status)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (key) do nothing`,
    [
      key,
      analysis.decision,
      analysis.score,
      analysis.reason,
      analysis.locationStatus,
      analysis.contractStatus,
    ],
  );
}
