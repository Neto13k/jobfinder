// Teste independente de conexão com o PostgreSQL do Supabase.
//
// Uso:
//   npm run build
//   node --env-file=.env scripts/db-connection-test.mjs
//
// Executa SELECT 1 e confirma a existência das tabelas esperadas.
// Não executa o pipeline, não migra registros e nunca imprime a DATABASE_URL.

import process from "node:process";
import { closePool, getPool } from "../dist/db/postgres.js";

// Tabelas que devem existir após a migration inicial.
const EXPECTED_TABLES = ["analyzed_jobs", "notified_jobs"];

/** Interrompe o teste com uma mensagem clara quando a condição falhar. */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`[db-connection-test] ${message}`);
  }
}

async function main() {
  const pool = getPool();

  const ping = await pool.query("select 1 as ok");
  assert(ping.rows[0]?.ok === 1, "SELECT 1 não retornou 1.");
  console.log("Conexão OK: SELECT 1 respondeu com sucesso.");

  const { rows } = await pool.query(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name`,
    [EXPECTED_TABLES],
  );

  const found = rows.map((row) => row.table_name);
  const missing = EXPECTED_TABLES.filter((name) => !found.includes(name));
  assert(
    missing.length === 0,
    `Tabelas ausentes em public: ${missing.join(", ")}.`,
  );

  console.log(`Tabelas confirmadas em public: ${found.join(", ")}.`);
}

try {
  await main();
  console.log("Teste de conexão concluído com sucesso.");
} catch (error) {
  // Apenas a mensagem do erro: a DATABASE_URL nunca é registrada.
  console.error(
    "[db-connection-test] Falha:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
