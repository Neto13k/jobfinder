import { stripHtml } from "./text-normalize.js";
import type { Job } from "../types/job.js";

/**
 * Classificação da contratação da vaga:
 * - "allowed": vínculo compatível confirmado (CLT, estágio/aprendizagem, ou
 *   CLT/PJ como alternativas reais).
 * - "blocked": vínculo inequivocamente incompatível (exclusivamente PJ/CNPJ).
 * - "unknown": contratação não informada ou expressa apenas por termos
 *   ambíguos que não confirmam nem excluem o vínculo.
 */
export type JobContract = "allowed" | "blocked" | "unknown";

// Vínculo CLT (também aceito como alternativa real ao lado de PJ).
const CLT_PATTERN = /\bclt\b/;

// Estágio/aprendizagem: vínculo compatível. "Trainee" NÃO entra aqui: um
// programa de trainee é ambíguo quanto ao vínculo e não confirma CLT.
const INTERNSHIP_PATTERN =
  /\b(?:estagio|estagiari[oa]|estagi\w*|intern|internship|aprendiz|apprentice)\b/;

// Vínculo PJ/CNPJ (pessoa jurídica). Só bloqueia quando é a ÚNICA modalidade
// informada; termos internacionais ambíguos ("Contract", "Contractor") NÃO são
// equiparados a PJ brasileiro.
const PJ_PATTERN = /\b(?:pj|cnpj|pessoa juridica|mei|microempreendedor)\b/;

// Negação imediatamente antes de um termo (ex.: "não é PJ", "sem CLT", "not PJ").
const NEGATION_BEFORE =
  /\b(?:nao|sem|nenhum|nenhuma|nem|not|without|isnt)\b[^.;!?]{0,15}$/;

// Negação logo depois do termo (ex.: "CLT não é oferecida", "PJ unavailable").
const NEGATION_AFTER = /^[^.;!?]{0,15}\b(?:nao|not|indisponivel|unavailable)\b/;

// Contexto de CONTRATAÇÃO do candidato (não de terceiros). Um "PJ" só bloqueia
// quando aparece ligado a um destes termos.
const HIRING_CONTEXT =
  /\b(?:contrat\w*|vincul\w*|regime|modalidade|tipo|modelo|forma|remuneracao|pagamento|prestacao de servico|vaga|atuacao|atuar|sera|hire|hiring|employed|employment)\b/;

// Rede de segurança: "PJ" precedido por um TERCEIRO (cliente, parceiro,
// fornecedor) descreve o contrato do terceiro, não o do candidato — não bloqueia.
const THIRD_PARTY_BEFORE =
  /\b(?:clientes?|clients?|parceir\w*|partners?|fornecedor\w*|terceir\w*|empresas?|companies?|company|consultoria|mercado)\b[^.;!?]{0,18}$/;

/** Normaliza acentos, espaços e letras maiúsculas. */
function normalize(text: string): string {
  return stripHtml(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verifica se o texto contém o termo sem que ele esteja negado na mesma frase.
 *
 * A negação é procurada apenas na vizinhança imediata (até ~15 caracteres), para
 * não interpretar uma menção negada ("não é PJ", "sem CLT") como vínculo.
 */
function hasUnnegatedTerm(text: string, term: RegExp): boolean {
  const matcher = new RegExp(term.source, "gi");
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text)) !== null) {
    const start = match.index;
    const before = text.slice(Math.max(0, start - 20), start);
    const after = text.slice(
      start + match[0].length,
      start + match[0].length + 20,
    );

    if (NEGATION_BEFORE.test(before) || NEGATION_AFTER.test(after)) {
      continue;
    }

    return true;
  }

  return false;
}

/**
 * Indica se a DESCRIÇÃO aponta PJ como vínculo do CANDIDATO.
 *
 * Só conta quando o "PJ" aparece em contexto de contratação e não está ligado a
 * um terceiro ("clientes PJ", "parceiros PJ"), evitando bloquear a vaga por
 * menções a empresas terceirizadas.
 */
function hasHiringPj(text: string): boolean {
  const matcher = new RegExp(PJ_PATTERN.source, "gi");
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text)) !== null) {
    const start = match.index;
    const before = text.slice(Math.max(0, start - 20), start);

    if (THIRD_PARTY_BEFORE.test(before)) {
      continue;
    }

    const window = text.slice(
      Math.max(0, start - 40),
      start + match[0].length + 40,
    );

    if (HIRING_CONTEXT.test(window)) {
      return true;
    }
  }

  return false;
}

/**
 * Classifica a contratação de uma vaga.
 *
 * O campo estruturado `contractTypes` é autoritativo quando presente, mas
 * termos ambíguos (ex.: "Full-time", "Contract") NÃO decidem: nesse caso a
 * avaliação prossegue para o título e a descrição. Somente um vínculo PJ/CNPJ
 * EXCLUSIVO é bloqueado; "CLT ou PJ" (alternativas reais) é permitido.
 *
 * - CLT ou estágio/aprendizagem confirmados em qualquer origem (campo, título
 *   ou descrição) tornam a vaga compatível.
 * - PJ só bloqueia quando é o vínculo do CANDIDATO: no campo estruturado, no
 *   título ou em contexto de contratação na descrição. Menções a PJ de
 *   TERCEIROS ("clientes PJ", "parceiros PJ") NÃO bloqueiam.
 * - Contradição EXPLÍCITA entre título e campo estruturado (ex.: título de
 *   estágio/CLT com "PJ" no campo, ou título "PJ" com "CLT" no campo) resulta
 *   em indefinido.
 *
 * Negação e contradição são consideradas: menções negadas ("não é PJ",
 * "sem CLT") não contam como sinal. "Trainee" não confirma CLT. Termos como
 * "Full-time", "Contract", "Contractor", "Remote" e "Homeoffice" permanecem
 * indefinidos.
 */
export function classifyJobContract(job: Job): JobContract {
  const types = (job.contractTypes ?? [])
    .filter((value): value is string => typeof value === "string")
    .map(normalize);
  const typesText = types.join(" ; ");

  const title = normalize(job.title ?? "");
  const description = normalize(job.description ?? "");

  const structuredAllowed =
    hasUnnegatedTerm(typesText, CLT_PATTERN) ||
    hasUnnegatedTerm(typesText, INTERNSHIP_PATTERN);
  const structuredPj = hasUnnegatedTerm(typesText, PJ_PATTERN);

  const titleAllowed =
    hasUnnegatedTerm(title, CLT_PATTERN) ||
    hasUnnegatedTerm(title, INTERNSHIP_PATTERN);
  const titlePj = hasUnnegatedTerm(title, PJ_PATTERN);

  const descriptionAllowed =
    hasUnnegatedTerm(description, CLT_PATTERN) ||
    hasUnnegatedTerm(description, INTERNSHIP_PATTERN);

  // Contradição explícita entre título e campo estruturado: indefinido.
  if (
    (titleAllowed && structuredPj && !structuredAllowed) ||
    (titlePj && structuredAllowed && !structuredPj)
  ) {
    return "unknown";
  }

  // CLT/estágio confirmado em qualquer origem confiável: compatível.
  if (structuredAllowed || titleAllowed || descriptionAllowed) {
    return "allowed";
  }

  // PJ como vínculo do candidato (campo, título ou contexto): incompatível.
  if (structuredPj || titlePj || hasHiringPj(description)) {
    return "blocked";
  }

  return "unknown";
}

/**
 * Motivo objetivo do descarte por contratação; null quando a vaga não é
 * descartada por essa etapa.
 */
export function contractDiscardReason(job: Job): string | null {
  return classifyJobContract(job) === "blocked"
    ? "contratação exclusivamente PJ/CNPJ"
    : null;
}

/**
 * Remove somente vagas com contratação inequivocamente incompatível.
 * Vagas indefinidas permanecem para análise posterior com IA.
 */
export function filterByContract(jobs: Job[]): Job[] {
  return jobs.filter((job) => classifyJobContract(job) !== "blocked");
}
