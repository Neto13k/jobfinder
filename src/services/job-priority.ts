import type { Job } from "../types/job.js";

// Menor valor = maior prioridade (usado como chave de ordenação).
const HIGH = 0;
const MEDIUM = 1;
const LOW = 2;

// Modalidade remota indicada no texto da localização.
const REMOTE = /\b(remote|remoto|home\s?office|teletrabalho)\b/;

// Regiões amplas que incluem o Brasil ou permanecem em avaliação.
const BROAD_REGION =
  /\b(latam|latin america|america latina|global|worldwide|anywhere)\b/;

// Cidade-alvo para vagas presenciais ou híbridas.
const TARGET_CITY = /\bmaceio\b/;

// Brasil explícito na localização.
const BRAZIL = /\b(brazil|brasil)\b/;

// Países/regiões estrangeiros usados nos padrões abaixo.
const FOREIGN =
  "us|usa|united states|canada|uk|united kingdom|eu|european union|emea|europe";

// Restrição explícita a residentes de outros países.
const FOREIGN_RESTRICTION = new RegExp(
  `\\b(?:${FOREIGN})\\s+(?:residents?|citizens?)\\s+only\\b` +
    `|\\b(?:${FOREIGN})\\s+only\\b` +
    `|\\b(?:must be |required to be )?(?:based|located) in (?:the )?(?:${FOREIGN})\\b`,
);

// Localidade claramente estrangeira.
const FOREIGN_LOCATION = new RegExp(`\\b(?:${FOREIGN})\\b`);

// Exclusão explícita de candidatos brasileiros.
const BRAZIL_EXCLUSION = new RegExp(
  `\\b(?:excluding|except|without)\\s+(?:the\\s+)?(?:brazil|brasil)\\b` +
    `|\\b(?:brazil|brasil)\\s+(?:excluded|not\\s+available|not\\s+eligible)\\b` +
    `|\\bnot\\s+available\\s+in\\s+(?:the\\s+)?(?:brazil|brasil)\\b` +
    `|\\b(?:exceto|excluindo|sem)\\s+(?:o\\s+)?(?:brasil|brazil)\\b` +
    `|\\b(?:brasil|brazil)\\s+(?:excluido|excluida|indisponivel)\\b` +
    `|\\bnao\\s+disponivel\\s+(?:no|em|para)?\\s*(?:o\\s+)?(?:brasil|brazil)\\b`,
);

/** Normaliza acentos, espaços e letras maiúsculas. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Limites das categorias de recência, em milissegundos.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Categorias temporais: menor valor = mais recente (maior prioridade).
const RECENT_24H = 0;
const RECENT_72H = 1;
const RECENT_7D = 2;
const RECENT_14D = 3;
const OLDER = 4;
const UNKNOWN_DATE = 5;

/** Categoria temporal e instante de publicação (0 quando ausente ou inválido). */
interface Recency {
  rank: number;
  timestamp: number;
}

/**
 * Classifica a recência a partir de `publishedAt` e de um instante de
 * referência.
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
 * Ordena as vagas por recência e, em seguida, por prioridade geográfica,
 * sem excluir nenhuma.
 *
 * Chave de ordenação, da mais relevante para a menos:
 * 1. Categoria temporal — recém-publicadas primeiro (≤24h, ≤72h, ≤7d, ≤14d,
 *    >14d e, por último, data desconhecida ou inválida). A recência prevalece
 *    sobre a geografia: uma vaga recente de localização indefinida supera uma
 *    vaga elegível muito antiga.
 * 2. Prioridade geográfica (HIGH, MEDIUM, LOW) — preservada dentro de cada
 *    faixa temporal.
 * 3. Data de publicação mais recente primeiro, dentro da mesma faixa e da
 *    mesma prioridade geográfica.
 *
 * A ordenação é estável: empates mantêm a ordem original. As vagas sem data
 * são preservadas e nenhuma é descartada pela idade. Os objetos originais não
 * são modificados.
 *
 * @param jobs Vagas a ordenar (o array de entrada não é alterado).
 * @param referenceDate Instante de referência para o cálculo da recência;
 *   padrão `new Date()`. Útil para testes determinísticos.
 */
export function prioritizeJobs(
  jobs: Job[],
  referenceDate: Date = new Date(),
): Job[] {
  const reference = referenceDate.getTime();

  return jobs
    .map((job, index) => {
      const recency = classifyRecency(job.publishedAt, reference);
      return {
        job,
        index,
        temporal: recency.rank,
        geographic: priorityRank(job),
        timestamp: recency.timestamp,
      };
    })
    .sort(
      (a, b) =>
        a.temporal - b.temporal ||
        a.geographic - b.geographic ||
        b.timestamp - a.timestamp ||
        a.index - b.index,
    )
    .map((entry) => entry.job);
}

/**
 * Calcula a prioridade geográfica de uma vaga (menor valor = maior prioridade).
 *
 * HIGH: remoto disponível para o Brasil ou presencial/híbrido em Maceió/AL.
 * MEDIUM: remoto LATAM/global ou de localização desconhecida/ambígua, ainda
 *   precisando de avaliação.
 * LOW: restrição explícita a região estrangeira, sem evidência de elegibilidade
 *   brasileira.
 *
 * A heurística é conservadora — "remote: true" isolado ou a mera menção a
 * "Brazil"/"Brasil" na descrição não são tratados como elegibilidade.
 */
function priorityRank(job: Job): number {
  const location = normalize(job.location ?? "");

  // Sem localização: precisa de avaliação.
  if (!location) {
    return MEDIUM;
  }

  // Exclusão explícita de candidatos brasileiros tem precedência sobre tudo,
  // inclusive sobre indicações de remoto, LATAM ou global.
  if (BRAZIL_EXCLUSION.test(location)) {
    return LOW;
  }

  // Restrição explícita de residência tem precedência sobre tudo.
  if (FOREIGN_RESTRICTION.test(location)) {
    return LOW;
  }

  // Presencial, híbrido ou remoto em Maceió/AL.
  if (TARGET_CITY.test(location)) {
    return HIGH;
  }

  // Remoto pode vir da flag da vaga ou do texto da localização.
  const remote = job.remote === true || REMOTE.test(location);

  // Remoto explicitamente disponível para candidatos no Brasil.
  if (remote && BRAZIL.test(location)) {
    return HIGH;
  }

  if (remote) {
    // Regiões amplas (LATAM, global, worldwide) permanecem em avaliação, mesmo
    // quando também citam países estrangeiros.
    if (BROAD_REGION.test(location)) {
      return MEDIUM;
    }

    // Restrita a uma região estrangeira explícita.
    if (FOREIGN_LOCATION.test(location)) {
      return LOW;
    }

    // Remoto sem região definida.
    return MEDIUM;
  }

  // Localização brasileira sem modalidade remota.
  if (BRAZIL.test(location)) {
    return MEDIUM;
  }

  // Localidade estrangeira explícita (presencial/híbrido fora do Brasil).
  if (FOREIGN_LOCATION.test(location)) {
    return LOW;
  }

  // Informação ambígua.
  return MEDIUM;
}
