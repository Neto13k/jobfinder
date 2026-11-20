import { normalize } from "./seniority-filter.js";
import type { Job } from "../types/job.js";

// Cargos comerciais/administrativos/corporativos INEQUÍVOCOS: excluídos mesmo
// quando o título cita desenvolvimento de software como contexto comercial
// (ex.: "Account Executive, Software Development Services"). A correspondência
// é por PALAVRA INTEIRA (não substring), para não descartar cargos legítimos
// como "Salesforce Developer".
const NON_DEVELOPER_ROLE_PHRASES = [
  // Comercial e vendas
  "account executive",
  "sales executive",
  "sales representative",
  "sales manager",
  "sales development representative",
  "account manager",
  "business development",
  "customer success",
  "sdr",
  "bdr",
  "vendedor",
  "vendedora",
  "executivo de vendas",
  "executivo de contas",
  "gerente comercial",
  "gerente de contas",
  "consultor de vendas",
  "representante comercial",
  // Administrativo
  "assistente administrativo",
  "auxiliar administrativo",
  // Recursos humanos e recrutamento
  "recrutador",
  "recruiter",
  "talent acquisition",
  // Suporte técnico e atendimento: funções de TI não-desenvolvimento,
  // descartadas mesmo quando a empresa se apresenta como "de tecnologia".
  "analista de suporte",
  "assistente de suporte",
  "tecnico de suporte",
  "suporte tecnico",
  "help desk",
  "service desk",
  "telemarketing",
  // Jurídico
  "advogado",
  "advogada",
];

// Domínios não técnicos: só excluem o título quando NÃO há termo forte de
// desenvolvimento. Assim, "Desenvolvedor de Sistemas Financeiros" (com
// "desenvolvedor") é preservado, mas "Analista Financeiro" (sem sinal de
// desenvolvimento) é descartado. A correspondência é por palavra inteira, para
// não confundir "finance" com "financeiros" nem "sales" com "Salesforce".
const NON_DEVELOPER_DOMAIN_WORDS = [
  "sales",
  "vendas",
  "comercial",
  "marketing",
  "growth",
  "social media",
  "conteudo",
  "content",
  "financeiro",
  "finance",
  "financial",
  "contabil",
  "accounting",
  "contas a pagar",
  "contas a receber",
  "tesouraria",
  "administrativo",
  "administrative",
  "back office",
  "recurso humano",
  "recursos humanos",
  "recrutamento",
  "juridico",
  "direito",
  "legal counsel",
];

// Termos que, no TÍTULO, identificam um cargo de desenvolvimento (PT e EN).
// Evitam-se linguagens de programação isoladas: uma mera menção a "React" ou
// "Python" não comprova que o cargo seja de desenvolvimento.
const DEVELOPER_KEYWORDS = [
  "software engineer",
  "software engineering",
  "software development",
  "software developer",
  "developer",
  "desenvolvedor",
  "desenvolvedora",
  "frontend",
  "front-end",
  "front end",
  "backend",
  "back-end",
  "back end",
  "full stack",
  "fullstack",
  "full-stack",
  "web development",
  "web developer",
  "desenvolvimento de software",
  "desenvolvimento web",
  "desenvolvimento de sistemas",
  "desenvolvimento de aplicativ",
  "engenheiro de software",
  "engenheira de software",
  "engenharia de software",
  "programador",
  "programadora",
  "mobile developer",
  "desenvolvedor mobile",
  "devops",
  "site reliability",
  "engenheiro de dados",
  "data engineer",
  "engenheiro de testes",
  "qa engineer",
];

// Títulos genéricos ou ambíguos: só são considerados desenvolvimento quando a
// DESCRIÇÃO comprova atividades relacionadas a software. Cobre programas de
// estágio/trainee, engenharia e análise de sistemas genéricas e vagas de
// tecnologia/produto que não nomeiam o cargo como desenvolvimento.
const AMBIGUOUS_TITLE_KEYWORDS = [
  "estagi",
  "intern",
  "internship",
  "trainee",
  "aprendiz",
  "apprentice",
  "programa",
  "program",
  "engenharia",
  "engineering",
  "engenheiro",
  "engineer",
  "analista",
  "analyst",
  "sistemas",
  "systems",
  "tecnologia",
  "technology",
  "produto",
  "product",
  "computacao",
  "computing",
  "informatica",
  "desenvolvimento",
];

// Evidência de atividades relacionadas a software na DESCRIÇÃO. Exige vínculo
// entre uma atividade (desenvolvimento, programação etc.) e um artefato de
// software, ou um papel/termo inequívoco de desenvolvimento. Uma linguagem de
// programação isolada NÃO conta como prova.
const SOFTWARE_ACTIVITY = new RegExp(
  [
    // Atividade de desenvolvimento ligada a software/sistemas/aplicações.
    "\\b(?:desenvolvimento|desenvolver|constru(?:ir|cao)|implementa(?:r|cao)" +
      "|manutencao|programacao|codificacao|arquitetura|integracao)\\b[^.;!?]{0,40}" +
      "\\b(?:software|sistemas?|aplicativ\\w*|aplicac\\w*|apis?|web|mobile" +
      "|backend|frontend|plataforma|produto digital)\\b",
    // Termos de engenharia/desenvolvimento de software (EN).
    "\\b(?:software|systems?|web|mobile)\\s+(?:development|engineering|developer)\\b",
    // Papéis explicitamente de desenvolvimento.
    "\\b(?:desenvolvedor(?:a|es|as)?|programador(?:a|es|as)?|developer|engineer)\\b",
    // Áreas de atuação de desenvolvimento.
    "\\b(?:front-?end|back-?end|full-?stack|fullstack)\\b",
    // Elementos típicos de um cargo de desenvolvimento.
    "\\b(?:apis|banco de dados|microservicos?|testes automatizados|deploy" +
      "|versionamento|metodologias ageis|scrum)\\b",
  ].join("|"),
);

// Programa de estágio/trainee/aprendizagem (título genérico e ambíguo quanto à
// área). É preservado apenas quando há uma trilha de Tecnologia/Produto REAL
// (nomeada no título ou listada como área/trilha na descrição); menções
// institucionais à tecnologia NÃO comprovam trilha técnica.
const PROGRAM_TITLE =
  /\b(?:programa|program|estagio|estagiari[oa]|internship|trainee|aprendiz|apprentice)\b/;

// Termos de Tecnologia/Produto que caracterizam uma trilha técnica.
const TECHNOLOGY_AREA =
  /\b(?:tecnologia|technology|tech|desenvolvimento|developer|software|sistemas?|produto|product|dados|data|front-?end|back-?end|full-?stack|mobile|devops|qa|engenharia de software|ti)\b/;

// Indicador de que o texto enumera ÁREAS/TRILHAS oferecidas pelo programa
// (atribuições efetivas), e não mero texto institucional.
const AREA_CUE =
  /\b(?:areas?|trilhas?|enfases?|vagas?|oportunidades?|atuacao|carreiras?|especializacoes?|cursos?|possibilidades?|ramos?|segmentos?)\b/;

// Trilha de Tecnologia/Produto REAL na descrição: uma área/trilha seguida, na
// MESMA oração, por um termo técnico. Assim, a menção institucional isolada
// ("somos uma empresa de tecnologia") não é interpretada como trilha.
const PROGRAM_TECH_TRACK = new RegExp(
  `${AREA_CUE.source}[^.;!?]{0,80}` +
    "\\b(?:tecnologia|technology|tech|desenvolvimento|developer|software" +
    "|sistemas?|produto|product|dados|data|front-?end|back-?end|full-?stack" +
    "|mobile|devops|qa|ti)\\b",
);

/** Escapa caracteres especiais de regex em um termo literal. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Retorna o primeiro termo presente no título por PALAVRA INTEIRA, ou null.
 *
 * A fronteira de palavra evita exclusões por substring (ex.: "sales" não casa
 * com "Salesforce"; "finance" não casa com "financeiros").
 */
function titleHasTerm(title: string, terms: string[]): string | null {
  for (const term of terms) {
    const pattern = new RegExp(`\\b${escapeRegExp(normalize(term))}\\b`);
    if (pattern.test(title)) {
      return term;
    }
  }

  return null;
}

/** Veredito do filtro de desenvolvimento, com o motivo objetivo do descarte. */
export interface DeveloperDecision {
  developer: boolean;
  reason: string | null;
}

/**
 * Classifica a vaga quanto a ser de desenvolvimento, expondo o motivo.
 *
 * Precedência:
 * 1. Cargo comercial/administrativo inequívoco no título → descartado.
 * 2. Termo forte de desenvolvimento no título → preservado.
 * 3. Domínio não técnico sem termo de desenvolvimento → descartado.
 * 4. Título genérico/ambíguo com evidência de software na descrição, ou
 *    programa de estágio com trilha de Tecnologia/Produto REAL → preservado.
 * 5. Demais casos → descartado.
 */
function classifyDeveloper(job: Job): DeveloperDecision {
  const title = normalize(job.title ?? "");

  const role = titleHasTerm(title, NON_DEVELOPER_ROLE_PHRASES);
  if (role) {
    return { developer: false, reason: `cargo de área não técnica (papel "${role}")` };
  }

  const isDeveloperByKeyword = DEVELOPER_KEYWORDS.some((term) =>
    title.includes(normalize(term)),
  );
  const domain = titleHasTerm(title, NON_DEVELOPER_DOMAIN_WORDS);

  if (!isDeveloperByKeyword && domain) {
    return { developer: false, reason: `cargo de área não técnica (termo "${domain}")` };
  }

  if (isDeveloperByKeyword) {
    return { developer: true, reason: null };
  }

  const ambiguous = AMBIGUOUS_TITLE_KEYWORDS.some((term) =>
    title.includes(normalize(term)),
  );

  if (ambiguous) {
    const description = normalize(job.description ?? "");

    if (SOFTWARE_ACTIVITY.test(description)) {
      return { developer: true, reason: null };
    }

    // Programa multidisciplinar: preservado apenas com trilha de
    // Tecnologia/Produto REAL — nomeada no título ou listada como área/trilha
    // na descrição. Menções institucionais à tecnologia não bastam.
    if (PROGRAM_TITLE.test(title)) {
      const titleTrack = TECHNOLOGY_AREA.test(title);
      const descriptionTrack = PROGRAM_TECH_TRACK.test(description);

      if (titleTrack || descriptionTrack) {
        return { developer: true, reason: null };
      }
    }
  }

  return { developer: false, reason: "sem evidência de atividades de desenvolvimento" };
}

/**
 * Indica se uma vaga é de desenvolvimento de software.
 *
 * Títulos comerciais/administrativos são descartados mesmo citando "software
 * development"; um mero termo de domínio (ex.: "financeiro") não descarta um
 * cargo de desenvolvimento; títulos genéricos são preservados quando a
 * descrição comprova atividades de software.
 */
export function isDeveloperJob(job: Job): boolean {
  return classifyDeveloper(job).developer;
}

/** Motivo objetivo do descarte por desenvolvimento; null quando é de desenvolvimento. */
export function developerDiscardReason(job: Job): string | null {
  return classifyDeveloper(job).reason;
}

/**
 * Filtra apenas vagas de desenvolvimento de software.
 *
 * @param jobs Lista de vagas a filtrar.
 * @returns Somente as vagas relacionadas a desenvolvimento.
 */
export function filterDeveloperJobs(jobs: Job[]): Job[] {
  return jobs.filter(isDeveloperJob);
}
