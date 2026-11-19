import { performance } from "node:perf_hooks";

import type { Job } from "../types/job.js";
import {
  BoardTimeoutError,
  fetchBoardWithTimeout,
  isTimeoutError,
} from "./board-http.js";

/** Origem das vagas. */
const SOURCE = "inhire";

/** Endpoint público das páginas de divulgação (carreira) da InHire. */
const API_BASE_URL = "https://api.inhire.app/job-posts/public/pages";

/**
 * Pausa entre requisições sequenciais de detalhe, em milissegundos.
 *
 * A lista não traz descrição, datas nem tipo de contratação, então cada vaga
 * exige uma requisição complementar. A API documenta um limite sustentado de
 * 20 req/s; a pausa mantém cada empresa bem abaixo disso, mesmo com várias
 * empresas coletadas em paralelo pelo pipeline.
 */
const REQUEST_PACING_MS = 250;

/**
 * Intervalo mínimo, compartilhado por todas as empresas, entre os inícios das
 * requisições InHire (listagens e detalhes), em milissegundos.
 *
 * A pausa por empresa ({@link REQUEST_PACING_MS}) não limita o agregado quando
 * várias empresas rodam em paralelo. Este teto compartilhado garante um limite
 * global (≈ 1 / 60 ms ≈ 16 req/s), abaixo do limite sustentado de 20 req/s
 * informado pela InHire, independentemente da concorrência. Cobre listagens e
 * detalhes: a listagem de cada empresa também é uma requisição e, somada aos
 * detalhes, não pode ultrapassar o limite compartilhado.
 */
export const MIN_REQUEST_INTERVAL_MS = 60;

/**
 * Máximo de timeouts consecutivos nas requisições de detalhe de uma empresa
 * antes de abandonar os detalhes restantes.
 *
 * Timeouts repetidos sinalizam instabilidade da API para aquela empresa; nesse
 * caso os detalhes restantes são ignorados para não consumir o orçamento de
 * tempo da execução, preservando as vagas já coletadas. Uma requisição
 * bem-sucedida reinicia o contador, de modo que empresas lentas porém saudáveis
 * (muitas vagas, sem falhas) nunca são truncadas — não há limite de quantidade
 * de vagas nem de tempo fixo.
 */
const MAX_CONSECUTIVE_DETAIL_TIMEOUTS = 3;

/**
 * Número máximo de empresas (tenants) InHire coletadas simultaneamente.
 *
 * Cada empresa faz uma requisição de listagem e uma de detalhe por vaga,
 * espaçadas por {@link REQUEST_PACING_MS} (≈ 4 req/s por empresa). Com quatro
 * empresas em paralelo, o agregado fica em torno de 16 req/s, abaixo do limite
 * sustentado de 20 req/s informado pela documentação da InHire, considerando
 * listagens e detalhes. As demais fontes (boards públicos, LinkedIn, Indeed)
 * não são afetadas por este controle.
 */
export const INHIRE_MAX_CONCURRENT_TENANTS = 4;

/**
 * Rótulo explícito do tipo de contratação informado pela InHire.
 *
 * É anexado à descrição normalizada para que a análise de IA identifique a
 * evidência de contratação sem depender da redação do anúncio.
 */
const CONTRACT_TYPE_LABEL = "Tipo de contratação (InHire)";

/** Resumo de vaga exposto pela página de divulgação (listagem). */
interface InhireJobSummary {
  jobId: string;
  displayName: string;
  status?: string;
  workplaceType?: string;
  location?: string;
}

/** Resposta da página de divulgação (contém os resumos das vagas). */
interface InhireCareerPage {
  tenantName?: string;
  jobsPage?: unknown;
}

/** Detalhe completo de uma vaga (campos usados). */
interface InhireJobDetail {
  jobId?: string;
  displayName?: string;
  tenantName?: string;
  status?: string;
  workplaceType?: string;
  location?: string;
  description?: string;
  contractType?: unknown;
  publishedAt?: string;
}

/**
 * Erro de resposta HTTP da InHire.
 *
 * Preserva o status para que o provider reconheça o rate limiting (HTTP 429)
 * sem depender da mensagem textual.
 */
class InhireRequestError extends Error {
  /** Status HTTP da resposta. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "InhireRequestError";
    this.status = status;
    // Restaura o protótipo para que `instanceof` funcione com o alvo transpilado.
    Object.setPrototypeOf(this, InhireRequestError.prototype);
  }
}

// --- Controle compartilhado e simples de concorrência entre empresas ---------

// Contador de empresas ativas e fila de espera por uma vaga. O estado vive no
// módulo para que, quando o pipeline dispara todas as empresas InHire em
// paralelo, no máximo INHIRE_MAX_CONCURRENT_TENANTS avancem por vez.
let activeTenants = 0;
const tenantWaiters: Array<() => void> = [];

/**
 * Aguarda uma vaga de concorrência para iniciar a coleta de uma empresa.
 *
 * A verificação e o incremento são síncronos, então a concessão é atômica no
 * laço de eventos do Node.js.
 */
async function acquireTenantSlot(): Promise<void> {
  if (activeTenants < INHIRE_MAX_CONCURRENT_TENANTS) {
    activeTenants++;
    return;
  }

  await new Promise<void>((resolve) => {
    tenantWaiters.push(resolve);
  });
}

/**
 * Libera a vaga da empresa, transferindo-a ao próximo da fila quando houver.
 *
 * A transferência direta mantém o contador estável: a vaga passa para o
 * próximo sem que `activeTenants` seja decrementado e reincrementado.
 */
function releaseTenantSlot(): void {
  const next = tenantWaiters.shift();

  if (next) {
    next();
    return;
  }

  activeTenants--;
}

// --- Teto agregado compartilhado entre requisições (listagens e detalhes) ----

// Instante (relógio monotônico, ms) em que a próxima requisição InHire pode
// iniciar. O estado vive no módulo, então o teto vale para todas as empresas e
// abrange tanto as listagens quanto os detalhes.
let nextRequestAllowedAt = 0;

/** Relógio monotônico em milissegundos, imune a ajustes do relógio de parede. */
function monotonicNow(): number {
  return performance.now();
}

/**
 * Aguarda o intervalo mínimo compartilhado entre os inícios das requisições
 * InHire (listagens e detalhes).
 *
 * A reserva do próximo instante é síncrona, então chamadas concorrentes de
 * empresas distintas recebem instantes distintos e o espaçamento nunca é
 * comprimido. Usa relógio monotônico para não depender de ajustes do relógio de
 * parede. Quando o laço de eventos atrasa uma chamada (o instante reservado já
 * passou), a próxima reserva parte do instante atual — e não do agendamento
 * vencido — mantendo o espaçamento entre os inícios efetivos. Apenas o disparo
 * é ordenado; a espera pela resposta HTTP não é serializada.
 */
async function waitForRequestSlot(): Promise<void> {
  const now = monotonicNow();
  const startAt = Math.max(now, nextRequestAllowedAt);
  nextRequestAllowedAt = startAt + MIN_REQUEST_INTERVAL_MS;

  const wait = startAt - now;
  if (wait > 0) {
    await delay(wait);
  }
}

/**
 * Busca as vagas de uma empresa (tenant) na InHire e as normaliza para
 * {@link Job}.
 *
 * A listagem pública (`/job-posts/public/pages`, cabeçalho `X-Tenant`) devolve
 * apenas identificador, título, status, modalidade e localização. Como as
 * descrições completas, as datas de publicação e o tipo de contratação só
 * existem no detalhe, cada vaga publicada é complementada por uma requisição a
 * `/job-posts/public/pages/{jobId}`. Nenhuma informação ausente é inventada e a
 * data da coleta nunca é usada como data de publicação.
 *
 * As requisições usam o timeout dos boards públicos (ver
 * {@link fetchBoardWithTimeout}); os inícios são espaçados por
 * {@link REQUEST_PACING_MS} (por empresa) e por {@link MIN_REQUEST_INTERVAL_MS}
 * (teto agregado compartilhado entre listagens e detalhes). A concorrência
 * entre empresas é limitada a {@link INHIRE_MAX_CONCURRENT_TENANTS} por
 * execução. Não há limite de quantidade de vagas nem de tempo fixo; os detalhes
 * de uma empresa só são abandonados após
 * {@link MAX_CONSECUTIVE_DETAIL_TIMEOUTS} timeouts consecutivos ou em rate
 * limiting (HTTP 429), sempre preservando as vagas já coletadas. Não há novas
 * tentativas.
 *
 * @param tenant Identificador (X-Tenant) da empresa na InHire.
 * @throws {BoardTimeoutError} Se a listagem exceder o timeout.
 * @throws {Error} Se a listagem retornar resposta HTTP de erro ou inválida.
 */
export async function fetchInhireJobs(tenant: string): Promise<Job[]> {
  const slug = tenant.trim();

  if (!slug) {
    throw new Error("InHire tenant is required.");
  }

  await acquireTenantSlot();

  try {
    return await collectTenantJobs(slug);
  } finally {
    releaseTenantSlot();
  }
}

/** Coleta e normaliza as vagas de uma empresa (já com vaga de concorrência). */
async function collectTenantJobs(slug: string): Promise<Job[]> {
  const headers = { "X-Tenant": slug };

  // A listagem também passa pelo teto agregado compartilhado, junto aos detalhes.
  await waitForRequestSlot();

  const page = await fetchBoardWithTimeout(
    API_BASE_URL,
    SOURCE,
    async (response) => {
      if (!response.ok) {
        throw new InhireRequestError(
          response.status,
          `Falha ao consultar a InHire (tenant "${slug}"): ${response.status} ${response.statusText}`,
        );
      }

      const data: unknown = await response.json();

      if (typeof data !== "object" || data === null) {
        throw new Error(
          `InHire API retornou uma resposta inválida (tenant "${slug}").`,
        );
      }

      return data as InhireCareerPage;
    },
    headers,
  );

  // Ausência da lista equivale a página sem vagas; formato inesperado é erro.
  if (page.jobsPage !== undefined && !Array.isArray(page.jobsPage)) {
    throw new Error(
      `InHire API retornou uma resposta inválida (tenant "${slug}").`,
    );
  }

  const summaries = (Array.isArray(page.jobsPage) ? page.jobsPage : []).filter(
    isJobSummary,
  );
  const tenantName =
    typeof page.tenantName === "string" && page.tenantName.trim() !== ""
      ? page.tenantName
      : slug;

  const jobs: Job[] = [];
  // Timeouts de detalhe consecutivos desta empresa; uma resposta bem-sucedida
  // reinicia o contador. Ao atingir o limite, os detalhes restantes são
  // abandonados preservando as vagas já coletadas.
  let consecutiveTimeouts = 0;

  for (let index = 0; index < summaries.length; index++) {
    const summary = summaries[index];

    // Vaga explicitamente fora do ar não é exibida na página pública.
    if (summary.status !== undefined && summary.status !== "published") {
      continue;
    }

    if (index > 0) {
      await delay(REQUEST_PACING_MS);
    }

    // Respeita o teto agregado compartilhado antes de cada detalhe.
    await waitForRequestSlot();

    // O try abrange o detalhe E a normalização (`toJob`): qualquer falha
    // descarta apenas esta vaga, preservando as já coletadas e as seguintes.
    try {
      const detail = await fetchJobDetail(slug, summary.jobId, headers);
      jobs.push(toJob(summary, detail, slug, tenantName));
      // Requisição bem-sucedida: reinicia a contagem de timeouts consecutivos.
      consecutiveTimeouts = 0;
    } catch (error) {
      if (error instanceof InhireRequestError && error.status === 429) {
        console.warn(
          `Rate limiting (HTTP 429) na InHire (tenant "${slug}"): ` +
            `${jobs.length} vaga(s) preservada(s) antes do bloqueio; ` +
            "detalhes restantes ignorados.",
        );
        break;
      }

      const message = error instanceof Error ? error.message : String(error);

      // Timeout do detalhe: conta a falha; após o limite, abandona os detalhes
      // restantes preservando as vagas já coletadas. Timeouts isolados apenas
      // descartam a vaga afetada.
      if (error instanceof BoardTimeoutError || isTimeoutError(error)) {
        consecutiveTimeouts++;

        if (consecutiveTimeouts >= MAX_CONSECUTIVE_DETAIL_TIMEOUTS) {
          console.warn(
            `${MAX_CONSECUTIVE_DETAIL_TIMEOUTS} timeouts consecutivos na InHire ` +
              `(tenant "${slug}"): ${jobs.length} vaga(s) preservada(s); ` +
              "detalhes restantes ignorados.",
          );
          break;
        }

        console.error(
          `Timeout ao processar a vaga ${summary.jobId} (tenant "${slug}") ` +
            `[${consecutiveTimeouts}/${MAX_CONSECUTIVE_DETAIL_TIMEOUTS}]: ${message}`,
        );
        continue;
      }

      // Falha pontual (detalhe ou normalização) isola apenas a vaga afetada.
      console.error(
        `Falha ao processar a vaga ${summary.jobId} (tenant "${slug}"): ${message}`,
      );
      continue;
    }
  }

  return jobs;
}

/** Busca o detalhe de uma vaga, validando a resposta HTTP e o corpo. */
async function fetchJobDetail(
  slug: string,
  jobId: string,
  headers: Record<string, string>,
): Promise<InhireJobDetail> {
  return fetchBoardWithTimeout(
    `${API_BASE_URL}/${encodeURIComponent(jobId)}`,
    SOURCE,
    async (response) => {
      if (!response.ok) {
        throw new InhireRequestError(
          response.status,
          `Falha ao consultar o detalhe da vaga ${jobId} (tenant "${slug}"): ${response.status} ${response.statusText}`,
        );
      }

      const data: unknown = await response.json();

      if (typeof data !== "object" || data === null) {
        throw new Error(
          `InHire API retornou um detalhe inválido (tenant "${slug}", vaga "${jobId}").`,
        );
      }

      return data as InhireJobDetail;
    },
    headers,
  );
}

/** Normaliza uma vaga da InHire para {@link Job}. */
function toJob(
  summary: InhireJobSummary,
  detail: InhireJobDetail,
  slug: string,
  tenantName: string,
): Job {
  const title = firstNonEmpty(detail.displayName) ?? summary.displayName;
  const location = firstNonEmpty(detail.location, summary.location) ?? "";
  // Defesa contra tipos inesperados da API: só aceita string; qualquer outro
  // tipo cai para a listagem (workplaceType) ou vira descrição vazia.
  const workplaceType =
    asString(detail.workplaceType) ?? asString(summary.workplaceType);
  const company = firstNonEmpty(detail.tenantName, tenantName, slug) ?? slug;
  const jobId = firstNonEmpty(detail.jobId, summary.jobId) ?? summary.jobId;
  const contractTypes = normalizeContractType(detail.contractType);
  const description = asString(detail.description) ?? "";

  return {
    id: summary.jobId,
    title,
    company,
    location,
    remote: workplaceType?.toLowerCase() === "remote",
    description: buildDescription(description, contractTypes),
    // URL pública de candidatura (candidatura é manual, feita pelo usuário).
    url: `https://${slug}.inhire.app/vagas/${jobId}`,
    source: SOURCE,
    // Somente a data real de publicação; a data da coleta nunca é usada.
    publishedAt: firstNonEmpty(detail.publishedAt),
  };
}

/**
 * Compõe a descrição final preservando integralmente o texto original e
 * antepondo, quando existir, o tipo de contratação informado pela InHire.
 *
 * A evidência é colocada no início para sobreviver ao truncamento aplicado na
 * montagem do prompt de IA e traz um rótulo explícito. Quando `contractType`
 * está ausente ou vazio, a descrição original é devolvida sem alteração.
 */
function buildDescription(description: string, contractTypes: string[]): string {
  if (contractTypes.length === 0) {
    return description;
  }

  const evidence = `${CONTRACT_TYPE_LABEL}: ${contractTypes.join(", ")}`;

  return description.trim() === "" ? evidence : `${evidence}\n\n${description}`;
}

/** Extrai os tipos de contratação não vazios informados pela InHire. */
function normalizeContractType(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Retorna o valor apenas se for string (defesa contra tipos inesperados da API). */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Retorna o primeiro valor não vazio (após `trim`), ou `undefined`. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  return undefined;
}

/** Identifica um resumo de vaga válido (identificador e título obrigatórios). */
function isJobSummary(value: unknown): value is InhireJobSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const summary = value as Partial<InhireJobSummary>;
  return (
    typeof summary.jobId === "string" &&
    summary.jobId.trim() !== "" &&
    typeof summary.displayName === "string" &&
    summary.displayName.trim() !== ""
  );
}

/** Aguarda o intervalo informado, para espaçar as requisições. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
