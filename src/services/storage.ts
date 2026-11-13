/**
 * Seleção explícita do backend de persistência dos históricos.
 *
 * - "json": arquivos em data/ (comportamento local da v1.0). Padrão.
 * - "postgres": tabelas no Supabase via src/db/postgres.ts.
 *
 * A escolha é feita por JOBFINDER_STORAGE. Não há fallback automático: um erro
 * no PostgreSQL propaga como erro, nunca cai silenciosamente para JSON.
 */
export type StorageBackend = "json" | "postgres";

/**
 * Lê o backend configurado em JOBFINDER_STORAGE.
 *
 * @returns "json" (padrão) ou "postgres".
 * @throws Error quando o valor informado não for reconhecido.
 */
export function getStorageBackend(): StorageBackend {
  const raw = process.env.JOBFINDER_STORAGE?.trim().toLowerCase();

  if (!raw) {
    return "json";
  }
  if (raw === "json" || raw === "postgres") {
    return raw;
  }

  throw new Error(
    `Valor inválido para JOBFINDER_STORAGE: "${raw}". Use "json" ou "postgres".`,
  );
}

/**
 * Indica se o backend ativo é o PostgreSQL.
 *
 * @returns true quando JOBFINDER_STORAGE=postgres.
 */
export function isPostgresStorage(): boolean {
  return getStorageBackend() === "postgres";
}

// Fila simples que serializa operações de leitura/escrita no modo JSON,
// evitando que duas tarefas intercalem o mesmo read-modify-write no processo.
let queue: Promise<unknown> = Promise.resolve();

/**
 * executa uma tarefa mantendo as operações de arquivo em série.
 *
 * @param task Operação de persistência local.
 * @returns O resultado da tarefa.
 */
export function withStorageLock<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}
