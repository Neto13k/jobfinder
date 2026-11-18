import type { IndeedJobSource } from "./indeed-searches.js";

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
export type JobSource = BoardJobSource | LinkedInJobSource | IndeedJobSource;

/**
 * Fontes validadas para o pipeline (quadros públicos de empresa).
 *
 * Cada identificador abaixo foi confirmado contra o endpoint público do
 * respectivo provider (resposta HTTP 200 com corpo válido), e o nome da empresa
 * do quadro foi conferido no metadado/portal oficial antes de ser adicionado.
 * Boards que responderam erro HTTP, que apontavam para empresa sem evidência de
 * contratação no Brasil ou cuja identidade não pôde ser confirmada ficaram de
 * fora. As buscas do LinkedIn (v2.0) não são estáticas: ficam em
 * `linkedin-searches.ts` e são selecionadas por lote em
 * `services/linkedin-search-rotation.ts`.
 *
 * Cobertura: empresas brasileiras de tecnologia/fintech/software e empresas
 * internacionais que contratam profissionais residentes no Brasil.
 */
export const BOARD_JOB_SOURCES: readonly BoardJobSource[] = [
  // --- Lever ---
  { provider: "lever", identifier: "Flex" }, // existente (Flex)
  { provider: "lever", identifier: "ciandt" }, // CI&T
  { provider: "lever", identifier: "bluelightconsulting" }, // Bluelight Consulting
  { provider: "lever", identifier: "oowlish" }, // Oowlish Technology

  // --- Ashby ---
  { provider: "ashby", identifier: "Ashby" }, // existente (Ashby)
  { provider: "ashby", identifier: "nubank" }, // Nubank
  { provider: "ashby", identifier: "articul8" }, // Articul8 (vaga afirmativa Brasil)
  { provider: "ashby", identifier: "trm-labs" }, // TRM Labs
  { provider: "ashby", identifier: "alternativepayments" }, // Alternative Payments (remoto Brasil)
  { provider: "ashby", identifier: "canals" }, // Canals (Brasil/Colômbia/Argentina, inclui júnior)
  { provider: "ashby", identifier: "truelogic" }, // Truelogic (LATAM remoto)
  { provider: "ashby", identifier: "river" }, // River (Americas remoto)
  { provider: "ashby", identifier: "deel" }, // Deel (vazio no momento; válido)

  // --- Greenhouse ---
  { provider: "greenhouse", identifier: "ifoodcarreiras" }, // iFood
  { provider: "greenhouse", identifier: "xpinc" }, // XP Inc.
  { provider: "greenhouse", identifier: "inter" }, // Inter Carreiras
  { provider: "greenhouse", identifier: "c6bank" }, // C6 Bank
  { provider: "greenhouse", identifier: "stone" }, // Stone
  { provider: "greenhouse", identifier: "agibank" }, // Agibank
  { provider: "greenhouse", identifier: "clara" }, // Clara
  { provider: "greenhouse", identifier: "ebanx" }, // EBANX
  { provider: "greenhouse", identifier: "vtex" }, // VTEX
  { provider: "greenhouse", identifier: "quintoandar" }, // Grupo QuintoAndar
  { provider: "greenhouse", identifier: "jusbrasil" }, // Jusbrasil
  { provider: "greenhouse", identifier: "gympass" }, // Wellhub (ex-Gympass)
  { provider: "greenhouse", identifier: "bees" }, // BEES
  { provider: "greenhouse", identifier: "ilia" }, // ília
  { provider: "greenhouse", identifier: "wildlifestudios" }, // Wildlife Studios
  { provider: "greenhouse", identifier: "rdstation" }, // RD Station
  { provider: "greenhouse", identifier: "cortex" }, // Cortex
  { provider: "greenhouse", identifier: "pagarme" }, // Pagar.me (vazio no momento; válido)
  { provider: "greenhouse", identifier: "toradex" }, // Toradex
  { provider: "greenhouse", identifier: "encora10" }, // Encora
  { provider: "greenhouse", identifier: "sezzle" }, // Sezzle
  { provider: "greenhouse", identifier: "exadelinc" }, // Exadel
  { provider: "greenhouse", identifier: "appnovation" }, // Appnovation Technologies
  { provider: "greenhouse", identifier: "capco" }, // Capco
];
