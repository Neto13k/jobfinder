
import type { Job } from "../types/job.js";

export type JobLocation = "allowed" | "blocked" | "unknown";

// Identifica modalidade remota.
const REMOTE = /\b(remote|remoto|home\s?office|teletrabalho)\b/;

// Cidade aceita para vagas presenciais e híbridas.
const TARGET_CITY = /\bmaceio\b/;

// Regiões que incluem explicitamente o Brasil.
const ELIGIBLE_REGION =
  /\b(brazil|brasil|latam|latin america|america latina|worldwide|global|anywhere)\b/;

// Restrição explícita a residentes de outros países.
const FOREIGN_RESTRICTION =
  /\b(?:us|usa|united states|canada|uk|united kingdom)\s+(?:residents?|citizens?)\s+only\b|\b(?:us|usa|united states|canada|uk|united kingdom)\s+only\b|\b(?:must be |required to be )?(?:based|located) in (?:the )?(?:us|usa|united states|canada|uk|united kingdom)\b/;

// Localidades claramente fora da área presencial aceita.
const FOREIGN_LOCATION =
  /\b(us|usa|united states|canada|uk|united kingdom|europe|emea|apac|london|londres|india|germany|ireland)\b/;

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
 * Classifica a localização de uma vaga.
 *
 * allowed: elegibilidade geográfica claramente compatível.
 * blocked: incompatibilidade geográfica explícita.
 * unknown: informação insuficiente ou ambígua.
 */
export function classifyJobLocation(job: Job): JobLocation {
  const location = normalize(job.location ?? "");

  if (!location) {
    return "unknown";
  }

  // Restrições explícitas de residência têm prioridade.
  if (FOREIGN_RESTRICTION.test(location)) {
    // Se houver regiões compatíveis e incompatíveis,
    // preservar para análise posterior.
    if (ELIGIBLE_REGION.test(location)) {
      return "unknown";
    }

    return "blocked";
  }

  // Vagas em Maceió são aceitas.
  if (TARGET_CITY.test(location)) {
    return "allowed";
  }

  // Vagas remotas.
  if (REMOTE.test(location)) {
    if (ELIGIBLE_REGION.test(location)) {
      return "allowed";
    }

    if (FOREIGN_LOCATION.test(location)) {
      return "blocked";
    }

    return "unknown";
  }

  // Localização brasileira sem modalidade definida.
  if (ELIGIBLE_REGION.test(location)) {
    return "unknown";
  }

  // Presencial em outra região explicitamente identificada.
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
  return jobs.filter(
    (job) => classifyJobLocation(job) !== "blocked",
  );
}
