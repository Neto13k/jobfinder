import type { Job } from "../types/job.js";

// Termos de senioridade alta. A regex é compilada uma única vez, no módulo.
// Como o título é normalizado (sem acento), "sênior" chega aqui como "senior".
const SENIORITY_PATTERN =
  /\b(senior|sr|pleno|mid[\s-]?level|staff|principal|lead)\b/;

/** Remove acentos e força minúsculas, para comparar sem depender da escrita. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Remove vagas com senioridade alta no título.
 *
 * Mantém vagas junior, de estágio, trainee e sem senioridade informada. A
 * correspondência é por palavra inteira, então "leadership" não é excluída.
 */
export function filterBySeniority(jobs: Job[]): Job[] {
  return jobs.filter((job) => !SENIORITY_PATTERN.test(normalize(job.title)));
}
