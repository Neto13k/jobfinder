import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Job } from "../types/job.js";

// Histórico em disco (relativo à raiz de execução) — ignorado pelo Git.
const HISTORY_FILE = join(process.cwd(), "data", "notified-jobs.json");

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

// Lê o histórico; somente arquivo inexistente conta como lista vazia.
async function readHistory(): Promise<string[]> {
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
      `Histórico de notificações vazio (possível perda de dados): ${HISTORY_FILE}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    // Não sobrescreve nem apaga: apenas sinaliza o problema.
    throw new Error(
      `Histórico de notificações corrompido (JSON inválido): ${HISTORY_FILE}`,
    );
  }

  if (!Array.isArray(data) || !data.every((item) => typeof item === "string")) {
    throw new Error(
      `Histórico de notificações corrompido (formato inesperado): ${HISTORY_FILE}`,
    );
  }

  return data;
}

// Grava o histórico, criando a pasta quando necessário.
async function writeHistory(keys: string[]): Promise<void> {
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await writeFile(HISTORY_FILE, `${JSON.stringify(keys, null, 2)}\n`, "utf8");
}

/**
 * Indica se a vaga já foi notificada anteriormente.
 *
 * @param job Vaga consultada.
 * @returns true quando a chave já consta no histórico.
 */
export async function isJobNotified(job: Job): Promise<boolean> {
  const keys = await readHistory();

  return keys.includes(generateJobKey(job));
}

/**
 * Registra a vaga como notificada.
 *
 * Deve ser chamada apenas após o envio da notificação; a coleta e a análise
 * não fazem esse registro automaticamente.
 *
 * @param job Vaga a registrar.
 */
export async function markJobAsNotified(job: Job): Promise<void> {
  const keys = await readHistory();
  const key = generateJobKey(job);

  if (keys.includes(key)) {
    return;
  }

  keys.push(key);
  await writeHistory(keys);
}
