import { BRAZIL_EXCLUSION, ELIGIBLE_AREA, ELIGIBLE_REGION, TARGET_CITY } from "../config/geo-patterns.js";
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

// Localidades claramente estrangeiras: países, regiões e cidades frequentes nos
// anúncios. A mera menção na descrição NÃO bloqueia; estes termos só pesam na
// localização da vaga ou em exigências explícitas de residência.
const FOREIGN_AREA = [
  // América do Norte
  "us", "usa", "united states", "estados unidos", "eua", "canada", "mexico",
  "mexico city", "cidade do mexico", "california", "new york", "nova york",
  "san francisco", "seattle", "boston", "chicago", "austin", "dallas",
  "atlanta", "los angeles", "miami", "toronto", "vancouver", "montreal",
  // Reino Unido, Irlanda e Europa
  "uk", "united kingdom", "reino unido", "england", "scotland", "wales",
  "ireland", "irlanda", "london", "londres", "dublin", "europe",
  "european union", "uniao europeia", "european economic area", "eea",
  "emea", "germany", "alemania", "france", "franca", "italy", "italia",
  "netherlands", "holanda", "paises baixos", "belgium", "belgica",
  "switzerland", "suica", "austria", "poland", "polonia", "romania",
  "romenia", "ukraine", "ucrania", "hungary", "czech", "greece", "grecia",
  "sweden", "suecia", "norway", "noruega", "denmark", "dinamarca",
  "finland", "finlandia", "portugal", "spain", "espana", "lisbon", "lisboa",
  "madrid", "barcelona", "berlin", "munich", "amsterdam", "paris",
  // Ásia, Oceania e Oriente Médio
  "apac", "india", "indonesia", "philippines", "filipinas", "pakistan",
  "bangladesh", "vietnam", "china", "japan", "japao", "singapore",
  "singapura", "australia", "new zealand", "dubai", "uae",
  "emirados arabes unidos", "israel", "hong kong", "korea", "bangalore",
  "bengaluru", "hyderabad", "tokyo", "shanghai", "beijing", "sydney",
  "melbourne",
  // África
  "egypt", "nigeria", "kenya", "south africa", "africa do sul",
  // América Latina (fora do Brasil)
  "colombia", "argentina", "chile", "peru", "venezuela", "equador",
  "ecuador", "bolivia", "paraguay", "paraguai", "uruguay", "uruguai",
  "costa rica", "panama", "guatemala", "honduras", "el salvador",
  "nicaragua", "cuba", "republica dominicana", "puerto rico", "bogota",
  "medellin", "cali", "lima", "santiago", "buenos aires", "montevideu",
  "montevideo",
].join("|");

// Localidade estrangeira isolada (usada na localização e em exigências).
const FOREIGN_LOCATION = new RegExp(`\\b(?:${FOREIGN_AREA})\\b`);

// Exclusão explícita de candidatos residentes em outro país (incompatível).
//
// A expressão geográfica é avaliada por completo: se a mesma oração também
// admitir Brasil/LATAM/global (ex.: "must be based in Colombia or Brazil"), a
// exigência é ambígua e NÃO é decidida aqui — fica para
// `evaluateResidenceRestriction`, que trata alternativas como indefinidas.
const FOREIGN_ONLY = new RegExp(
  "(?:" +
    `\\b(?:${FOREIGN_AREA})\\s+(?:residents?|citizens?|residentes?|cidadaos?)\\s+(?:only|apenas)\\b` +
    `|\\b(?:must\\s+be\\s+|required\\s+to\\s+be\\s+)(?:based|located)\\s+in\\s+(?:the\\s+)?(?:${FOREIGN_AREA})\\b` +
    ")" +
    `(?![^.;!?]*\\b(?:${ELIGIBLE_AREA})\\b)`,
);

// Estados e principais cidades brasileiras: reconhecem vagas remotas no Brasil
// mesmo sem as palavras "Brazil"/"Brasil" na localização. Não inclui siglas de
// UF (ambíguas com estados dos EUA) para evitar falso positivo.
const BRAZIL_PLACE = new RegExp(
  "\\b(?:" +
    [
      // Estados (nomes completos)
      "acre", "alagoas", "amapa", "amazonas", "bahia", "ceara",
      "distrito federal", "espirito santo", "goias", "maranhao",
      "mato grosso do sul", "mato grosso", "minas gerais", "paraiba",
      "parana", "pernambuco", "piaui", "rio de janeiro",
      "rio grande do norte", "rio grande do sul", "rondonia", "roraima",
      "santa catarina", "sao paulo", "sergipe", "tocantins",
      // Principais cidades
      "brasilia", "salvador", "fortaleza", "belo horizonte", "manaus",
      "curitiba", "recife", "goiania", "belem", "porto alegre",
      "guarulhos", "campinas", "sao luis", "maceio", "campo grande",
      "natal", "teresina", "joao pessoa", "santo andre", "osasco",
      "sao jose dos campos", "ribeirao preto", "uberlandia", "sorocaba",
      "aracaju", "cuiaba", "joinville", "juiz de fora", "londrina",
      "niteroi", "florianopolis", "porto velho", "macapa",
      "caxias do sul", "vitoria", "feira de santana",
      "sao bernardo do campo", "nova iguacu", "contagem",
      "aparecida de goiania",
    ].join("|") +
    ")\\b",
);

// Termos estrangeiros que "escondem" uma localidade brasileira como subcadeia
// (ex.: "El Salvador" contém "Salvador"): removidos antes de reconhecer
// cidades/estados brasileiros, para evitar colisão de classificação.
const FOREIGN_SHADOWING_BRAZIL = /\b(?:el|san)\s+salvador\b/g;

// Evidência EXPLÍCITA de elegibilidade a candidatos residentes no Brasil,
// usada apenas na descrição. Reconhece construções que ligam candidatos ou
// residentes (ou verbos de aceitação/residência) ao Brasil; NÃO conta meras
// menções genéricas (clientes, escritórios, empresa global).
const BRAZIL_ELIGIBILITY = new RegExp(
  [
    // "candidatos/residentes no Brasil", "candidates based in Brazil"
    "\\b(?:residents?|candidates?|applicants?|people|professionals?|developers?" +
      "|employees?|residentes?|candidat[oa]s?|pessoas|profissionais?" +
      "|desenvolvedor(?:es)?|colaboradores?)\\b[^.;!?]{0,30}" +
      "\\b(?:in|of|from|no|na|em|do|da)\\s+(?:the\\s+)?(?:brazil|brasil)\\b",
    // "aberta a residentes no Brasil", "open to ... Brazil", "hiring in Brazil"
    "\\b(?:open|available|accepting|accept|hiring|hire|considering|eligible" +
      "|abert[oa]s?|disponi(?:vel|veis)|aceitamos|aceita|contratamos|contrata" +
      "|consideramos|elegi(?:vel|veis)|buscamos|procuramos)\\b[^.;!?]{0,40}" +
      "\\b(?:brazil|brasil)\\b",
    // "must reside in Brazil", "residir no Brasil"
    "\\b(?:must\\s+be\\s+based|must\\s+reside|must\\s+live|reside|residing" +
      "|residir|resida|morar|mora|domiciliad[oa])\\b[^.;!?]{0,20}" +
      "\\b(?:in|no|na|em|do|da)\\s+(?:the\\s+)?(?:brazil|brasil)\\b",
  ].join("|"),
);

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
// eventual localidade específica (ex.: "Brasil ou São Paulo"). Deriva da área
// elegível compartilhada, acrescida da cidade-alvo.
const ELIGIBLE_PLACE = new RegExp(`\\b(?:${ELIGIBLE_AREA}|maceio)\\b`, "g");

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
 * allowed: presencial/híbrido em Maceió/AL ou remoto elegível a residentes no
 *          Brasil (país, região LATAM/global ou cidade/estado brasileiro).
 * blocked: presencial/híbrido explícito fora de Maceió, restrição explícita a
 *          residentes de outro país ou exclusão explícita do Brasil.
 * unknown: modalidade desconhecida, sinais contraditórios, elegibilidade
 *          geográfica incerta (ex.: exigência estrangeira com alternativa no
 *          Brasil, localização estrangeira com elegibilidade explícita ao
 *          Brasil na descrição) ou restrição de residência não classificável.
 *
 * A elegibilidade brasileira é admitida na LOCALIZAÇÃO da vaga, em exigências
 * explícitas de residência ou quando a DESCRIÇÃO declara explicitamente aceitar
 * candidatos residentes no Brasil. Menções genéricas no anúncio (clientes,
 * escritórios ou empresa global) NÃO comprovam que residentes no Brasil podem
 * se candidatar.
 */
export function classifyJobLocation(job: Job): JobLocation {
  const location = normalize(job.location ?? "");
  const description = normalize(job.description ?? "");
  const scope = normalize(
    `${job.location ?? ""} ${job.title ?? ""} ${job.description ?? ""}`,
  );

  // Exclusão explícita de candidatos residentes no Brasil: incompatível.
  if (BRAZIL_EXCLUSION.test(scope)) {
    return "blocked";
  }

  // Restrição explícita a residentes de outro país: incompatível.
  if (FOREIGN_ONLY.test(scope)) {
    return "blocked";
  }

  // Demais exigências explícitas de residência (localização, título e descrição)
  // têm prioridade, inclusive em vagas remotas.
  const restriction = evaluateResidenceRestriction(scope);
  if (restriction !== "none") {
    return restriction;
  }

  const modality = resolveModality(job);

  // Vagas explicitamente em Maceió/AL são aceitas (presencial, híbrida ou remota).
  if (TARGET_CITY.test(location)) {
    return "allowed";
  }

  // Localização com país, região ou cidade/estado brasileiro reconhecido.
  // Em "El Salvador"/"San Salvador" (estrangeiros) o termo "Salvador" é
  // removido antes da checagem para não confundir com a cidade brasileira.
  const brazilPlace = BRAZIL_PLACE.test(
    location.replace(FOREIGN_SHADOWING_BRAZIL, " "),
  );
  const locationEligible = ELIGIBLE_REGION.test(location) || brazilPlace;

  // Presencial ou híbrido explícito fora de Maceió: bloqueado quando há
  // localização; sem localização identificável permanece indefinido.
  if (modality === "onsite") {
    return location ? "blocked" : "unknown";
  }

  // Remoto explícito: exige evidência de elegibilidade para residentes no Brasil.
  if (modality === "remote") {
    if (locationEligible) {
      return "allowed";
    }

    // Localização estrangeira explícita. Se a descrição indicar de forma
    // EXPLÍCITA que aceita candidatos residentes no Brasil, preserva a vaga
    // como indefinida para a IA; menções genéricas (clientes, escritórios,
    // empresa global) NÃO liberam e a vaga permanece bloqueada.
    if (FOREIGN_LOCATION.test(location)) {
      return BRAZIL_ELIGIBILITY.test(description) ? "unknown" : "blocked";
    }

    // Localização sem país/região estrangeiro contraditório (vazia ou genérica,
    // como "Remote"/"Remoto"): se a descrição declara de forma EXPLÍCITA aceitar
    // candidatos residentes no Brasil, a vaga é elegível. A ausência de restrição
    // NÃO conta como elegibilidade — só a evidência explícita libera a vaga; os
    // casos realmente indefinidos seguem conservadoramente como "unknown".
    if (BRAZIL_ELIGIBILITY.test(description)) {
      return "allowed";
    }

    // Sem informação geográfica suficiente para confirmar: indefinida.
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
