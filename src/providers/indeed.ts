import { scrapeJobs, type Job as ScrapedJob, type ScrapeOptions, type SiteName } from "ts-jobspy";

import { classifyJobModality } from "../services/location-filter.js";
import {
  toRateLimitError,
  withRateLimitGuard,
} from "../services/rate-limit.js";
import type { Job } from "../types/job.js";

/** Origem das vagas. */
const SOURCE = "indeed";

/** Plataforma consultada na biblioteca ts-jobspy. */
const SITE: SiteName = "indeed";

/** País fixado na busca, para evitar o domínio padrão da biblioteca (usa). */
const COUNTRY = "Brazil";

/** Limite padrão de tempo por pesquisa, em milissegundos (30 segundos). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Parâmetros de busca aceitos pelo provider do Indeed. */
export interface IndeedSearchParams {
  /** Termo de busca (ex.: "desenvolvedor backend"). */
  searchTerm: string;
  /** Localização textual (ex.: "Maceió, AL" ou "Brasil"). */
  location?: string;
  /**
   * Quando `true`, restringe a busca a vagas marcadas como remotas.
   *
   * A biblioteca aceita, no máximo, um grupo de filtro por busca no Indeed
   * (precedência `hoursOld` > `easyApply` > `jobType`/`isRemote`). Como este
   * provider não expõe `hoursOld` nem `easyApply`, `jobType` e `isRemote` podem
   * ser combinados com segurança; ainda assim, o que a biblioteca descartar é
   * reportado em `unsupportedOptions` e registrado como aviso.
   */
  isRemote?: boolean;
  /** Tipo de contratação (ex.: `fulltime`, `parttime`, `contract`, `internship`). */
  jobType?: string;
  /** Limite de vagas por busca (padrão da biblioteca: 15). */
  resultsWanted?: number;
  /** Limite de tempo da pesquisa em milissegundos (padrão: 30 s). */
  timeoutMs?: number;
}

/**
 * Busca vagas de desenvolvedor no Indeed via ts-jobspy e as normaliza para {@link Job}.
 *
 * A biblioteca isola falhas por site e reporta o desfecho de cada coleta em
 * `result.meta.sites`. O estado do Indeed é tratado explicitamente:
 * `error` lança (nada foi coletado); `partial` preserva as vagas já coletadas,
 * mas registra a interrupção para não passar por sucesso completo; `empty` é um
 * resultado válido sem vagas; e a ausência de metadados é tratada como falha,
 * nunca como sucesso silencioso. Filtros que a biblioteca descarta são
 * registrados em `unsupportedOptions` e sinalizados como aviso.
 *
 * Cada vaga só é convertida se puder ser identificada com segurança (URL HTTPS
 * do domínio oficial do Indeed e ID derivável); registros inseguros são
 * descartados com um aviso.
 *
 * @param params Termo de busca e filtros opcionais de localização, modalidade, tipo e limite.
 * @returns Vagas normalizadas, com ID estável, descrição completa, URL e localização originais.
 * @throws {Error} Se o termo de busca estiver vazio, se faltarem os metadados do
 * Indeed ou se a coleta terminar em `error`.
 * @throws {RateLimitError} Se a coleta indicar rate limiting (HTTP 429); o erro
 * carrega as vagas já coletadas (vazio em `error`, preservadas em `partial`).
 * Uma rejeição direta da promessa de coleta também é convertida nesse erro.
 */
export async function fetchIndeedJobs(
  params: IndeedSearchParams,
): Promise<Job[]> {
  const searchTerm = params.searchTerm.trim();

  if (searchTerm === "") {
    throw new Error("Indeed search term is required.");
  }

  // Opções da biblioteca montadas apenas com os campos informados: ela rejeita
  // valores inválidos e chaves desconhecidas, então nada é passado por engano.
  const options: ScrapeOptions = {
    sites: SITE,
    searchTerm,
    // Fixa o domínio do Indeed no Brasil (br.indeed.com) em vez do padrão (usa).
    country: COUNTRY,
    // Interrompe a pesquisa lenta para não travar a coleta das demais fontes;
    // a biblioteca reporta o corte como `partial` ou `error` em `meta.sites`.
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  if (params.location !== undefined) {
    options.location = params.location;
  }

  if (params.isRemote !== undefined) {
    options.isRemote = params.isRemote;
  }

  if (params.jobType !== undefined) {
    options.jobType = params.jobType;
  }

  if (params.resultsWanted !== undefined) {
    options.resultsWanted = params.resultsWanted;
  }

  // Converte uma eventual rejeição direta da coleta (ex.: `RateLimitException`
  // escapando da biblioteca) em `RateLimitError`; os demais erros são
  // repropagados sem alteração.
  const result = await withRateLimitGuard(() => scrapeJobs(options), SOURCE);

  const siteMeta = result.meta.sites.find((entry) => entry.site === SITE);

  // Sem metadados do Indeed, não há como comprovar a coleta: falha explícita.
  if (!siteMeta) {
    throw new Error(
      "A coleta do Indeed não retornou metadados; não é possível confirmá-la como bem-sucedida.",
    );
  }

  const jobs: Job[] = [];

  for (const scraped of result.jobs) {
    const job = toJob(scraped);

    if (!job) {
      // Aviso genérico: não expõe URL, título nem conteúdo da vaga descartada.
      console.warn(
        "Vaga do Indeed descartada: URL não-HTTPS, fora do domínio oficial ou ID não identificável.",
      );
      continue;
    }

    jobs.push(job);
  }

  // Rate limiting (HTTP 429): sinaliza o orquestrador para interromper apenas as
  // pesquisas restantes do Indeed, preservando as vagas já convertidas
  // (inclusive as de um retorno parcial).
  const rateLimit = toRateLimitError(SOURCE, siteMeta.status, siteMeta.error, jobs);
  if (rateLimit) {
    throw rateLimit;
  }

  switch (siteMeta.status) {
    case "ok":
      // Coleta completa e sem interrupções.
      break;
    case "empty":
      // Resultado válido sem vagas para os filtros informados: não é falha.
      break;
    case "partial":
      // Vagas coletadas antes da interrupção são preservadas, mas o motivo é
      // registrado para distinguir de uma coleta totalmente bem-sucedida.
      console.warn(
        `Coleta do Indeed interrompida (resultados parciais): ${siteMeta.error.message}`,
      );
      break;
    case "error":
      throw new Error(`Falha ao consultar o Indeed: ${siteMeta.error.message}`);
  }

  // Filtros que a biblioteca descartou (ex.: `jobType` fora dos tipos suportados
  // ou conflito no único grupo de filtro aceito) não podem passar por aplicados.
  if (siteMeta.unsupportedOptions && siteMeta.unsupportedOptions.length > 0) {
    console.warn(
      `Indeed ignorou filtros não suportados: ${siteMeta.unsupportedOptions.join(", ")}.`,
    );
  }

  return jobs;
}

/**
 * Normaliza uma vaga retornada pela biblioteca para {@link Job}.
 *
 * @returns A vaga normalizada ou `undefined` quando o registro não pode ser
 * identificado com segurança (URL inválida/fora do domínio ou ID ausente).
 */
function toJob(scraped: ScrapedJob): Job | undefined {
  const rawUrl = scraped.jobUrl.trim();
  const url = parseIndeedUrl(rawUrl);

  if (!url) {
    return undefined;
  }

  const id = resolveJobId(scraped, url);

  if (!id) {
    return undefined;
  }

  const location = scraped.location ?? "";
  const description = scraped.description ?? "";

  return {
    id,
    title: scraped.title,
    company: scraped.company ?? "",
    location,
    // `Job.remote` só representa "confirmado como remoto". O sinal estruturado
    // da vaga (`scraped.isRemote === true`) tem precedência; quando ele não
    // confirma, a modalidade é inferida dos sinais do próprio anúncio
    // (título/localização/descrição). O filtro `isRemote` usado na pesquisa não
    // entra aqui: ter buscado vagas remotas não prova que cada resultado seja
    // remoto. `false` significa "não confirmado como remoto", nunca "presencial".
    remote: resolveRemote(scraped, location, description),
    description,
    url: rawUrl,
    source: SOURCE,
    publishedAt: scraped.datePosted ?? undefined,
  };
}

/**
 * Decide se a vaga é remota.
 *
 * Prioriza o sinal estruturado da própria vaga (`isRemote === true`). Como esse
 * sinal da biblioteca só reconhece palavras-chave em inglês, quando ele não
 * confirma a modalidade recorre-se a {@link classifyJobModality}, que entende
 * termos em português (ex.: "remoto", "home office").
 */
function resolveRemote(
  scraped: ScrapedJob,
  location: string,
  description: string,
): boolean {
  if (scraped.isRemote === true) {
    return true;
  }

  return (
    classifyJobModality({
      title: scraped.title,
      location,
      description,
    }) === "remote"
  );
}

/**
 * Valida a URL da vaga: precisa ser HTTPS e pertencer a `indeed.com` ou a um de
 * seus subdomínios (ex.: `br.indeed.com`). Os parâmetros da URL (como `jk`) são
 * preservados para acessar o anúncio.
 *
 * @param rawUrl URL informada pela biblioteca.
 * @returns A URL analisada ou `undefined` se for inválida, não-HTTPS ou de outro domínio.
 */
function parseIndeedUrl(rawUrl: string): URL | undefined {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:") {
    return undefined;
  }

  const host = url.hostname;
  const isOfficialDomain = host === "indeed.com" || host.endsWith(".indeed.com");

  return isOfficialDomain ? url : undefined;
}

/**
 * Resolve um ID estável para a vaga.
 *
 * Prioriza o identificador `jk` da URL canônica da vaga; na sua ausência,
 * aproveita o ID fornecido pela própria biblioteca. Nenhum ID é inventado.
 *
 * @param scraped Vaga retornada pela biblioteca.
 * @param url URL já validada da vaga.
 * @returns O ID estável ou `undefined` se nenhum for seguro.
 */
function resolveJobId(scraped: ScrapedJob, url: URL): string | undefined {
  const jk = url.searchParams.get("jk")?.trim();

  if (jk && /^[A-Za-z0-9_-]+$/.test(jk)) {
    return jk;
  }

  const libraryId = scraped.id?.trim();

  return libraryId ? libraryId : undefined;
}
