import type { Job } from "../types/job.js";

/** Origem das vagas. */
const SOURCE = "greenhouse";

/** Endpoint do Job Board público da Greenhouse. */
const API_BASE_URL = "https://boards-api.greenhouse.io/v1/boards";

/** Vaga como retornada pela API da Greenhouse (apenas campos usados). */
interface GreenhouseJob {
  id: number;
  title: string;
  updated_at?: string;
  absolute_url: string;
  content?: string;
  location?: {
    name?: string;
  };
}

/** Resposta da listagem de vagas da Greenhouse. */
interface GreenhouseJobsResponse {
  jobs: GreenhouseJob[];
}

/**
 * Busca as vagas de um quadro público da Greenhouse e as normaliza para {@link Job}.
 *
 * @param boardToken Identificador do quadro (board) na Greenhouse.
 * @throws {Error} Se a resposta HTTP for de erro.
 */
export async function fetchGreenhouseJobs(boardToken: string): Promise<Job[]> {
  const response = await fetch(`${API_BASE_URL}/${boardToken}/jobs`);

  if (!response.ok) {
    throw new Error(
      `Falha ao consultar a Greenhouse (board "${boardToken}"): ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as GreenhouseJobsResponse;

  return data.jobs.map((job) => {
    const location = job.location?.name ?? "";

    return {
      id: String(job.id),
      title: job.title,
      company: boardToken,
      location,
      remote: isRemote(location),
      description: job.content ?? "",
      url: job.absolute_url,
      source: SOURCE,
      publishedAt: job.updated_at,
    };
  });
}

/** Infere trabalho remoto a partir do texto de localização. */
function isRemote(location: string): boolean {
  return /remote|remoto|home\s?office|anywhere/i.test(location);
}
