import type { Job } from "../types/job.js";
import { fetchBoardWithTimeout } from "./board-http.js";

/** Origem das vagas. */
const SOURCE = "lever";

interface LeverPosting {
  id: string;
  text: string;
  categories?: {
    location?: string;
  };
  descriptionPlain?: string;
  description?: string;
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

  return {
    id: posting.id,
    title: posting.text,
    company: siteName,
    location,
    remote:
      posting.workplaceType?.toLowerCase() === "remote" ||
      location.toLowerCase().includes("remote"),
    description: posting.descriptionPlain ?? posting.description ?? "",
    url: posting.hostedUrl ?? posting.applyUrl ?? "",
    source: SOURCE,
    publishedAt,
  };
}

function isLeverPosting(value: unknown): value is LeverPosting {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const posting = value as Partial<LeverPosting>;
  return typeof posting.id === "string" && typeof posting.text === "string";
}
