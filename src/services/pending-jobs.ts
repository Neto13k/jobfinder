import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { query, withTransaction } from "../db/postgres.js";
import { generateJobKey, isJobNotified } from "./deduplication.js";
import { getStorageBackend, withStorageLock } from "./storage.js";
import type { Job, JobWorkplaceType } from "../types/job.js";

// Fila de vagas pendentes no modo JSON (relativo ao cwd) — ignorada pelo Git.
const JSON_PENDING_FILE = ["data", "pending-jobs.json"];

// Chave fixa do advisory lock transacional que serializa a reconciliação da
// fila entre execuções concorrentes (distinta da chave da cota). No PostgreSQL,
// a leitura-modificação-escrita da fila ocorre dentro de uma transação, de modo
// que duas execuções não percam nem dupliquem pendências.
const PENDING_LOCK_KEY = 4_923_005_312;

/**
 * Motivo pelo qual uma vaga elegível permaneceu pendente nesta execução.
 *
 * - `analysis_limit`: barrada pelo limite de análises da execução (o histórico
 *   foi consultado, mas a vaga não pôde ser analisada nem percorrida).
 * - `gemini_unavailable`: falha da IA que exige nova tentativa — indisponibilidade,
 *   rede, autenticação, cota/tokens esgotados, orçamento (de requisições ou de
 *   tempo) excedido, resposta vazia/estruturalmente inválida do lote ou vaga
 *   sem resultado válido. Inclui as vagas do PRÓPRIO lote que falhou, além das
 *   posteriores ao bloqueio.
 * - `notification_limit`: já analisada e notificável, mas sem envio
 *   EXCLUSIVAMENTE pelo limite de notificações da execução.
 */
export type PendingJobReason =
  | "analysis_limit"
  | "gemini_unavailable"
  | "notification_limit";

const REASONS: readonly PendingJobReason[] = [
  "analysis_limit",
  "gemini_unavailable",
  "notification_limit",
];

const WORKPLACE_TYPES: readonly JobWorkplaceType[] = [
  "remote",
  "hybrid",
  "onsite",
  "unknown",
];

/**
 * Registro persistido de uma vaga pendente.
 *
 * Guarda o objeto {@link Job} COMPLETO (e não apenas a chave) para que a vaga
 * seja recuperada mesmo quando a fonte NÃO a coleta novamente. `firstSeenAt`
 * marca a entrada na fila (base da expiração por TTL) e `updatedAt` a última
 * atualização.
 */
export interface PendingJobRecord {
  key: string;
  job: Job;
  reason: PendingJobReason;
  firstSeenAt: string;
  updatedAt: string;
}

/** Vaga a persistir como pendente, com o motivo desta execução. */
export interface PendingJobInput {
  job: Job;
  reason: PendingJobReason;
}

/** Linha da tabela public.pending_jobs. */
interface PendingJobRow {
  [column: string]: unknown;
  key: string;
  job: unknown;
  reason: string;
  first_seen_at: Date | string;
  updated_at: Date | string;
}

/** Dias, por padrão, antes de uma pendência ser considerada obsoleta. */
export const DEFAULT_PENDING_TTL_DAYS = 7;

/** Número máximo de pendências persistidas, por padrão. */
export const DEFAULT_PENDING_MAX_JOBS = 200;

/** Configuração da fila de vagas pendentes. */
export interface PendingJobsConfig {
  /** Liga/desliga a persistência de pendências (padrão: ligada). */
  enabled: boolean;
  /** Idade máxima de uma pendência antes de ser considerada obsoleta (ms). */
  ttlMs: number;
  /** Teto de pendências persistidas (as mais antigas são descartadas). */
  maxJobs: number;
}

/**
 * Lê um inteiro estrito de uma variável de ambiente, com valor mínimo.
 *
 * Aceita apenas dígitos (sem sinal, fração ou texto extra). Valores ausentes ou
 * inválidos recorrem ao padrão seguro.
 */
function parseStrictInt(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  const trimmed = raw?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) {
    return fallback;
  }

  const value = Number(trimmed);
  return Number.isInteger(value) && value >= min ? value : fallback;
}

/**
 * Resolve a configuração da fila de pendências a partir do ambiente.
 *
 * `JOBFINDER_PENDING_JOBS_ENABLED` (padrão "true"), `JOBFINDER_PENDING_JOB_TTL_DAYS`
 * (padrão 7, mínimo 1) e `JOBFINDER_PENDING_MAX_JOBS` (padrão 200, mínimo 1).
 * Valores inválidos recorrem ao padrão seguro.
 *
 * @param env Ambiente consultado (padrão: `process.env`).
 * @returns A configuração validada.
 */
export function resolvePendingJobsConfig(
  env: NodeJS.ProcessEnv = process.env,
): PendingJobsConfig {
  const enabled =
    (env.JOBFINDER_PENDING_JOBS_ENABLED ?? "true").trim().toLowerCase() !==
    "false";
  const ttlDays = parseStrictInt(
    env.JOBFINDER_PENDING_JOB_TTL_DAYS,
    DEFAULT_PENDING_TTL_DAYS,
    1,
  );
  const maxJobs = parseStrictInt(
    env.JOBFINDER_PENDING_MAX_JOBS,
    DEFAULT_PENDING_MAX_JOBS,
    1,
  );

  return { enabled, ttlMs: ttlDays * 24 * 60 * 60 * 1_000, maxJobs };
}

/** Verifica se o valor é uma modalidade de trabalho válida. */
function isWorkplaceType(value: unknown): value is JobWorkplaceType {
  return (
    typeof value === "string" &&
    WORKPLACE_TYPES.includes(value as JobWorkplaceType)
  );
}

/** Verifica se o valor é uma lista de strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Valida e normaliza um objeto de vaga lido da fila.
 *
 * Exige os campos essenciais e coerência de tipos; os campos opcionais são
 * copiados apenas quando válidos. Não usa `any` nem conversões que contornem a
 * validação (mesmo rigor dos históricos).
 *
 * @param value Valor bruto lido do registro.
 * @returns A vaga validada ou `undefined` quando o formato é inválido.
 */
function normalizeJob(value: unknown): Job | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  const valid =
    typeof record.id === "string" &&
    record.id.trim() !== "" &&
    typeof record.title === "string" &&
    typeof record.company === "string" &&
    typeof record.location === "string" &&
    typeof record.remote === "boolean" &&
    typeof record.description === "string" &&
    typeof record.url === "string" &&
    typeof record.source === "string" &&
    record.source.trim() !== "";

  if (!valid) {
    return undefined;
  }

  const job: Job = {
    id: record.id as string,
    title: record.title as string,
    company: record.company as string,
    location: record.location as string,
    remote: record.remote as boolean,
    description: record.description as string,
    url: record.url as string,
    source: record.source as string,
  };

  if (typeof record.publishedAt === "string") {
    job.publishedAt = record.publishedAt;
  }
  if (isWorkplaceType(record.workplaceType)) {
    job.workplaceType = record.workplaceType;
  }
  if (isStringArray(record.contractTypes)) {
    job.contractTypes = [...record.contractTypes];
  }
  if (isStringArray(record.additionalLocations)) {
    job.additionalLocations = [...record.additionalLocations];
  }

  return job;
}

/**
 * Valida e normaliza um registro pendente.
 *
 * A chave precisa ser coerente com a vaga (`source:id`), impedindo que um
 * registro adulterado seja recuperado sob uma chave errada.
 *
 * @param value Valor bruto lido do registro.
 * @returns O registro normalizado ou `undefined` quando inválido.
 */
function normalizePendingRecord(value: unknown): PendingJobRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const job = normalizeJob(record.job);
  const firstSeenAt = record.firstSeenAt;
  const updatedAt = record.updatedAt;

  const valid =
    typeof record.key === "string" &&
    REASONS.includes(record.reason as PendingJobReason) &&
    job !== undefined &&
    typeof firstSeenAt === "string" &&
    !Number.isNaN(Date.parse(firstSeenAt)) &&
    typeof updatedAt === "string" &&
    !Number.isNaN(Date.parse(updatedAt)) &&
    record.key === generateJobKey(job);

  if (!valid) {
    return undefined;
  }

  return {
    key: record.key as string,
    job: job as Job,
    reason: record.reason as PendingJobReason,
    firstSeenAt: firstSeenAt as string,
    updatedAt: updatedAt as string,
  };
}

/**
 * Converte um timestamp do PostgreSQL (`Date` ou string) em ISO 8601.
 *
 * @param value Valor bruto da coluna.
 * @returns A data em ISO ou `undefined` quando inválida.
 */
function toIsoString(value: Date | string): string | undefined {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Converte e valida uma linha do PostgreSQL no registro pendente.
 *
 * Reaproveita a MESMA validação de integridade do JSON
 * ({@link normalizePendingRecord}): chave coerente com a vaga (`source:id`),
 * motivo permitido, `Job` válido e datas válidas. Registros inconsistentes
 * devolvem `undefined`, e o chamador (`readAllPendingRecords`) converte isso em
 * erro explícito — nunca em descarte silencioso.
 *
 * Exportada para permitir o teste determinístico da validação do PostgreSQL sem
 * depender de uma conexão real.
 *
 * @param row Linha lida da tabela `public.pending_jobs`.
 * @returns O registro validado ou `undefined` quando inválido.
 */
export function rowToPendingRecord(
  row: PendingJobRow,
): PendingJobRecord | undefined {
  const firstSeenAt = toIsoString(row.first_seen_at);
  const updatedAt = toIsoString(row.updated_at);
  if (firstSeenAt === undefined || updatedAt === undefined) {
    return undefined;
  }

  return normalizePendingRecord({
    key: row.key,
    job: row.job,
    reason: row.reason,
    firstSeenAt,
    updatedAt,
  });
}

// Lê a fila JSON; somente arquivo inexistente conta como lista vazia.
async function readJsonPending(): Promise<PendingJobRecord[]> {
  const file = join(process.cwd(), ...JSON_PENDING_FILE);
  let content: string;

  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  // Arquivo existente porém vazio indica perda da fila: não apaga nada.
  if (content.trim() === "") {
    throw new Error(
      `Fila de vagas pendentes vazia (possível perda de dados): ${file}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // Não sobrescreve nem apaga: apenas sinaliza o problema.
    throw new Error(
      `Fila de vagas pendentes corrompida (JSON inválido): ${file}`,
    );
  }

  if (!Array.isArray(data)) {
    throw new Error(
      `Fila de vagas pendentes corrompida (formato inesperado): ${file}`,
    );
  }

  const records: PendingJobRecord[] = [];
  for (const item of data) {
    const record = normalizePendingRecord(item);
    if (!record) {
      throw new Error(
        `Fila de vagas pendentes corrompida (registro inválido): ${file}`,
      );
    }

    records.push(record);
  }

  return records;
}

// Grava a fila JSON de forma ATÔMICA: o conteúdo vai para um arquivo temporário
// no MESMO diretório e só substitui a fila original por `rename` (atômico no
// mesmo sistema de arquivos). Uma falha de gravação remove o temporário e
// propaga o erro, preservando a fila original intacta.
async function writeJsonPending(
  records: readonly PendingJobRecord[],
): Promise<void> {
  const file = join(process.cwd(), ...JSON_PENDING_FILE);
  await mkdir(dirname(file), { recursive: true });

  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  } catch (error) {
    // Não sobrescreve a fila original: remove o temporário e propaga o erro.
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

// Lê todos os registros persistidos, lançando em caso de corrupção.
async function readAllPendingRecords(): Promise<PendingJobRecord[]> {
  if (getStorageBackend() === "postgres") {
    const { rows } = await query<PendingJobRow>(
      `select key, job, reason, first_seen_at, updated_at
         from public.pending_jobs
        order by key asc`,
    );

    const records: PendingJobRecord[] = [];
    for (const row of rows) {
      const record = rowToPendingRecord(row);
      if (!record) {
        throw new Error(
          `Fila de vagas pendentes corrompida (registro inválido): ${row.key}`,
        );
      }

      records.push(record);
    }

    return records;
  }

  return readJsonPending();
}

/** Resultado da leitura da fila de pendências. */
export interface LoadedPendingJobs {
  /** Registros utilizáveis (não notificados e dentro do TTL). */
  records: PendingJobRecord[];
  /** Chaves descartadas na leitura (já notificadas ou obsoletas). */
  droppedKeys: string[];
  /** Quantas pendências foram descartadas por já estarem notificadas. */
  droppedNotified: number;
  /** Quantas pendências foram descartadas por obsolescência (TTL). */
  droppedExpired: number;
}

/**
 * Carrega as pendências persistentes, filtrando as já resolvidas ou obsoletas.
 *
 * Pendências já notificadas (inclusive reservadas) e pendências mais antigas
 * que o TTL são EXCLUÍDAS da recuperação, mas registradas em `droppedKeys` para
 * remoção explícita na reconciliação — nunca descartadas em silêncio. O arquivo
 * vazio/corrompido lança (sem fallback silencioso).
 *
 * @param options Instante de referência e configuração (padrão: agora/ambiente).
 * @returns Os registros utilizáveis e as chaves descartadas.
 * @throws Error se a fila estiver corrompida ou o backend indisponível.
 */
export async function loadPendingJobs(
  options: { nowMs?: number; config?: PendingJobsConfig } = {},
): Promise<LoadedPendingJobs> {
  const config = options.config ?? resolvePendingJobsConfig();
  if (!config.enabled) {
    return {
      records: [],
      droppedKeys: [],
      droppedNotified: 0,
      droppedExpired: 0,
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const all = await readAllPendingRecords();

  const records: PendingJobRecord[] = [];
  const droppedKeys: string[] = [];
  let droppedNotified = 0;
  let droppedExpired = 0;

  for (const record of all) {
    // Já notificada/reservada por uma execução anterior: resolvida.
    if (await isJobNotified(record.job)) {
      droppedNotified++;
      droppedKeys.push(record.key);
      console.log(
        `Pendência resolvida (já notificada): ${record.key}`,
      );
      continue;
    }

    const age = nowMs - Date.parse(record.firstSeenAt);
    if (Number.isFinite(age) && age > config.ttlMs) {
      droppedExpired++;
      droppedKeys.push(record.key);
      console.log(
        `Pendência obsoleta descartada (${Math.round(age / 3_600_000)} h): ${record.key}`,
      );
      continue;
    }

    records.push(record);
  }

  return { records, droppedKeys, droppedNotified, droppedExpired };
}

/** Parâmetros da reconciliação da fila. */
export interface SavePendingJobsParams {
  /** Vagas que devem permanecer pendentes após esta execução. */
  pending: readonly PendingJobInput[];
  /** Chaves resolvidas nesta execução (removidas da fila). */
  resolvedKeys: readonly string[];
  /** Instante do início da execução, usado como guarda da remoção. */
  runStartedAtIso?: string;
  /** Instante da gravação (padrão: agora). */
  nowMs?: number;
  /** Configuração da fila (padrão: ambiente). */
  config?: PendingJobsConfig;
}

/** Resultado da reconciliação da fila. */
export interface SavePendingJobsResult {
  /** Pendências persistidas após a reconciliação. */
  kept: number;
  /** Pendências removidas (resolvidas ou descartadas pelo teto). */
  removed: number;
}

/**
 * Reconcilia a fila de pendências: mantém as pendentes desta execução e remove
 * as resolvidas, dentro de uma operação serializada.
 *
 * No PostgreSQL, a leitura-modificação-escrita ocorre numa transação com
 * advisory lock, impedindo que execuções concorrentes percam ou dupliquem
 * pendências. Nos DOIS backends, a remoção E a atualização são protegidas por
 * `runStartedAtIso`: só se remove/sobrescreve um registro ANTERIOR ao início
 * desta execução, de modo que uma execução mais antiga não apague nem
 * sobrescreva uma pendência atualizada por uma execução mais recente (mesmo que
 * grave depois em tempo de relógio). No JSON, a seção crítica é serializada por
 * {@link withStorageLock}. Quando o total excede o teto, as entradas mais
 * antigas são descartadas (registradas no log).
 *
 * @param params Pendentes a manter, chaves resolvidas e configuração.
 * @returns A contagem de pendências mantidas e removidas.
 * @throws Error se o backend de persistência estiver indisponível.
 */
export async function savePendingJobs(
  params: SavePendingJobsParams,
): Promise<SavePendingJobsResult> {
  const config = params.config ?? resolvePendingJobsConfig();
  if (!config.enabled) {
    return { kept: 0, removed: 0 };
  }

  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const runStartedAtIso = params.runStartedAtIso ?? nowIso;

  if (getStorageBackend() === "postgres") {
    return savePendingPostgres(
      params.pending,
      params.resolvedKeys,
      nowIso,
      runStartedAtIso,
      config,
    );
  }

  return savePendingJson(
    params.pending,
    params.resolvedKeys,
    nowIso,
    runStartedAtIso,
    config,
  );
}

// Reconciliação no modo JSON, sob o lock compartilhado dos históricos.
async function savePendingJson(
  pending: readonly PendingJobInput[],
  resolvedKeys: readonly string[],
  nowIso: string,
  runStartedAtIso: string,
  config: PendingJobsConfig,
): Promise<SavePendingJobsResult> {
  return withStorageLock(async () => {
    const records = await readJsonPending();
    const byKey = new Map(records.map((record) => [record.key, record]));

    let removed = 0;
    for (const key of resolvedKeys) {
      const existing = byKey.get(key);
      // Mesma proteção do PostgreSQL: só remove o que NÃO foi atualizado após o
      // início desta execução, preservando linhas recém-atualizadas por uma
      // execução concorrente.
      if (existing && existing.updatedAt < runStartedAtIso) {
        byKey.delete(key);
        removed++;
      }
    }

    for (const { job, reason } of pending) {
      const key = generateJobKey(job);
      const existing = byKey.get(key);
      // Só grava por CIMA de um registro ANTERIOR ao início desta execução. Uma
      // pendência atualizada depois do início (por uma execução mais recente) é
      // preservada, MESMO que esta execução — mais antiga — grave depois em
      // tempo de relógio (o que a guarda `updatedAt > nowIso` não cobria).
      // Mesma garantia do PostgreSQL (`where updated_at < runStartedAtIso`).
      if (existing && existing.updatedAt >= runStartedAtIso) {
        continue;
      }

      byKey.set(key, {
        key,
        job,
        reason,
        firstSeenAt: existing?.firstSeenAt ?? nowIso,
        updatedAt: nowIso,
      });
    }

    const sorted = [...byKey.values()].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    const kept = enforceCap(sorted, config.maxJobs);
    removed += sorted.length - kept.length;

    await writeJsonPending(kept);
    return { kept: kept.length, removed };
  });
}

// Reconciliação no PostgreSQL, dentro de uma transação com advisory lock.
async function savePendingPostgres(
  pending: readonly PendingJobInput[],
  resolvedKeys: readonly string[],
  nowIso: string,
  runStartedAtIso: string,
  config: PendingJobsConfig,
): Promise<SavePendingJobsResult> {
  return withTransaction(async (client) => {
    // Serializa a reconciliação entre TODAS as execuções até o fim da transação.
    await client.query("select pg_advisory_xact_lock($1::bigint)", [
      PENDING_LOCK_KEY,
    ]);

    for (const { job, reason } of pending) {
      const key = generateJobKey(job);
      // A cláusula `where` no `do update` preserva a MESMA garantia da remoção:
      // só sobrescreve a linha quando ela é ANTERIOR ao início desta execução.
      // Assim, uma execução antiga que grave depois em tempo de relógio não
      // sobrescreve uma pendência atualizada por uma execução mais recente.
      await client.query(
        `insert into public.pending_jobs (key, job, reason, first_seen_at, updated_at)
         values ($1, $2::jsonb, $3, $4::timestamptz, $4::timestamptz)
         on conflict (key) do update
           set job = excluded.job,
               reason = excluded.reason,
               updated_at = excluded.updated_at
           where public.pending_jobs.updated_at < $5::timestamptz`,
        [key, JSON.stringify(job), reason, nowIso, runStartedAtIso],
      );
    }

    let removed = 0;
    if (resolvedKeys.length > 0) {
      // Só remove o que não foi atualizado após o início desta execução: uma
      // linha recém-atualizada por outra execução concorrente é preservada.
      const { rowCount } = await client.query(
        `delete from public.pending_jobs
          where key = any($1::text[])
            and updated_at < $2::timestamptz`,
        [resolvedKeys, runStartedAtIso],
      );
      removed += rowCount ?? 0;
    }

    // Teto: descarta as entradas mais antigas, preservando as recém-atualizadas.
    const { rowCount: capped } = await client.query(
      `delete from public.pending_jobs
        where key in (
          select key from public.pending_jobs
           order by updated_at desc, key asc
          offset $1
        )`,
      [config.maxJobs],
    );
    removed += capped ?? 0;

    const { rows } = await client.query<{ count: number }>(
      "select count(*)::int as count from public.pending_jobs",
    );
    const kept = Number(rows[0]?.count ?? 0);
    return { kept, removed };
  });
}

/**
 * Aplica o teto de pendências, preservando as mais recentes.
 *
 * Ordena por `updatedAt` decrescente (desempate por chave) e mantém apenas as
 * primeiras `maxJobs`, devolvendo-as em ordem determinística por chave.
 */
function enforceCap(
  records: readonly PendingJobRecord[],
  maxJobs: number,
): PendingJobRecord[] {
  if (records.length <= maxJobs) {
    return [...records];
  }

  const kept = [...records]
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) {
        return a.updatedAt < b.updatedAt ? 1 : -1;
      }
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .slice(0, maxJobs);

  return kept.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
