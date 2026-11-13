import type { Job } from "../types/job.js";

/** Termos que indicam cargo de desenvolvimento de software. */
const DEVELOPER_KEYWORDS = [
  "software engineer",
  "software engineering",
  "software development",
  "developer",
  "frontend",
  "front-end",
  "backend",
  "back-end",
  "full stack",
  "fullstack",
  "web development",
  "react",
  "desenvolvedor",
  "desenvolvedora",
  "desenvolvimento de software",
  "desenvolvimento web",
  "desenvolvimento de sistemas",
  "engenheiro de software",
  "engenheira de software",
  "engenharia de software",
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
