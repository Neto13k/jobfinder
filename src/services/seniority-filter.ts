import { stripHtml } from "./text-normalize.js";
import type { Job } from "../types/job.js";

// Termos de senioridade ACIMA de júnior. A regex é compilada uma única vez, no
// módulo. Como o título é normalizado (sem acento), "sênior" chega como
// "senior". A correspondência é por palavra inteira: "leadership" e
// "especialização" não são excluídos. Inclui os termos brasileiros "gerente",
// "líder (técnico)" e "middle".
//
// Níveis romanos (II, III, IV, V, VI) indicam posições acima de júnior em
// cargos de desenvolvimento; como este filtro roda após o filtro de
// desenvolvimento, todos os títulos avaliados já são de desenvolvimento.
const SENIORITY_WORDS =
  /\b(?:senior|sr|pleno|mid[\s-]?level|middle|master|intermediate|staff|principal|lead|lider|manager|gerente|head|especialista|specialist|ii|iii|iv|v|vi)\b/;

// Abreviação "PL" (pleno) isolada, sem confundir com "PL/SQL".
const PL_ABBREVIATION = /\bpl\b(?![\/\w])/;

// Sinal explícito de júnior/estágio no título: protege a vaga de menções a
// profissionais seniores na descrição.
const JUNIOR_TITLE =
  /\b(?:junior|jr|estagio|estagiari[oa]|estagi\w*|intern|internship|trainee|aprendiz|apprentice)\b/;

// Vaga que ACEITA EXPLICITAMENTE mais de um nível, incluindo júnior — ex.:
// "Júnior ou Pleno", "Jr/Pleno", "Júnior a Pleno". Como admite candidatos
// júnior, deve ser preservada mesmo citando um nível intermediário. Exige um
// conector explícito entre os níveis, para NÃO tratar "Desenvolvedor Pleno"
// (nível único) como aceitação de júnior.
const MULTILEVEL_JUNIOR_TITLE = new RegExp(
  [
    "\\b(?:junior|jr|estagio|estagiari[oa]|trainee|aprendiz)\\b\\.?\\s*" +
      "(?:\\/|,|\\bou\\b|\\be\\b|\\band\\b|\\bor\\b|\\ba\\b|\\bate\\b|\\bto\\b|[-–])\\s*" +
      "\\b(?:pleno|pl|mid[\\s-]?level|intermediate|senior|sr)\\b",
    "\\b(?:pleno|pl|mid[\\s-]?level|intermediate|senior|sr)\\b\\.?\\s*" +
      "(?:\\/|,|\\bou\\b|\\be\\b|\\band\\b|\\bor\\b|\\ba\\b|\\bate\\b|\\bto\\b|[-–])\\s*" +
      "\\b(?:junior|jr|estagio|estagiari[oa]|trainee|aprendiz)\\b",
  ].join("|"),
);

// Evidência EXPLÍCITA de senioridade na descrição, usada quando o título é
// inconclusivo. Exige enquadramento de nível/cargo ("vaga de nível sênior",
// "senior position", "Senioridade: Sênior/Pleno"), para NÃO interpretar menções
// à equipe ("trabalhará com engenheiros seniores") como senioridade da vaga.
const DESCRIPTION_SENIORITY = new RegExp(
  [
    "\\b(?:vaga|cargo|posicao|position|role|nivel|level|oportunidade|senioridade)\\b[^.;!?]{0,40}" +
      "\\b(?:senior|pleno|middle|especialista|specialist|lead|lider|principal|staff|master" +
      "|manager|gerente|head|intermediate)\\b",
    "\\b(?:senior|pleno|middle|especialista|specialist|lead|lider|principal|staff|master" +
      "|intermediate)\\s+(?:position|role|level|vaga|cargo|nivel|oportunidade)\\b",
  ].join("|"),
);

/**
 * Remove acentos e força minúsculas, para comparar sem depender da escrita.
 * Preserva espaços e pontuação (não colapsa nem remove caracteres). Marcação e
 * entidades HTML são removidas antes, sem alterar a descrição original.
 */
export function normalize(text: string): string {
  return stripHtml(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Indica se a vaga tem senioridade acima da faixa desejada.
 *
 * Decide pelo título quando conclusivo. Um título explicitamente júnior/estágio
 * é sempre preservado, mesmo que a descrição cite profissionais seniores da
 * equipe. Só quando o título é inconclusivo a descrição é consultada, aceitando
 * apenas evidência EXPLÍCITA de nível. Anos de experiência isolados não são
 * usados como bloqueio. Vagas de senioridade desconhecida ou ambígua são
 * preservadas.
 */
export function isHighSeniority(job: Job): boolean {
  const title = normalize(job.title ?? "");

  // Vaga que ACEITA explicitamente mais de um nível, incluindo júnior: não é
  // incompatível, pois admite candidatos júnior.
  if (MULTILEVEL_JUNIOR_TITLE.test(title)) {
    return false;
  }

  if (SENIORITY_WORDS.test(title) || PL_ABBREVIATION.test(title)) {
    return true;
  }

  // Júnior/estágio explícito no título: nunca descartar por menções na
  // descrição.
  if (JUNIOR_TITLE.test(title)) {
    return false;
  }

  const description = normalize(job.description ?? "");

  // Aceitação explícita de júnior na descrição: preservar.
  if (MULTILEVEL_JUNIOR_TITLE.test(description)) {
    return false;
  }

  return DESCRIPTION_SENIORITY.test(description);
}

/**
 * Motivo objetivo do descarte por senioridade (nível identificado); null quando
 * a vaga não é descartada por essa etapa.
 */
export function seniorityDiscardReason(job: Job): string | null {
  const title = normalize(job.title ?? "");

  if (MULTILEVEL_JUNIOR_TITLE.test(title) || JUNIOR_TITLE.test(title)) {
    return null;
  }

  const titleTerm =
    title.match(SENIORITY_WORDS)?.[0] ?? title.match(PL_ABBREVIATION)?.[0];
  if (titleTerm) {
    return `nível "${titleTerm}" acima da faixa desejada (título)`;
  }

  const description = normalize(job.description ?? "");
  if (MULTILEVEL_JUNIOR_TITLE.test(description)) {
    return null;
  }

  if (DESCRIPTION_SENIORITY.test(description)) {
    const descriptionTerm =
      description.match(SENIORITY_WORDS)?.[0] ?? "sênior";
    return `nível "${descriptionTerm}" acima da faixa desejada (descrição)`;
  }

  return null;
}

/**
 * Remove vagas com senioridade alta.
 *
 * Mantém vagas júnior, de estágio, trainee e sem senioridade informada. A
 * correspondência é por palavra inteira, então "leadership" não é excluída.
 */
export function filterBySeniority(jobs: Job[]): Job[] {
  return jobs.filter((job) => !isHighSeniority(job));
}
