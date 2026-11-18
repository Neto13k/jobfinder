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

test("triagem geográfica: remoto sem informação geográfica permanece indefinido", () => {
  assert.equal(
    classifyJobLocation(
      job({
        title: "Desenvolvedor Júnior (Remoto)",
        location: "",
        remote: true,
        description: "",
      }),
    ),
    "unknown",
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
