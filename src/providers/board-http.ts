/**
 * Timeout único das requisições aos boards públicos (Greenhouse, Lever, Ashby).
 *
 * Um valor só evita divergência entre providers: cada requisição é abandonada
 * se não concluir em 15 segundos.
 */
export const BOARD_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Erro de timeout ao consultar um board público.
 *
 * Permite diferenciar o timeout de outros erros HTTP nos logs sem depender da
 * mensagem textual.
 */
export class BoardTimeoutError extends Error {
  /** Fonte (provider) cuja requisição excedeu o limite. */
  readonly source: string;
  /** Limite de tempo, em milissegundos, que foi excedido. */
  readonly timeoutMs: number;

  constructor(source: string, timeoutMs: number) {
    super(`Timeout de ${timeoutMs} ms ao consultar a fonte ${source}.`);
    this.name = "BoardTimeoutError";
    this.source = source;
    this.timeoutMs = timeoutMs;
    // Restaura o protótipo para que `instanceof` funcione com o alvo transpilado.
    Object.setPrototypeOf(this, BoardTimeoutError.prototype);
  }
}

/**
 * Indica se o erro decorre do cancelamento por timeout.
 *
 * `AbortSignal.timeout` aborta com `DOMException` de nome "TimeoutError"; alguns
 * caminhos do undici propagam o mesmo cancelamento como "AbortError". A
 * detecção é feita pelo nome para não depender da hierarquia de protótipos.
 */
export function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Executa uma requisição HTTP de board público com timeout de 15 segundos.
 *
 * O `AbortSignal.timeout` é anexado à requisição e governa conexão, cabeçalhos
 * e leitura do corpo: como o corpo da resposta está vinculado ao sinal, um
 * `read` que ultrapasse o limite também é cancelado. Timeouts são convertidos
 * em {@link BoardTimeoutError} (diferenciável nos logs); qualquer outro erro —
 * inclusive as respostas HTTP de erro produzidas por `read` — é repropagado sem
 * alteração, preservando o tratamento atual de cada provider.
 *
 * @param url Endpoint do board.
 * @param source Rótulo do provider (ex.: "greenhouse").
 * @param read Lê/valida a resposta; recebe o {@link Response} resolvido.
 * @param headers Cabeçalhos extras da requisição (ex.: `X-Tenant` da InHire);
 *   ausente nos providers que não exigem cabeçalho.
 * @returns O valor produzido por `read`.
 * @throws {BoardTimeoutError} Quando a requisição excede o timeout.
 * @throws O erro original de `read` quando não é timeout.
 */
export async function fetchBoardWithTimeout<T>(
  url: string,
  source: string,
  read: (response: Response) => Promise<T>,
  headers?: Record<string, string>,
): Promise<T> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(BOARD_REQUEST_TIMEOUT_MS),
      ...(headers ? { headers } : {}),
    });

    return await read(response);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new BoardTimeoutError(source, BOARD_REQUEST_TIMEOUT_MS);
    }

    throw error;
  }
}
