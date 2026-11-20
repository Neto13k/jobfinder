import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { query } from "../db/postgres.js";
import {
  ANALYSIS_CRITERIA_VERSION,
  type AnalysisStatus,
  type JobAnalysis,
} from "./ai-analyzer.js";
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
  seniorityStatus: JobAnalysis["seniorityStatus"];
  technologiesStatus: JobAnalysis["technologiesStatus"];
  locationStatus: JobAnalysis["locationStatus"];
  contractStatus: JobAnalysis["contractStatus"];
  analyzedAt: string;
  /** Versão dos critérios que produziu a análise; null em registros legados. */
  criteriaVersion: string | null;
}

/** Linha da tabela public.analyzed_jobs. */
interface AnalyzedJobRow {
  [column: string]: unknown;
  key: string;
  decision: string;
  score: number;
  reason: string;
  seniority_status: string;
  technologies_status: string;
  location_status: string;
  contract_status: string;
  analyzed_at: Date | string;
  criteria_version: string | null;
}

/** Verifica se o valor é um status de critério válido. */
function isStatus(value: unknown): value is AnalysisStatus {
  return typeof value === "string" && STATUSES.includes(value as AnalysisStatus);
}

/**
 * Refina um valor desconhecido para um status válido (`AnalysisStatus`).
 *
 * Ausente (`undefined`), devolve o `fallback` informado — usado pelos registros
 * legados, anteriores aos quatro critérios. Presente porém fora do domínio,
 * devolve `undefined`. Não usa `any` nem conversões de tipo, preservando a
 * validação rigorosa do histórico.
 *
 * @param value Valor bruto lido do registro.
 * @param fallback Status padrão quando o valor está ausente.
 * @returns O status validado ou `undefined` quando inválido.
 */
function toStatus(
  value: unknown,
  fallback?: AnalysisStatus,
): AnalysisStatus | undefined {
  if (value === undefined) {
    return fallback;
  }

  return isStatus(value) ? value : undefined;
}

/**
 * Normaliza um registro persistido no histórico JSON.
 *
 * Registros legados (anteriores aos quatro critérios) não possuem
 * `seniorityStatus` nem `technologiesStatus`; quando ausentes, são
 * normalizados como `"unknown"` — classificação conservadora que exige
 * revisão — preservando a `decision` e a `criteriaVersion` originais. Valores
 * presentes porém inválidos continuam sendo rejeitados, para não enfraquecer a
 * validação do histórico.
 *
 * @param value Registro bruto lido do histórico.
 * @returns O registro normalizado ou `undefined` quando o formato é inválido.
 */
function normalizeAnalyzedJobRecord(
  value: unknown,
): AnalyzedJobRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const score = record.score;
  const version = record.criteriaVersion;

  // A versão é opcional: ausente ou null identifica um registro legado.
  const versionValid =
    version === undefined ||
    version === null ||
    (typeof version === "string" && version.trim() !== "");

  const valid =
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
    versionValid;

  if (!valid) {
    return undefined;
  }

  // Critérios validados por type guard, refinando de `unknown` para
  // `AnalysisStatus`. Ausentes (registros legados) viram "unknown".
  const seniorityStatus = toStatus(record.seniorityStatus, "unknown");
  const technologiesStatus = toStatus(record.technologiesStatus, "unknown");
  const locationStatus = toStatus(record.locationStatus);
  const contractStatus = toStatus(record.contractStatus);

  if (
    seniorityStatus === undefined ||
    technologiesStatus === undefined ||
    locationStatus === undefined ||
    contractStatus === undefined
  ) {
    return undefined;
  }

  return {
    key: record.key as string,
    decision: record.decision as JobAnalysis["decision"],
    score,
    reason: record.reason as string,
    seniorityStatus,
    technologiesStatus,
    locationStatus,
    contractStatus,
    analyzedAt: record.analyzedAt as string,
    criteriaVersion: version as string | null,
  };
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

  if (!Array.isArray(data)) {
    throw new Error(
      `Histórico de análises corrompido (formato inesperado): ${file}`,
    );
  }

  const records: AnalyzedJobRecord[] = [];
  for (const item of data) {
    const record = normalizeAnalyzedJobRecord(item);
    if (!record) {
      throw new Error(
        `Histórico de análises corrompido (formato inesperado): ${file}`,
      );
    }

    records.push(record);
  }

  return records;
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
    seniorityStatus: row.seniority_status as JobAnalysis["seniorityStatus"],
    technologiesStatus:
      row.technologies_status as JobAnalysis["technologiesStatus"],
    locationStatus: row.location_status as JobAnalysis["locationStatus"],
    contractStatus: row.contract_status as JobAnalysis["contractStatus"],
    analyzedAt: new Date(row.analyzed_at).toISOString(),
    criteriaVersion:
      typeof row.criteria_version === "string" ? row.criteria_version : null,
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
 * Retorna o resultado da análise mais recente da vaga, quando existir.
 *
 * Como o histórico preserva uma linha por versão de critérios, devolve sempre
 * a versão mais recente. Útil para inspecionar vagas incompatíveis ou marcadas
 * para revisão.
 *
 * @param job Vaga consultada.
 * @returns O registro mais recente ou undefined se ainda não analisada.
 */
export async function getAnalyzedJob(
  job: Job,
): Promise<AnalyzedJobRecord | undefined> {
  const key = generateJobKey(job);

  if (getStorageBackend() === "postgres") {
    const { rows } = await query<AnalyzedJobRow>(
      `select key, decision, score, reason,
              seniority_status, technologies_status,
              location_status, contract_status, analyzed_at, criteria_version
         from public.analyzed_jobs
        where key = $1
        order by analyzed_at desc
        limit 1`,
      [key],
    );

    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  const records = await readJsonHistory();
  return records
    .filter((record) => record.key === key)
    .reduce<AnalyzedJobRecord | undefined>(
      (latest, record) =>
        !latest || record.analyzedAt > latest.analyzedAt ? record : latest,
      undefined,
    );
}

/**
 * Retorna a análise armazenada apenas quando ela foi produzida com a versão
 * vigente dos critérios.
 *
 * Análises de versões anteriores — inclusive registros legados, sem versão —
 * são ignoradas para forçar a reanálise. Os resultados antigos permanecem
 * armazenados, apenas não são reutilizados.
 *
 * @param job Vaga consultada.
 * @returns O registro da versão vigente ou undefined se precisar reanalisar.
 */
export async function getReusableAnalysis(
  job: Job,
): Promise<AnalyzedJobRecord | undefined> {
  const key = generateJobKey(job);

  if (getStorageBackend() === "postgres") {
    const { rows } = await query<AnalyzedJobRow>(
      `select key, decision, score, reason,
              seniority_status, technologies_status,
              location_status, contract_status, analyzed_at, criteria_version
         from public.analyzed_jobs
        where key = $1 and criteria_version = $2
        limit 1`,
      [key, ANALYSIS_CRITERIA_VERSION],
    );

    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  const records = await readJsonHistory();
  return records.find(
    (record) =>
      record.key === key &&
      record.criteriaVersion === ANALYSIS_CRITERIA_VERSION,
  );
}

/**
 * Registra a análise da vaga para a versão vigente dos critérios.
 *
 * A idempotência é por vaga **e** versão: se já existir uma análise da versão
 * vigente, ela é preservada (nada é sobrescrito). Se a vaga já possuir análises
 * de versões anteriores, essas permanecem intactas e um novo registro é
 * acrescentado — nenhum resultado antigo é apagado ou alterado.
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
    // Acrescenta a análise da versão vigente. O conflito por (key, versão)
    // preserva qualquer resultado já gravado para o mesmo par (idempotente).
    await query(
      `insert into public.analyzed_jobs
         (key, decision, score, reason, seniority_status, technologies_status,
          location_status, contract_status, criteria_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (key, criteria_version) do nothing`,
      [
        key,
        analysis.decision,
        analysis.score,
        analysis.reason,
        analysis.seniorityStatus,
        analysis.technologiesStatus,
        analysis.locationStatus,
        analysis.contractStatus,
        ANALYSIS_CRITERIA_VERSION,
      ],
    );
    return;
  }

  await withStorageLock(async () => {
    const records = await readJsonHistory();
    const existing = records.find(
      (record) =>
        record.key === key &&
        record.criteriaVersion === ANALYSIS_CRITERIA_VERSION,
    );

    // Já existe análise da versão vigente: preserva o resultado (idempotente).
    if (existing) {
      return;
    }

    // Acrescenta um novo registro para a versão vigente, sem alterar nem
    // excluir os resultados de versões anteriores.
    records.push({
      key,
      decision: analysis.decision,
      score: analysis.score,
      reason: analysis.reason,
      seniorityStatus: analysis.seniorityStatus,
      technologiesStatus: analysis.technologiesStatus,
      locationStatus: analysis.locationStatus,
      contractStatus: analysis.contractStatus,
      analyzedAt: new Date().toISOString(),
      criteriaVersion: ANALYSIS_CRITERIA_VERSION,
    });

    await writeJsonHistory(records);
  });
}
