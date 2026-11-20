/**
 * Padrões geográficos compartilhados pela triagem (`location-filter`) e pela
 * priorização (`job-priority`).
 *
 * Os dois serviços normalizam o texto antes de testar (minúsculas, sem acentos
 * e com espaços colapsados), por isso os termos são grafados sem acento. As
 * expressões avaliadas com `.test()` não usam a flag `g`, permanecendo sem
 * estado entre chamadas.
 */

// --- Vocabulário base ------------------------------------------------------

/** Termos que indicam o Brasil no texto normalizado (país e código ISO "BR"). */
const BRAZIL_TERMS = "brazil|brasil|br";

/**
 * Regiões amplas que incluem o Brasil ou permanecem em avaliação. Mantidas
 * separadas do Brasil porque a priorização as classifica de forma distinta
 * (Brasil remoto é HIGH; LATAM/global é MEDIUM).
 */
const BROAD_REGION_TERMS =
  "latam|latin america|america latina|worldwide|global|anywhere";

/**
 * Área elegível a candidatos residentes no Brasil: o país somado às regiões
 * amplas. Fonte única dos termos reutilizados em expressões compostas.
 */
export const ELIGIBLE_AREA = `${BRAZIL_TERMS}|${BROAD_REGION_TERMS}`;

// --- Expressões compartilhadas --------------------------------------------

/** Região elegível ao Brasil (país ou região ampla). */
export const ELIGIBLE_REGION = new RegExp(`\\b(?:${ELIGIBLE_AREA})\\b`);

/** Brasil explícito na localização. */
export const BRAZIL = new RegExp(`\\b(?:${BRAZIL_TERMS})\\b`);

/** Regiões amplas (LATAM/global), deliberadamente distintas do Brasil. */
export const BROAD_REGION = new RegExp(`\\b(?:${BROAD_REGION_TERMS})\\b`);

/** Cidade-alvo para vagas presenciais ou híbridas (Maceió/AL). */
export const TARGET_CITY = /\bmaceio\b/;

/** Exclusão explícita de candidatos residentes no Brasil. */
export const BRAZIL_EXCLUSION =
  /\b(?:excluding|except|without)\s+(?:the\s+)?(?:brazil|brasil)\b|\b(?:brazil|brasil)\s+(?:excluded|not\s+available|not\s+eligible)\b|\bnot\s+available\s+in\s+(?:the\s+)?(?:brazil|brasil)\b|\b(?:exceto|excluindo|sem)\s+(?:o\s+)?(?:brasil|brazil)\b|\b(?:brasil|brazil)\s+(?:excluido|excluida|indisponivel)\b|\bnao\s+disponivel\s+(?:no|em|para)?\s*(?:o\s+)?(?:brasil|brazil)\b/;
