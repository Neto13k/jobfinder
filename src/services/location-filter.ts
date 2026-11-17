import type { Job } from "../types/job.js";

export type JobLocation = "allowed" | "blocked" | "unknown";

/** Modalidade de trabalho inferida a partir do próprio anúncio. */
export type JobModality = "remote" | "onsite" | "unknown";

/** Decisão sobre as exigências de residência: incompatível, incerta ou nenhuma. */
type ResidenceDecision = "blocked" | "unknown" | "none";

// Sinais de trabalho remoto no anúncio (título, localização e descrição).
const REMOTE_MODALITY =
  /\b(?:remot[oa]s?|remotes?|home\s?-?office|teletrabalho|wfh|work from home)\b/;

// Sinais de trabalho presencial ou híbrido.
const ONSITE_MODALITY =
  /\b(?:presencia(?:l|is)|hibrid[oa]s?|hybrids?|on\s?-?site|in\s?-?office|no escritorio)\b/;

// Negação imediatamente antes do sinal (ex.: "não é remoto", "not remote").
const NEGATION_BEFORE =
  /\b(?:nao|sem|nenhum|nenhuma|not|no|without|isnt|cannot|can't)\b[^.;!?]{0,15}$/;

// Negação logo depois do sinal (ex.: "remote is not available").
const NEGATION_AFTER = /^[^.;!?]{0,15}\b(?:not|nao|indisponivel|unavailable)\b/;

// Cidade aceita para vagas presenciais e híbridas.
const TARGET_CITY = /\bmaceio\b/;

// Regiões que incluem explicitamente o Brasil.
const ELIGIBLE_REGION =
  /\b(brazil|brasil|latam|latin america|america latina|worldwide|global|anywhere)\b/;

// Localidades claramente fora da área aceita (presencial ou de residência).
const FOREIGN_LOCATION =
  /\b(us|usa|united states|estados unidos|eua|canada|uk|united kingdom|reino unido|europe|emea|apac|london|londres|india|germany|ireland)\b/;

// Exclusão explícita de candidatos residentes em outro país (incompatível).
const FOREIGN_ONLY =
  /\b(?:us|usa|united states|estados unidos|eua|canada|uk|united kingdom|reino unido)\s+(?:residents?|citizens?|residentes?|cidadaos?)\s+(?:only|apenas)\b|\b(?:must\s+be\s+|required\s+to\s+be\s+)(?:based|located)\s+in\s+(?:the\s+)?(?:us|usa|united states|estados unidos|eua|canada|uk|united kingdom|reino unido)\b/;

// Exigência explícita de residência, capturando o local exigido.
// A captura vai até a próxima pontuação e abrange alternativas ligadas por
// conjunções (ex.: "Brasil ou São Paulo"), para avaliar a expressão completa.
// Ex.: "residir em São Paulo", "residentes no Brasil", "must reside in the US".
const RESIDENCE_REQUIREMENT =
  /\b(?:residente|residentes|residents?|residir|resida|morar|mora|domiciliad[oa]|reside|residing|must\s+reside|must\s+live|must\s+be\s+based|must\s+be\s+located)\b\s*(?:nos|nas|dos|das|em|no|na|in|at|of|de|do|da)\b\s*([a-z0-9][a-z0-9 '-]*)?/;

// Palavras de ligação sem valor de localidade (artigos, preposições e conjunções).
const LOCATION_FILLER =
  /\b(?:e|ou|and|or|the|of|in|at|em|no|na|nos|nas|de|do|da|dos|das|a|o|as|os)\b/g;

// Termos de localidade compatível. Removidos do local exigido para isolar uma
// eventual localidade específica (ex.: "Brasil ou São Paulo").
const ELIGIBLE_PLACE =
  /\b(?:brazil|brasil|latam|latin america|america latina|worldwide|global|anywhere|maceio)\b/g;

// Normaliza acentos, espaços e letras maiúsculas.
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verifica se o texto contém o sinal sem que ele esteja negado na mesma frase.
 *
 * A negação é procurada apenas na vizinhança imediata (até 15 caracteres) e
 * dentro da mesma frase, para não interpretar uma palavra isolada como
 * confirmação de modalidade.
 */
function hasUnnegatedSignal(text: string, signal: RegExp): boolean {
  const matcher = new RegExp(signal.source, "gi");
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text)) !== null) {
    const start = match.index;
    const before = text.slice(Math.max(0, start - 20), start);
    const after = text.slice(start + match[0].length, start + match[0].length + 20);

    if (NEGATION_BEFORE.test(before) || NEGATION_AFTER.test(after)) {
      continue;
    }

    return true;
  }

  return false;
}

/** Sinais textuais de modalidade presentes em título, localização e descrição. */
function detectTextualSignals(input: {
  title?: string;
  location?: string;
  description?: string;
}): { remote: boolean; onsite: boolean } {
  const text = normalize(
    `${input.title ?? ""} ${input.location ?? ""} ${input.description ?? ""}`,
  );

  if (!text) {
    return { remote: false, onsite: false };
  }

  return {
    remote: hasUnnegatedSignal(text, REMOTE_MODALITY),
    onsite: hasUnnegatedSignal(text, ONSITE_MODALITY),
  };
}

/**
 * Infere a modalidade de uma vaga a partir dos sinais do próprio anúncio.
 *
 * Usa título, localização e descrição, descartando ocorrências negadas
 * ("não é remoto") e tratando sinais contraditórios como indefinidos. O filtro
 * `isRemote` usado na pesquisa NÃO é considerado: cada vaga é avaliada apenas
 * pelo que ela mesma informa.
 *
 * @returns "remote", "onsite" ou "unknown" quando o anúncio for ambíguo.
 */
export function classifyJobModality(input: {
  title?: string;
  location?: string;
  description?: string;
}): JobModality {
  const { remote, onsite } = detectTextualSignals(input);

  // Sinais contraditórios: não há evidência suficiente para confirmar.
  if (remote && onsite) {
    return "unknown";
  }

  if (onsite) {
    return "onsite";
  }

  if (remote) {
    return "remote";
  }

  return "unknown";
}

/**
 * Combina o sinal estruturado de remoto (`Job.remote`) com os sinais textuais.
 *
 * `Job.remote === true` é um sinal estruturado confiável (providers que expõem
 * a modalidade, como Greenhouse, Lever e Ashby). `Job.remote === false` NÃO
 * confirma presencial: apenas indica "remoto não confirmado". Sinais
 * estruturados e textuais contraditórios resultam em "unknown".
 */
function resolveModality(job: Job): JobModality {
  const { remote: textualRemote, onsite } = detectTextualSignals(job);
  const remote = textualRemote || job.remote === true;

  if (remote && onsite) {
    return "unknown";
  }

  if (onsite) {
    return "onsite";
  }

  if (remote) {
    return "remote";
  }

  return "unknown";
}

/**
 * Avalia TODAS as restrições explícitas de residência encontradas no texto.
 *
 * A precedência é incompatível > incerta > compatível:
 * - "blocked": alguma exigência aponta exclusivamente para local estrangeiro.
 * - "unknown": alguma exigência é incerta (sem local identificável, local
 *   específico sem incompatibilidade comprovada, alternativa geográfica ou
 *   expressão que mistura região elegível com uma localidade específica), mesmo
 *   que outra mencione Brasil, LATAM ou global.
 * - "none": sem restrição explícita ou apenas restrições claramente compatíveis.
 *
 * Nomes de cidades ou países soltos no texto descritivo NÃO bloqueiam: apenas
 * exigências explícitas de residência são consideradas.
 */
function evaluateResidenceRestriction(
  text: string,
): "blocked" | "unknown" | "none" {
  const matcher = new RegExp(RESIDENCE_REQUIREMENT.source, "g");
  let result: "blocked" | "unknown" | "none" = "none";
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text)) !== null) {
    const place = (match[1] ?? "").trim();

    // Exigência sem local identificável: incerta.
    if (!place) {
      result = "unknown";
      continue;
    }

    const foreign = FOREIGN_LOCATION.test(place);
    const eligible = TARGET_CITY.test(place) || ELIGIBLE_REGION.test(place);

    // Local estrangeiro combinado a uma região elegível (alternativa geográfica
    // contraditória, ex.: "US or Brazil") é incerto, não incompatível.
    if (foreign && eligible) {
      result = "unknown";
      continue;
    }

    // Exigência exclusivamente estrangeira: incompatível, tem prioridade máxima.
    if (foreign) {
      return "blocked";
    }

    // Resíduo após remover regiões compatíveis e palavras de ligação: isola uma
    // eventual localidade específica (ex.: "Brasil ou São Paulo" → "são paulo").
    const residual = place
      .replace(ELIGIBLE_PLACE, " ")
      .replace(LOCATION_FILLER, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Localidade específica presente (com ou sem região elegível): incerta.
    if (residual) {
      result = "unknown";
      continue;
    }

    // Sem localidade específica: exige uma região claramente compatível para ser
    // considerada compatível; caso contrário, permanece incerta.
    if (!eligible) {
      result = "unknown";
    }
  }

  return result;
}

/**
 * Classifica a localização de uma vaga.
 *
 * allowed: presencial/híbrido em Maceió/AL ou remoto elegível a residentes no Brasil.
 * blocked: presencial/híbrido explícito fora de Maceió ou restrição explícita
 *          a residentes de outro país.
 * unknown: modalidade desconhecida, sinais contraditórios, elegibilidade
 *          geográfica incerta ou restrição de residência não classificável.
 */
export function classifyJobLocation(job: Job): JobLocation {
  const location = normalize(job.location ?? "");
  const scope = normalize(
    `${job.location ?? ""} ${job.title ?? ""} ${job.description ?? ""}`,
  );

  // Restrições explícitas de residência (localização, título e descrição) têm
  // prioridade, inclusive em vagas remotas.
  if (FOREIGN_ONLY.test(scope)) {
    return "blocked";
  }

  const restriction = evaluateResidenceRestriction(scope);
  if (restriction !== "none") {
    return restriction;
  }

  const modality = resolveModality(job);

  // Vagas explicitamente em Maceió/AL são aceitas (presencial, híbrida ou remota).
  if (TARGET_CITY.test(location)) {
    return "allowed";
  }

  // Presencial ou híbrido explícito fora de Maceió: bloqueado.
  if (modality === "onsite") {
    return location ? "blocked" : "unknown";
  }

  // Remoto explícito: exige evidência de elegibilidade para residentes no Brasil.
  if (modality === "remote") {
    if (ELIGIBLE_REGION.test(location)) {
      return "allowed";
    }

    if (FOREIGN_LOCATION.test(location)) {
      return "blocked";
    }

    return "unknown";
  }

  // Modalidade desconhecida: mantém a triagem conservadora já existente.
  if (!location) {
    return "unknown";
  }

  if (FOREIGN_LOCATION.test(location)) {
    return "blocked";
  }

  return "unknown";
}

/**
 * Remove somente vagas claramente incompatíveis.
 * Vagas indefinidas seguem para análise posterior com IA.
 */
export function filterByLocation(jobs: Job[]): Job[] {
  return jobs.filter((job) => classifyJobLocation(job) !== "blocked");
}
