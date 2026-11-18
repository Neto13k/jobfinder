import { scrapeJobs, type Job as ScrapedJob, type ScrapeOptions, type SiteName } from "ts-jobspy";

import { classifyJobModality } from "../services/location-filter.js";
import {
  toRateLimitError,
  withRateLimitGuard,
} from "../services/rate-limit.js";
import type { Job } from "../types/job.js";

/** Origem das vagas. */
const SOURCE = "linkedin";

/** Plataforma consultada na biblioteca ts-jobspy. */
const SITE: SiteName = "linkedin";

/** Limite padrão de tempo por pesquisa, em milissegundos (45 segundos). */
const DEFAULT_TIMEOUT_MS = 45_000;

/** Parâmetros de busca aceitos pelo provider do LinkedIn. */
export interface LinkedInSearchParams {
  /** Termo de busca (ex.: "desenvolvedor backend"). */
  searchTerm: string;
  /** Localização textual (ex.: "Maceió, AL" ou "Brasil"). */
  location?: string;
  /** ID geográfico do LinkedIn (parâmetro `geoId`), fixa a busca em uma localidade exata. */
  geoId?: string;
  /** Quando `true`, restringe a resultados marcados como remotos. */
  isRemote?: boolean;
  /** Limite de vagas por busca (padrão da biblioteca: 15). */
  resultsWanted?: number;
  /** Limite de tempo da pesquisa em milissegundos (padrão: 45 s). */
  timeoutMs?: number;
}

/**
 * Busca vagas de desenvolvedor no LinkedIn via ts-jobspy e as normaliza para {@link Job}.
 *
 * A biblioteca isola falhas por site e reporta o desfecho de cada coleta em
 * `result.meta.sites`. O estado do LinkedIn é tratado explicitamente:
 * `error` lança (nada foi coletado); `partial` preserva as vagas já coletadas,
 * mas registra a interrupção para não passar por sucesso completo; `empty` é um
 * resultado válido sem vagas; e a ausência de metadados é tratada como falha,
 * nunca como sucesso silencioso.
 *
 * Cada vaga só é convertida se puder ser identificada com segurança (URL HTTPS
 * do domínio oficial do LinkedIn e ID extraível); registros inseguros são
 * descartados com um aviso.
 *
 * @param params Termo de busca e filtros opcionais de localização, modalidade e limite.
 * @returns Vagas normalizadas, com ID estável, descrição completa, URL e localização originais.
 * @throws {Error} Se o termo de busca estiver vazio, se faltarem os metadados do
 * LinkedIn ou se a coleta terminar em `error`.
 * @throws {RateLimitError} Se a coleta indicar rate limiting (HTTP 429); o erro
 * carrega as vagas já coletadas (vazio em `error`, preservadas em `partial`).
 * Uma rejeição direta da promessa de coleta também é convertida nesse erro.
 */
export async function fetchLinkedInJobs(
  params: LinkedInSearchParams,
): Promise<Job[]> {
  const searchTerm = params.searchTerm.trim();

  if (searchTerm === "") {
    throw new Error("LinkedIn search term is required.");
  }

  // Opções da biblioteca montadas apenas com os filtros informados: ela rejeita
  // valores inválidos e chaves desconhecidas, então nada é passado por engano.
  const linkedinOptions: NonNullable<ScrapeOptions["linkedin"]> = {
    // Busca a descrição completa de cada anúncio (requisição extra por vaga),
    // necessária para a análise posterior da IA.
    fetchDescription: true,
  };

  if (params.geoId !== undefined) {
    // `geoId` fixa a busca em uma localidade exata (suporte via patch do ts-jobspy).
    linkedinOptions.geoId = params.geoId;
  }

  const options: ScrapeOptions = {
    sites: SITE,
    searchTerm,
    linkedin: linkedinOptions,
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

  if (params.resultsWanted !== undefined) {
    options.resultsWanted = params.resultsWanted;
  }

  // Converte uma eventual rejeição direta da coleta (ex.: `RateLimitException`
  // escapando da biblioteca) em `RateLimitError`; os demais erros são
  // repropagados sem alteração.
  const result = await withRateLimitGuard(() => scrapeJobs(options), SOURCE);

  const siteMeta = result.meta.sites.find((entry) => entry.site === SITE);

  // Sem metadados do LinkedIn, não há como comprovar a coleta: falha explícita.
  if (!siteMeta) {
    throw new Error(
      "A coleta do LinkedIn não retornou metadados; não é possível confirmá-la como bem-sucedida.",
    );
  }

  const jobs: Job[] = [];

  for (const scraped of result.jobs) {
    const job = toJob(scraped);

    if (!job) {
      // Aviso genérico: não expõe URL, título nem conteúdo da vaga descartada.
      console.warn(
        "Vaga do LinkedIn descartada: URL não-HTTPS, fora do domínio oficial ou ID não identificável.",
      );
      continue;
    }

    jobs.push(job);
  }

  // Rate limiting (HTTP 429): sinaliza o orquestrador para interromper apenas as
  // pesquisas restantes do LinkedIn, preservando as vagas já convertidas
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
        `Coleta do LinkedIn interrompida (resultados parciais): ${siteMeta.error.message}`,
      );
      break;
    case "error":
      throw new Error(`Falha ao consultar o LinkedIn: ${siteMeta.error.message}`);
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
  const url = parseLinkedInUrl(rawUrl);

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
    // `Job.remote` é booleano e não representa "desconhecido". A modalidade é
    // inferida dos sinais do próprio anúncio (título/localização/descrição), e
    // não do filtro `isRemote` usado na pesquisa — remoto nessa busca não prova
    // que cada vaga retornada seja remota. `false` significa "não confirmado
    // como remoto", nunca "presencial"; ampliar `Job.remote` para um estado
    // tri-state fica pendente.
    remote:
      classifyJobModality({
        title: scraped.title,
        location,
        description,
      }) === "remote",
    description,
    url: rawUrl,
    source: SOURCE,
    publishedAt: scraped.datePosted ?? undefined,
  };
}

/**
 * Valida a URL da vaga: precisa ser HTTPS e pertencer a `linkedin.com` ou a um
 * de seus subdomínios.
 *
 * @param rawUrl URL informada pela biblioteca.
 * @returns A URL analisada ou `undefined` se for inválida, não-HTTPS ou de outro domínio.
 */
function parseLinkedInUrl(rawUrl: string): URL | undefined {
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
  const isOfficialDomain = host === "linkedin.com" || host.endsWith(".linkedin.com");

  return isOfficialDomain ? url : undefined;
}

/**
 * Resolve um ID estável para a vaga.
 *
 * Prioriza a rota canônica `/jobs/view/{id}`; na sua ausência, aceita o
 * identificador da plataforma apenas quando for puramente numérico.
 *
 * @param scraped Vaga retornada pela biblioteca.
 * @param url URL já validada da vaga.
 * @returns O ID estável ou `undefined` se nenhum for seguro.
 */
function resolveJobId(scraped: ScrapedJob, url: URL): string | undefined {
  const routeId = extractIdFromPath(url.pathname);

  if (routeId) {
    return routeId;
  }

  const platformId = scraped.id?.trim();

  if (platformId && /^\d+$/.test(platformId)) {
    return platformId;
  }

  return undefined;
}

/**
 * Extrai o ID numérico da rota `/jobs/view/{id}`.
 *
 * Aceita tanto o formato direto (`/jobs/view/123456`) quanto o com slug
 * (`/jobs/view/engenheiro-backend-123456`), ignorando a barra final.
 */
function extractIdFromPath(pathname: string): string | undefined {
  const match = /^\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/.exec(pathname);
  return match?.[1];
}
