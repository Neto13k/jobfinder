import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { JobAnalysis } from "./ai-analyzer.js";
import { generateJobKey } from "./deduplication.js";
import type { Job } from "../types/job.js";

// Histórico de vagas já analisadas (ignorado pelo Git).
const HISTORY_FILE = join(process.cwd(), "data", "analyzed-jobs.json");

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

// Lê o histórico; somente arquivo inexistente conta como lista vazia.
async function readHistory(): Promise<AnalyzedJobRecord[]> {
  let content: string;

  try {
    content = await readFile(HISTORY_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  // Arquivo existente porém vazio indica perda do histórico: não apaga nada.
  if (content.trim() === "") {
    throw new Error(
      `Histórico de análises vazio (possível perda de dados): ${HISTORY_FILE}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // Não sobrescreve nem apaga: apenas sinaliza o problema.
    throw new Error(
      `Histórico de análises corrompido (JSON inválido): ${HISTORY_FILE}`,
    );
  }

  if (!Array.isArray(data) || !data.every(isAnalyzedJobRecord)) {
    throw new Error(
      `Histórico de análises corrompido (formato inesperado): ${HISTORY_FILE}`,
    );
  }

  return data;
}

// Grava o histórico, criando a pasta quando necessário.
async function writeHistory(records: AnalyzedJobRecord[]): Promise<void> {
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await writeFile(
    HISTORY_FILE,
    `${JSON.stringify(records, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Indica se a vaga já foi analisada.
 *
 * @param job Vaga consultada.
 * @returns true quando a chave já consta no histórico de análises.
 */
export async function isJobAnalyzed(job: Job): Promise<boolean> {
  const records = await readHistory();

  return records.some((record) => record.key === generateJobKey(job));
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
  const records = await readHistory();

  return records.find((record) => record.key === generateJobKey(job));
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
  const records = await readHistory();
  const key = generateJobKey(job);

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

  await writeHistory(records);
}
