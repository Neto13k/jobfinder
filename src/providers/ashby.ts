import type { Job } from "../types/job.js";

/** Origem das vagas. */
const SOURCE = "ashby";

/** Endpoint público do Job Board da Ashby. */
const API_BASE_URL = "https://api.ashbyhq.com/posting-api/job-board";

/** Localização informada pela Ashby (principal ou secundária). */
interface AshbyLocation {
  location?: string;
}

/** Vaga como retornada pela API da Ashby (apenas campos usados). */
interface AshbyJob {
  title: string;
  location?: string;
  secondaryLocations?: AshbyLocation[];
  workplaceType?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  isListed?: boolean;
}

/**
 * Busca as vagas de um Job Board público da Ashby e as normaliza para {@link Job}.
 *
 * Vagas explicitamente não listadas (`isListed === false`) são descartadas.
 *
 * @param boardName Identificador do Job Board na Ashby (ex.: "Ashby").
 * @throws {Error} Se a resposta HTTP for de erro ou o corpo for inválido.
 */
export async function fetchAshbyJobs(boardName: string): Promise<Job[]> {
  if (!boardName.trim()) {
    throw new Error("Ashby board name is required.");
  }

  const response = await fetch(
    `${API_BASE_URL}/${encodeURIComponent(boardName)}`,
  );

  if (!response.ok) {
    throw new Error(
      `Falha ao consultar a Ashby (board "${boardName}"): ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { jobs?: unknown } | null;
  const postings = data?.jobs;

  if (!Array.isArray(postings)) {
    throw new Error(
      `Ashby API retornou uma resposta inválida (board "${boardName}").`,
    );
  }

  return postings
    .filter((posting) => !isUnlisted(posting))
    .map((posting) => toJob(posting, boardName));
}

/** Normaliza uma vaga da Ashby para {@link Job}. */
function toJob(posting: unknown, boardName: string): Job {
  if (!isAshbyJob(posting)) {
    throw new Error("Ashby API retornou uma vaga inválida.");
  }

  // URL canônica da vaga, base do identificador estável.
   const url = posting.jobUrl?.trim() || posting.applyUrl?.trim() || "";

  return {
    id: `${boardName}:${url}`,
    title: posting.title,
    company: boardName,
    location: buildLocation(posting),
    remote: isRemote(posting),
    description: posting.descriptionPlain ?? posting.descriptionHtml ?? "",
    url,
    source: SOURCE,
    publishedAt: posting.publishedAt,
  };
}

/** Junta a localização principal e as secundárias, sem inferir elegibilidade. */
function buildLocation(job: AshbyJob): string {
  const secondary = (job.secondaryLocations ?? []).map(
    (entry) => entry.location,
  );
  const locations = [job.location, ...secondary].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );

  return [...new Set(locations)].join(" | ");
}

/**
 * Remoto somente quando o tipo de trabalho declarado é "Remote".
 *
 * A flag `isRemote` da API também cobre "Hybrid", então não comprova sozinha
 * trabalho totalmente remoto; por isso usamos apenas `workplaceType`.
 */
function isRemote(job: AshbyJob): boolean {
  return job.workplaceType?.toLowerCase() === "remote";
}

/** Indica se a vaga foi explicitamente marcada como não listada. */
function isUnlisted(posting: unknown): boolean {
  if (typeof posting !== "object" || posting === null) {
    return false;
  }

  return (posting as { isListed?: unknown }).isListed === false;
}

/** Valida se o objeto possui os campos mínimos de uma vaga da Ashby. */
function isAshbyJob(value: unknown): value is AshbyJob {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const job = value as Partial<AshbyJob>;
  const hasTitle = typeof job.title === "string" && job.title.trim() !== "";
  const hasUrl =
    (typeof job.jobUrl === "string" && job.jobUrl.trim() !== "") ||
    (typeof job.applyUrl === "string" && job.applyUrl.trim() !== "");

  return hasTitle && hasUrl;
}
