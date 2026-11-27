import type { Job } from "../types/job.js";

/** Origem das vagas. */
const SOURCE = "inhire";

/** Endpoint público da Página de Carreira da InHire. */
const API_BASE_URL = "https://api.inhire.app/job-posts/public/pages";

/** Tempo máximo de espera pela resposta da InHire (ms). */
const REQUEST_TIMEOUT_MS = 10_000;

/** Vaga como retornada na listagem da InHire (apenas campos usados). */
interface InHireJobSummary {
  jobId: string;
  displayName: string;
  status?: string;
  workplaceType?: string;
  location?: string;
}

/** Resposta da listagem de vagas da InHire. */
interface InHireJobsPageResponse {
  jobsPage?: InHireJobSummary[];
}

/**
 * Busca as vagas publicadas de um tenant da InHire e as normaliza para {@link Job}.
 *
 * A listagem pública não traz descrição nem data de publicação, então esses
 * campos não são preenchidos.
 *
 * @param tenant Identificador do tenant, enviado no cabeçalho `X-Tenant`.
 * @throws {Error} Se a resposta HTTP não for 200.
 */
export async function fetchInHireJobs(tenant: string): Promise<Job[]> {
  const response = await fetch(API_BASE_URL, {
    headers: { "X-Tenant": tenant },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status !== 200) {
    throw new Error(
      `Falha ao consultar a InHire (tenant "${tenant}"): ${response.status} ${response.statusText}${await describeFailure(response)}`,
    );
  }

  const data = (await response.json()) as InHireJobsPageResponse;
  // `jobsPage` pode vir ausente (não apenas vazio) para tenants sem vagas;
  // sem o fallback, um `.filter` em `undefined` estouraria com um TypeError.
  const jobsPage = data.jobsPage ?? [];

  return jobsPage
    .filter(isPublished)
    .map((job) => ({
      id: job.jobId,
      title: job.displayName,
      company: tenant,
      location: job.location ?? "",
      remote: isRemote(job),
      description: "",
      url: `https://${tenant}.inhire.app/vagas/${encodeURIComponent(job.jobId)}`,
      source: SOURCE,
    }));
}

/**
 * Considera publicada a vaga cujo `status` é "published" ou está ausente.
 *
 * A listagem pública da InHire já retorna apenas vagas publicadas, então a
 * ausência de `status` não deve descartar a vaga silenciosamente quando um
 * tenant omite o campo; apenas um status explícito diferente é descartado.
 */
function isPublished(job: InHireJobSummary): boolean {
  return job.status === undefined || job.status === "published";
}

/** Remoto somente quando o tipo de trabalho declarado é "Remote". */
function isRemote(job: InHireJobSummary): boolean {
  return job.workplaceType?.toLowerCase() === "remote";
}

/**
 * Anexa o motivo do corpo da resposta de erro para facilitar a triagem no log.
 *
 * Um 404 costuma significar tenant fora da lista de páginas públicas: a InHire
 * responde "Tenant not found", sinal que vale distinguir dos demais erros.
 */
async function describeFailure(response: Response): Promise<string> {
  const label = response.status === 404 ? "tenant não encontrado" : "erro";

  try {
    const detail = (await response.text()).trim();
    return detail ? `, ${label}: ${detail.slice(0, 200)}` : `, ${label}`;
  } catch {
    return `, ${label}`;
  }
}
