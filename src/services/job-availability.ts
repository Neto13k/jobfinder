import type { Job } from "../types/job.js";

// --- Configuração ----------------------------------------------------------

// Tempo máximo de cada consulta ao catálogo público do board.
const DEFAULT_TIMEOUT_MS = 10_000;
// Boards consultados em paralelo por avaliação (limita requisições simultâneas).
const DEFAULT_CONCURRENCY = 3;

/** Configuração da verificação de disponibilidade (opt-in). */
export interface AvailabilityConfig {
  /** Quando `false` (padrão), nenhuma consulta é feita e nada é descartado. */
  enabled: boolean;
  /** Timeout por consulta ao catálogo, em milissegundos. */
  timeoutMs: number;
  /** Número máximo de boards consultados simultaneamente. */
  concurrency: number;
}

/** Lê um booleano textual; valores ausentes/inválidos usam o padrão seguro. */
function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? "").trim().toLowerCase();

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return fallback;
}

/** Lê um inteiro positivo; valores ausentes/inválidos usam o padrão seguro. */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  const value = (raw ?? "").trim();

  if (!/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number(value);
  return parsed >= 1 ? parsed : fallback;
}

/**
 * Resolve a configuração da verificação de disponibilidade.
 *
 * A funcionalidade é **opt-in**: sem `JOBFINDER_VERIFY_OPEN_JOBS=true` nenhuma
 * consulta é feita, preservando integralmente o comportamento atual.
 *
 * @param env Ambiente de onde ler as variáveis (padrão: `process.env`).
 */
export function resolveAvailabilityConfig(
  env: NodeJS.ProcessEnv = process.env,
): AvailabilityConfig {
  return {
    enabled: readBoolean(env.JOBFINDER_VERIFY_OPEN_JOBS, false),
    timeoutMs: readPositiveInt(
      env.JOBFINDER_VERIFY_OPEN_JOBS_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    concurrency: readPositiveInt(
      env.JOBFINDER_VERIFY_OPEN_JOBS_CONCURRENCY,
      DEFAULT_CONCURRENCY,
    ),
  };
}

// --- Classificação ---------------------------------------------------------

/**
 * Disponibilidade de uma vaga:
 * - "open": a vaga consta no catálogo público da própria fonte;
 * - "closed": o catálogo foi lido com sucesso e a vaga NÃO consta nele;
 * - "unknown": fonte sem catálogo confiável, falha, timeout ou bloqueio.
 */
export type JobAvailability = "open" | "closed" | "unknown";

/**
 * Indica se a fonte oferece um catálogo público confiável para confirmar a
 * disponibilidade. Apenas Greenhouse e Lever expõem a lista completa de vagas
 * abertas por board, permitindo confirmar o encerramento pela ausência da vaga.
 */
export function supportsAvailability(source: string): boolean {
  return source === "greenhouse" || source === "lever";
}

// --- Consulta ao catálogo --------------------------------------------------

/** Consulta injetável: devolve os IDs abertos do board ou `null` (indefinido). */
export type BoardIdFetcher = (
  source: string,
  board: string,
) => Promise<ReadonlySet<string> | null>;

/**
 * Executa uma requisição JSON com timeout; lança em qualquer falha.
 *
 * @param url Endpoint do catálogo.
 * @param timeoutMs Limite de tempo da requisição.
 */
async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  return body;
}

/**
 * Lê os IDs das vagas abertas de um board público.
 *
 * Retorna `null` — disponibilidade indefinida — em qualquer situação que não
 * permita confirmar o catálogo: fonte sem suporte, resposta HTTP de erro,
 * timeout, corpo inesperado ou falha de rede. Nunca lança: uma verificação
 * indisponível **não** pode descartar uma vaga.
 *
 * @param source Fonte da vaga ("greenhouse" ou "lever").
 * @param board Identificador do board (`job.company` para essas fontes).
 * @param timeoutMs Limite de tempo da requisição.
 */
async function fetchBoardJobIds(
  source: string,
  board: string,
  timeoutMs: number,
): Promise<ReadonlySet<string> | null> {
  try {
    if (source === "greenhouse") {
      const data = await fetchJson(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs`,
        timeoutMs,
      );

      if (typeof data !== "object" || data === null) {
        return null;
      }

      const jobs = (data as { jobs?: unknown }).jobs;
      if (!Array.isArray(jobs)) {
        return null;
      }

      const ids = new Set<string>();
      for (const entry of jobs) {
        if (typeof entry !== "object" || entry === null) {
          continue;
        }

        const id = (entry as { id?: unknown }).id;
        if (typeof id === "number") {
          ids.add(String(id));
        } else if (typeof id === "string" && id !== "") {
          ids.add(id);
        }
      }

      return ids;
    }

    if (source === "lever") {
      const data = await fetchJson(
        `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`,
        timeoutMs,
      );

      if (!Array.isArray(data)) {
        return null;
      }

      const ids = new Set<string>();
      for (const entry of data) {
        if (typeof entry !== "object" || entry === null) {
          continue;
        }

        const id = (entry as { id?: unknown }).id;
        if (typeof id === "string" && id !== "") {
          ids.add(id);
        }
      }

      return ids;
    }

    return null;
  } catch {
    // Falha, timeout ou bloqueio: disponibilidade indefinida (não descarta).
    return null;
  }
}

/** Dependências injetáveis da avaliação de disponibilidade (uso em testes). */
export interface AvailabilityDependencies {
  /** Consulta o catálogo de um board; padrão: HTTP nas APIs públicas. */
  fetchBoardIds?: BoardIdFetcher;
  /** Timeout por consulta, em milissegundos (padrão: configuração atual). */
  timeoutMs?: number;
  /** Máximo de boards consultados em paralelo (padrão: configuração atual). */
  concurrency?: number;
}

/**
 * Avalia a disponibilidade de cada vaga, consultando **uma vez** cada board.
 *
 * Agrupa as vagas por `source` + board (`job.company` para Greenhouse/Lever) e
 * limita a concorrência entre boards, evitando requisições excessivas. Fontes
 * sem catálogo confiável recebem "unknown" sem nenhuma consulta. Uma falha de
 * um board afeta apenas as vagas daquele board.
 *
 * A função é conservadora: só marca "closed" quando o catálogo foi lido com
 * sucesso e o ID da vaga **não** consta nele; qualquer incerteza resulta em
 * "unknown", preservando a notificação conforme a política existente.
 *
 * @param jobs Vagas candidatas à notificação.
 * @param deps Dependências injetáveis (consulta, timeout, concorrência).
 * @returns Mapa de cada vaga para sua disponibilidade.
 */
export async function evaluateJobAvailability(
  jobs: Job[],
  deps: AvailabilityDependencies = {},
): Promise<Map<Job, JobAvailability>> {
  const config = resolveAvailabilityConfig();
  const timeoutMs = deps.timeoutMs ?? config.timeoutMs;
  const concurrency = deps.concurrency ?? config.concurrency;
  const fetchIds =
    deps.fetchBoardIds ??
    ((source: string, board: string) =>
      fetchBoardJobIds(source, board, timeoutMs));

  const result = new Map<Job, JobAvailability>();

  // Agrupa por fonte+board para consultar cada catálogo uma única vez.
  const groups = new Map<string, { source: string; board: string; jobs: Job[] }>();

  for (const job of jobs) {
    if (!supportsAvailability(job.source)) {
      result.set(job, "unknown");
      continue;
    }

    const key = `${job.source}\u0000${job.company}`;
    const existing = groups.get(key);

    if (existing) {
      existing.jobs.push(job);
    } else {
      groups.set(key, { source: job.source, board: job.company, jobs: [job] });
    }
  }

  const groupList = [...groups.values()];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < groupList.length) {
      const group = groupList[cursor++];
      const ids = await fetchIds(group.source, group.board);

      for (const job of group.jobs) {
        if (ids === null) {
          result.set(job, "unknown");
        } else {
          result.set(job, ids.has(job.id) ? "open" : "closed");
        }
      }
    }
  };

  const workers = Math.min(concurrency, groupList.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return result;
}
