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
  geoId?: string;
  isRemote?: boolean;
  resultsWanted?: number;
}

/** Fonte de vagas suportada pelo pipeline. */
export type JobSource = BoardJobSource | LinkedInJobSource;

/**
 * Fontes validadas para o MVP 1.0 (quadros públicos de empresa).
 *
 * As buscas do LinkedIn (v2.0) não são estáticas: ficam em `linkedin-searches.ts`
 * e são selecionadas por lote em `services/linkedin-search-rotation.ts`.
 */
export const BOARD_JOB_SOURCES: readonly BoardJobSource[] = [
  { provider: "greenhouse", identifier: "stripe" },
  { provider: "lever", identifier: "Flex" },
  { provider: "ashby", identifier: "Ashby" },
];
