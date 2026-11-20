// Testes determinísticos da reformulação da triagem (TASK-03).
//
// Uso:   npm run build
//        node scripts/test-triage-filters.mjs
//
// Cobrem, sem rede nem estado externo, os filtros de desenvolvimento,
// senioridade, localização e contratação, além da deduplicação conservadora de
// anúncios equivalentes. Todas as funções avaliadas são puras.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  filterDeveloperJobs,
  isDeveloperJob,
  developerDiscardReason,
} = await import("../dist/services/job-filter.js");
const { filterBySeniority, isHighSeniority, seniorityDiscardReason } =
  await import("../dist/services/seniority-filter.js");
const { filterByLocation, classifyJobLocation, locationDiscardReason } =
  await import("../dist/services/location-filter.js");
const { filterByContract, classifyJobContract, contractDiscardReason } =
  await import("../dist/services/contract-filter.js");
const { deduplicateJobs, groupEquivalentJobs, generateJobKey } = await import(
  "../dist/services/deduplication.js"
);

/** Monta uma vaga mínima com os campos sobrepostos. */
function job(overrides) {
  return {
    id: "1",
    title: "Desenvolvedor",
    company: "Empresa",
    location: "Remoto - Brasil",
    remote: true,
    description: "",
    url: "https://example.com",
    source: "test",
    ...overrides,
  };
}

/** Descrição substantiva (>= 80 caracteres normalizados) usada na equivalência. */
function longDescription(extra = "") {
  return (
    "Buscamos pessoa desenvolvedora para atuar no desenvolvimento de software, " +
    "construindo APIs, integrando sistemas e participando de testes automatizados. " +
    extra
  ).trim();
}

// --- 1. Filtro de desenvolvimento ------------------------------------------

test("desenvolvimento: descarta Account Executive de serviços de software", () => {
  assert.equal(
    isDeveloperJob(
      job({
        title: "Account Executive, Software Development Services",
        description: "Vendas de serviços de desenvolvimento de software.",
      }),
    ),
    false,
  );
});

test("desenvolvimento: preserva programa de estágio com atividades de desenvolvimento", () => {
  assert.equal(
    isDeveloperJob(
      job({
        title: "Programa de Estágio 2026",
        description:
          "Atividades de desenvolvimento de software, programação e testes automatizados.",
      }),
    ),
    true,
  );
});

test("desenvolvimento: preserva Geração Desafio com atividades de desenvolvimento", () => {
  assert.equal(
    isDeveloperJob(
      job({
        title: "Programa de Estágio — Geração Desafio",
        description: "Programa com atividades de desenvolvimento web e manutenção de sistemas.",
      }),
    ),
    true,
  );
});

test("desenvolvimento: preserva engenharia/análise de sistemas com evidência de software", () => {
  assert.equal(
    isDeveloperJob(
      job({
        title: "Analista de Sistemas",
        description: "Desenvolvimento de APIs e integração de sistemas.",
      }),
    ),
    true,
  );
  assert.equal(
    isDeveloperJob(
      job({
        title: "Engenheiro de Produção",
        description: "Atuação no desenvolvimento de software embarcado.",
      }),
    ),
    true,
  );
});

test("desenvolvimento: descarta cargos comerciais mesmo citando software", () => {
  assert.equal(
    isDeveloperJob(
      job({
        title: "Executivo de Vendas",
        description: "Venda de soluções de desenvolvimento de software.",
      }),
    ),
    false,
  );
  assert.equal(
    filterDeveloperJobs([
      job({ title: "Estágio em Marketing" }),
      job({ title: "Estágio em Recursos Humanos" }),
      job({ title: "Estágio em Direito" }),
    ]).length,
    0,
  );
});

test("desenvolvimento: menção isolada a linguagem não comprova cargo de desenvolvimento", () => {
  assert.equal(
    isDeveloperJob(
      job({
        title: "Analista de Suporte",
        description: "Conhecimento em React é um diferencial.",
      }),
    ),
    false,
  );
});

// --- 2. Filtro de senioridade ----------------------------------------------

test("senioridade: reconhece Master, Intermediate, Principal, Staff, Manager, Head, Lead, Pleno, PL e SR", () => {
  const titles = [
    "Desenvolvedor Master",
    "Intermediate Software Engineer",
    "Principal Engineer",
    "Staff Engineer",
    "Engineering Manager",
    "Head of Engineering",
    "Tech Lead",
    "Desenvolvedor Pleno",
    "Desenvolvedor PL",
    "Desenvolvedor SR",
  ];

  for (const title of titles) {
    assert.equal(isHighSeniority(job({ title })), true, title);
  }
});

test("senioridade: níveis II, III e superiores bloqueiam cargos de desenvolvimento", () => {
  assert.equal(isHighSeniority(job({ title: "Desenvolvedor II" })), true);
  assert.equal(isHighSeniority(job({ title: "Engenheiro de Software III" })), true);
  assert.equal(isHighSeniority(job({ title: "Desenvolvedor IV" })), true);
});

test("senioridade: numeração isolada não é interpretada como senioridade", () => {
  assert.equal(isHighSeniority(job({ title: "Desenvolvedor 2026" })), false);
  assert.equal(isHighSeniority(job({ title: "Estágio em Desenvolvimento 2026" })), false);
});

test("senioridade: júnior com descrição citando profissionais seniores é preservado", () => {
  assert.equal(
    isHighSeniority(
      job({
        title: "Desenvolvedor Júnior",
        description: "Você trabalhará com engenheiros seniores experientes.",
      }),
    ),
    false,
  );
});

test("senioridade: descrição inconclusiva com nível explícito é bloqueada", () => {
  assert.equal(
    isHighSeniority(
      job({
        title: "Desenvolvedor Backend",
        description: "Vaga de nível sênior para o nosso time.",
      }),
    ),
    true,
  );
});

test("senioridade: senioridade desconhecida é preservada", () => {
  assert.equal(
    isHighSeniority(
      job({ title: "Desenvolvedor Backend", description: "Construa APIs REST." }),
    ),
    false,
  );
  assert.equal(
    filterBySeniority([
      job({ title: "Desenvolvedor Júnior" }),
      job({ title: "Desenvolvedor Backend" }),
    ]).length,
    2,
  );
});

// --- 3. Filtro de localização ----------------------------------------------

test("localização: Turquia e Índia são reconhecidas como restrição estrangeira", () => {
  assert.equal(
    classifyJobLocation(job({ location: "Remote - Turkey", description: "" })),
    "blocked",
  );
  assert.equal(
    classifyJobLocation(job({ location: "Remote - India", description: "" })),
    "blocked",
  );
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Presencial",
        location: "Istanbul, Turkey",
        remote: false,
        description: "Vaga presencial em Istambul.",
      }),
    ),
    "blocked",
  );
});

test("localização: workplaceType estruturado é considerado", () => {
  // workplaceType remoto e sem restrição geográfica: elegível.
  assert.equal(
    classifyJobLocation(
      job({ workplaceType: "remote", remote: false, location: "", description: "" }),
    ),
    "allowed",
  );
  // workplaceType presencial fora de Maceió: bloqueado.
  assert.equal(
    classifyJobLocation(
      job({
        workplaceType: "onsite",
        remote: false,
        location: "Recife, Pernambuco",
        description: "",
      }),
    ),
    "blocked",
  );
  // workplaceType híbrido em Maceió: permitido.
  assert.equal(
    classifyJobLocation(
      job({
        workplaceType: "hybrid",
        remote: false,
        location: "Maceió, Alagoas",
        description: "",
      }),
    ),
    "allowed",
  );
});

test("localização: additionalLocations participam da avaliação geográfica", () => {
  assert.equal(
    classifyJobLocation(
      job({
        location: "",
        additionalLocations: ["Remote - Brazil"],
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );
});

test("localização: remote=false não é prova de presencialidade", () => {
  assert.equal(
    classifyJobLocation(job({ location: "Brazil", remote: false, description: "" })),
    "unknown",
  );
});

test("localização: contradição entre workplaceType e texto fica indefinida", () => {
  assert.equal(
    classifyJobLocation(
      job({
        workplaceType: "onsite",
        remote: false,
        location: "Remote - Brazil",
        description: "",
      }),
    ),
    "unknown",
  );
});

test("localização: menção a país estrangeiro no texto não bloqueia", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: true,
        description: "Temos clientes na Índia e na Turquia.",
      }),
    ),
    "allowed",
  );
});

// --- 4. Filtro de contratação ----------------------------------------------

test("contratação: CLT e estágio são permitidos; PJ/CNPJ exclusivo é bloqueado", () => {
  assert.equal(
    classifyJobContract(job({ contractTypes: ["CLT"] })),
    "allowed",
  );
  assert.equal(
    classifyJobContract(job({ contractTypes: ["Estágio"] })),
    "allowed",
  );
  assert.equal(classifyJobContract(job({ contractTypes: ["PJ"] })), "blocked");
  assert.equal(classifyJobContract(job({ contractTypes: ["CNPJ"] })), "blocked");
});

test("contratação: CLT ou PJ como alternativas reais é permitido", () => {
  assert.equal(
    classifyJobContract(job({ contractTypes: ["CLT", "PJ"] })),
    "allowed",
  );
});

test("contratação: não informada permanece indefinida", () => {
  assert.equal(
    classifyJobContract(job({ description: "Vaga remota com benefícios." })),
    "unknown",
  );
});

test("contratação: termos ambíguos não confirmam CLT nem equivalem a PJ", () => {
  for (const term of [
    "Full-time",
    "FullTime",
    "Remote",
    "Homeoffice",
    "Contract",
    "Contractor",
  ]) {
    assert.equal(
      classifyJobContract(job({ contractTypes: [term] })),
      "unknown",
      term,
    );
  }
});

test("contratação: CLT/PJ na descrição é distinguido de requisitos", () => {
  assert.equal(
    classifyJobContract(
      job({ description: "Contratação CLT com benefícios." }),
    ),
    "allowed",
  );
  assert.equal(
    classifyJobContract(
      job({ description: "Contratação exclusivamente PJ." }),
    ),
    "blocked",
  );
});

test("contratação: filterByContract remove apenas as bloqueadas", () => {
  const kept = filterByContract([
    job({ id: "a", contractTypes: ["CLT"] }),
    job({ id: "b", contractTypes: ["PJ"] }),
    job({ id: "c" }),
  ]);
  assert.deepEqual(
    kept.map((item) => item.id),
    ["a", "c"],
  );
});

// --- 6. Deduplicação conservadora de anúncios equivalentes -----------------

test("equivalência: anúncios equivalentes da Bluelight com IDs diferentes são agrupados", () => {
  const a = job({
    source: "linkedin",
    id: "bl-1",
    company: "Bluelight Consulting",
    title: "Desenvolvedor Full Stack",
    location: "Remote - Brazil",
    remote: true,
    url: "https://bl/1",
    description: longDescription(),
  });
  const b = job({
    source: "indeed",
    id: "bl-2",
    company: "Bluelight Consulting",
    title: "Desenvolvedor Full Stack",
    location: "Remote - Brazil",
    remote: true,
    url: "https://bl/2",
    description: longDescription(),
  });

  const { jobs: kept, groups } = groupEquivalentJobs(deduplicateJobs([a, b]));

  assert.equal(kept.length, 1);
  assert.equal(groups.length, 1);
  // Representante estável: menor chave "source:id" (indeed < linkedin).
  assert.equal(groups[0].representativeKey, "indeed:bl-2");
  assert.deepEqual(
    groups[0].members.map((member) => member.key),
    ["linkedin:bl-1"],
  );
  // URLs e localidades dos anúncios agrupados são preservadas.
  assert.equal(groups[0].members[0].url, "https://bl/1");
  assert.equal(groups[0].members[0].location, "Remote - Brazil");
});

test("equivalência: anúncios equivalentes da Bionexo com IDs diferentes são agrupados", () => {
  const a = job({
    source: "greenhouse",
    id: "bio-1",
    company: "Bionexo",
    title: "Pessoa Desenvolvedora Backend",
    location: "Remoto - Brasil",
    remote: true,
    url: "https://bio/1",
    description: longDescription(),
  });
  const b = job({
    source: "lever",
    id: "bio-2",
    company: "Bionexo",
    title: "Pessoa Desenvolvedora Backend",
    location: "Remoto - Brasil",
    remote: true,
    url: "https://bio/2",
    description: longDescription(),
  });

  const { jobs: kept, groups } = groupEquivalentJobs(deduplicateJobs([a, b]));

  assert.equal(kept.length, 1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members[0].key, "lever:bio-2");
});

test("equivalência: mesmo título e empresa com requisitos diferentes não são agrupados", () => {
  const a = job({
    source: "linkedin",
    id: "x1",
    company: "Acme",
    title: "Desenvolvedor Full Stack",
    url: "https://x/1",
    description: longDescription("Requisito: experiência com Node.js."),
  });
  const b = job({
    source: "indeed",
    id: "x2",
    company: "Acme",
    title: "Desenvolvedor Full Stack",
    url: "https://x/2",
    description: longDescription("Requisito: experiência com Java."),
  });

  const { jobs: kept, groups } = groupEquivalentJobs([a, b]);

  assert.equal(kept.length, 2);
  assert.equal(groups.length, 0);
});

test("equivalência: diferença de localização impede o agrupamento", () => {
  const a = job({
    source: "linkedin",
    id: "l1",
    company: "Acme",
    title: "Desenvolvedor Full Stack",
    location: "Remote - Brazil",
    url: "https://l/1",
    description: longDescription(),
  });
  const b = job({
    source: "indeed",
    id: "l2",
    company: "Acme",
    title: "Desenvolvedor Full Stack",
    location: "Remote - Colombia",
    url: "https://l/2",
    description: longDescription(),
  });

  const { jobs: kept, groups } = groupEquivalentJobs([a, b]);

  assert.equal(kept.length, 2);
  assert.equal(groups.length, 0);
});

test("equivalência: descrição genérica ou insuficiente não agrupa", () => {
  const a = job({
    source: "linkedin",
    id: "g1",
    company: "Acme",
    title: "Desenvolvedor",
    url: "https://g/1",
    description: "Vaga remota.",
  });
  const b = job({
    source: "indeed",
    id: "g2",
    company: "Acme",
    title: "Desenvolvedor",
    url: "https://g/2",
    description: "Vaga remota.",
  });

  const { jobs: kept, groups } = groupEquivalentJobs([a, b]);

  assert.equal(kept.length, 2);
  assert.equal(groups.length, 0);
});

test("equivalência: a deduplicação por identidade source:id é preservada", () => {
  const a = job({
    source: "linkedin",
    id: "same",
    company: "Acme",
    title: "Desenvolvedor",
    description: longDescription(),
  });
  const b = job({
    source: "linkedin",
    id: "same",
    company: "Acme",
    title: "Desenvolvedor",
    description: longDescription("Conteúdo diferente."),
  });

  const unique = deduplicateJobs([a, b]);

  assert.equal(unique.length, 1);
  assert.equal(generateJobKey(unique[0]), "linkedin:same");
});

test("equivalência: filterByLocation é preservado (não remove indefinidas)", () => {
  const kept = filterByLocation([
    job({ id: "ok", location: "Remoto - Brasil", remote: true }),
    job({ id: "blocked", location: "Remote - Turkey", remote: true }),
    job({ id: "unknown", location: "Brazil", remote: false }),
  ]);
  assert.deepEqual(
    kept.map((item) => item.id),
    ["ok", "unknown"],
  );
});

// --- TASK-03 (correções complementares): regressões específicas ------------

test("desenvolvimento: preserva Salesforce Developer (não confunde 'sales' por substring)", () => {
  assert.equal(isDeveloperJob(job({ title: "Salesforce Developer" })), true);
  assert.equal(isDeveloperJob(job({ title: "Salesforce Senior Developer" })), true);
});

test("desenvolvimento: preserva desenvolvedor de sistemas financeiros", () => {
  assert.equal(
    isDeveloperJob(job({ title: "Desenvolvedor de Sistemas Financeiros" })),
    true,
  );
  assert.equal(
    isDeveloperJob(job({ title: "Backend Developer, Financial Systems" })),
    true,
  );
});

test("desenvolvimento: continua excluindo cargos comerciais", () => {
  assert.equal(isDeveloperJob(job({ title: "Sales Manager" })), false);
  assert.equal(isDeveloperJob(job({ title: "Executivo de Vendas" })), false);
  assert.equal(isDeveloperJob(job({ title: "Analista Financeiro" })), false);
});

test("desenvolvimento: motivo do descarte é específico", () => {
  assert.match(developerDiscardReason(job({ title: "Analista de Marketing" })), /marketing/);
  assert.match(developerDiscardReason(job({ title: "Sales Manager" })), /não técnica/);
  assert.equal(developerDiscardReason(job({ title: "Desenvolvedor" })), null);
});

test("senioridade: preserva vaga que aceita explicitamente Júnior/Pleno", () => {
  assert.equal(isHighSeniority(job({ title: "Desenvolvedor Júnior ou Pleno" })), false);
  assert.equal(isHighSeniority(job({ title: "Desenvolvedor Júnior/Pleno" })), false);
  assert.equal(isHighSeniority(job({ title: "Pessoa Desenvolvedora Jr. a Pleno" })), false);
  // Aceitação explícita apenas na descrição (título inconclusivo): preservar.
  assert.equal(
    isHighSeniority(
      job({
        title: "Desenvolvedor Backend",
        description: "Vaga aberta para candidatos júnior ou pleno.",
      }),
    ),
    false,
  );
});

test("senioridade: níveis incompatíveis inequívocos continuam bloqueados", () => {
  assert.equal(isHighSeniority(job({ title: "Desenvolvedor Pleno" })), true);
  assert.equal(isHighSeniority(job({ title: "Desenvolvedor Sênior" })), true);
  assert.equal(isHighSeniority(job({ title: "Tech Lead" })), true);
  assert.match(
    seniorityDiscardReason(job({ title: "Desenvolvedor Sênior" })),
    /senior/,
  );
  assert.equal(
    seniorityDiscardReason(job({ title: "Desenvolvedor Júnior ou Pleno" })),
    null,
  );
});

test("contratação: campo ambíguo (Full-time) permite avaliar a descrição", () => {
  assert.equal(
    classifyJobContract(
      job({ contractTypes: ["Full-time"], description: "Contratação CLT." }),
    ),
    "allowed",
  );
  assert.equal(
    classifyJobContract(
      job({ contractTypes: ["Full-time"], description: "Regime PJ." }),
    ),
    "blocked",
  );
  // Sem sinal na descrição: permanece indefinido.
  assert.equal(
    classifyJobContract(job({ contractTypes: ["Full-time"] })),
    "unknown",
  );
});

test("contratação: Trainee não confirma CLT", () => {
  assert.equal(classifyJobContract(job({ contractTypes: ["Trainee"] })), "unknown");
  assert.equal(
    classifyJobContract(job({ title: "Programa Trainee", description: "" })),
    "unknown",
  );
});

test("contratação: negações e contradições são reconhecidas", () => {
  // Negação de PJ: não bloqueia; CLT confirma.
  assert.equal(
    classifyJobContract(
      job({ description: "Não é PJ. Contratação CLT com benefícios." }),
    ),
    "allowed",
  );
  // PJ afirmado com CLT negado: bloqueado.
  assert.equal(
    classifyJobContract(job({ description: "Regime PJ, sem CLT." })),
    "blocked",
  );
  // Contradição CLT + PJ como alternativas reais: permitido.
  assert.equal(
    classifyJobContract(job({ description: "Contratação CLT ou PJ." })),
    "allowed",
  );
  assert.match(
    contractDiscardReason(job({ description: "Regime PJ." })),
    /PJ/,
  );
});

test("equivalência: diferença de modalidade impede o agrupamento", () => {
  const a = job({
    source: "linkedin",
    id: "m1",
    company: "Acme",
    title: "Desenvolvedor Full Stack",
    url: "https://m/1",
    remote: true,
    description: longDescription(),
  });
  const b = job({
    source: "indeed",
    id: "m2",
    company: "Acme",
    title: "Desenvolvedor Full Stack",
    url: "https://m/2",
    remote: false,
    description: longDescription(),
  });

  const { jobs: kept, groups } = groupEquivalentJobs([a, b]);

  assert.equal(kept.length, 2);
  assert.equal(groups.length, 0);
});

test("equivalência: representante é estável independentemente da ordem de entrada", () => {
  const a = job({
    source: "linkedin",
    id: "z1",
    company: "Acme",
    title: "Desenvolvedor Full Stack",
    url: "https://z/1",
    description: longDescription(),
  });
  const b = job({
    source: "indeed",
    id: "a1",
    company: "Acme",
    title: "Desenvolvedor Full Stack",
    url: "https://z/2",
    description: longDescription(),
  });

  const direct = groupEquivalentJobs([a, b]);
  const reversed = groupEquivalentJobs([b, a]);

  // Menor chave "source:id" (indeed:a1 < linkedin:z1), em qualquer ordem.
  assert.equal(direct.groups[0].representativeKey, "indeed:a1");
  assert.equal(reversed.groups[0].representativeKey, "indeed:a1");
  assert.deepEqual(
    direct.groups[0].members.map((member) => member.key),
    reversed.groups[0].members.map((member) => member.key),
  );
});

test("equivalência: descrição longa porém repetitiva não é evidência substantiva", () => {
  const repetitive = Array.from({ length: 20 }, () => "vaga").join(" ");
  const a = job({
    source: "linkedin",
    id: "r1",
    company: "Acme",
    title: "Desenvolvedor",
    url: "https://r/1",
    description: repetitive,
  });
  const b = job({
    source: "indeed",
    id: "r2",
    company: "Acme",
    title: "Desenvolvedor",
    url: "https://r/2",
    description: repetitive,
  });

  const { jobs: kept, groups } = groupEquivalentJobs([a, b]);

  assert.equal(kept.length, 2);
  assert.equal(groups.length, 0);
});

test("auditoria: motivos específicos por etapa de descarte", () => {
  const foreign = job({
    title: "Desenvolvedor",
    location: "Remote - Turkey",
    remote: true,
    description: "",
  });
  assert.equal(classifyJobLocation(foreign), "blocked");
  assert.match(locationDiscardReason(foreign), /localiza/i);
  assert.equal(
    locationDiscardReason(job({ location: "Remoto - Brasil", remote: true })),
    null,
  );
});

// --- TASK-03 (replay real): regressões específicas -------------------------

test("HTML: entidades são decodificadas antes do filtro de senioridade (título)", () => {
  // "S&ecirc;nior" → "Sênior" → "senior": sem a decodificação a palavra falha.
  assert.equal(
    isHighSeniority(job({ title: "Desenvolvedor&nbsp;S&ecirc;nior" })),
    true,
  );
});

test("HTML: entidades são decodificadas antes do filtro de senioridade (descrição)", () => {
  assert.equal(
    isHighSeniority(
      job({
        title: "Desenvolvedor Backend",
        description: "Senioridade: S&ecirc;nior/Pleno",
      }),
    ),
    true,
  );
});

test("HTML: a descrição original é preservada após a triagem", () => {
  const original = "<p>Vaga de <strong>nível sênior</strong> &amp; desafiadora.</p>";
  const vaga = job({ title: "Desenvolvedor Backend", description: original });
  assert.equal(isHighSeniority(vaga), true);
  // A visão limpa é usada só na triagem; o texto bruto segue para auditoria/IA.
  assert.equal(vaga.description, original);
});

test("senioridade: reconhece 'Senioridade: Sênior/Pleno' na descrição", () => {
  assert.equal(
    isHighSeniority(
      job({ title: "Desenvolvedor Backend", description: "Senioridade: Sênior/Pleno" }),
    ),
    true,
  );
});

test("senioridade: Gerente, Líder Técnico e Middle são reconhecidos", () => {
  for (const title of [
    "Gerente de Desenvolvimento",
    "Líder Técnico",
    "Desenvolvedor Middle",
    "Desenvolvedor Mid-Level",
  ]) {
    assert.equal(isHighSeniority(job({ title })), true, title);
  }
});

test("desenvolvimento: preserva programa multidisciplinar com trilha de Tecnologia/Produto", () => {
  assert.equal(
    isDeveloperJob(
      job({
        title: "Programa de Estágio 2026 - Tecnologia e Produto",
        description: "",
      }),
    ),
    true,
  );
  // Programa sem trilha de Tecnologia/Produto: continua descartado.
  assert.equal(
    isDeveloperJob(
      job({
        title: "Programa de Estágio 2026",
        description: "Áreas disponíveis: Marketing, Vendas e RH.",
      }),
    ),
    false,
  );
});

test("contratação: PJ de terceiros (clientes/parceiros) não bloqueia a vaga", () => {
  assert.equal(
    classifyJobContract(
      job({ description: "Atuamos com clientes PJ e parceiros PJ em todo o Brasil." }),
    ),
    "unknown",
  );
});

test("contratação: contradição explícita entre título e campo resulta em indefinido", () => {
  // Título de estágio (compatível) × campo "PJ" (incompatível): indefinido.
  assert.equal(
    classifyJobContract(job({ title: "Programa de Estágio", contractTypes: ["PJ"] })),
    "unknown",
  );
  // Título "PJ" × campo "CLT": indefinido.
  assert.equal(
    classifyJobContract(job({ title: "Desenvolvedor PJ", contractTypes: ["CLT"] })),
    "unknown",
  );
});

test("localização: país estrangeiro no título com localização genérica não é presumido elegível", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Software Engineer - India",
        location: "Remote",
        remote: true,
        description: "",
      }),
    ),
    "blocked",
  );
  assert.equal(
    classifyJobLocation(
      job({
        title: "Backend Developer (Colombia)",
        location: "Remoto",
        remote: true,
        description: "",
      }),
    ),
    "blocked",
  );
});

test("localização: país estrangeiro no título e na localização permanece bloqueado", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Software Engineer - Turkey",
        location: "Remote - Turkey",
        remote: true,
        description: "",
      }),
    ),
    "blocked",
  );
});

test("localização: título estrangeiro com elegibilidade explícita ao Brasil fica indefinido", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Software Engineer - India",
        location: "Remote",
        remote: true,
        description: "Vaga remota aberta a residentes no Brasil.",
      }),
    ),
    "unknown",
  );
});

test("localização: 'us' isolado no título (join us) não é tratado como país", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Join us - Software Engineer",
        location: "Remote",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );
});

// --- TASK-03 (ajuste final): conflito título × localidade e atribuições -----

test("localização: conflito entre país do título e localidade adicional fica indefinido", () => {
  // Título indica país estrangeiro; localidade ADICIONAL indica o Brasil:
  // conflito → indefinido, sem presumir elegibilidade brasileira.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Software Engineer - India",
        location: "",
        additionalLocations: ["Remote - Brazil"],
        remote: true,
        description: "",
      }),
    ),
    "unknown",
  );
  // Título estrangeiro com localidade principal brasileira: mesmo conflito.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Backend Developer (Colombia)",
        location: "Remote - Brazil",
        remote: true,
        description: "",
      }),
    ),
    "unknown",
  );
});

test("desenvolvimento: descarta função de suporte mesmo com empresa 'de tecnologia'", () => {
  assert.equal(
    isDeveloperJob(
      job({
        title: "Analista de Suporte",
        description:
          "Somos uma empresa de tecnologia. Buscamos profissional para atendimento de chamados e suporte ao cliente.",
      }),
    ),
    false,
  );
  assert.equal(
    isDeveloperJob(
      job({
        title: "Estágio em Suporte Técnico",
        description: "Empresa de tecnologia com foco em atendimento.",
      }),
    ),
    false,
  );
});

test("desenvolvimento: programa multidisciplinar exige trilha tecnológica real", () => {
  // Texto institucional mencionando tecnologia NÃO comprova trilha.
  assert.equal(
    isDeveloperJob(
      job({
        title: "Programa de Estágio 2026",
        description:
          "Somos uma empresa de tecnologia. Áreas disponíveis: Marketing, Vendas e RH.",
      }),
    ),
    false,
  );
  // Trilha tecnológica listada entre as áreas: preservado.
  assert.equal(
    isDeveloperJob(
      job({
        title: "Programa de Estágio 2026",
        description: "Áreas disponíveis: Marketing, Tecnologia e Produto.",
      }),
    ),
    true,
  );
});


