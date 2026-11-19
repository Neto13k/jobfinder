// Testes dos filtros e da política de notificação (funções puras).
//
// Uso:   npm run build
//        node scripts/test-filters.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { filterDeveloperJobs } = await import("../dist/services/job-filter.js");
const { filterBySeniority } = await import("../dist/services/seniority-filter.js");
const { filterByLocation, classifyJobLocation } = await import(
  "../dist/services/location-filter.js"
);
const { classifyNotification } = await import(
  "../dist/services/notification-policy.js"
);
const { prioritizeJobs } = await import("../dist/services/job-priority.js");

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

test("filtro de estagiário preserva 'Estágio em Desenvolvimento de Software'", () => {
  const kept = filterDeveloperJobs([
    job({ title: "Estágio em Desenvolvimento de Software" }),
  ]);
  assert.equal(kept.length, 1);
});

test("filtro preserva desenvolvimento júnior em português e inglês", () => {
  const kept = filterDeveloperJobs([
    job({ title: "Desenvolvedor Júnior" }),
    job({ title: "Junior Software Engineer" }),
    job({ title: "Software Development Intern" }),
    job({ title: "Estágio em Desenvolvimento Web" }),
    job({ title: "Frontend Developer" }),
    job({ title: "Programador Júnior" }),
  ]);
  assert.equal(kept.length, 6);
});

test("filtro descarta estágios de outras áreas", () => {
  const kept = filterDeveloperJobs([
    job({ title: "Estágio em Marketing" }),
    job({ title: "Estágio em Recursos Humanos" }),
    job({ title: "Estágio em Vendas" }),
    job({ title: "Estágio em Direito" }),
  ]);
  assert.equal(kept.length, 0);
});

test("filtro de senioridade exclui cargos altos e mantém júnior/estágio", () => {
  const kept = filterBySeniority([
    job({ title: "Desenvolvedor Sênior" }),
    job({ title: "Senior Software Engineer" }),
    job({ title: "Tech Lead" }),
    job({ title: "Desenvolvedor Júnior" }),
    job({ title: "Estágio em Desenvolvimento de Software" }),
  ]);
  const titles = kept.map((item) => item.title);
  assert.deepEqual(titles, [
    "Desenvolvedor Júnior",
    "Estágio em Desenvolvimento de Software",
  ]);
});

test("filtro de senioridade bloqueia especialista/specialist e preserva os demais", () => {
  const kept = filterBySeniority([
    job({ title: "Engenheiro Fullstack - Especialista" }),
    job({ title: "Software Engineer Specialist" }),
    job({ title: "Desenvolvedor Júnior" }),
    job({ title: "Estágio em Desenvolvimento de Software" }),
    job({ title: "Desenvolvedor Full Stack" }),
    job({ title: "Desenvolvedor com foco em especialização" }),
  ]);
  const titles = kept.map((item) => item.title);
  assert.deepEqual(titles, [
    "Desenvolvedor Júnior",
    "Estágio em Desenvolvimento de Software",
    "Desenvolvedor Full Stack",
    "Desenvolvedor com foco em especialização",
  ]);
});

test("filtro de localização bloqueia restrição estrangeira explícita", () => {
  assert.equal(
    classifyJobLocation(job({ location: "US residents only" })),
    "blocked",
  );
  const kept = filterByLocation([
    job({ location: "US residents only" }),
    job({ location: "Remoto - Brasil" }),
    job({ location: "" }),
  ]);
  assert.equal(kept.length, 2);
});

test("triagem geográfica: remoto elegível no Brasil é permitido", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Brazil",
        remote: true,
        description: "Vaga 100% remota, aberta a residentes no Brasil.",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: remoto restrito aos EUA é bloqueado", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Remote Junior Developer",
        location: "United States",
        remote: true,
        description: "Aberto apenas a residentes dos Estados Unidos.",
      }),
    ),
    "blocked",
  );
});

test("triagem geográfica: presencial em São Paulo é bloqueado", () => {
  const presencial = job({
    title: "Desenvolvedor Júnior - Presencial",
    location: "São Paulo, SP, Brazil",
    remote: false,
    description: "Vaga presencial no escritório em São Paulo.",
  });

  assert.equal(classifyJobLocation(presencial), "blocked");

  const kept = filterByLocation([
    presencial,
    job({ location: "", remote: false }),
  ]);
  assert.equal(kept.length, 1, "A vaga presencial em SP deveria ser removida.");
});

test("triagem geográfica: híbrido em Maceió é permitido", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Híbrido)",
        location: "Maceió, Alagoas, Brazil",
        remote: false,
        description: "Modelo híbrido, 2 dias no escritório em Maceió.",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: modalidade não informada permanece indefinida", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: false,
        description: "Buscamos pessoa desenvolvedora para integrar o time.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: negação de trabalho remoto não confirma modalidade", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: false,
        description: "Importante: esta não é uma vaga remota.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: sinais contraditórios de modalidade ficam indefinidos", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior Remoto",
        location: "São Paulo, SP, Brazil",
        remote: true,
        description: "Na prática é uma vaga híbrida, com dias presenciais.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: preserva a classificação dos providers existentes", () => {
  // Greenhouse/Ashby usam "remote" na localização; Lever usa workplaceType.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Frontend Developer",
        location: "Remote - Brazil",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );

  // Localidade estrangeira explícita continua bloqueada.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Software Engineer",
        location: "London, United Kingdom",
        remote: false,
        description: "",
      }),
    ),
    "blocked",
  );

  // Localização ausente permanece para análise posterior com IA.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Backend Developer",
        location: "",
        remote: false,
        description: "",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: campo estruturado remote é respeitado (providers de API)", () => {
  // Greenhouse/Lever/Ashby expõem a modalidade em campo próprio; o texto do
  // anúncio pode não conter a palavra "remoto".
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: true,
        description: "Buscamos pessoa desenvolvedora para integrar o time.",
      }),
    ),
    "allowed",
  );

  // `remote: false` NÃO confirma presencial: permanece indefinido.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: false,
        description: "Buscamos pessoa desenvolvedora para integrar o time.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: contradição entre campo remoto e texto presencial fica indefinida", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: true,
        description: "Esta é uma vaga presencial no escritório.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: restrição de residência estrangeira na descrição é bloqueada", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: true,
        description: "Vaga remota, mas é necessário residir nos Estados Unidos.",
      }),
    ),
    "blocked",
  );
});

test("triagem geográfica: exigência de residência fora da área elegível não é permitida", () => {
  // Vaga remota elegível ao Brasil em tese, mas a descrição exige residência
  // em outra cidade/estado: não pode ser considerada `allowed`.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: true,
        description: "Vaga remota. É necessário residir em São Paulo.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: exigência de residência sem local identificável é incerta", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: false,
        description: "Requisito: residir na região.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: restrição de residência compatível não bloqueia", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: true,
        description: "Vaga 100% remota. É necessário residir no Brasil.",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: nome de país estrangeiro em texto descritivo não bloqueia", () => {
  // Mera menção a outros países na descrição NÃO deve bloquear a vaga.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Brazil",
        remote: true,
        description: "Atendemos clientes nos Estados Unidos e no Canadá.",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: remoto restrito à Colômbia é bloqueado", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - Colombia",
        remote: true,
        description: "",
      }),
    ),
    "blocked",
  );
});

test("triagem geográfica: remoto restrito a Portugal é bloqueado", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - Portugal",
        remote: true,
        description: "",
      }),
    ),
    "blocked",
  );
});

test("triagem geográfica: remoto restrito à União Europeia é bloqueado", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Junior Developer (Remote)",
        location: "Remote - European Union",
        remote: true,
        description: "",
      }),
    ),
    "blocked",
  );
});

test("triagem geográfica: remoto explicitamente disponível no Brasil é permitido", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - Brazil",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: remoto em cidade brasileira sem restrição é permitido", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "São Paulo, SP",
        remote: true,
        description: "Vaga 100% remota.",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: remoto LATAM e Worldwide são preservados", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - LATAM",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );

  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Worldwide",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: remoto sem informação geográfica é presumido elegível", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: exclusão explícita do Brasil é bloqueada", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote",
        remote: true,
        description: "This position is not available in Brazil.",
      }),
    ),
    "blocked",
  );
});

test("triagem geográfica: presencial em Cuiabá é bloqueado", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior - Presencial",
        location: "Cuiabá, Mato Grosso, Brazil",
        remote: false,
        description: "Vaga presencial em Cuiabá.",
      }),
    ),
    "blocked",
  );
});

test("triagem geográfica: presencial em Maceió é permitido", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior - Presencial",
        location: "Maceió, Alagoas, Brazil",
        remote: false,
        description: "Vaga presencial em Maceió.",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: modalidade contraditória permanece indefinida", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior Remoto",
        location: "Brazil",
        remote: true,
        description: "Na prática é uma vaga presencial no escritório.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: região estrangeira com elegibilidade brasileira não é bloqueada", () => {
  // A localização cita regiões estrangeiras, mas o Brasil também está elegível:
  // não deve ser bloqueada.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - US / Canada / Brazil",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );

  // Restrição que alterna entre região estrangeira e Brasil é ambígua: indefinida.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote",
        remote: true,
        description: "Exclusive for residents of the European Union or Brazil.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: El Salvador não é confundido com Salvador/BA", () => {
  // "El Salvador" (país) contém "Salvador" (cidade brasileira) como subcadeia:
  // sem elegibilidade brasileira, deve ser bloqueado.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - El Salvador",
        remote: true,
        description: "",
      }),
    ),
    "blocked",
  );

  // Salvador/BA é uma localidade brasileira: permitido.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - Salvador, Bahia",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );
});

test("triagem geográfica: exigência estrangeira com alternativa no Brasil é indefinida", () => {
  // A expressão geográfica completa admite o Brasil: não bloquear, mas também
  // não confirmar (política conservadora).
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote",
        remote: true,
        description: "Must be based in Colombia or Brazil.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: menção a clientes/empresa global não comprova elegibilidade", () => {
  // Localização estrangeira sem elegibilidade na própria localização: menções
  // genéricas na descrição não liberam a vaga.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - Colombia",
        remote: true,
        description: "Atendemos clientes brasileiros em todo o mundo.",
      }),
    ),
    "blocked",
  );

  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - Colombia",
        remote: true,
        description: "Somos uma empresa global com escritórios no Brasil.",
      }),
    ),
    "blocked",
  );
});

test("triagem geográfica: localização estrangeira com elegibilidade explícita ao Brasil fica indefinida", () => {
  // A descrição declara, de forma explícita, que aceita candidatos residentes
  // no Brasil: preservar a vaga para análise posterior (não bloquear).
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - Colombia",
        remote: true,
        description: "Vaga remota aberta a residentes no Brasil.",
      }),
    ),
    "unknown",
  );

  assert.equal(
    classifyJobLocation(
      job({
        title: "Junior Developer (Remote)",
        location: "Remote - Colombia",
        remote: true,
        description: "Open to candidates based in Brazil.",
      }),
    ),
    "unknown",
  );
});

test("triagem geográfica: elegibilidade explícita não confunde menções genéricas nem restrição estrangeira", () => {
  // Menção genérica (clientes) não é elegibilidade: permanece bloqueada.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - Colombia",
        remote: true,
        description: "Atendemos clientes brasileiros em todo o mundo.",
      }),
    ),
    "blocked",
  );

  // Restrição de residência exclusivamente estrangeira segue bloqueada.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "Remote - United States",
        remote: true,
        description: "Must be based in the United States.",
      }),
    ),
    "blocked",
  );
});

// --- TASK-01: presunção operacional de elegibilidade em vagas remotas ------
//
// Revisão do filtro geográfico: vagas remotas sem restrição geográfica
// contraditória passam a ser "allowed" (presunção operacional, NÃO uma
// confirmação de disponibilidade no Brasil). Bloqueios explícitos (restrição a
// residentes de outro país, exclusão do Brasil) seguem "blocked" e os sinais
// geográficos contraditórios seguem "unknown".

test("TASK-01: remote e remoto sem país informado são presumidos elegíveis", () => {
  // Localização genérica ("Remote"/"Remoto") sem país e sem restrição: a
  // ausência de restrição geográfica presume elegibilidade operacional.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Junior Developer",
        location: "Remote",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Remoto",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );
});

test("TASK-01: localização vazia com remote=true é presumida elegível", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "",
        remote: true,
        description: "",
      }),
    ),
    "allowed",
  );
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "",
        remote: true,
        description: "Buscamos pessoa desenvolvedora para integrar o time.",
      }),
    ),
    "allowed",
  );
});

test("TASK-01: elegibilidade explícita ao Brasil libera remoto sem país informado", () => {
  // Modalidade remota confirmada e descrição declarando EXPLICITAMENTE aceitar
  // residentes no Brasil: antes ficava "unknown"; agora é "allowed".
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Remoto",
        remote: true,
        description: "Vaga 100% remota e aberta a residentes no Brasil.",
      }),
    ),
    "allowed",
  );
  assert.equal(
    classifyJobLocation(
      job({
        title: "Junior Developer",
        location: "Remote",
        remote: true,
        description: "Open to candidates based in Brazil.",
      }),
    ),
    "allowed",
  );
  assert.equal(
    classifyJobLocation(
      job({
        title: "Junior Developer",
        location: "Remote",
        remote: true,
        description: "Must reside in Brazil.",
      }),
    ),
    "allowed",
  );
});

test("TASK-01: localização vazia com remote=true e elegibilidade explícita é permitida", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "",
        remote: true,
        description: "Estamos contratando profissionais no Brasil.",
      }),
    ),
    "allowed",
  );
});

test("TASK-01: menção genérica na descrição não altera a presunção de elegibilidade", () => {
  // Clientes e escritórios no Brasil são apenas menções genéricas: não mudam o
  // resultado de uma vaga remota sem restrição geográfica (segue presumida).
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Remoto",
        remote: true,
        description: "Atendemos clientes em todo o Brasil.",
      }),
    ),
    "allowed",
  );
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Remote",
        remote: true,
        description: "Somos uma empresa global com escritório no Brasil.",
      }),
    ),
    "allowed",
  );
});

test("TASK-01: procedência da fonte não altera a presunção de elegibilidade", () => {
  // A procedência da fonte (InHire, ATS brasileiro) é irrelevante para a
  // classificação: uma vaga remota sem restrição geográfica é presumida
  // elegível, com ou sem evidência explícita na descrição.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Remoto",
        remote: true,
        description: "Faça parte do nosso time de tecnologia.",
        source: "inhire",
      }),
    ),
    "allowed",
  );
  // Com evidência explícita, a mesma procedência continua permitida.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Remoto",
        remote: true,
        description: "Vaga remota aberta a residentes no Brasil.",
        source: "inhire",
      }),
    ),
    "allowed",
  );
});

test("TASK-01: vaga remota de fonte internacional é presumida elegível salvo bloqueio explícito", () => {
  // Fonte internacional com localização brasileira explícita: permitida.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Junior Developer",
        location: "Remote - Brazil",
        remote: true,
        description: "",
        source: "linkedin",
      }),
    ),
    "allowed",
  );
  // Fonte internacional sem país informado e sem restrição: presumida elegível.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Junior Developer",
        location: "Remote",
        remote: true,
        description: "",
        source: "linkedin",
      }),
    ),
    "allowed",
  );
  // Fonte internacional com restrição estrangeira explícita: bloqueada.
  assert.equal(
    classifyJobLocation(
      job({
        title: "Junior Developer",
        location: "Remote - United States",
        remote: true,
        description: "US residents only.",
        source: "linkedin",
      }),
    ),
    "blocked",
  );
});

test("TASK-01: restrição contraditória entre país estrangeiro e Brasil fica indefinida", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior",
        location: "Remoto",
        remote: true,
        description: "Vaga remota restrita a residentes de Portugal ou do Brasil.",
      }),
    ),
    "unknown",
  );
});

test("TASK-01: presencial e híbrido em Maceió permanecem permitidos", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior - Presencial",
        location: "Maceió, Alagoas, Brazil",
        remote: false,
        description: "Vaga presencial em Maceió.",
      }),
    ),
    "allowed",
  );
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Híbrido)",
        location: "Maceió, Alagoas, Brazil",
        remote: false,
        description: "Híbrido: 2 dias no escritório em Maceió.",
      }),
    ),
    "allowed",
  );
});

test("política de notificação classifica compatível, revisão e nulo", () => {
  assert.equal(
    classifyNotification({
      decision: "compatible",
      score: 90,
      reason: "ok",
      locationStatus: "allowed",
      contractStatus: "allowed",
    }),
    "compatible",
  );
  assert.equal(
    classifyNotification({
      decision: "review",
      score: 60,
      reason: "contratação indefinida",
      locationStatus: "allowed",
      contractStatus: "unknown",
    }),
    "manual_review",
  );
  assert.equal(
    classifyNotification({
      decision: "incompatible",
      score: 10,
      reason: "PJ",
      locationStatus: "allowed",
      contractStatus: "blocked",
    }),
    null,
  );
});

test("TASK-08: matriz de notificação (localização × contratação)", () => {
  const cases = [
    ["allowed", "allowed", "compatible", "compatible"],
    ["allowed", "allowed", "review", "manual_review"],
    ["allowed", "unknown", "review", "manual_review"],
    ["unknown", "allowed", "review", "manual_review"],
    ["unknown", "unknown", "review", "manual_review"],
    ["blocked", "allowed", "incompatible", null],
    ["allowed", "blocked", "incompatible", null],
    ["blocked", "unknown", "incompatible", null],
    ["unknown", "blocked", "incompatible", null],
  ];

  for (const [locationStatus, contractStatus, decision, expected] of cases) {
    assert.equal(
      classifyNotification({
        decision,
        score: 50,
        reason: "teste",
        locationStatus,
        contractStatus,
      }),
      expected,
      `${locationStatus} × ${contractStatus} (${decision}) deveria ser ${expected}`,
    );
  }
});

test("TASK-08: vaga rejeitada pela IA nunca é notificada mesmo com critérios permitidos", () => {
  // Incompatibilidade por senioridade/tecnologia: localização e contratação
  // permitidas, mas a decisão é "incompatible".
  assert.equal(
    classifyNotification({
      decision: "incompatible",
      score: 15,
      reason: "requer senioridade sênior",
      locationStatus: "allowed",
      contractStatus: "allowed",
    }),
    null,
  );
});

test("TASK-08: informação indefinida nunca vira compatível", () => {
  for (const [locationStatus, contractStatus] of [
    ["allowed", "unknown"],
    ["unknown", "allowed"],
    ["unknown", "unknown"],
  ]) {
    assert.equal(
      classifyNotification({
        decision: "review",
        score: 70,
        reason: "informação indefinida",
        locationStatus,
        contractStatus,
      }),
      "manual_review",
    );
  }
});

test("TASK-08b: decisão review permanece manual_review mesmo com ambos os critérios allowed", () => {
  assert.equal(
    classifyNotification({
      decision: "review",
      score: 85,
      reason: "requisitos a confirmar",
      locationStatus: "allowed",
      contractStatus: "allowed",
    }),
    "manual_review",
  );
});

test("TASK-08b: compatible exige decisão compatible e ambos os critérios allowed", () => {
  // Só a combinação exata (compatible + allowed + allowed) confirma a vaga.
  assert.equal(
    classifyNotification({
      decision: "compatible",
      score: 90,
      reason: "ok",
      locationStatus: "allowed",
      contractStatus: "allowed",
    }),
    "compatible",
  );
  assert.equal(
    classifyNotification({
      decision: "review",
      score: 90,
      reason: "ok",
      locationStatus: "allowed",
      contractStatus: "allowed",
    }),
    "manual_review",
  );
});

// --- Calibragem 4.0: priorização temporal ---------------------------------

// Data de referência fixa para testes determinísticos.
const REFERENCE = new Date("2026-11-18T12:00:00.000Z");

/** ISO de N horas antes da data de referência. */
function hoursBefore(hours) {
  return new Date(REFERENCE.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/** ISO de N dias antes da data de referência. */
function daysBefore(days) {
  return hoursBefore(days * 24);
}

/** Ids na ordem retornada. */
function ids(jobs) {
  return jobs.map((item) => item.id);
}

test("priorização temporal: vagas recentes passam à frente das antigas", () => {
  const result = prioritizeJobs(
    [
      job({ id: "antiga", publishedAt: daysBefore(30) }),
      job({ id: "recente", publishedAt: hoursBefore(1) }),
      job({ id: "media", publishedAt: daysBefore(2) }),
    ],
    REFERENCE,
  );
  assert.deepEqual(ids(result), ["recente", "media", "antiga"]);
});

test("priorização temporal: recência prevalece sobre elegibilidade geográfica", () => {
  // Localização indefinida (MEDIUM) mas recém-publicada supera uma vaga
  // elegível (HIGH) muito antiga.
  const result = prioritizeJobs(
    [
      job({
        id: "elegivel-antiga",
        location: "Remoto - Brasil",
        publishedAt: daysBefore(30),
      }),
      job({
        id: "indefinida-recente",
        location: "",
        remote: true,
        publishedAt: hoursBefore(1),
      }),
    ],
    REFERENCE,
  );
  assert.deepEqual(ids(result), ["indefinida-recente", "elegivel-antiga"]);
});

test("priorização temporal: prioridade geográfica é preservada na mesma faixa", () => {
  // Todas na faixa ≤24h: a ordem geográfica decide primeiro e, dentro de cada
  // prioridade, a vaga mais recente vem antes.
  const result = prioritizeJobs(
    [
      job({ id: "latam-1h", location: "Remote - LATAM", publishedAt: hoursBefore(1) }),
      job({ id: "elegivel-20h", location: "Remoto - Brasil", publishedAt: hoursBefore(20) }),
      job({ id: "elegivel-2h", location: "Remoto - Brasil", publishedAt: hoursBefore(2) }),
      job({ id: "restrita-3h", location: "US residents only", publishedAt: hoursBefore(3) }),
    ],
    REFERENCE,
  );
  assert.deepEqual(ids(result), [
    "elegivel-2h",
    "elegivel-20h",
    "latam-1h",
    "restrita-3h",
  ]);
});

test("priorização temporal: limites das categorias temporais", () => {
  const result = prioritizeJobs(
    [
      job({ id: "d15", publishedAt: daysBefore(15) }),
      job({ id: "h23", publishedAt: hoursBefore(23) }),
      job({ id: "d8", publishedAt: daysBefore(8) }),
      job({ id: "h25", publishedAt: hoursBefore(25) }),
      job({ id: "d13", publishedAt: daysBefore(13) }),
      job({ id: "h71", publishedAt: hoursBefore(71) }),
      job({ id: "d6", publishedAt: daysBefore(6) }),
      job({ id: "h73", publishedAt: hoursBefore(73) }),
    ],
    REFERENCE,
  );
  assert.deepEqual(ids(result), [
    "h23", // ≤24h
    "h25", // >24h ≤72h (mais recente primeiro)
    "h71", // >24h ≤72h
    "h73", // >72h ≤7d (mais recente primeiro)
    "d6", // >72h ≤7d
    "d8", // >7d ≤14d (mais recente primeiro)
    "d13", // >7d ≤14d
    "d15", // >14d
  ]);
});

test("priorização temporal: datas ausentes, inválidas e futuras não são recentes", () => {
  const future = new Date(REFERENCE.getTime() + 60 * 60 * 1000).toISOString();
  const result = prioritizeJobs(
    [
      job({ id: "sem-data", publishedAt: undefined }),
      job({ id: "invalida", publishedAt: "data-invalida" }),
      job({ id: "futura", publishedAt: future }),
      job({ id: "recente", publishedAt: hoursBefore(1) }),
    ],
    REFERENCE,
  );
  // Apenas a vaga recém-publicada é tratada como recente; as demais caem na
  // categoria de recência desconhecida, preservadas na ordem original.
  assert.deepEqual(ids(result), ["recente", "sem-data", "invalida", "futura"]);
});

test("priorização temporal: preserva vagas sem data e não exclui por idade", () => {
  const result = prioritizeJobs(
    [
      job({ id: "muito-antiga", publishedAt: daysBefore(365) }),
      job({ id: "sem-data" }),
    ],
    REFERENCE,
  );
  assert.equal(result.length, 2);
  assert.deepEqual(ids(result).sort(), ["muito-antiga", "sem-data"]);
});

test("priorização temporal: estabilidade em empates", () => {
  const same = hoursBefore(2);
  const result = prioritizeJobs(
    [
      job({ id: "a", publishedAt: same }),
      job({ id: "b", publishedAt: same }),
      job({ id: "c" }),
      job({ id: "d" }),
    ],
    REFERENCE,
  );
  // Empate temporal e geográfico mantém a ordem de entrada, inclusive entre as
  // vagas sem data.
  assert.deepEqual(ids(result), ["a", "b", "c", "d"]);
});

test("priorização temporal: não muta o array nem os objetos originais", () => {
  const original = [
    job({ id: "x", publishedAt: daysBefore(30) }),
    job({ id: "y", publishedAt: hoursBefore(1) }),
  ];
  const snapshot = JSON.parse(JSON.stringify(original));

  const result = prioritizeJobs(original, REFERENCE);

  assert.notEqual(result, original); // devolve uma nova coleção
  assert.deepEqual(original, snapshot); // array de entrada intacto
  assert.equal(result.length, 2);
  // Mesmas referências, apenas reordenadas: nenhuma vaga foi clonada ou mutada.
  assert.ok(result.every((item) => original.includes(item)));
});

test("priorização temporal: funciona sem data de referência (padrão agora)", () => {
  const result = prioritizeJobs([job({ id: "a" }), job({ id: "b" })]);
  assert.equal(result.length, 2);
});
