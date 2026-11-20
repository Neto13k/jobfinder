import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { query, withTransaction } from "../db/postgres.js";
import { GeminiAnalysisError } from "./ai-analyzer.js";
import { getStorageBackend, withStorageLock } from "./storage.js";

// Controle de cota no modo JSON (relativo ao cwd) — ignorado pelo Git.
const JSON_QUOTA_FILE = ["data", "gemini-quota.json"];

/** Cota diária de requisições ao Gemini, por padrão (plano gratuito). */
export const DEFAULT_DAILY_QUOTA = 450;

/** Teto operacional seguro da cota diária (RPD). */
export const HARD_MAX_DAILY_QUOTA = 450;

/** Execuções programadas por dia, por padrão (cron horário: 24 execuções). */
export const DEFAULT_EXECUTIONS_PER_DAY = 24;

/** Intervalo mínimo entre requisições, em milissegundos, por padrão. */
export const DEFAULT_MIN_INTERVAL_MS = 6_000;

/** Piso operacional do intervalo mínimo em produção (6 s). */
export const HARD_MIN_INTERVAL_MS = 6_000;

/** Limite conservador de tokens de entrada por minuto, por padrão (250k TPM). */
export const DEFAULT_TPM_LIMIT = 250_000;

/** Teto operacional seguro do limite de tokens por minuto (TPM). */
export const HARD_MAX_TPM_LIMIT = 250_000;

/**
 * Orçamento padrão da fase de análise, em milissegundos (8 min).
 *
 * Fica abaixo do `timeout-minutes: 10` do GitHub Actions, reservando margem
 * para a coleta e para o próprio encerramento do job.
 */
export const DEFAULT_TIME_BUDGET_MS = 8 * 60 * 1_000;

/**
 * Margem reservada antes do fim do orçamento de tempo, em milissegundos.
 *
 * Garante folga para concluir uma chamada ao Gemini (timeout de 30 s) e para o
 * encerramento da execução, contando o tempo DESDE O INÍCIO DO PIPELINE
 * (coleta + espera inclusas). Uma requisição só é iniciada se ainda houver essa
 * margem disponível.
 */
export const CALL_RESERVE_MS = 45_000;

/**
 * Fuso da renovação da cota.
 *
 * A cota é diária e se renova à meia-noite NESTE fuso, alinhada ao dia de
 * cobrança da API Gemini (`America/Los_Angeles`), e não ao UTC do runner.
 */
export const QUOTA_TIME_ZONE = "America/Los_Angeles";

const DAILY_QUOTA_ENV = "JOBFINDER_GEMINI_DAILY_QUOTA";
const EXECUTIONS_PER_DAY_ENV = "JOBFINDER_GEMINI_EXECUTIONS_PER_DAY";
const MIN_INTERVAL_ENV = "JOBFINDER_GEMINI_MIN_INTERVAL_MS";
const TPM_LIMIT_ENV = "JOBFINDER_GEMINI_TPM_LIMIT";
const TIME_BUDGET_ENV = "JOBFINDER_GEMINI_TIME_BUDGET_MS";

// Tentativas internas de reserva quando o intervalo compartilhado ainda não foi
// satisfeito (concorrência entre execuções). Cada tentativa reconsulta o estado
// persistido e passa pelo controle, sem nunca ultrapassar cota/tokens.
const MAX_RESERVATION_ATTEMPTS = 5;

// Chave fixa do advisory lock transacional que serializa as reservas de cota
// entre TODAS as execuções (e dias). No PostgreSQL, isso garante que cota,
// tokens e o intervalo mínimo compartilhado sejam avaliados sobre um estado
// consistente, inclusive na virada do dia de cota.
const QUOTA_LOCK_KEY = 4_923_005_311;

/**
 * Lê um inteiro estrito de uma variável de ambiente, com valor mínimo.
 *
 * Aceita apenas dígitos (sem sinal, fração ou texto extra). Valores ausentes ou
 * inválidos recorrem ao padrão seguro.
 *
 * @param raw Valor bruto da variável.
 * @param fallback Valor padrão quando ausente ou inválido.
 * @param min Valor mínimo aceito (inclusive).
 * @returns O inteiro validado ou o padrão.
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

/** Configuração do controle de cota do Gemini. */
export interface GeminiQuotaConfig {
  /** Requisições permitidas por dia (limitada a {@link HARD_MAX_DAILY_QUOTA}). */
  dailyQuota: number;
  /** Execuções programadas por dia (base da distribuição do orçamento). */
  executionsPerDay: number;
  /** Intervalo mínimo entre requisições, em milissegundos (0 desativa). */
  minIntervalMs: number;
  /** Limite conservador de tokens de entrada por minuto (TPM). */
  tpmLimit: number;
  /** Orçamento de tempo da fase de análise, em milissegundos. */
  timeBudgetMs: number;
  /** Fuso da renovação diária. */
  timeZone: string;
}

/**
 * Resolve a configuração do controle de cota a partir do ambiente.
 *
 * Aplica os tetos operacionais seguros: a cota diária é limitada a
 * {@link HARD_MAX_DAILY_QUOTA} (450 RPD) e o limite de tokens a
 * {@link HARD_MAX_TPM_LIMIT} (250k TPM). Em produção (`NODE_ENV=production`), o
 * intervalo mínimo é elevado ao piso de {@link HARD_MIN_INTERVAL_MS} (6 s); fora
 * de produção ele pode ser reduzido (inclusive a 0) para testes manuais.
 *
 * @param env Ambiente consultado (padrão: `process.env`).
 * @returns A configuração validada, com os padrões seguros quando ausente.
 */
export function resolveGeminiQuotaConfig(
  env: NodeJS.ProcessEnv = process.env,
): GeminiQuotaConfig {
  const production = (env.NODE_ENV ?? "").trim().toLowerCase() === "production";

  const dailyQuota = Math.min(
    parseStrictInt(env[DAILY_QUOTA_ENV], DEFAULT_DAILY_QUOTA, 1),
    HARD_MAX_DAILY_QUOTA,
  );
  const executionsPerDay = parseStrictInt(
    env[EXECUTIONS_PER_DAY_ENV],
    DEFAULT_EXECUTIONS_PER_DAY,
    1,
  );
  const baseInterval = parseStrictInt(
    env[MIN_INTERVAL_ENV],
    DEFAULT_MIN_INTERVAL_MS,
    0,
  );
  const minIntervalMs = production
    ? Math.max(baseInterval, HARD_MIN_INTERVAL_MS)
    : baseInterval;
  const tpmLimit = Math.min(
    parseStrictInt(env[TPM_LIMIT_ENV], DEFAULT_TPM_LIMIT, 1),
    HARD_MAX_TPM_LIMIT,
  );
  const timeBudgetMs = parseStrictInt(
    env[TIME_BUDGET_ENV],
    DEFAULT_TIME_BUDGET_MS,
    1,
  );

  return {
    dailyQuota,
    executionsPerDay,
    minIntervalMs,
    tpmLimit,
    timeBudgetMs,
    timeZone: QUOTA_TIME_ZONE,
  };
}

/** Formata `date` no fuso informado, devolvendo o componente `type`. */
function partOf(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
  type: Intl.DateTimeFormatPartTypes,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    ...options,
  }).formatToParts(date);

  return parts.find((part) => part.type === type)?.value ?? "";
}

/**
 * Calcula o "dia de cota" (YYYY-MM-DD) no fuso informado.
 *
 * A renovação ocorre à meia-noite local desse fuso, de modo que a virada do dia
 * de cobrança da API independa do UTC do runner do GitHub Actions.
 *
 * @param date Instante de referência.
 * @param timeZone Fuso da renovação (padrão: {@link QUOTA_TIME_ZONE}).
 * @returns O dia no formato "YYYY-MM-DD".
 */
export function quotaDayFor(
  date: Date,
  timeZone: string = QUOTA_TIME_ZONE,
): string {
  const dateParts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  const year = partOf(date, timeZone, dateParts, "year");
  const month = partOf(date, timeZone, dateParts, "month");
  const day = partOf(date, timeZone, dateParts, "day");

  return `${year}-${month}-${day}`;
}

/**
 * Calcula a "janela de minuto" (YYYY-MM-DDTHH:MM) no fuso informado.
 *
 * Serve de chave para o controle de tokens de entrada por minuto (TPM): quando
 * a janela muda, o consumo de tokens reinicia.
 *
 * @param date Instante de referência.
 * @param timeZone Fuso da janela (padrão: {@link QUOTA_TIME_ZONE}).
 * @returns A janela no formato "YYYY-MM-DDTHH:MM".
 */
export function quotaMinuteFor(
  date: Date,
  timeZone: string = QUOTA_TIME_ZONE,
): string {
  const dateParts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  const timeParts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  const year = partOf(date, timeZone, dateParts, "year");
  const month = partOf(date, timeZone, dateParts, "month");
  const day = partOf(date, timeZone, dateParts, "day");
  const hour = partOf(date, timeZone, timeParts, "hour");
  const minute = partOf(date, timeZone, timeParts, "minute");

  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Distribui o saldo diário entre as execuções restantes.
 *
 * O orçamento de cada execução é o saldo restante dividido pelo número de
 * execuções ainda previstas (a atual inclusive), arredondado para cima. Assim o
 * orçamento se distribui pelas 24 execuções e o saldo não utilizado por
 * execuções anteriores é absorvido pelas seguintes — sem que a soma ultrapasse
 * a cota, que é garantida pela reserva atômica diária. Quando o saldo zera, o
 * orçamento é 0.
 *
 * @param params Cota diária, já usado, execuções iniciadas antes desta e total
 *   de execuções previstas no dia.
 * @returns O número de requisições que esta execução pode gastar.
 */
export function planExecutionAllowance(params: {
  dailyQuota: number;
  used: number;
  previouslyStartedExecutions: number;
  executionsPerDay: number;
}): number {
  const { dailyQuota, used, previouslyStartedExecutions, executionsPerDay } =
    params;

  const remainingBalance = Math.max(0, dailyQuota - used);
  if (remainingBalance === 0) {
    return 0;
  }

  const remainingExecutions = Math.max(
    1,
    executionsPerDay - previouslyStartedExecutions,
  );

  return Math.ceil(remainingBalance / remainingExecutions);
}

/**
 * Converte um orçamento de requisições em limite de vagas por execução.
 *
 * Cada requisição envia até `batchSize` vagas numa única chamada
 * `generateContent`, então o limite de vagas é o produto dos dois.
 *
 * @param requestsAvailable Requisições disponíveis nesta execução.
 * @param batchSize Vagas por requisição (tamanho configurado do lote).
 * @returns O limite de vagas (0 quando não há requisições ou lote).
 */
export function planJobBudget(
  requestsAvailable: number,
  batchSize: number,
): number {
  if (requestsAvailable <= 0 || batchSize <= 0) {
    return 0;
  }

  return requestsAvailable * batchSize;
}

/**
 * Calcula a espera necessária para respeitar o intervalo mínimo entre
 * requisições, medido a partir da última requisição registrada.
 *
 * @param lastRequestAt Instante da última requisição (ISO) ou null.
 * @param nowMs Instante atual em milissegundos.
 * @param intervalMs Intervalo mínimo exigido, em milissegundos.
 * @returns A espera em milissegundos (0 quando já decorreu o intervalo).
 */
export function computeDelayMs(
  lastRequestAt: string | null,
  nowMs: number,
  intervalMs: number,
): number {
  if (!lastRequestAt || intervalMs <= 0) {
    return 0;
  }

  const last = Date.parse(lastRequestAt);
  if (Number.isNaN(last)) {
    return 0;
  }

  return Math.max(0, intervalMs - (nowMs - last));
}

/**
 * Instante (ISO) da última requisição registrada em QUALQUER dia.
 *
 * O intervalo mínimo é compartilhado entre execuções e NÃO pode ser zerado pela
 * virada do dia de cota: quando um novo dia começa sem requisições, o intervalo
 * ainda deve ser medido a partir da última requisição do dia anterior. Por isso
 * a busca percorre todos os registros, e não apenas o do dia corrente.
 *
 * @param records Registros persistidos do controle de cota.
 * @returns O instante mais recente (ISO) ou null quando não há requisições.
 */
function latestRequestAt(records: readonly QuotaDayRecord[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const record of records) {
    if (!record.lastRequestAt) {
      continue;
    }

    const ms = Date.parse(record.lastRequestAt);
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latest = record.lastRequestAt;
    }
  }

  return latest;
}

/** Estado persistido da cota de um dia. */
export interface QuotaDayRecord {
  /** Dia de cota (YYYY-MM-DD) no fuso {@link QUOTA_TIME_ZONE}. */
  quotaDay: string;
  /** Requisições já consumidas no dia. */
  used: number;
  /** Execuções iniciadas no dia (base da distribuição). */
  executions: number;
  /** Instante da última requisição registrada (ISO) ou null. */
  lastRequestAt: string | null;
  /** Janela de minuto (YYYY-MM-DDTHH:MM) da contagem de tokens ou null. */
  tokenMinute: string | null;
  /** Tokens de entrada consumidos na janela de minuto atual. */
  tokens: number;
}

/** Linha da tabela public.gemini_quota. */
interface QuotaRow {
  [column: string]: unknown;
  quota_day: string;
  used: number;
  executions: number;
  last_request_at: Date | string | null;
  token_minute: string | null;
  tokens_used: number;
  /** Última requisição registrada em qualquer dia (coluna derivada). */
  global_last_request_at?: Date | string | null;
}

/** Valida e normaliza um registro do controle de cota no JSON. */
function normalizeQuotaRecord(value: unknown): QuotaDayRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const used = record.used;
  const executions = record.executions;
  const lastRequestAt = record.lastRequestAt;
  // Campos de tokens são opcionais: registros anteriores os normalizam como
  // vazios, sem descartar o controle (não há reescrita de decisões passadas).
  const tokenMinute = record.tokenMinute;
  const tokens = record.tokens;

  const lastValid =
    lastRequestAt === undefined ||
    lastRequestAt === null ||
    (typeof lastRequestAt === "string" &&
      !Number.isNaN(Date.parse(lastRequestAt)));

  const tokenMinuteValid =
    tokenMinute === undefined ||
    tokenMinute === null ||
    typeof tokenMinute === "string";

  const tokensValid = tokens === undefined || (typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0);

  const valid =
    typeof record.quotaDay === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.quotaDay) &&
    typeof used === "number" &&
    Number.isInteger(used) &&
    used >= 0 &&
    typeof executions === "number" &&
    Number.isInteger(executions) &&
    executions >= 0 &&
    lastValid &&
    tokenMinuteValid &&
    tokensValid;

  if (!valid) {
    return undefined;
  }

  return {
    quotaDay: record.quotaDay as string,
    used: used as number,
    executions: executions as number,
    lastRequestAt: typeof lastRequestAt === "string" ? lastRequestAt : null,
    tokenMinute: typeof tokenMinute === "string" ? tokenMinute : null,
    tokens: typeof tokens === "number" ? tokens : 0,
  };
}

/** Converte uma linha do PostgreSQL no registro de cota. */
function rowToQuota(row: QuotaRow): QuotaDayRecord {
  return {
    quotaDay: row.quota_day,
    used: Number(row.used),
    executions: Number(row.executions),
    lastRequestAt: row.last_request_at
      ? new Date(row.last_request_at).toISOString()
      : null,
    tokenMinute: row.token_minute ?? null,
    tokens: Number(row.tokens_used),
  };
}

/** Converte um instante do PostgreSQL (Date|string|null) em ISO ou null. */
function toIso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

// Lê o controle de cota JSON; somente arquivo inexistente conta como vazio.
async function readJsonQuota(): Promise<QuotaDayRecord[]> {
  const file = join(process.cwd(), ...JSON_QUOTA_FILE);
  let content: string;

  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  // Arquivo existente porém vazio indica perda do controle: não apaga nada.
  if (content.trim() === "") {
    throw new Error(
      `Controle de cota do Gemini vazio (possível perda de dados): ${file}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error(
      `Controle de cota do Gemini corrompido (JSON inválido): ${file}`,
    );
  }

  if (!Array.isArray(data)) {
    throw new Error(
      `Controle de cota do Gemini corrompido (formato inesperado): ${file}`,
    );
  }

  const records: QuotaDayRecord[] = [];
  for (const item of data) {
    const record = normalizeQuotaRecord(item);
    if (!record) {
      throw new Error(
        `Controle de cota do Gemini corrompido (registro inválido): ${file}`,
      );
    }

    records.push(record);
  }

  return records;
}

// Grava o controle de cota JSON, criando a pasta quando necessário.
async function writeJsonQuota(records: QuotaDayRecord[]): Promise<void> {
  const file = join(process.cwd(), ...JSON_QUOTA_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

/**
 * Registra o início de uma execução e devolve o estado do dia.
 *
 * O contador de execuções do dia é incrementado de forma atômica (upsert por
 * `quota_day`), servindo de base para distribuir o saldo restante.
 *
 * @param quotaDay Dia de cota (YYYY-MM-DD).
 * @returns O estado do dia após o incremento.
 * @throws Error se o backend de persistência estiver indisponível.
 */
export async function registerExecutionStart(
  quotaDay: string,
): Promise<QuotaDayRecord> {
  if (getStorageBackend() === "postgres") {
    const { rows } = await query<QuotaRow>(
      `insert into public.gemini_quota (quota_day, used, executions)
       values ($1, 0, 1)
       on conflict (quota_day) do update
         set executions = public.gemini_quota.executions + 1,
             updated_at = now()
       returning quota_day::text as quota_day, used, executions,
                 last_request_at, token_minute, tokens_used`,
      [quotaDay],
    );

    return rowToQuota(rows[0]);
  }

  return withStorageLock(async () => {
    const records = await readJsonQuota();
    const existing = records.find((record) => record.quotaDay === quotaDay);

    if (existing) {
      existing.executions += 1;
      await writeJsonQuota(records);
      return { ...existing };
    }

    const created: QuotaDayRecord = {
      quotaDay,
      used: 0,
      executions: 1,
      lastRequestAt: null,
      tokenMinute: null,
      tokens: 0,
    };
    records.push(created);
    await writeJsonQuota(records);
    return { ...created };
  });
}

/** Parâmetros de uma reserva de cota (uma tentativa de requisição). */
export interface QuotaReservationParams {
  /** Dia de cota (YYYY-MM-DD) revalidado no momento da reserva. */
  quotaDay: string;
  /** Requisições permitidas no dia. */
  dailyLimit: number;
  /** Instante da requisição (ISO), gravado como última requisição. */
  nowIso: string;
  /** Intervalo mínimo compartilhado entre requisições, em milissegundos. */
  minIntervalMs: number;
  /** Janela de minuto (YYYY-MM-DDTHH:MM) da contagem de tokens. */
  tokenMinute: string;
  /** Tokens de entrada estimados para esta requisição. */
  tokens: number;
  /** Limite de tokens de entrada por minuto. */
  tpmLimit: number;
}

/** Motivo pelo qual uma reserva não foi concedida. */
export type QuotaReservationReason = "quota" | "interval" | "tokens";

/** Resultado de uma tentativa de reserva de cota. */
export interface QuotaReservationResult {
  /** true quando a requisição foi reservada e pode ser emitida. */
  granted: boolean;
  /** Motivo da recusa (null quando concedida). */
  reason: QuotaReservationReason | null;
  /** Requisições consumidas no dia após a tentativa. */
  used: number;
  /** Tokens consumidos na janela de minuto após a tentativa. */
  tokensUsed: number;
  /** Instante da última requisição registrada (ISO) ou null. */
  lastRequestAt: string | null;
}

// Reserva no PostgreSQL dentro de uma transação serializada por um advisory
// lock, lendo e escrevendo o estado persistido de forma atômica. Cota, tokens e
// o intervalo mínimo (medido sobre a última requisição de QUALQUER dia) são
// avaliados sobre o mesmo estado consistente — válido entre execuções e dias.
async function reservePostgres(
  params: QuotaReservationParams,
): Promise<QuotaReservationResult> {
  const {
    quotaDay,
    dailyLimit,
    nowIso,
    minIntervalMs,
    tokenMinute,
    tokens,
    tpmLimit,
  } = params;

  return withTransaction(async (client) => {
    // Serializa as reservas de TODAS as execuções (qualquer dia) até o fim da
    // transação, impedindo que duas reservas concorrentes avaliem o mesmo
    // estado — inclusive na virada do dia de cota.
    await client.query("select pg_advisory_xact_lock($1::bigint)", [
      QUOTA_LOCK_KEY,
    ]);

    // Garante a linha do dia (necessária após a virada da meia-noite).
    await client.query(
      `insert into public.gemini_quota (quota_day)
       values ($1)
       on conflict (quota_day) do nothing`,
      [quotaDay],
    );

    const { rows } = await client.query<QuotaRow>(
      `select used, tokens_used, token_minute, last_request_at,
              (select max(last_request_at) from public.gemini_quota)
                as global_last_request_at
         from public.gemini_quota
        where quota_day = $1`,
      [quotaDay],
    );
    const row = rows[0];
    const used = row ? Number(row.used) : 0;
    const tokensUsed = row ? Number(row.tokens_used) : 0;
    const windowTokens = row && row.token_minute === tokenMinute ? tokensUsed : 0;
    // O intervalo é medido a partir da última requisição de qualquer dia: a
    // virada da meia-noite cria um dia sem requisições e não pode zerá-lo.
    const lastRequestAt = toIso(row.global_last_request_at ?? null);

    if (used >= dailyLimit) {
      return {
        granted: false,
        reason: "quota" as const,
        used,
        tokensUsed: windowTokens,
        lastRequestAt,
      };
    }
    if (windowTokens + tokens > tpmLimit) {
      return {
        granted: false,
        reason: "tokens" as const,
        used,
        tokensUsed: windowTokens,
        lastRequestAt,
      };
    }
    if (computeDelayMs(lastRequestAt, Date.parse(nowIso), minIntervalMs) > 0) {
      return {
        granted: false,
        reason: "interval" as const,
        used,
        tokensUsed: windowTokens,
        lastRequestAt,
      };
    }

    const { rows: updated } = await client.query<QuotaRow>(
      `update public.gemini_quota
          set used = used + 1,
              tokens_used = $3,
              token_minute = $4,
              last_request_at = $2::timestamptz,
              updated_at = now()
        where quota_day = $1
        returning used, tokens_used, last_request_at`,
      [quotaDay, nowIso, windowTokens + tokens, tokenMinute],
    );
    const resultRow = updated[0];

    return {
      granted: true,
      reason: null,
      used: Number(resultRow.used),
      tokensUsed: Number(resultRow.tokens_used),
      lastRequestAt: toIso(resultRow.last_request_at),
    };
  });
}

// Reserva no modo JSON sob o mesmo lock dos históricos, avaliando cota, tokens
// e intervalo na mesma seção crítica (atômica dentro do processo).
async function reserveJson(
  params: QuotaReservationParams,
): Promise<QuotaReservationResult> {
  const {
    quotaDay,
    dailyLimit,
    nowIso,
    minIntervalMs,
    tokenMinute,
    tokens,
    tpmLimit,
  } = params;

  return withStorageLock(async () => {
    const records = await readJsonQuota();
    let record = records.find((item) => item.quotaDay === quotaDay);
    if (!record) {
      record = {
        quotaDay,
        used: 0,
        executions: 0,
        lastRequestAt: null,
        tokenMinute: null,
        tokens: 0,
      };
      records.push(record);
    }

    const windowTokens = record.tokenMinute === tokenMinute ? record.tokens : 0;
    // O intervalo MÍNIMO compartilhado é medido a partir da última requisição
    // de QUALQUER dia: na virada da meia-noite um novo dia começa sem
    // requisição, então usar só o registro do dia zeraria o intervalo.
    const lastRequestAt = latestRequestAt(records);

    if (record.used >= dailyLimit) {
      return {
        granted: false,
        reason: "quota" as const,
        used: record.used,
        tokensUsed: windowTokens,
        lastRequestAt,
      };
    }
    if (windowTokens + tokens > tpmLimit) {
      return {
        granted: false,
        reason: "tokens" as const,
        used: record.used,
        tokensUsed: windowTokens,
        lastRequestAt,
      };
    }

    const delay = computeDelayMs(
      lastRequestAt,
      Date.parse(nowIso),
      minIntervalMs,
    );
    if (delay > 0) {
      return {
        granted: false,
        reason: "interval" as const,
        used: record.used,
        tokensUsed: windowTokens,
        lastRequestAt,
      };
    }

    record.used += 1;
    record.tokens = windowTokens + tokens;
    record.tokenMinute = tokenMinute;
    record.lastRequestAt = nowIso;
    await writeJsonQuota(records);

    return {
      granted: true,
      reason: null,
      used: record.used,
      tokensUsed: record.tokens,
      lastRequestAt: record.lastRequestAt,
    };
  });
}

/**
 * Reserva UMA requisição na cota diária, de forma ATÔMICA.
 *
 * Avalia, numa única operação atômica sobre o estado PERSISTIDO (consultado a
 * cada chamada), três limites independentes: a cota do dia (`used < dailyLimit`),
 * o consumo de tokens de entrada na janela de minuto
 * (`tokens ≤ tpmLimit`) e o intervalo mínimo compartilhado desde a última
 * requisição. No PostgreSQL, é uma única instrução `update ... where ...`; no
 * JSON, a seção crítica é serializada por {@link withStorageLock}. Isso impede
 * que execuções simultâneas ultrapassem a cota diária, os tokens por minuto ou o
 * intervalo mínimo. Cada TENTATIVA de requisição consome uma reserva, inclusive
 * quando a chamada falha depois — o consumo é anterior à requisição.
 *
 * @param params Parâmetros da reserva (dia revalidado, limites, tokens e instante).
 * @returns O resultado da reserva, com o motivo quando recusada.
 * @throws Error se o backend de persistência estiver indisponível.
 */
export async function reserveQuotaRequest(
  params: QuotaReservationParams,
): Promise<QuotaReservationResult> {
  return getStorageBackend() === "postgres"
    ? reservePostgres(params)
    : reserveJson(params);
}

/** Resumo da cota desta execução, para logs e decisões de orçamento. */
export interface GeminiQuotaSnapshot {
  quotaDay: string;
  dailyQuota: number;
  executionsPerDay: number;
  /** Posição desta execução no dia (1 = primeira). */
  executionOrdinal: number;
  /** Requisições já usadas no dia antes desta execução. */
  usedAtStart: number;
  /** Requisições que esta execução pode gastar. */
  allowance: number;
  /** Limite de vagas desta execução (requisições × tamanho do lote). */
  jobBudget: number;
  minIntervalMs: number;
  /** Limite de tokens de entrada por minuto. */
  tpmLimit: number;
  /** Orçamento de tempo da fase de análise, em milissegundos. */
  timeBudgetMs: number;
}

/** Opções do gerenciador de cota. */
export interface GeminiQuotaManagerOptions {
  /** Vagas por requisição (tamanho configurado do lote). */
  batchSize: number;
  /** Configuração da cota (padrão: derivada do ambiente). */
  config?: GeminiQuotaConfig;
  /**
   * Instante (ms) do INÍCIO DO PIPELINE (antes da coleta).
   *
   * O orçamento de tempo é medido a partir daqui — coleta e esperas inclusas.
   * Padrão: o instante de criação do gerenciador.
   */
  pipelineStartedAtMs?: number;
  /** Fonte de tempo em milissegundos (injetável nos testes). */
  now?: () => number;
  /** Espera entre requisições (injetável nos testes). */
  sleep?: (ms: number) => Promise<void>;
}

/** Espera real; substituível nos testes. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gerencia a cota do Gemini durante uma execução.
 *
 * Registra o início, distribui o orçamento diário pelo número de execuções
 * previstas e concede reservas atômicas por requisição — cada uma revalidando o
 * dia de cota (inclusive após esperas e na virada da meia-noite), o consumo de
 * tokens por minuto e o intervalo mínimo compartilhado. O orçamento de tempo é
 * medido desde o início do pipeline, com margem para uma chamada e o
 * encerramento. Ao esgotar a cota, os tokens, o orçamento, o tempo — ou ao
 * falhar o controle — lança {@link GeminiAnalysisError} para que o orquestrador
 * interrompa novas chamadas preservando o reaproveitamento do histórico.
 */
export class GeminiQuotaManager {
  private readonly config: GeminiQuotaConfig;
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly startedAt: number;
  private snapshotValue: GeminiQuotaSnapshot | undefined;
  private requestsUsed = 0;
  // Falha ao registrar o início da execução. Não derruba o processamento:
  // apenas impede novas chamadas (categoria "unavailable"), preservando o
  // reaproveitamento do histórico salvo.
  private startFailure: unknown = undefined;

  constructor(options: GeminiQuotaManagerOptions) {
    this.config = options.config ?? resolveGeminiQuotaConfig();
    this.batchSize = options.batchSize;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.startedAt = options.pipelineStartedAtMs ?? this.now();
  }

  /**
   * Registra o início da execução e calcula o orçamento a partir da cota.
   *
   * Uma falha ao registrar o início (backend de persistência indisponível) NÃO
   * derruba a execução: ela é registrada e o orçamento desta execução fica em 0,
   * de modo que {@link acquire} recuse novas chamadas — preservando o
   * reaproveitamento do histórico salvo.
   *
   * @returns O resumo da cota desta execução.
   */
  async start(): Promise<GeminiQuotaSnapshot> {
    const quotaDay = quotaDayFor(new Date(this.now()), this.config.timeZone);

    let record: QuotaDayRecord;
    try {
      record = await registerExecutionStart(quotaDay);
    } catch (error) {
      this.startFailure = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        "Falha ao controlar a cota do Gemini nesta execução; novas chamadas " +
          `serão interrompidas: ${message}`,
      );

      const snapshot: GeminiQuotaSnapshot = {
        quotaDay,
        dailyQuota: this.config.dailyQuota,
        executionsPerDay: this.config.executionsPerDay,
        executionOrdinal: 0,
        usedAtStart: 0,
        allowance: 0,
        jobBudget: 0,
        minIntervalMs: this.config.minIntervalMs,
        tpmLimit: this.config.tpmLimit,
        timeBudgetMs: this.config.timeBudgetMs,
      };
      this.snapshotValue = snapshot;
      return snapshot;
    }

    const allowance = planExecutionAllowance({
      dailyQuota: this.config.dailyQuota,
      used: record.used,
      previouslyStartedExecutions: Math.max(0, record.executions - 1),
      executionsPerDay: this.config.executionsPerDay,
    });
    const jobBudget = planJobBudget(allowance, this.batchSize);

    const snapshot: GeminiQuotaSnapshot = {
      quotaDay,
      dailyQuota: this.config.dailyQuota,
      executionsPerDay: this.config.executionsPerDay,
      executionOrdinal: record.executions,
      usedAtStart: record.used,
      allowance,
      jobBudget,
      minIntervalMs: this.config.minIntervalMs,
      tpmLimit: this.config.tpmLimit,
      timeBudgetMs: this.config.timeBudgetMs,
    };
    this.snapshotValue = snapshot;

    console.log(
      `Cota Gemini: ${snapshot.dailyQuota}/dia | usados hoje: ${snapshot.usedAtStart} | ` +
        `execução ${snapshot.executionOrdinal}/${snapshot.executionsPerDay} | ` +
        `orçamento desta execução: ${snapshot.allowance} requisição(ões) ` +
        `(até ${snapshot.jobBudget} vaga(s) com lote de ${this.batchSize}) | ` +
        `TPM: ${snapshot.tpmLimit}`,
    );

    return snapshot;
  }

  /** Resumo da cota desta execução. Falha se `start` ainda não foi chamado. */
  get snapshot(): GeminiQuotaSnapshot {
    if (!this.snapshotValue) {
      throw new Error("A cota do Gemini ainda não foi iniciada (chame start).");
    }

    return this.snapshotValue;
  }

  /** Requisições já consumidas nesta execução. */
  get requestsConsumed(): number {
    return this.requestsUsed;
  }

  /**
   * Reserva uma requisição antes de chamá-la, respeitando tempo, intervalo,
   * cota e tokens.
   *
   * Antes de cada chamada, consulta o estado PERSISTIDO e revalida o dia de
   * cota e o ORÇAMENTO DE TEMPO. Se o intervalo mínimo compartilhado ainda não
   * foi satisfeito (por outra execução simultânea), aguarda e RE-TENTA pelo
   * mesmo controle — cada nova tentativa volta a consultar o estado e revalidar
   * o dia e o tempo, inclusive após uma espera e na virada da meia-noite.
   * Esgota-se de forma explícita (sem fallback silencioso) quando o orçamento
   * de tempo (contado desde o início do pipeline), o orçamento de requisições
   * da execução, a cota diária ou os tokens por minuto se esgotam — sempre com
   * categoria global, para que o orquestrador pare de chamar o Gemini e siga
   * reaproveitando o histórico.
   *
   * @param inputTokens Tokens de entrada estimados da requisição (prompt completo).
   * @throws {GeminiAnalysisError} Quando a requisição não pode ser reservada.
   */
  async acquire(inputTokens = 0): Promise<void> {
    if (this.startFailure !== undefined) {
      throw new GeminiAnalysisError(
        "unavailable",
        "Controle de cota do Gemini indisponível nesta execução; " +
          "interrompendo novas chamadas.",
        { cause: this.startFailure },
      );
    }

    const snapshot = this.snapshot;
    const tokens =
      Number.isFinite(inputTokens) && inputTokens > 0
        ? Math.ceil(inputTokens)
        : 0;

    if (this.requestsUsed >= snapshot.allowance) {
      throw new GeminiAnalysisError(
        "rate_limit",
        `Orçamento de requisições desta execução esgotado ` +
          `(${snapshot.allowance}).`,
      );
    }

    for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt++) {
      // Revalida o orçamento de tempo ANTES de cada tentativa — inclusive após
      // qualquer espera — reservando margem para a chamada (timeout) e o
      // encerramento. É contado desde o INÍCIO do pipeline (coleta e esperas),
      // de modo que nenhuma chamada é emitida sem a margem necessária.
      if (this.now() - this.startedAt + CALL_RESERVE_MS > snapshot.timeBudgetMs) {
        throw new GeminiAnalysisError(
          "rate_limit",
          `Orçamento de tempo da execução esgotado (${snapshot.timeBudgetMs} ms ` +
            `desde o início do pipeline); interrompendo novas chamadas ao Gemini.`,
        );
      }

      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      // Revalida o dia e a janela de minuto a cada tentativa (virada da meia-noite).
      const quotaDay = quotaDayFor(new Date(nowMs), this.config.timeZone);
      const tokenMinute = quotaMinuteFor(new Date(nowMs), this.config.timeZone);

      let outcome: QuotaReservationResult;
      try {
        outcome = await reserveQuotaRequest({
          quotaDay,
          dailyLimit: snapshot.dailyQuota,
          nowIso,
          minIntervalMs: snapshot.minIntervalMs,
          tokenMinute,
          tokens,
          tpmLimit: snapshot.tpmLimit,
        });
      } catch (error) {
        throw new GeminiAnalysisError(
          "unavailable",
          "Falha ao controlar a cota do Gemini; interrompendo novas chamadas.",
          { cause: error },
        );
      }

      if (outcome.granted) {
        this.requestsUsed += 1;
        console.log(
          `Cota Gemini: requisição ${this.requestsUsed}/${snapshot.allowance} ` +
            `desta execução | usados hoje: ` +
            `${outcome.used}/${snapshot.dailyQuota} | ` +
            `tokens no minuto: ${outcome.tokensUsed}/${snapshot.tpmLimit}`,
        );
        return;
      }

      if (outcome.reason === "quota") {
        throw new GeminiAnalysisError(
          "rate_limit",
          `Cota diária do Gemini esgotada (${snapshot.dailyQuota} requisições).`,
        );
      }

      if (outcome.reason === "tokens") {
        throw new GeminiAnalysisError(
          "rate_limit",
          `Limite de tokens de entrada por minuto atingido ` +
            `(${snapshot.tpmLimit} TPM); interrompendo novas chamadas ao Gemini.`,
        );
      }

      // Intervalo mínimo ainda não satisfeito (concorrência): aguarda o tempo
      // restante a partir do estado persistido e RE-TENTA pelo mesmo controle.
      const delay = computeDelayMs(
        outcome.lastRequestAt,
        nowMs,
        snapshot.minIntervalMs,
      );
      if (delay > 0) {
        await this.sleep(delay);
      }
    }

    throw new GeminiAnalysisError(
      "rate_limit",
      "Intervalo mínimo entre requisições não satisfeito após novas " +
        "tentativas; interrompendo novas chamadas ao Gemini.",
    );
  }
}

/**
 * Cria e inicia o gerenciador de cota do Gemini.
 *
 * @param options Opções do gerenciador.
 * @returns O gerenciador já iniciado, com o orçamento desta execução.
 */
export async function createGeminiQuotaManager(
  options: GeminiQuotaManagerOptions,
): Promise<GeminiQuotaManager> {
  const manager = new GeminiQuotaManager(options);
  await manager.start();
  return manager;
}
