import type { Job } from "../types/job.js";

/** Termos que indicam cargo de desenvolvimento de software. */
const DEVELOPER_KEYWORDS = [
  "software engineer",
  "developer",
  "frontend",
  "front-end",
  "backend",
  "back-end",
  "full stack",
  "fullstack",
  "react",
  "desenvolvedor",
  "desenvolvedora",
  "engenheiro de software",
  "engenheira de software",
  "programador",
  "programadora",
];

/** Termos que indicam cargos fora de desenvolvimento. */
const NON_DEVELOPER_KEYWORDS = [
  "sales",
  "vendas",
  "marketing",
  "human resources",
  "recursos humanos",
  "recruiter",
  "recrutamento",
];

/**
 * Filtra apenas vagas de desenvolvimento de software pelo título.
 *
 * A exclusão tem prioridade: títulos de áreas não técnicas (ex.: vendas,
 * marketing) são descartados mesmo que citem termos de tecnologia.
 *
 * @param jobs Lista de vagas a filtrar.
 * @returns Somente as vagas relacionadas a desenvolvimento.
 */
export function filterDeveloperJobs(jobs: Job[]): Job[] {
  return jobs.filter((job) => {
    const title = job.title.toLowerCase();

    if (NON_DEVELOPER_KEYWORDS.some((term) => title.includes(term))) {
      return false;
    }

    return DEVELOPER_KEYWORDS.some((term) => title.includes(term));
  });
}
