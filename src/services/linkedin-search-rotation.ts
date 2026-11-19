import {
  LINKEDIN_LOCAL_SEARCHES,
  LINKEDIN_REMOTE_SEARCHES,
} from "../config/linkedin-searches.js";
import type { LinkedInJobSource } from "../config/job-sources.js";

/** Total de lotes distintos; define o ciclo da rotação. */
export const LINKEDIN_TOTAL_BATCHES = 22;

/** Pesquisas remotas por lote; as demais posições do lote são a pesquisa local. */
export const LINKEDIN_REMOTES_PER_BATCH = 4;

/** Duração de uma hora em milissegundos, base do cálculo por hora UTC. */
const MS_PER_HOUR = 3_600_000;

/** Seleção de um lote de pesquisas do LinkedIn. */
export interface LinkedInBatch {
  /** Número do lote, de 1 a {@link LINKEDIN_TOTAL_BATCHES}. */
  batchNumber: number;
  /** Pesquisa local (Maceió/AL) do lote. */
  local: LinkedInJobSource;
  /** Quatro pesquisas remotas nacionais do lote. */
  remotes: LinkedInJobSource[];
  /** As cinco pesquisas do lote, na ordem de execução (local primeiro). */
  searches: LinkedInJobSource[];
}

// A rotação só é válida com exatamente 22 locais e 88 remotas (22 lotes de 5).
if (
  LINKEDIN_LOCAL_SEARCHES.length !== LINKEDIN_TOTAL_BATCHES ||
  LINKEDIN_REMOTE_SEARCHES.length !==
    LINKEDIN_TOTAL_BATCHES * LINKEDIN_REMOTES_PER_BATCH
) {
  throw new Error(
    "Matriz de pesquisas do LinkedIn inválida: esperado 22 locais e 88 remotas, " +
      `recebido ${LINKEDIN_LOCAL_SEARCHES.length} e ${LINKEDIN_REMOTE_SEARCHES.length}.`,
  );
}

/**
 * Seleciona o lote de pesquisas do LinkedIn correspondente à hora UTC de `date`.
 *
 * Determinístico e sem estado: converte a data em horas UTC absolutas desde a
 * época (epoch ÷ 1 h) e aplica módulo {@link LINKEDIN_TOTAL_BATCHES}, de modo
 * que cada hora do calendário mapeie sempre para o mesmo lote e o ciclo se
 * repita a cada 22 horas. Execuções na mesma hora repetem o mesmo lote e nada
 * precisa ser persistido entre execuções.
 *
 * @param date Data de referência (padrão: agora). Recebida como parâmetro para
 * permitir a validação manual de qualquer hora.
 * @returns O lote com 1 pesquisa local e 4 remotas.
 */
export function selectLinkedInBatch(date: Date = new Date()): LinkedInBatch {
  const absoluteHours = Math.floor(date.getTime() / MS_PER_HOUR);
  const index =
    ((absoluteHours % LINKEDIN_TOTAL_BATCHES) + LINKEDIN_TOTAL_BATCHES) %
    LINKEDIN_TOTAL_BATCHES;

  const local = LINKEDIN_LOCAL_SEARCHES[index];
  const remotes = LINKEDIN_REMOTE_SEARCHES.slice(
    index * LINKEDIN_REMOTES_PER_BATCH,
    index * LINKEDIN_REMOTES_PER_BATCH + LINKEDIN_REMOTES_PER_BATCH,
  );

  return {
    batchNumber: index + 1,
    local,
    remotes,
    searches: [local, ...remotes],
  };
}
