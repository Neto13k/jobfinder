import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { query } from "../db/postgres.js";
import { getStorageBackend, withStorageLock } from "./storage.js";
import type { Job } from "../types/job.js";

// Histórico de vagas notificadas no modo JSON (relativo ao cwd) — ignorado pelo Git.
const JSON_HISTORY_FILE = ["data", "notified-jobs.json"];

/** Estado de entrega de uma notificação. */
export type NotificationStatus = "pending" | "sent";

/**
 * Registro persistido de notificação.
 *
 * `pending` indica reserva obtida por uma execução cujo envio ainda não foi
 * confirmado; `sent` indica entrega aceita pelo Telegram e confirmada no banco.
 */
export interface NotifiedJobRecord {
  key: string;
  status: NotificationStatus;
  reservedBy: string | null;
  reservedAt: string | null;
}

/**
 * Reserva obtida por uma execução.
 *
 * O token identifica a execução dona da reserva: apenas quem o possui pode
 * confirmar ou liberar a vaga, impedindo que uma execução confirme a reserva
 * de outra.
 */
export interface NotificationReservation {
  key: string;
  token: string;
}

/** Reserva pendente exposta para diagnóstico e recuperação manual. */
export interface PendingReservation {
  key: string;
  reservedBy: string | null;
  reservedAt: string | null;
}

/** Ação de recuperação aplicada a uma reserva pendente. */
export type PendingResolution = "sent" | "released";

/** Linha da tabela public.notified_jobs. */
interface NotifiedJobRow {
  [column: string]: unknown;
  key: string;
  status: string;
  reserved_by: string | null;
  reserved_at: Date | string | null;
}

/**
 * Gera uma chave única para a vaga a partir de `source` e `id`.
 *
 * @param job Vaga de origem.
 * @returns Chave no formato "source:id".
 */
export function generateJobKey(job: Job): string {
  return `${job.source}:${job.id}`;
}

/**
 * Remove vagas duplicadas dentro da mesma execução.
 *
 * Mantém a primeira ocorrência de cada chave.
 *
 * @param jobs Lista de vagas possivelmente repetidas.
 * @returns Lista sem duplicatas.
 */
export function deduplicateJobs(jobs: Job[]): Job[] {
  const seen = new Set<string>();

  return jobs.filter((job) => {
    const key = generateJobKey(job);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

/** Normaliza um item do histórico JSON, aceitando o formato legado (string). */
function normalizeJsonEntry(value: unknown): NotifiedJobRecord | undefined {
  // Formato legado: apenas a chave, sempre tratada como já notificada.
  if (typeof value === "string") {
    return value.trim() === ""
      ? undefined
      : { key: value, status: "sent", reservedBy: null, reservedAt: null };
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || record.key.trim() === "") {
    return undefined;
  }

  return {
    key: record.key,
    status: record.status === "pending" ? "pending" : "sent",
    reservedBy: typeof record.reservedBy === "string" ? record.reservedBy : null,
    reservedAt: typeof record.reservedAt === "string" ? record.reservedAt : null,
  };
}

// Lê o histórico JSON; somente arquivo inexistente conta como lista vazia.
async function readJsonHistory(): Promise<NotifiedJobRecord[]> {
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
      `Histórico de notificações vazio (possível perda de dados): ${file}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // Não sobrescreve nem apaga: apenas sinaliza o problema.
    throw new Error(
      `Histórico de notificações corrompido (JSON inválido): ${file}`,
    );
  }

  if (!Array.isArray(data)) {
    throw new Error(
      `Histórico de notificações corrompido (formato inesperado): ${file}`,
    );
  }

  return data.map((item) => {
    const record = normalizeJsonEntry(item);
    if (!record) {
      throw new Error(
        `Histórico de notificações corrompido (registro inválido): ${file}`,
      );
    }
    return record;
  });
}

// Grava o histórico JSON, criando a pasta quando necessário.
async function writeJsonHistory(records: NotifiedJobRecord[]): Promise<void> {
  const file = join(process.cwd(), ...JSON_HISTORY_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

/**
 * Indica se a vaga já possui reserva ou notificação registrada.
 *
 * Reservas pendentes contam como "notificada" para impedir o reenvio
 * automático de mensagens cujo resultado é desconhecido.
 *
 * @param job Vaga consultada.
 * @returns true quando a chave já consta no histórico.
 */
export async function isJobNotified(job: Job): Promise<boolean> {
  const key = generateJobKey(job);

  if (getStorageBackend() === "postgres") {
    const { rowCount } = await query(
      "select 1 from public.notified_jobs where key = $1 limit 1",
      [key],
    );
    return (rowCount ?? 0) > 0;
  }

  const records = await readJsonHistory();
  return records.some((record) => record.key === key);
}

/**
 * Reserva a vaga para notificação, antes do envio.
 *
 * A inserção é atômica (chave única): execuções repetidas ou simultâneas só
 * recebem uma reserva, identificada pelo token devolvido. Use o token em
 * confirmJobNotification ou releaseJobNotification.
 *
 * @param job Vaga a reservar.
 * @returns A reserva obtida ou undefined se a vaga já estava reservada/notificada.
 * @throws Error se o backend de persistência estiver indisponível.
 */
export async function reserveJobNotification(
  job: Job,
): Promise<NotificationReservation | undefined> {
  const key = generateJobKey(job);
  const token = randomUUID();

  if (getStorageBackend() === "postgres") {
    const { rowCount } = await query(
      `insert into public.notified_jobs (key, status, reserved_by, reserved_at)
       values ($1, 'pending', $2, now())
       on conflict (key) do nothing
       returning key`,
      [key, token],
    );
    return (rowCount ?? 0) > 0 ? { key, token } : undefined;
  }

  return withStorageLock(async () => {
    const records = await readJsonHistory();

    if (records.some((record) => record.key === key)) {
      return undefined;
    }

    records.push({
      key,
      status: "pending",
      reservedBy: token,
      reservedAt: new Date().toISOString(),
    });
    await writeJsonHistory(records);
    return { key, token };
  });
}

/**
 * Confirma a notificação após o Telegram aceitar a mensagem.
 *
 * Só confirma a reserva pendente pertencente a este token; reservas de outra
 * execução (ou já confirmadas/liberadas) não são alteradas.
 *
 * @param reservation Reserva obtida em reserveJobNotification.
 * @returns true se esta execução confirmou a própria reserva; false caso contrário.
 */
export async function confirmJobNotification(
  reservation: NotificationReservation,
): Promise<boolean> {
  const { key, token } = reservation;

  if (getStorageBackend() === "postgres") {
    const { rowCount } = await query(
      `update public.notified_jobs
          set status = 'sent', notified_at = now()
        where key = $1 and status = 'pending' and reserved_by = $2`,
      [key, token],
    );
    return (rowCount ?? 0) > 0;
  }

  return withStorageLock(async () => {
    const records = await readJsonHistory();
    const record = records.find((item) => item.key === key);

    if (!record || record.status !== "pending" || record.reservedBy !== token) {
      return false;
    }

    record.status = "sent";
    record.reservedBy = null;
    await writeJsonHistory(records);
    return true;
  });
}

/**
 * Libera uma reserva cujo envio falhou de forma confirmada.
 *
 * Só remove a reserva pendente pertencente a este token: uma notificação já
 * confirmada ou reservada por outra execução é preservada.
 *
 * @param reservation Reserva obtida em reserveJobNotification.
 * @returns true se a reserva foi liberada; false se não pertencia a este token.
 */
export async function releaseJobNotification(
  reservation: NotificationReservation,
): Promise<boolean> {
  const { key, token } = reservation;

  if (getStorageBackend() === "postgres") {
    const { rowCount } = await query(
      `delete from public.notified_jobs
        where key = $1 and status = 'pending' and reserved_by = $2`,
      [key, token],
    );
    return (rowCount ?? 0) > 0;
  }

  return withStorageLock(async () => {
    const records = await readJsonHistory();
    const record = records.find((item) => item.key === key);

    if (!record || record.status !== "pending" || record.reservedBy !== token) {
      return false;
    }

    await writeJsonHistory(records.filter((item) => item.key !== key));
    return true;
  });
}

/**
 * Registra a vaga como notificada (reserva + confirmação).
 *
 * Atalho para scripts e testes; o pipeline principal usa reserveJobNotification
 * e confirmJobNotification para tratar falhas de envio.
 *
 * @param job Vaga a registrar.
 */
export async function markJobAsNotified(job: Job): Promise<void> {
  const reservation = await reserveJobNotification(job);

  if (!reservation) {
    return;
  }

  await confirmJobNotification(reservation);
}

/**
 * Lista reservas pendentes, opcionalmente apenas as mais antigas que um limite.
 *
 * Serve para identificar reservas abandonadas antes de decidir, manualmente,
 * se a mensagem foi entregue ou se deve ser liberada.
 *
 * @param olderThanMs Idade mínima em milissegundos (0 lista todas).
 * @returns Reservas pendentes, das mais antigas para as mais recentes.
 */
export async function listPendingReservations(
  olderThanMs = 0,
): Promise<PendingReservation[]> {
  const cutoff = Date.now() - olderThanMs;

  let pending: PendingReservation[];

  if (getStorageBackend() === "postgres") {
    const { rows } = await query<NotifiedJobRow>(
      `select key, status, reserved_by, reserved_at
         from public.notified_jobs
        where status = 'pending'
        order by reserved_at asc nulls first`,
    );

    pending = rows.map((row) => ({
      key: row.key,
      reservedBy: row.reserved_by,
      reservedAt: row.reserved_at ? new Date(row.reserved_at).toISOString() : null,
    }));
  } else {
    const records = await readJsonHistory();
    pending = records
      .filter((record) => record.status === "pending")
      .map((record) => ({
        key: record.key,
        reservedBy: record.reservedBy,
        reservedAt: record.reservedAt,
      }));
  }

  // Reservas sem timestamp são mantidas: a idade é desconhecida, não nula.
  return pending.filter(
    (item) => !item.reservedAt || Date.parse(item.reservedAt) <= cutoff,
  );
}

/**
 * Resolve manualmente uma reserva pendente, sem reenviar mensagens.
 *
 * Use "sent" quando a mensagem foi confirmadamente entregue e "released" quando
 * é seguro tentar novamente. A vaga é identificada pela chave "source:id".
 *
 * @param key Chave da vaga.
 * @param resolution "sent" para confirmar a entrega ou "released" para liberar.
 * @returns true se uma reserva pendente foi alterada; false se não havia.
 */
export async function resolvePendingReservation(
  key: string,
  resolution: PendingResolution,
): Promise<boolean> {
  if (getStorageBackend() === "postgres") {
    if (resolution === "sent") {
      const { rowCount } = await query(
        `update public.notified_jobs
            set status = 'sent', notified_at = now()
          where key = $1 and status = 'pending'`,
        [key],
      );
      return (rowCount ?? 0) > 0;
    }

    const { rowCount } = await query(
      "delete from public.notified_jobs where key = $1 and status = 'pending'",
      [key],
    );
    return (rowCount ?? 0) > 0;
  }

  return withStorageLock(async () => {
    const records = await readJsonHistory();
    const record = records.find(
      (item) => item.key === key && item.status === "pending",
    );

    if (!record) {
      return false;
    }

    if (resolution === "sent") {
      record.status = "sent";
      record.reservedBy = null;
      await writeJsonHistory(records);
    } else {
      await writeJsonHistory(records.filter((item) => item.key !== key));
    }

    return true;
  });
}
