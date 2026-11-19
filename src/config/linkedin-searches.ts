import type { LinkedInJobSource } from "./job-sources.js";

/** Limite de vagas por pesquisa, igual em todas as 110 configurações. */
export const LINKEDIN_RESULTS_WANTED = 10;

/** Localização e `geoId` das pesquisas de Maceió/AL (presencial, híbrido e remoto). */
const LOCAL_LOCATION = "Maceio, Alagoas, Brazil";
const LOCAL_GEO_ID = "102957102";

/** Localização das pesquisas remotas disponíveis para candidatos no Brasil. */
const REMOTE_LOCATION = "Brazil";

/**
 * 22 termos locais de Maceió/AL.
 *
 * Sem `isRemote` para cobrir presencial, híbrido e remoto; o `geoId` fixa a
 * busca na cidade. Evitam-se termos genéricos (nada de "desenvolvedor" puro).
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
  "desenvolvedor javascript júnior",
  "desenvolvedor typescript júnior",
  "desenvolvedor web júnior",
  "junior software engineer",
  "junior full stack developer",
  "junior frontend developer",
  "junior backend developer",
  "estágio desenvolvimento de software",
  "estágio em programação",
  "estágio front-end",
  "estágio back-end",
  "desenvolvedor de software",
  "estágio em tecnologia",
] as const;

/**
 * 88 termos remotos nacionais: variações em português e inglês de júnior e
 * estágio (desenvolvedor, full stack, front-end, back-end, React, Node.js,
 * JavaScript, TypeScript e web) e também termos de cargo sem senioridade
 * explícita (ex.: "software engineer", "react developer"), que dependem da
 * triagem de senioridade posterior. Sem duplicatas.
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
  "full stack developer júnior",
  "fullstack developer júnior",
  "desenvolvedor front-end júnior",
  "desenvolvedor frontend júnior",
  "desenvolvedor front end júnior",
  "desenvolvedor react júnior",
  "desenvolvedor react.js júnior",
  "desenvolvedor reactjs júnior",
  "desenvolvedor back-end júnior",
  "desenvolvedor backend júnior",
  "desenvolvedor back end júnior",
  "desenvolvedor node.js júnior",
  "desenvolvedor nodejs júnior",
  "desenvolvedor node júnior",
  "desenvolvedor javascript júnior",
  "desenvolvedor typescript júnior",
  "desenvolvedor web júnior",
  "desenvolvedor web full stack júnior",
  "desenvolvedor de software júnior",
  "desenvolvedor de sistemas júnior",
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
  "software developer intern",
  "software engineering intern",
  "software engineering internship",
  "software engineer intern",
  "developer intern",
  "web developer intern",
  "frontend developer intern",
  "backend developer intern",
  "full stack developer intern",
  "react developer intern",
  "node.js developer intern",
  "programming intern",
  "intern software developer",
  "junior developer internship",
  "developer internship",
  "software development intern",
  "estágio em desenvolvimento de software",
  "estágio em programação",
  "estágio desenvolvimento web",
  "estágio front-end",
  "estágio back-end",
  "software engineer",
  "react developer",
  "node.js developer",
  "javascript developer",
  "typescript developer",
  "full stack developer",
  "frontend developer",
  "backend developer",
] as const;

/** 22 pesquisas locais de Maceió/AL fixadas por `geoId`. */
export const LINKEDIN_LOCAL_SEARCHES: readonly LinkedInJobSource[] =
  LOCAL_TERMS.map(
    (searchTerm): LinkedInJobSource => ({
      provider: "linkedin",
      searchTerm,
      location: LOCAL_LOCATION,
      geoId: LOCAL_GEO_ID,
      resultsWanted: LINKEDIN_RESULTS_WANTED,
    }),
  );

/** 88 pesquisas remotas disponíveis para candidatos no Brasil. */
export const LINKEDIN_REMOTE_SEARCHES: readonly LinkedInJobSource[] =
  REMOTE_TERMS.map(
    (searchTerm): LinkedInJobSource => ({
      provider: "linkedin",
      searchTerm,
      location: REMOTE_LOCATION,
      isRemote: true,
      resultsWanted: LINKEDIN_RESULTS_WANTED,
    }),
  );
