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

/**
 * Ordena as vagas por prioridade geográfica, sem excluir nenhuma.
 *
 * HIGH: remoto disponível para o Brasil ou presencial/híbrido em Maceió/AL.
 * MEDIUM: remoto LATAM/global ou de localização desconhecida/ambígua, ainda
 *         precisando de avaliação.
 * LOW: restrição explícita a região estrangeira, sem evidência de
 *      elegibilidade brasileira.
 *
 * A ordenação é estável: vagas de mesma prioridade mantêm a ordem original.
 * A heurística é conservadora — "remote: true" isolado ou a mera menção a
 * "Brazil"/"Brasil" na descrição não são tratados como elegibilidade.
 */
export function prioritizeJobs(jobs: Job[]): Job[] {
  return jobs
    .map((job, index) => ({ job, index, rank: priorityRank(job) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.job);
}

/** Calcula a prioridade de uma vaga considerando localização e modalidade. */
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
