/** Plataformas de vagas baseadas em quadro (board) público de uma empresa. */
export type BoardProvider = "greenhouse" | "lever" | "ashby";

/** Fonte de vagas de uma empresa em uma plataforma baseada em quadro. */
export interface BoardJobSource {
  provider: BoardProvider;
  identifier: string;
}

/** Parâmetros de uma busca por termo no LinkedIn Jobs. */
export interface LinkedInJobSource {
  provider: "linkedin";
  searchTerm: string;
  location?: string;
  isRemote?: boolean;
  resultsWanted?: number;
}

/** Fonte de vagas suportada pelo pipeline. */
export type JobSource = BoardJobSource | LinkedInJobSource;

/** Fontes validadas para o MVP 1.0, mais as buscas do LinkedIn (v2.0). */
export const JOB_SOURCES: readonly JobSource[] = [
  { provider: "greenhouse", identifier: "stripe" },
  { provider: "lever", identifier: "Flex" },
  { provider: "ashby", identifier: "Ashby" },
  // LinkedIn: desenvolvimento (júnior e estágio) presencial/híbrido em Maceió/AL.
  // Sem `isRemote`: o ts-jobspy só filtra quando `isRemote` é true, então a
  // localização restringe a busca — a triagem fica com os filtros existentes.
  {
    provider: "linkedin",
    searchTerm: "desenvolvedor",
    location: "Maceió, Alagoas, Brasil",
    resultsWanted: 10,
  },
  // LinkedIn: desenvolvimento júnior remoto disponível para o Brasil.
  {
    provider: "linkedin",
    searchTerm: "desenvolvedor júnior",
    location: "Brasil",
    isRemote: true,
    resultsWanted: 10,
  },
];
