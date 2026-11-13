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
