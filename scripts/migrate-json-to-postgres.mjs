// Migração dos históricos JSON locais para o PostgreSQL do Supabase.
//
// Uso:
//   npm run build
//   node --env-file=.env scripts/migrate-json-to-postgres.mjs --dry-run
//   node --env-file=.env scripts/migrate-json-to-postgres.mjs
//
// - Modo simulação com --dry-run: não abre conexão nem grava nada.
// - Importação idempotente: usa ON CONFLICT DO NOTHING (pode rodar várias vezes).
// - Preserva os arquivos originais: apenas lê, nunca escreve nem apaga.
// - Nunca imprime DATABASE_URL nem credenciais.
//
// Este script NÃO é executado automaticamente pelo JobFinder.

import process from "node:process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { closePool, query } from "../dist/db/postgres.js";

const DRY_RUN = process.argv.includes("--dry-run");

const ANALYZED_FILE = join(process.cwd(), "data", "analyzed-jobs.json");
const NOTIFIED_FILE = join(process.cwd(), "data", "notified-jobs.json");

/**
 * Lê um arquivo JSON, tratando ausência como lista vazia.
 *
 * Arquivo existente porém vazio ou corrompido interrompe a migração para não
 * importar dados parciais.
 */
async function readJsonArray(file) {
  let content;

  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      console.log(`Ignorado (arquivo inexistente): ${file}`);
      return [];
    }

    throw error;
  }

  if (content.trim() === "") {
    throw new Error(`Arquivo vazio (possível perda de dados): ${file}`);
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error(`Arquivo com JSON inválido: ${file}`);
  }

  if (!Array.isArray(data)) {
    throw new Error(`Arquivo com formato inesperado (esperado array): ${file}`);
  }

  return data;
}

/** Confere os campos mínimos de um registro de análise importado do JSON. */
function assertAnalyzedRecord(record) {
  if (typeof record !== "object" || record === null) {
    throw new Error("Registro de análise inválido (não é objeto).");
  }

  const required = [
    "key",
    "decision",
    "score",
    "reason",
    "locationStatus",
    "contractStatus",
    "analyzedAt",
  ];
  for (const field of required) {
    if (record[field] === undefined || record[field] === null) {
      throw new Error(`Registro de análise sem o campo "${field}".`);
    }
  }
}

async function migrateAnalyzed(records) {
  // Valida TODOS os registros antes de qualquer gravação — inclusive no dry-run.
  for (const record of records) {
    assertAnalyzedRecord(record);
  }

  if (DRY_RUN) {
    console.log(`[dry-run] analyzed_jobs: ${records.length} registro(s) seriam importados.`);
    return { inserted: 0, skipped: 0 };
  }

  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const { rowCount } = await query(
      `insert into public.analyzed_jobs
         (key, decision, score, reason, location_status, contract_status, analyzed_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (key) do nothing
       returning key`,
      [
        String(record.key),
        String(record.decision),
        Number(record.score),
        String(record.reason),
        String(record.locationStatus),
        String(record.contractStatus),
        new Date(record.analyzedAt).toISOString(),
      ],
    );

    if ((rowCount ?? 0) > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  return { inserted, skipped };
}

/**
 * Normaliza uma entrada de notificação.
 *
 * Aceita o formato legado (string com a chave, tratada como "sent") e o formato
 * atual (objeto com key/status). Valida durante o dry-run também.
 */
function normalizeNotifiedEntry(entry) {
  if (typeof entry === "string") {
    const key = entry.trim();
    if (key === "") {
      throw new Error("Registro de notificação inválido (texto vazio).");
    }
    return { key, status: "sent" };
  }

  if (typeof entry === "object" && entry !== null) {
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (key === "") {
      throw new Error("Registro de notificação inválido (sem chave).");
    }
    return { key, status: entry.status === "pending" ? "pending" : "sent" };
  }

  throw new Error("Registro de notificação inválido (formato inesperado).");
}

async function migrateNotified(entries) {
  // Valida e normaliza antes do dry-run.
  const records = entries.map(normalizeNotifiedEntry);

  if (DRY_RUN) {
    console.log(`[dry-run] notified_jobs: ${records.length} registro(s) seriam importados.`);
    return { inserted: 0, skipped: 0 };
  }

  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    const { rowCount } = await query(
      `insert into public.notified_jobs (key, status)
       values ($1, $2)
       on conflict (key) do nothing
       returning key`,
      [record.key, record.status],
    );

    if ((rowCount ?? 0) > 0) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }

  return { inserted, skipped };
}

async function main() {
  console.log(DRY_RUN ? "Modo simulação (--dry-run): nada será gravado." : "Modo real: gravando no PostgreSQL.");

  const analyzed = await readJsonArray(ANALYZED_FILE);
  const notified = await readJsonArray(NOTIFIED_FILE);

  const analyzedResult = await migrateAnalyzed(analyzed);
  const notifiedResult = await migrateNotified(notified);

  if (!DRY_RUN) {
    console.log(
      `analyzed_jobs: ${analyzedResult.inserted} inserido(s), ` +
        `${analyzedResult.skipped} já existente(s).`,
    );
    console.log(
      `notified_jobs: ${notifiedResult.inserted} inserido(s), ` +
        `${notifiedResult.skipped} já existente(s).`,
    );
  }

  console.log("Arquivos JSON originais preservados (nenhuma escrita local).");
  console.log("Migração concluída.");
}

try {
  await main();
} catch (error) {
  // Apenas a mensagem: nunca a DATABASE_URL.
  console.error(
    "[migrate-json-to-postgres] Falha:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
