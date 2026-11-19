import type { JobSource } from "../config/job-sources.js";
import type { Job } from "../types/job.js";

/**
 * Formato do erro reportado pela ts-jobspy em `meta.sites[].error`.
 *
 * Reproduzido localmente para não depender de tipo interno da biblioteca e
 * permitir testar a detecção sem chamadas externas.
 */
export interface SiteErrorLike {
  name?: string;
  message?: string;
}

/**
 * Sinaliza rate limiting (HTTP 429) detectado em uma fonte de vagas.
 *
 * Carrega as vagas preservadas antes do bloqueio (vazio quando nada foi
 * coletado), permitindo ao orquestrador mantê-las e interromper apenas as
 * pesquisas restantes daquela fonte.
 */
export class RateLimitError extends Error {
  /** Rótulo da fonte que respondeu com rate limiting. */
  readonly source: string;
  /** Vagas já válidas coletadas antes do bloqueio. */
  readonly preservedJobs: readonly Job[];

  constructor(
    source: string,
    preservedJobs: readonly Job[] = [],
    message?: string,
  ) {
    super(message ?? `Rate limiting (HTTP 429) detectado na fonte ${source}.`);
    this.name = "RateLimitError";
    this.source = source;
    this.preservedJobs = preservedJobs;
    // Restaura o protótipo para que `instanceof` funcione com o alvo transpilado.
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * Identifica rate limiting nos metadados/erros reportados pela ts-jobspy.
 *
 * Prioriza o sinal estruturado (`name === "RateLimitException"`), usado quando a
 * coleta falha antes de coletar qualquer vaga. Recorre à mensagem como fallback
 * restrito — necessário nos retornos parciais, em que o erro é agregado como
 * `ScrapeInterrupted` — exigindo o prefixo literal "HTTP 429" (presente em todas
 * as mensagens reais da biblioteca, incluindo as de descrição) ou o status 429
 * acompanhado de um marcador de rate limiting. Isso evita falsos positivos com
 * erros que só citam "429" sem o prefixo HTTP.
 *
 * @param error Erro reportado em `meta.sites[].error` (ausente em `ok`/`empty`).
 * @returns `true` apenas quando há evidência confiável de rate limiting.
 */
export function isRateLimitError(error: SiteErrorLike | undefined): boolean {
  if (!error) {
    return false;
  }

  if (error.name === "RateLimitException") {
    return true;
  }

  const message = error.message ?? "";
  // Toda mensagem de 429 da biblioteca traz o prefixo literal "HTTP 429"
  // (inclusive as de descrição, ex.: "job <id>: description fetch returned
  // HTTP 429"). O marcador textual cobre variações de redação sem abrir mão da
  // proteção contra falsos positivos: um "429" isolado, sem o prefixo HTTP,
  // continua sendo ignorado.
  return (
    /\bHTTP\s*429\b/i.test(message) ||
    (/\b429\b/.test(message) && /rate.?limit|too many requests/i.test(message))
  );
}

/**
 * Traduz o desfecho de uma coleta da ts-jobspy em um {@link RateLimitError}.
 *
 * Só produz resultado nos status `error` e `partial`; nos demais (ou quando não
 * há rate limiting) retorna `undefined` para preservar o fluxo existente de
 * cada provider.
 *
 * @param source Rótulo da fonte (ex.: `"linkedin"`).
 * @param status Desfecho da coleta em `meta.sites[].status`.
 * @param error Erro reportado em `meta.sites[].error`.
 * @param jobs Vagas já normalizadas, preservadas no retorno parcial.
 * @returns O erro de rate limiting correspondente, ou `undefined`.
 */
export function toRateLimitError(
  source: string,
  status: "ok" | "empty" | "partial" | "error",
  error: SiteErrorLike | undefined,
  jobs: readonly Job[],
): RateLimitError | undefined {
  if (status !== "partial" && status !== "error") {
    return undefined;
  }

  if (!isRateLimitError(error)) {
    return undefined;
  }

  return new RateLimitError(source, jobs, error?.message);
}

/**
 * Normaliza um valor capturado em `catch` para o formato {@link SiteErrorLike}.
 *
 * A ts-jobspy sempre lança subclasses de `Error`; valores atípicos recorrem à
 * conversão textual. Nunca lança, para manter o tratamento de erro previsível.
 *
 * @param error Valor capturado na rejeição.
 * @returns Objeto com `name`/`message` quando disponíveis.
 */
function toSiteErrorLike(error: unknown): SiteErrorLike {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}

/**
 * Executa uma coleta da ts-jobspy convertendo rejeições de rate limiting em
 * {@link RateLimitError}.
 *
 * A biblioteca normalmente reporta falhas por site em `result.meta.sites`, mas
 * uma rejeição direta da promessa de coleta pode escapar com um
 * `RateLimitException`. Este guarda reconhece esse caso — reutilizando
 * {@link isRateLimitError} — e devolve o {@link RateLimitError} tipado. Como a
 * promessa rejeitada não retorna resultados, não há vagas preservadas. Qualquer
 * outro erro é repropagado sem alteração, preservando o tratamento existente.
 *
 * @param scrape Função que dispara a coleta (ex.: `() => scrapeJobs(options)`).
 * @param source Rótulo da fonte (ex.: `"linkedin"`).
 * @returns O resultado da coleta, quando concluída com sucesso.
 * @throws {RateLimitError} Quando a rejeição indica rate limiting (HTTP 429).
 * @throws O erro original quando a rejeição não é de rate limiting.
 */
export async function withRateLimitGuard<T>(
  scrape: () => Promise<T>,
  source: string,
): Promise<T> {
  try {
    return await scrape();
  } catch (error) {
    const siteError = toSiteErrorLike(error);

    if (!isRateLimitError(siteError)) {
      // Repropaga o erro original (stack incluída) para os demais tratamentos.
      throw error;
    }

    throw new RateLimitError(source, [], siteError.message);
  }
}

/**
 * Coleta um lote de pesquisas de um único provider, uma por vez.
 *
 * Interrompe as pesquisas restantes somente quando uma delas sinaliza rate
 * limiting ({@link RateLimitError}), preservando as vagas já coletadas — tanto
 * as das pesquisas anteriores quanto as devolvidas pelo próprio erro — e sem
 * repetir a pesquisa bloqueada. Erros que não sejam de rate limiting continuam
 * sendo propagados; o isolamento comum dessas falhas é feito pelo coletor.
 *
 * @param searches Pesquisas do provider, na ordem de execução.
 * @param fetchJobs Coletor de uma pesquisa; deve lançar {@link RateLimitError}
 *   quando a fonte responder com HTTP 429.
 * @param describe Converte a pesquisa em rótulo legível para os logs.
 * @returns As vagas coletadas até a interrupção (ou até o fim do lote).
 */
export async function collectSearchBatch(
  searches: readonly JobSource[],
  fetchJobs: (source: JobSource) => Promise<Job[]>,
  describe: (source: JobSource) => string,
): Promise<Job[]> {
  const collected: Job[] = [];

  for (let index = 0; index < searches.length; index++) {
    const search = searches[index];

    try {
      collected.push(...(await fetchJobs(search)));
    } catch (error) {
      if (!(error instanceof RateLimitError)) {
        throw error;
      }

      collected.push(...error.preservedJobs);

      const remaining = searches.length - index - 1;
      console.warn(
        `Rate limiting (HTTP 429) na fonte ${describe(search)}: ` +
          `${error.preservedJobs.length} vaga(s) preservada(s) antes do bloqueio; ` +
          `${remaining} pesquisa(s) restante(s) do provider ignorada(s).`,
      );
      break;
    }
  }

  return collected;
}
