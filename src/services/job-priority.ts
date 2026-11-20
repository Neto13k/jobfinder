import { BRAZIL, BROAD_REGION, TARGET_CITY } from "../config/geo-patterns.js";
import { classifyJobContract } from "./contract-filter.js";
import { classifyJobLocation } from "./location-filter.js";
import { stripHtml } from "./text-normalize.js";
import type { Job } from "../types/job.js";

// Pesos máximos de cada critério. A soma é exatamente 100, então a pontuação
// total de qualquer vaga está sempre no intervalo [0, 100].
const STACK_WEIGHT = 35;
const SENIORITY_WEIGHT = 30;
const LOCATION_WEIGHT = 20;
const RECENCY_WEIGHT = 10;
const CONTRACT_WEIGHT = 5;

// --- Critério 1: Stack -----------------------------------------------------

/**
 * Tecnologias-alvo do perfil, com o padrão que as reconhece no texto
 * normalizado (sem acento e minúsculo). A correspondência é por palavra
 * inteira para não confundir "react" com "reactive" nem "node" com "nodes".
 */
const STACK_TECHNOLOGIES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "JavaScript", pattern: /\b(?:javascript|java\s?script)\b/ },
  { label: "TypeScript", pattern: /\b(?:typescript|type\s?script)\b/ },
  { label: "React", pattern: /\breact(?:\.?js)?\b/ },
  { label: "Node.js", pattern: /\bnode(?:\.?js)?\b/ },
  { label: "Express", pattern: /\bexpress(?:\.?js)?\b/ },
  { label: "PostgreSQL", pattern: /\bpostgres(?:ql)?\b/ },
];

// Pesos relativos de uma tecnologia conforme o contexto em que é citada:
// requisito obrigatório, diferencial ou menção incidental.
const CONTEXT_MANDATORY = 1;
const CONTEXT_DIFFERENTIAL = 0.5;
const CONTEXT_INCIDENTAL = 0.2;

// Cues de requisito OBRIGATÓRIO (texto normalizado, sem acento).
const MANDATORY_CUES =
  /\b(?:requisit\w*|obrigatori\w*|necessari\w*|imprescind\w*|indispens\w*|exigid\w*|exigencia\w*|required|must[\s-]have|essencia(?:l|is)|proficien\w*|dominio|experiencia(?: solida| comprovada)?(?: em| com| de)|conhecimento(?: solido| avancado)? em|strong experience)\b/;

// Cues de DIFERENCIAL (desejável, não obrigatório). Cobre a forma plural
// ("Diferenciais"), comum em listas de requisitos.
const DIFFERENTIAL_CUES =
  /\b(?:diferencia\w*|desej\w*|nice[\s-]to[\s-]have|plus|bonus|opcional|preferencialmente)\b/;

// Negação literal ("não", "sem", "not", "without"...). O "no" é tratado à parte
// em `DISMISSAL_CUES`, pois em português costuma ser a contração "em + o".
const NEGATION_CUES =
  /\b(?:nao|sem|nenhum|nenhuma|not|without|isn'?t|aren'?t|don'?t|dont|cannot|can'?t)\b/;

// Dispensa ou ausência explícita de exigência, incluindo a construção inglesa
// "no experience/knowledge with".
const DISMISSAL_CUES =
  /\b(?:dispens\w*|abrimos\s+mao|nao\s+precisa\w*|nao\s+exigimos|nao\s+requeremos|no\s+experience|no\s+knowledge|no\s+prior)\b/;

// Termos de exigência ou experiência que, negados, dispensam a tecnologia
// (ex.: "não é necessário", "not required", "não requer").
const REQUIREMENT_CUES =
  /\b(?:necessari\w*|obrigatori\w*|requisit\w*|requer\w*|exigid\w*|exigencia\w*|required|requirement|needed|essential|essencial|experiencia|experience|conhecimento|knowledge)\b/;

// --- Critério 2: Senioridade -----------------------------------------------

// Júnior/estágio/aprendizagem: alvo preferencial (maioris pontos).
const JUNIOR_TITLE =
  /\b(?:junior|jr|estagio|estagiari[oa]|estagi\w*|intern|internship|aprendiz|apprentice)\b/;

// Trainee: programa de entrada, mas ambíguo quanto ao nível.
const TRAINEE_TITLE = /\btrainee\b/;

// Pleno/intermediário: abaixo do alvo, mas acima do desconhecido.
const MID_TITLE = /\b(?:pleno|mid[\s-]?level|middle|intermediate)\b/;
const PL_ABBREVIATION = /\bpl\b(?![\/\w])/;

// --- Critério 3: Localização -----------------------------------------------

// Modalidade remota indicada no texto da localização.
const REMOTE = /\b(?:remote|remoto|home\s?office|teletrabalho)\b/;

// --- Critério 4: Recência --------------------------------------------------

// Limites das categorias de recência, em milissegundos.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Categorias temporais: menor valor = mais recente.
const RECENT_24H = 0;
const RECENT_72H = 1;
const RECENT_7D = 2;
const RECENT_14D = 3;
const OLDER = 4;
const UNKNOWN_DATE = 5;

// --- Critério 5: Contratação -----------------------------------------------

// Pontuação neutra de contratação não confirmada; nunca exclui a vaga.
const CONTRACT_UNKNOWN_POINTS = 3;

/** Pontuação total e por critério de uma vaga (cada campo no intervalo [0, 100]). */
export interface JobPriorityScore {
  /** Soma dos cinco critérios; sempre em [0, 100]. */
  total: number;
  stack: number;
  seniority: number;
  location: number;
  recency: number;
  contract: number;
}

/** Categoria temporal e instante de publicação (0 quando ausente ou inválido). */
interface Recency {
  rank: number;
  timestamp: number;
}

/**
 * Normaliza acentos, marcação HTML, espaços e caixa.
 *
 * Reutiliza {@link stripHtml} para que marcação e entidades HTML não escondam
 * termos de stack na descrição, em paridade com os demais filtros.
 */
function normalize(text: string): string {
  return stripHtml(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Divide o texto em orações/segmentos, para avaliar o contexto de cada termo.
 *
 * O corte ocorre apenas em pontuação seguida de espaço ou do fim do texto, para
 * não partir tokens com ponto interno (ex.: "Node.js") — o que deslocaria
 * tecnologias para um segmento sem o cue de requisito — nem perder o contexto
 * da oração em que o requisito aparece.
 */
function splitSegments(text: string): string[] {
  return text
    .split(/[.;!?]+(?=\s|$)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

// Tags de bloco que delimitam itens ou parágrafos em HTML.
const HTML_BLOCK_TAGS =
  /<\/?(?:li|ul|ol|dl|dt|dd|p|br|div|tr|td|th|table|section|article|header|footer|h[1-6])\b[^>]*>/gi;

// As mesmas tags quando escapadas como entidades HTML (ex.: "&lt;li&gt;").
const HTML_ESCAPED_BLOCK_TAGS =
  /&lt;\s*\/?\s*(?:li|ul|ol|dl|dt|dd|p|br|div|tr|td|th|table|section|article|header|footer|h[1-6])\b[\s\S]*?&gt;/gi;

/**
 * Segmenta a descrição da vaga para a análise de contexto da stack.
 *
 * Marcação de bloco (real ou escapada) e quebras de linha viram separadores de
 * oração. Assim, cada item de lista — em HTML, HTML escapado ou texto simples —
 * é avaliado isoladamente, e o cabeçalho de uma seção ("Requisitos:") pode
 * definir o contexto dos itens seguintes sem ser dissolvido no texto.
 */
function stackSegments(description: string): string[] {
  const withBreaks = description
    .replace(HTML_BLOCK_TAGS, ". ")
    .replace(HTML_ESCAPED_BLOCK_TAGS, ". ")
    .replace(/\r\n|\r|\n/g, ". ");

  return splitSegments(normalize(withBreaks));
}

/**
 * Verifica se a tecnologia é expressamente negada ou dispensada na oração.
 *
 * A negação/dispensa é procurada apenas na vizinhança imediata do termo (25
 * caracteres antes e depois), para não descartar outras tecnologias citadas na
 * mesma oração. Reconhece a negação corrente ("não é necessário TypeScript",
 * "JavaScript não é obrigatório"), a dispensa ("TypeScript dispensável") e a
 * ausência de exigência no inglês ("no experience with React required").
 */
function isDeniedTechnology(segment: string, technology: RegExp): boolean {
  const matcher = new RegExp(technology.source, "g");
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(segment)) !== null) {
    const before = segment.slice(Math.max(0, match.index - 25), match.index);
    const after = segment.slice(
      match.index + match[0].length,
      match.index + match[0].length + 25,
    );
    const window = `${before} ${after}`;

    if (
      DISMISSAL_CUES.test(window) ||
      (NEGATION_CUES.test(window) && REQUIREMENT_CUES.test(window))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Contexto apontado por um cabeçalho de seção, ou `null` quando a oração não
 * traz cue de requisito nem de diferencial.
 *
 * Uma oração com cue de diferencial ("Diferenciais:") ou de requisito
 * ("Requisitos obrigatórios:") conta como contexto quando é um cabeçalho de
 * seção; caso contrário, serve apenas para pesar os termos da própria oração.
 */
function sectionContext(segment: string): number | null {
  if (DIFFERENTIAL_CUES.test(segment)) {
    return CONTEXT_DIFFERENTIAL;
  }
  if (MANDATORY_CUES.test(segment)) {
    return CONTEXT_MANDATORY;
  }
  return null;
}

/**
 * Indica se a oração é um cabeçalho de seção.
 *
 * Cabeçalhos são rótulos terminados em ":" — de requisitos ("Requisitos:",
 * "Diferenciais:") ou de outras seções ("Benefícios:", "Sobre a empresa:").
 * Apenas cabeçalhos delimitam seção; uma frase comum que apenas mencione um cue
 * de requisito (ex.: "Buscamos experiência com React.") não é cabeçalho e não
 * define o contexto dos itens seguintes.
 */
function isSectionHeader(segment: string): boolean {
  return /:$/.test(segment);
}

/**
 * Pontua a aderência à stack-alvo (0–35).
 *
 * Cada tecnologia vale integralmente quando é requisito obrigatório (ou quando
 * aparece no título), metade quando é diferencial e uma fração mínima quando é
 * apenas menção incidental. O contexto de um item herda o cabeçalho da sua
 * seção ("Requisitos:" / "Diferenciais:") enquanto outra seção não começar —
 * de modo que listas de itens, em HTML, HTML escapado ou texto simples, não
 * percam o cue do cabeçalho. Tecnologias expressamente negadas ou dispensadas
 * não pontuam. A soma normalizada pelo total de tecnologias é arredondada para
 * manter a pontuação determinística.
 */
function stackScore(job: Job): number {
  const title = normalize(job.title ?? "");
  const segments = stackSegments(job.description ?? "");

  // Peso efetivo de cada oração, na ordem do texto. Apenas um cabeçalho de
  // seção redefine o contexto: um cabeçalho de requisitos/diferenciais o assume;
  // qualquer outro (institucional, benefícios, etc.) encerra o contexto herdado.
  // Frases comuns apenas herdam o contexto corrente — nunca o redefinem.
  let inherited: number | null = null;
  const weights = segments.map((segment) => {
    if (isSectionHeader(segment)) {
      inherited = sectionContext(segment);
      return inherited ?? CONTEXT_INCIDENTAL;
    }
    return sectionContext(segment) ?? inherited ?? CONTEXT_INCIDENTAL;
  });

  let totalWeight = 0;
  for (const technology of STACK_TECHNOLOGIES) {
    let weight = 0;

    // Tecnologia anunciada no título: requisito central da vaga.
    if (technology.pattern.test(title)) {
      weight = CONTEXT_MANDATORY;
    } else {
      for (let index = 0; index < segments.length; index++) {
        if (!technology.pattern.test(segments[index])) {
          continue;
        }
        // Tecnologia expressamente negada ou dispensada na oração não pontua.
        if (isDeniedTechnology(segments[index], technology.pattern)) {
          continue;
        }
        weight = Math.max(weight, weights[index]);
      }
    }

    totalWeight += weight;
  }

  return Math.round((totalWeight / STACK_TECHNOLOGIES.length) * STACK_WEIGHT);
}

/**
 * Pontua a senioridade (0–30), priorizando Júnior e Estágio.
 *
 * Júnior/estágio/aprendizagem recebem a pontuação máxima; trainee (ambíguo) e
 * pleno recebem valores intermediários; senioridade desconhecida recebe um valor
 * neutro — informação ausente nunca zera o critério nem exclui a vaga.
 */
function seniorityScore(job: Job): number {
  const title = normalize(job.title ?? "");

  if (JUNIOR_TITLE.test(title)) {
    return SENIORITY_WEIGHT;
  }
  if (TRAINEE_TITLE.test(title)) {
    return Math.round(SENIORITY_WEIGHT * 0.85);
  }
  if (MID_TITLE.test(title) || PL_ABBREVIATION.test(title)) {
    return Math.round(SENIORITY_WEIGHT * 0.5);
  }
  return Math.round(SENIORITY_WEIGHT * 0.6);
}

/**
 * Pontua a localização (0–20), reaproveitando {@link classifyJobLocation} como
 * fonte única da decisão geográfica.
 *
 * A classificação da triagem determina o teto da pontuação:
 * - `blocked` (restrição geográfica explícita) recebe zero;
 * - `unknown` (geografia ou modalidade indefinida) recebe um valor neutro de no
 *   máximo 8 pontos, para não penalizar informação ausente;
 * - `allowed` preserva a granularidade: remoto disponível para o Brasil
 *   (máximo), Maceió/AL, região ampla e remoto genérico.
 *
 * A modalidade considera também o campo estruturado `workplaceType`.
 */
function locationScore(job: Job): number {
  const classification = classifyJobLocation(job);

  // Incompatível: sem pontuação geográfica (a exclusão é decidida pelo filtro).
  if (classification === "blocked") {
    return 0;
  }

  // Indefinida: valor neutro, nunca acima de 8.
  if (classification === "unknown") {
    return 8;
  }

  const additional = (job.additionalLocations ?? [])
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const place = normalize(`${job.location ?? ""} ${additional}`.trim());

  // Presencial, híbrido ou remoto em Maceió/AL.
  if (TARGET_CITY.test(place)) {
    return 16;
  }

  const remote =
    job.remote === true ||
    job.workplaceType === "remote" ||
    REMOTE.test(place);

  // Remoto explicitamente disponível para candidatos no Brasil.
  if (remote && BRAZIL.test(place)) {
    return LOCATION_WEIGHT;
  }

  // Localização brasileira sem modalidade remota confirmada.
  if (BRAZIL.test(place)) {
    return 14;
  }

  // Remoto em região ampla (LATAM/global/worldwide).
  if (remote && BROAD_REGION.test(place)) {
    return 12;
  }

  if (remote) {
    return 10;
  }

  // Localização elegível sem modalidade remota confirmada: valor neutro.
  return 8;
}

/**
 * Classifica a recência a partir de `publishedAt` e de um instante de referência.
 *
 * Datas ausentes, inválidas ou futuras nunca são tratadas como recém-publicadas:
 * caem na categoria de recência desconhecida, preservando a vaga para análise.
 */
function classifyRecency(
  publishedAt: string | undefined,
  reference: number,
): Recency {
  if (!publishedAt) {
    return { rank: UNKNOWN_DATE, timestamp: 0 };
  }

  const timestamp = Date.parse(publishedAt);
  // Data inválida ou no futuro não é tratada como recém-publicada.
  if (Number.isNaN(timestamp) || timestamp > reference) {
    return { rank: UNKNOWN_DATE, timestamp: 0 };
  }

  const age = reference - timestamp;
  if (age <= DAY_MS) return { rank: RECENT_24H, timestamp };
  if (age <= 3 * DAY_MS) return { rank: RECENT_72H, timestamp };
  if (age <= 7 * DAY_MS) return { rank: RECENT_7D, timestamp };
  if (age <= 14 * DAY_MS) return { rank: RECENT_14D, timestamp };
  return { rank: OLDER, timestamp };
}

/**
 * Pontua a recência (0–10), favorecendo publicações recentes.
 *
 * Vagas antigas recebem pontuação menor, mas nunca são excluídas. Vagas sem
 * data (ou com data inválida/futura) recebem pontuação neutra, para não serem
 * penalizadas por informação ausente.
 */
function recencyScore(publishedAt: string | undefined, reference: number): number {
  switch (classifyRecency(publishedAt, reference).rank) {
    case RECENT_24H:
      return RECENCY_WEIGHT;
    case RECENT_72H:
      return 8;
    case RECENT_7D:
      return 6;
    case RECENT_14D:
      return 4;
    case OLDER:
      return 2;
    default:
      return 5;
  }
}

/**
 * Pontua a contratação (0–5), favorecendo CLT e Estágio confirmados.
 *
 * Reutiliza {@link classifyJobContract} para não duplicar as regras de vínculo.
 * Contratação não confirmada recebe pontuação neutra; contratação bloqueada
 * (incompatível) recebe zero — decisão tomada pelo filtro de contratação.
 */
function contractScore(job: Job): number {
  const contract = classifyJobContract(job);

  if (contract === "allowed") {
    return CONTRACT_WEIGHT;
  }
  if (contract === "unknown") {
    return CONTRACT_UNKNOWN_POINTS;
  }
  return 0;
}

/**
 * Calcula a pontuação determinística (0–100) de uma vaga, com o detalhamento
 * por critério.
 *
 * A pontuação é reproduzível: depende apenas da vaga, do instante de referência
 * e das regras puras. Informações desconhecidas (stack, senioridade, localidade,
 * data ou contratação) recebem valores neutros e nunca causam exclusão.
 *
 * @param job Vaga a pontuar.
 * @param referenceDate Instante de referência da recência; padrão `new Date()`.
 */
export function scoreJob(
  job: Job,
  referenceDate: Date = new Date(),
): JobPriorityScore {
  const stack = stackScore(job);
  const seniority = seniorityScore(job);
  const location = locationScore(job);
  const recency = recencyScore(job.publishedAt, referenceDate.getTime());
  const contract = contractScore(job);

  return {
    total: stack + seniority + location + recency + contract,
    stack,
    seniority,
    location,
    recency,
    contract,
  };
}

/**
 * Ordena as vagas por pontuação decrescente, sem excluir nenhuma.
 *
 * Chave de ordenação, da mais relevante para a menos:
 * 1. Pontuação total (0–100) — maior primeiro.
 * 2. Data de publicação mais recente primeiro (desempate por recência).
 * 3. Ordem de entrada (ordenação estável) — desempate final determinístico.
 *
 * A ordenação é estável e não modifica o array nem os objetos originais: os
 * mesmos objetos, apenas reordenados, são retornados em uma nova coleção.
 *
 * @param jobs Vagas a ordenar (o array de entrada não é alterado).
 * @param referenceDate Instante de referência da recência; padrão `new Date()`.
 *   Útil para testes determinísticos.
 */
export function prioritizeJobs(
  jobs: Job[],
  referenceDate: Date = new Date(),
): Job[] {
  const reference = referenceDate.getTime();

  return jobs
    .map((job, index) => ({
      job,
      index,
      score: scoreJob(job, referenceDate).total,
      timestamp: classifyRecency(job.publishedAt, reference).timestamp,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.timestamp - a.timestamp ||
        a.index - b.index,
    )
    .map((entry) => entry.job);
}
