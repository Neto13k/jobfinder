import {
  INDEED_LOCAL_SEARCHES,
  INDEED_REMOTE_SEARCHES,
} from "../config/indeed-searches.js";
import type { IndeedJobSource } from "../config/indeed-searches.js";

/** Total de lotes distintos; define o ciclo da rotação. */
export const INDEED_TOTAL_BATCHES = 20;

/** Pesquisas remotas por lote; as demais posições do lote são a pesquisa local. */
export const INDEED_REMOTES_PER_BATCH = 4;

/** Duração de uma hora em milissegundos, base do cálculo por hora UTC. */
const MS_PER_HOUR = 3_600_000;

/** Seleção de um lote de pesquisas do Indeed. */
export interface IndeedBatch {
  /** Número do lote, de 1 a {@link INDEED_TOTAL_BATCHES}. */
  batchNumber: number;
  /** Pesquisa local (Maceió/AL) do lote. */
  local: IndeedJobSource;
  /** Quatro pesquisas remotas nacionais do lote. */
  remotes: IndeedJobSource[];
  /** As cinco pesquisas do lote, na ordem de execução (local primeiro). */
  searches: IndeedJobSource[];
}

// A rotação só é válida com exatamente 20 locais e 80 remotas (20 lotes de 5).
if (
  INDEED_LOCAL_SEARCHES.length !== INDEED_TOTAL_BATCHES ||
  INDEED_REMOTE_SEARCHES.length !==
    INDEED_TOTAL_BATCHES * INDEED_REMOTES_PER_BATCH
) {
  throw new Error(
    "Matriz de pesquisas do Indeed inválida: esperado 20 locais e 80 remotas, " +
      `recebido ${INDEED_LOCAL_SEARCHES.length} e ${INDEED_REMOTE_SEARCHES.length}.`,
  );
}

/**
 * Seleciona o lote de pesquisas do Indeed correspondente à hora UTC de `date`.
 *
 * Determinístico e sem estado: converte a data em horas UTC absolutas desde a
 * época (epoch ÷ 1 h) e aplica módulo {@link INDEED_TOTAL_BATCHES}, de modo que
 * cada hora do calendário mapeie sempre para o mesmo lote e o ciclo se repita a
 * cada 20 horas. Execuções na mesma hora repetem o mesmo lote e nada precisa
 * ser persistido entre execuções. A rotação é independente da do LinkedIn.
 *
 * @param date Data de referência (padrão: agora). Recebida como parâmetro para
 * permitir a validação manual de qualquer hora.
 * @returns O lote com 1 pesquisa local e 4 remotas.
 */
export function selectIndeedBatch(date: Date = new Date()): IndeedBatch {
  const absoluteHours = Math.floor(date.getTime() / MS_PER_HOUR);
  const index =
    ((absoluteHours % INDEED_TOTAL_BATCHES) + INDEED_TOTAL_BATCHES) %
    INDEED_TOTAL_BATCHES;

  const local = INDEED_LOCAL_SEARCHES[index];
  const remotes = INDEED_REMOTE_SEARCHES.slice(
    index * INDEED_REMOTES_PER_BATCH,
    index * INDEED_REMOTES_PER_BATCH + INDEED_REMOTES_PER_BATCH,
  );

  return {
    batchNumber: index + 1,
    local,
    remotes,
    searches: [local, ...remotes],
  };
}
