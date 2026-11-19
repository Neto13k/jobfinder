import type { Job } from "../types/job.js";
import { fetchBoardWithTimeout } from "./board-http.js";
import { toStringList, toWorkplaceType } from "./normalize.js";

/** Origem das vagas. */
const SOURCE = "lever";

/** Seção adicional da descrição (ex.: "Responsibilities", "Requirements"). */
interface LeverList {
  /** Título da seção (ex.: "O que você fará"). */
  text?: string;
  /** Conteúdo da seção (HTML da Lever). */
  content?: string;
}

interface LeverPosting {
  id: string;
  text: string;
  categories?: {
    location?: string;
    /** Tipo de contratação informado pela Lever (ex.: "Full-time"). */
    commitment?: string;
    /** Localidades adicionais do anúncio, quando existirem. */
    allLocations?: string[];
  };
  descriptionPlain?: string;
  description?: string;
  /** Seções adicionais da descrição (responsabilidades, requisitos, etc.). */
  lists?: LeverList[];
  /** Conteúdo adicional em HTML. */
  additional?: string;
  /** Conteúdo adicional em texto puro. */
  additionalPlain?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
}

const LEVER_API_URL = "https://api.lever.co/v0/postings";

/**
 * Busca as vagas de um board público da Lever e as normaliza para {@link Job}.
 *
 * A requisição é limitada ao timeout dos boards públicos (ver
 * {@link fetchBoardWithTimeout}).
 *
 * @param siteName Identificador do board (site) na Lever.
 * @throws {BoardTimeoutError} Se a requisição exceder o timeout.
 * @throws {Error} Se a resposta HTTP for de erro ou o corpo for inválido.
 */
export async function fetchLeverJobs(siteName: string): Promise<Job[]> {
  if (!siteName.trim()) {
    throw new Error("Lever site name is required.");
  }

  const postings = await fetchBoardWithTimeout(
    `${LEVER_API_URL}/${encodeURIComponent(siteName)}?mode=json`,
    SOURCE,
    async (response) => {
      if (!response.ok) {
        throw new Error(
          `Lever API request failed with status ${response.status} ${response.statusText}.`,
        );
      }

      const body: unknown = await response.json();

      if (!Array.isArray(body)) {
        throw new Error("Lever API returned an invalid response.");
      }

      return body;
    },
  );

  return postings.map((posting) => toJob(posting, siteName));
}

function toJob(posting: unknown, siteName: string): Job {
  if (!isLeverPosting(posting)) {
    throw new Error("Lever API returned an invalid job posting.");
  }

  const location = posting.categories?.location ?? "";
  const publishedAt =
    posting.createdAt !== undefined
      ? new Date(posting.createdAt).toISOString()
      : undefined;
  // Modalidade obtida de forma segura: um valor inesperado (ex.: numérico) não
  // lança erro e não é convertido em informação.
  const workplaceType = toWorkplaceType(posting.workplaceType);

  const job: Job = {
    id: posting.id,
    title: posting.text,
    company: siteName,
    location,
    remote:
      workplaceType === "remote" ||
      location.toLowerCase().includes("remote"),
    description: buildDescription(posting),
    url: posting.hostedUrl ?? posting.applyUrl ?? "",
    source: SOURCE,
    publishedAt,
  };

  // Campos estruturados: só são adicionados quando efetivamente disponíveis.
  if (workplaceType !== undefined) {
    job.workplaceType = workplaceType;
  }

  const contractTypes = toStringList([posting.categories?.commitment]);
  if (contractTypes.length > 0) {
    job.contractTypes = contractTypes;
  }

  const additionalLocations = collectAdditionalLocations(
    posting.categories?.allLocations,
    location,
  );
  if (additionalLocations.length > 0) {
    job.additionalLocations = additionalLocations;
  }

  return job;
}

/**
 * Compõe a descrição completa preservando todas as seções relevantes do
 * anúncio, sem duplicar conteúdo.
 *
 * Ordem: descrição principal, seções adicionais (`lists`) e conteúdo adicional.
 * Cada bloco usa a versão textual quando existir e recorre ao HTML apenas como
 * fallback (as seções de `lists` só têm HTML). Campos ausentes são ignorados,
 * sem gerar placeholders.
 */
function buildDescription(posting: LeverPosting): string {
  const sections: string[] = [];

  const main = firstNonEmptyText(posting.descriptionPlain, posting.description);
  if (main !== "") {
    sections.push(main);
  }

  if (Array.isArray(posting.lists)) {
    for (const list of posting.lists) {
      if (typeof list !== "object" || list === null) {
        continue;
      }

      const heading = firstNonEmptyText(list.text);
      const content = firstNonEmptyText(list.content);
      const section = [heading, content].filter((part) => part !== "").join("\n");

      if (section !== "") {
        sections.push(section);
      }
    }
  }

  const extra = firstNonEmptyText(posting.additionalPlain, posting.additional);
  if (extra !== "") {
    sections.push(extra);
  }

  return sections.join("\n\n");
}

/**
 * Coleta as localidades adicionais do anúncio, removendo vazios, duplicatas e a
 * localidade principal (já registrada em `location`).
 */
function collectAdditionalLocations(
  allLocations: string[] | undefined,
  primary: string,
): string[] {
  const primaryNormalized = primary.trim().toLowerCase();

  return toStringList(allLocations).filter(
    (value) => value.toLowerCase() !== primaryNormalized,
  );
}

/** Retorna o primeiro texto não vazio (após `trim`) ou `""` quando não houver. */
function firstNonEmptyText(...values: (string | undefined)[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  return "";
}

function isLeverPosting(value: unknown): value is LeverPosting {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const posting = value as Partial<LeverPosting>;
  return typeof posting.id === "string" && typeof posting.text === "string";
}
