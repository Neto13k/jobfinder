import type { IndeedSearchParams } from "../providers/indeed.js";

/**
 * Parâmetros de uma busca no Indeed, com a plataforma que a atende.
 *
 * Definido aqui e reutilizado pela união `JobSource` em `job-sources.ts`, para
 * manter as pesquisas do Indeed junto de sua própria configuração.
 */
export interface IndeedJobSource extends IndeedSearchParams {
  provider: "indeed";
}

/** Limite de vagas por pesquisa, igual em todas as 110 configurações. */
export const INDEED_RESULTS_WANTED = 15;

/** Localização das pesquisas de Maceió/AL (presencial, híbrido e remoto). */
const LOCAL_LOCATION = "Maceió, AL";

/** Localização das pesquisas remotas disponíveis para candidatos no Brasil. */
const REMOTE_LOCATION = "Brazil";

/**
 * 22 termos locais de Maceió/AL.
 *
 * Sem `isRemote` para cobrir presencial, híbrido e remoto. Evitam-se termos
 * genéricos e vagas de nível pleno/sênior; cobrem desenvolvimento júnior,
 * estágio e cargos de software sem senioridade explícita (ex.: "desenvolvedor
 * de software").
 */
const LOCAL_TERMS = [
  "desenvolvedor júnior",
  "desenvolvedor full stack júnior",
  "desenvolvedor fullstack júnior",
  "desenvolvedor front-end júnior",
  "desenvolvedor frontend júnior",
  "desenvolvedor back-end júnior",
  "desenvolvedor backend júnior",
  "desenvolvedor react júnior",
  "desenvolvedor node.js júnior",
  "desenvolvedor typescript júnior",
  "desenvolvedor javascript júnior",
  "desenvolvedor web júnior",
  "engenharia de software júnior",
  "estágio desenvolvimento de software",
  "estágio em programação",
  "estágio front-end",
  "estágio back-end",
  "junior software engineer",
  "junior full stack developer",
  "junior frontend developer",
  "desenvolvedor de software",
  "estágio em tecnologia",
] as const;

/**
 * 88 termos remotos nacionais: variações em português e inglês de júnior e
 * estágio (desenvolvedor, full stack, front-end, back-end, React, Node.js,
 * JavaScript, TypeScript, web e engenharia de software) e também termos de
 * cargo sem senioridade explícita (ex.: "software engineer", "react
 * developer"), que dependem da triagem de senioridade posterior. Sem
 * duplicatas.
 */
const REMOTE_TERMS = [
  "desenvolvedor júnior",
  "desenvolvedor júnior backend",
  "desenvolvedor júnior frontend",
  "desenvolvedor júnior full stack",
  "desenvolvedor júnior fullstack",
  "desenvolvedor júnior react",
  "desenvolvedor júnior node.js",
  "desenvolvedor júnior javascript",
  "desenvolvedor júnior typescript",
  "desenvolvedor júnior web",
  "desenvolvedor full stack júnior",
  "desenvolvedor fullstack júnior",
  "desenvolvedor full-stack júnior",
  "desenvolvedor front-end júnior",
  "desenvolvedor frontend júnior",
  "desenvolvedor front end júnior",
  "desenvolvedor back-end júnior",
  "desenvolvedor backend júnior",
  "desenvolvedor back end júnior",
  "desenvolvedor react júnior",
  "desenvolvedor react.js júnior",
  "desenvolvedor reactjs júnior",
  "desenvolvedor node.js júnior",
  "desenvolvedor nodejs júnior",
  "desenvolvedor node júnior",
  "desenvolvedor javascript júnior",
  "desenvolvedor typescript júnior",
  "desenvolvedor web júnior",
  "desenvolvedor web full stack júnior",
  "desenvolvedor de software júnior",
  "engenharia de software júnior",
  "engenheiro de software júnior",
  "desenvolvedor de sistemas júnior",
  "programador júnior",
  "desenvolvedor jr",
  "estágio em desenvolvimento de software",
  "estágio em programação",
  "estágio desenvolvimento web",
  "estágio front-end",
  "estágio back-end",
  "estágio full stack",
  "estágio react",
  "estágio node.js",
  "estágio typescript",
  "estágio javascript",
  "junior developer",
  "junior software engineer",
  "software engineer junior",
  "associate software engineer",
  "junior software developer",
  "software developer junior",
  "junior web developer",
  "web developer junior",
  "junior application developer",
  "junior full stack developer",
  "full stack developer junior",
  "junior fullstack developer",
  "junior frontend developer",
  "junior front-end developer",
  "frontend developer junior",
  "junior react developer",
  "react developer junior",
  "junior backend developer",
  "junior back-end developer",
  "backend developer junior",
  "junior node.js developer",
  "node.js developer junior",
  "junior javascript developer",
  "javascript developer junior",
  "junior typescript developer",
  "typescript developer junior",
  "software engineer i",
  "software developer i",
  "entry level software developer",
  "entry level developer",
  "software developer intern",
  "software engineering intern",
  "software engineering internship",
  "software engineer intern",
  "developer intern",
  "software engineer",
  "react developer",
  "node.js developer",
  "javascript developer",
  "typescript developer",
  "full stack developer",
  "frontend developer",
  "backend developer",
] as const;

/** 22 pesquisas locais de Maceió/AL, abertas a presencial, híbrido e remoto. */
export const INDEED_LOCAL_SEARCHES: readonly IndeedJobSource[] =
  LOCAL_TERMS.map(
    (searchTerm): IndeedJobSource => ({
      provider: "indeed",
      searchTerm,
      location: LOCAL_LOCATION,
      resultsWanted: INDEED_RESULTS_WANTED,
    }),
  );

/** 88 pesquisas remotas disponíveis para candidatos no Brasil. */
export const INDEED_REMOTE_SEARCHES: readonly IndeedJobSource[] =
  REMOTE_TERMS.map(
    (searchTerm): IndeedJobSource => ({
      provider: "indeed",
      searchTerm,
      location: REMOTE_LOCATION,
      isRemote: true,
      resultsWanted: INDEED_RESULTS_WANTED,
    }),
  );
