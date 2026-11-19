import type { IndeedJobSource } from "./indeed-searches.js";

/** Plataformas de vagas baseadas em quadro (board) público de uma empresa. */
export type BoardProvider = "greenhouse" | "lever" | "ashby" | "inhire";

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

  // --- InHire ---
  // Empresas de tecnologia/software/fintech/dados confirmadas via API pública
  // (GET /job-posts/public/pages com X-Tenant): resposta HTTP 200 e `tenantName`
  // coerente com o portal oficial. Empresas fora do perfil (indústria, varejo,
  // telecom, federação esportiva, agência de marketing) foram rejeitadas.
  { provider: "inhire", identifier: "celcoin" }, // Celcoin (infratech de pagamentos)
  { provider: "inhire", identifier: "cappta" }, // Cappta (fintech de pagamentos)
  { provider: "inhire", identifier: "contabilizei" }, // Contabilizei (contabilidade digital)
  { provider: "inhire", identifier: "jump" }, // Jump (tecnologia e dados)
  { provider: "inhire", identifier: "avenue" }, // Avenue (fintech/investimentos)
  { provider: "inhire", identifier: "eveo" }, // EVEO (cloud privada)
  { provider: "inhire", identifier: "v360" }, // V360 (fintech de pagamentos)
  { provider: "inhire", identifier: "programmers" }, // Programmers - AI, Data & Software
  { provider: "inhire", identifier: "bionexo" }, // Bionexo (healthtech SaaS)
  { provider: "inhire", identifier: "netrin" }, // Netrin (consultoria de tecnologia)
  { provider: "inhire", identifier: "neoway" }, // Neoway (dados/analytics)
  { provider: "inhire", identifier: "olist" }, // Olist (plataforma de e-commerce)
  { provider: "inhire", identifier: "premiersoft" }, // Premiersoft (fábrica de software)
  { provider: "inhire", identifier: "radix" }, // Radix (engenharia e tecnologia)
  { provider: "inhire", identifier: "audaces" }, // Audaces (software para moda)
  { provider: "inhire", identifier: "cielo" }, // Cielo (tecnologia de pagamentos)
  { provider: "inhire", identifier: "alelo" }, // Alelo (benefícios/pagamentos)
  { provider: "inhire", identifier: "pravaler" }, // Pravaler (fintech de crédito educacional)
  { provider: "inhire", identifier: "alice" }, // Alice (healthtech)
  { provider: "inhire", identifier: "queropassagem" }, // Quero Passagem (viagens/tecnologia)
  // Boards válidos com identidade confirmada (`tenantName` igual ao portal), mas
  // temporariamente sem vagas publicadas; mantidos por serem fontes compatíveis.
  { provider: "inhire", identifier: "fiap" }, // FIAP (educação em tecnologia)
  { provider: "inhire", identifier: "livup" }, // Liv Up (foodtech)
];
