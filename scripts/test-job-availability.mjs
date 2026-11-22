// Testes determinísticos da verificação de disponibilidade (job-availability).
//
// Uso:   npm run build
//        node scripts/test-job-availability.mjs
//
// Sem rede: a consulta ao catálogo é injetada como dependência. Valida a
// configuração (opt-in), a classificação conservadora (open/closed/unknown), o
// agrupamento por board (uma consulta por board), a preservação em falha e o
// comportamento por fonte.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  resolveAvailabilityConfig,
  supportsAvailability,
  evaluateJobAvailability,
} = await import("../dist/services/job-availability.js");

/** Monta uma vaga mínima. */
function job(overrides) {
  return {
    id: "1",
    title: "Desenvolvedor",
    company: "acme",
    location: "Remoto - Brasil",
    remote: true,
    description: "",
    url: "https://example.com",
    source: "greenhouse",
    ...overrides,
  };
}

test("configuração: desabilitada por padrão", () => {
  const config = resolveAvailabilityConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.timeoutMs, 10_000);
  assert.equal(config.concurrency, 3);
});

test("configuração: habilitada explicitamente e limites válidos", () => {
  const config = resolveAvailabilityConfig({
    JOBFINDER_VERIFY_OPEN_JOBS: "true",
    JOBFINDER_VERIFY_OPEN_JOBS_TIMEOUT_MS: "5000",
    JOBFINDER_VERIFY_OPEN_JOBS_CONCURRENCY: "2",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.concurrency, 2);
});

test("configuração: valores inválidos usam o padrão seguro", () => {
  const config = resolveAvailabilityConfig({
    JOBFINDER_VERIFY_OPEN_JOBS: "talvez",
    JOBFINDER_VERIFY_OPEN_JOBS_TIMEOUT_MS: "-1",
    JOBFINDER_VERIFY_OPEN_JOBS_CONCURRENCY: "0",
  });
  assert.equal(config.enabled, false);
  assert.equal(config.timeoutMs, 10_000);
  assert.equal(config.concurrency, 3);
});

test("suporta apenas Greenhouse e Lever", () => {
  assert.equal(supportsAvailability("greenhouse"), true);
  assert.equal(supportsAvailability("lever"), true);
  assert.equal(supportsAvailability("ashby"), false);
  assert.equal(supportsAvailability("inhire"), false);
  assert.equal(supportsAvailability("linkedin"), false);
});

test("vaga presente no catálogo é 'open'; ausente é 'closed'", async () => {
  const open = job({ id: "10", source: "greenhouse", company: "acme" });
  const closed = job({ id: "99", source: "greenhouse", company: "acme" });

  const result = await evaluateJobAvailability([open, closed], {
    fetchBoardIds: async () => new Set(["10", "11"]),
  });

  assert.equal(result.get(open), "open");
  assert.equal(result.get(closed), "closed");
});

test("fonte sem catálogo confiável é 'unknown' e não consulta", async () => {
  let consulted = 0;
  const ashby = job({ source: "ashby", company: "x" });

  const result = await evaluateJobAvailability([ashby], {
    fetchBoardIds: async () => {
      consulted++;
      return new Set();
    },
  });

  assert.equal(result.get(ashby), "unknown");
  assert.equal(consulted, 0);
});

test("falha na consulta (null) preserva como 'unknown'", async () => {
  const j = job({ source: "lever", company: "acme", id: "abc" });

  const result = await evaluateJobAvailability([j], {
    fetchBoardIds: async () => null,
  });

  assert.equal(result.get(j), "unknown");
});

test("consulta cada board uma única vez (agrupamento)", async () => {
  const calls = [];
  const a1 = job({ id: "1", source: "greenhouse", company: "acme" });
  const a2 = job({ id: "2", source: "greenhouse", company: "acme" });
  const b1 = job({ id: "3", source: "lever", company: "beta" });

  const result = await evaluateJobAvailability([a1, a2, b1], {
    fetchBoardIds: async (source, board) => {
      calls.push(`${source}:${board}`);
      return new Set(["1", "2", "3"]);
    },
  });

  assert.deepEqual(calls.sort(), ["greenhouse:acme", "lever:beta"]);
  assert.equal(result.get(a1), "open");
  assert.equal(result.get(a2), "open");
  assert.equal(result.get(b1), "open");
});

test("falha de um board não afeta as vagas de outro", async () => {
  const a = job({ id: "1", source: "greenhouse", company: "acme" });
  const b = job({ id: "2", source: "lever", company: "beta" });

  const result = await evaluateJobAvailability([a, b], {
    fetchBoardIds: async (source) =>
      source === "greenhouse" ? null : new Set(["2"]),
  });

  assert.equal(result.get(a), "unknown");
  assert.equal(result.get(b), "open");
});
