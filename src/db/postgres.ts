import { readFileSync } from "node:fs";
import { Pool } from "pg";
import type { PoolConfig, QueryResult, QueryResultRow } from "pg";

let pool: Pool | undefined;

/** Parâmetros de SSL da connection string que seriam aplicados sobre o config. */
const SSL_CONNECTION_PARAMS = [
  "sslmode",
  "ssl",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslnegotiation",
];

/** Códigos de erro do TLS indicando falha na validação do certificado. */
const TLS_CERTIFICATE_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Remove parâmetros de SSL da connection string.
 *
 * O `pg` aplica o parse da connection string depois do config
 * (`Object.assign({}, config, parse(connectionString))`), então algo como
 * `sslmode=no-verify` sobrescreveria a configuração TLS deste módulo. Removê-los
 * garante que a validação do certificado definida aqui prevaleça.
 *
 * @param connectionString URL de conexão do PostgreSQL.
 * @returns A URL sem os parâmetros de SSL.
 */
function stripSslParams(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Formato não reconhecido: mantém como está e deixa o `pg` reportar o erro.
    return connectionString;
  }

  for (const param of SSL_CONNECTION_PARAMS) {
    url.searchParams.delete(param);
  }

  return url.toString();
}

/**
 * Monta a configuração TLS, sempre com validação do certificado do servidor.
 *
 * Usa o certificado CA indicado por DATABASE_CA_CERT_PATH (certificado do
 * Supabase). Sem essa variável, valida contra as CAs confiáveis do sistema.
 * A validação nunca é desativada.
 *
 * @returns Opções de TLS para o `pg`.
 * @throws Error se a CA indicada não puder ser lida.
 */
function buildSslConfig(): PoolConfig["ssl"] {
  const caPath = process.env.DATABASE_CA_CERT_PATH;
  if (!caPath) {
    return { rejectUnauthorized: true };
  }

  let ca: string;
  try {
    ca = readFileSync(caPath, "utf8");
  } catch {
    // Não expõe o caminho nem credenciais no erro.
    throw new Error(
      "Não foi possível ler o certificado CA indicado por DATABASE_CA_CERT_PATH.",
    );
  }

  return { ca, rejectUnauthorized: true };
}

/**
 * Identifica falhas de validação do certificado TLS.
 *
 * @param error Erro capturado durante a conexão.
 * @returns true quando o erro é de validação de certificado.
 */
function isCertificateError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return TLS_CERTIFICATE_ERROR_CODES.has(String((error as { code: unknown }).code));
}

/**
 * Retorna o pool de conexões, criando-o na primeira chamada.
 *
 * A URL vem de DATABASE_URL (nunca embutida no código). A conexão usa TLS com
 * validação do certificado do servidor, exigido pelo Supabase. Parâmetros de
 * SSL da URL são ignorados para não sobrepor essa configuração.
 *
 * @returns Pool compartilhado do PostgreSQL.
 * @throws Error se DATABASE_URL não estiver definida ou se a CA não puder ser lida.
 */
export function getPool(): Pool {
  if (pool) {
    return pool;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("A variável de ambiente DATABASE_URL não está definida.");
  }

  pool = new Pool({
    connectionString: stripSslParams(connectionString),
    ssl: buildSslConfig(),
    max: 5,
  });

  // Falhas em clientes ociosos não devem derrubar o processo sem aviso.
  pool.on("error", (error: Error) => {
    console.error("Erro inesperado na conexão PostgreSQL:", error.message);
  });

  return pool;
}

/**
 * Executa uma consulta parametrizada no pool compartilhado.
 *
 * @param text SQL com placeholders ($1, $2, ...).
 * @param params Valores correspondentes aos placeholders.
 * @returns Resultado da consulta.
 * @throws Error claro em caso de falha na validação do certificado TLS.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  try {
    return await getPool().query<T>(text, params);
  } catch (error) {
    if (isCertificateError(error)) {
      throw new Error(
        "Falha na validação do certificado TLS do PostgreSQL. " +
          "Se o servidor usar uma CA privada, configure DATABASE_CA_CERT_PATH " +
          "com o certificado fornecido pelo Supabase.",
      );
    }

    throw error;
  }
}

/** Encerra o pool, liberando todas as conexões abertas. */
export async function closePool(): Promise<void> {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = undefined;
}
