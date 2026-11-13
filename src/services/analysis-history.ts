import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { query } from "../db/postgres.js";
import type { JobAnalysis } from "./ai-analyzer.js";
import { generateJobKey } from "./deduplication.js";
import { getStorageBackend, withStorageLock } from "./storage.js";
import type { Job } from "../types/job.js";

// Histórico de vagas já analisadas no modo JSON (ignorado pelo Git).
const JSON_HISTORY_FILE = ["data", "analyzed-jobs.json"];

const DECISIONS: readonly JobAnalysis["decision"][] = [
  "compatible",
  "incompatible",
  "review",
];

const STATUSES: readonly JobAnalysis["locationStatus"][] = [
  "allowed",
  "blocked",
  "unknown",
];

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

/** Verifica se o valor tem o formato de um registro de análise. */
function isAnalyzedJobRecord(value: unknown): value is AnalyzedJobRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const score = record.score;

  return (
    typeof record.key === "string" &&
    record.key.trim() !== "" &&
    typeof record.reason === "string" &&
    record.reason.trim() !== "" &&
    typeof score === "number" &&
    Number.isInteger(score) &&
    score >= 0 &&
    score <= 100 &&
    typeof record.analyzedAt === "string" &&
    !Number.isNaN(Date.parse(record.analyzedAt)) &&
    DECISIONS.includes(record.decision as JobAnalysis["decision"]) &&
    STATUSES.includes(record.locationStatus as JobAnalysis["locationStatus"]) &&
    STATUSES.includes(record.contractStatus as JobAnalysis["contractStatus"])
  );
}

// Lê o histórico JSON; somente arquivo inexistente conta como lista vazia.
async function readJsonHistory(): Promise<AnalyzedJobRecord[]> {
  const file = join(process.cwd(), ...JSON_HISTORY_FILE);
  let content: string;

  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  // Arquivo existente porém vazio indica perda do histórico: não apaga nada.
  if (content.trim() === "") {
    throw new Error(
      `Histórico de análises vazio (possível perda de dados): ${file}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // Não sobrescreve nem apaga: apenas sinaliza o problema.
    throw new Error(
      `Histórico de análises corrompido (JSON inválido): ${file}`,
    );
  }

  if (!Array.isArray(data) || !data.every(isAnalyzedJobRecord)) {
    throw new Error(
      `Histórico de análises corrompido (formato inesperado): ${file}`,
    );
  }

  return data;
}

// Grava o histórico JSON, criando a pasta quando necessário.
async function writeJsonHistory(records: AnalyzedJobRecord[]): Promise<void> {
  const file = join(process.cwd(), ...JSON_HISTORY_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
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

  if (getStorageBackend() === "postgres") {
    const { rowCount } = await query(
      "select 1 from public.analyzed_jobs where key = $1 limit 1",
      [key],
    );
    return (rowCount ?? 0) > 0;
  }

  const records = await readJsonHistory();
  return records.some((record) => record.key === key);
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

  if (getStorageBackend() === "postgres") {
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

  const records = await readJsonHistory();
  return records.find((record) => record.key === key);
}

/**
 * Registra a vaga como analisada, preservando o resultado.
 *
 * Não marca a vaga como notificada; esse registro é separado.
 *
 * @param job Vaga analisada.
 * @param analysis Resultado estruturado da análise.
 */
export async function markJobAsAnalyzed(
  job: Job,
  analysis: JobAnalysis,
): Promise<void> {
  const key = generateJobKey(job);

  if (getStorageBackend() === "postgres") {
    // Idempotente: não sobrescreve uma análise já existente.
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
    return;
  }

  await withStorageLock(async () => {
    const records = await readJsonHistory();

    if (records.some((record) => record.key === key)) {
      return;
    }

    records.push({
      key,
      decision: analysis.decision,
      score: analysis.score,
      reason: analysis.reason,
      locationStatus: analysis.locationStatus,
      contractStatus: analysis.contractStatus,
      analyzedAt: new Date().toISOString(),
    });

    await writeJsonHistory(records);
  });
}
