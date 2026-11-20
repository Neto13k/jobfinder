import type { Job } from "../types/job.js";
import { fetchBoardWithTimeout } from "./board-http.js";
import { toStringList } from "./normalize.js";

/** Origem das vagas. */
const SOURCE = "greenhouse";

/** Endpoint do Job Board público da Greenhouse. */
const API_BASE_URL = "https://boards-api.greenhouse.io/v1/boards";

/** Escritório (localidade) informado pela Greenhouse. */
interface GreenhouseOffice {
  name?: string;
}

/** Metadado estruturado do anúncio (ex.: tipo de contratação). */
interface GreenhouseMetadata {
  name?: string;
  value?: string;
}

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
  offices?: GreenhouseOffice[];
  metadata?: GreenhouseMetadata[];
}

/** Resposta da listagem de vagas da Greenhouse. */
interface GreenhouseJobsResponse {
  jobs: GreenhouseJob[];
}

/**
 * Rótulos (normalizados) de metadados que representam tipo de contratação.
 *
 * O nome do metadado é configurável por quadro, então são aceitas as variantes
 * mais comuns em inglês e português; rótulos desconhecidos são ignorados.
 */
const CONTRACT_METADATA_NAMES = new Set([
  "employment type",
  "contract type",
  "tipo de contratacao",
  "tipo de contrato",
  "regime",
]);

/**
 * Busca as vagas de um quadro público da Greenhouse e as normaliza para {@link Job}.
 *
 * A requisição é limitada ao timeout dos boards públicos (ver
 * {@link fetchBoardWithTimeout}).
 *
 * @param boardToken Identificador do quadro (board) na Greenhouse.
 * @throws {BoardTimeoutError} Se a requisição exceder o timeout.
 * @throws {Error} Se a resposta HTTP for de erro.
 */
export async function fetchGreenhouseJobs(boardToken: string): Promise<Job[]> {
  const data = await fetchBoardWithTimeout(
    `${API_BASE_URL}/${encodeURIComponent(boardToken)}/jobs?content=true`,
    SOURCE,
    async (response) => {
      if (!response.ok) {
        throw new Error(
          `Falha ao consultar a Greenhouse (board "${boardToken}"): ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as GreenhouseJobsResponse;
    },
  );

  return data.jobs.map((job) => toJob(job, boardToken));
}

/**
 * Normaliza uma vaga da Greenhouse para {@link Job}.
 *
 * A data `updated_at` da API não é usada como data de publicação: ela indica
 * atualização, não publicação, e por isso não é atribuída a `publishedAt`.
 */
function toJob(job: GreenhouseJob, boardToken: string): Job {
  const location = job.location?.name ?? "";

  const result: Job = {
    id: String(job.id),
    title: job.title,
    company: boardToken,
    location,
    remote: isRemote(location),
    description: job.content ?? "",
    url: job.absolute_url,
    source: SOURCE,
  };

  // Campos estruturados: preservados apenas quando a fonte os fornece.
  const additionalLocations = collectAdditionalLocations(job.offices, location);
  if (additionalLocations.length > 0) {
    result.additionalLocations = additionalLocations;
  }

  const contractTypes = collectContractTypes(job.metadata);
  if (contractTypes.length > 0) {
    result.contractTypes = contractTypes;
  }

  return result;
}

/** Localidades (escritórios) adicionais, sem repetir a principal. */
function collectAdditionalLocations(
  offices: GreenhouseOffice[] | undefined,
  primary: string,
): string[] {
  if (!Array.isArray(offices)) {
    return [];
  }

  const names = offices.map((office) =>
    typeof office?.name === "string" ? office.name : "",
  );
  const primaryNormalized = primary.trim().toLowerCase();

  return toStringList(names).filter(
    (value) => value.toLowerCase() !== primaryNormalized,
  );
}

/** Tipos de contratação presentes nos metadados estruturados da vaga. */
function collectContractTypes(
  metadata: GreenhouseMetadata[] | undefined,
): string[] {
  if (!Array.isArray(metadata)) {
    return [];
  }

  const values: string[] = [];

  for (const entry of metadata) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    if (!CONTRACT_METADATA_NAMES.has(normalizeLabel(entry.name))) {
      continue;
    }

    if (typeof entry.value !== "string") {
      continue;
    }

    const value = entry.value.trim();

    if (value !== "" && !values.includes(value)) {
      values.push(value);
    }
  }

  return values;
}

/** Normaliza um rótulo (sem acento, minúsculo, espaços colapsados). */
function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Infere trabalho remoto a partir do texto de localização. */
function isRemote(location: string): boolean {
  return /remote|remoto|home\s?office|anywhere/i.test(location);
}
