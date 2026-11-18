// Testes do tratamento de HTTP 429 (rate limiting).
//
// Uso:  npm run build
//       node scripts/test-rate-limit.mjs
//
// Determinísticos: não fazem scraping nem chamadas externas. Exercitam a
// detecção (estruturada e por mensagem restrita), a conversão de rejeições
// diretas da coleta (promessa rejeitada) e a orquestração do lote (interrupção
// apenas do provider afetado, preservação de vagas parciais, continuidade dos
// demais providers e ausência de retry).

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  RateLimitError,
  isRateLimitError,
  toRateLimitError,
  collectSearchBatch,
  withRateLimitGuard,
} = await import("../dist/services/rate-limit.js");

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
    source: "rate-limit-test",
    ...overrides,
  };
}

/** Fonte de pesquisa mínima do LinkedIn. */
function linkedinSearch(searchTerm) {
  return { provider: "linkedin", searchTerm };
}

/** Fonte de pesquisa mínima do Indeed. */
function indeedSearch(searchTerm) {
  return { provider: "indeed", searchTerm };
}

/** Rótulo legível de uma fonte, no mesmo formato usado pelo orquestrador. */
function describe(source) {
  return `${source.provider} (${source.searchTerm})`;
}

// Mensagens reais extraídas da ts-jobspy 3.0.1 (node_modules/ts-jobspy/dist/index.mjs):
//   LinkedIn (RateLimitException): "LinkedIn responded with HTTP 429 (blocked for too many requests)"
//   Indeed   (RateLimitException): "Indeed responded with HTTP 429 (rate limited)"
// Nos retornos parciais, a mensagem é agregada em meta.sites[].error como
// ScrapeInterrupted no formato "page <n>: <mensagem>".
const LINKEDIN_RATE_LIMIT =
  "LinkedIn responded with HTTP 429 (blocked for too many requests)";
const INDEED_RATE_LIMIT = "Indeed responded with HTTP 429 (rate limited)";
const LINKEDIN_RATE_LIMIT_PARTIAL = `page 2: ${LINKEDIN_RATE_LIMIT}`;
const INDEED_RATE_LIMIT_PARTIAL = `page 2: ${INDEED_RATE_LIMIT}`;
// Erro de descrição do LinkedIn, agregado ao parcial por finish().
const LINKEDIN_DESCRIPTION_429 =
  "job 3847291: description fetch returned HTTP 429";

test("identifica RateLimitException estruturado (mensagens reais da biblioteca)", () => {
  assert.equal(
    isRateLimitError({ name: "RateLimitException", message: LINKEDIN_RATE_LIMIT }),
    true,
  );
  assert.equal(
    isRateLimitError({ name: "RateLimitException", message: INDEED_RATE_LIMIT }),
    true,
  );
});

test("reconhece as mensagens reais agregadas como ScrapeInterrupted", () => {
  assert.equal(
    isRateLimitError({
      name: "ScrapeInterrupted",
      message: LINKEDIN_RATE_LIMIT_PARTIAL,
    }),
    true,
  );
  assert.equal(
    isRateLimitError({
      name: "ScrapeInterrupted",
      message: INDEED_RATE_LIMIT_PARTIAL,
    }),
    true,
  );
});

test("reconhece o 429 de descrição do LinkedIn agregado ao parcial", () => {
  assert.equal(
    isRateLimitError({
      name: "ScrapeInterrupted",
      message: LINKEDIN_DESCRIPTION_429,
    }),
    true,
  );
});

test("não produz falso positivo: apenas 429, sem o prefixo HTTP", () => {
  assert.equal(
    isRateLimitError({ name: "LinkedInException", message: "status code 429" }),
    false,
  );
});

test("não produz falso positivo: apenas 'rate limit', sem o status 429", () => {
  assert.equal(
    isRateLimitError({
      name: "ScrapeInterrupted",
      message: "server says rate limited",
    }),
    false,
  );
});

test("não produz falso positivo em erros comuns e sem erro", () => {
  assert.equal(
    isRateLimitError({
      name: "LinkedInException",
      message: "LinkedIn responded with status code 500",
    }),
    false,
  );
  assert.equal(
    isRateLimitError({
      name: "IndeedException",
      message: "Indeed API responded with status code 403",
    }),
    false,
  );
  assert.equal(isRateLimitError(undefined), false);
});

test("RateLimitError carrega fonte, vagas preservadas e mensagem", () => {
  const preserved = [job({ id: "a" })];
  const error = new RateLimitError("linkedin", preserved, LINKEDIN_RATE_LIMIT);

  assert.ok(error instanceof Error);
  assert.equal(error.name, "RateLimitError");
  assert.equal(error.source, "linkedin");
  assert.deepEqual(error.preservedJobs, preserved);
  assert.equal(error.message, LINKEDIN_RATE_LIMIT);
});

test("toRateLimitError: RateLimitException direta da biblioteca (error, sem vagas)", () => {
  // É exatamente o metadata de toSiteError quando a biblioteca lança
  // RateLimitException antes de coletar qualquer vaga.
  const error = toRateLimitError(
    "linkedin",
    "error",
    { name: "RateLimitException", message: LINKEDIN_RATE_LIMIT },
    [],
  );

  assert.ok(error instanceof RateLimitError);
  assert.equal(error.source, "linkedin");
  assert.equal(error.preservedJobs.length, 0);
  assert.equal(error.message, LINKEDIN_RATE_LIMIT);
});

test("toRateLimitError: HTTP 429 com resultados parciais (mensagem agregada real)", () => {
  const preserved = [job({ id: "x" }), job({ id: "y" })];
  const error = toRateLimitError(
    "indeed",
    "partial",
    { name: "ScrapeInterrupted", message: INDEED_RATE_LIMIT_PARTIAL },
    preserved,
  );

  assert.ok(error instanceof RateLimitError);
  assert.deepEqual(error.preservedJobs, preserved);
});

test("toRateLimitError: 429 de descrição agregado em retorno parcial", () => {
  const preserved = [job({ id: "z" })];
  const error = toRateLimitError(
    "linkedin",
    "partial",
    { name: "ScrapeInterrupted", message: LINKEDIN_DESCRIPTION_429 },
    preserved,
  );

  assert.ok(error instanceof RateLimitError);
  assert.deepEqual(error.preservedJobs, preserved);
});

test("toRateLimitError ignora status ok/empty e erros não relacionados", () => {
  assert.equal(toRateLimitError("linkedin", "ok", undefined, []), undefined);
  assert.equal(toRateLimitError("linkedin", "empty", undefined, []), undefined);
  assert.equal(
    toRateLimitError(
      "linkedin",
      "error",
      {
        name: "LinkedInException",
        message: "LinkedIn responded with status code 500",
      },
      [],
    ),
    undefined,
  );
});

test("collectSearchBatch interrompe as pesquisas restantes e preserva as vagas", async () => {
  const searches = ["s1", "s2", "s3", "s4", "s5"].map(linkedinSearch);
  const calls = [];
  const collectedBefore = job({ id: "before" });
  const preservedPartial = job({ id: "partial" });

  const fetchJobs = async (source) => {
    calls.push(source.searchTerm);
    if (source.searchTerm === "s1") {
      return [collectedBefore];
    }
    if (source.searchTerm === "s2") {
      throw new RateLimitError("linkedin", [preservedPartial]);
    }
    return [job({ id: "never" })];
  };

  const result = await collectSearchBatch(searches, fetchJobs, describe);

  // A pesquisa bloqueada não é repetida (sem retry) e as restantes são ignoradas.
  assert.deepEqual(calls, ["s1", "s2"]);
  assert.deepEqual(result, [collectedBefore, preservedPartial]);
});

test("collectSearchBatch: HTTP 429 sem resultados apenas interrompe o provider", async () => {
  const searches = ["s1", "s2", "s3"].map(indeedSearch);
  const calls = [];

  const fetchJobs = async (source) => {
    calls.push(source.searchTerm);
    if (source.searchTerm === "s2") {
      throw new RateLimitError("indeed", []);
    }
    return [job({ id: `ok-${source.searchTerm}` })];
  };

  const result = await collectSearchBatch(searches, fetchJobs, describe);

  assert.deepEqual(calls, ["s1", "s2"]);
  assert.deepEqual(
    result.map((item) => item.id),
    ["ok-s1"],
  );
});

test("collectSearchBatch preserva os demais providers após rate limiting", async () => {
  const linkedinSearches = ["l1", "l2", "l3"].map(linkedinSearch);
  const indeedSearches = ["i1", "i2"].map(indeedSearch);

  const linkedinFetch = async (source) => {
    if (source.searchTerm === "l1") {
      throw new RateLimitError("linkedin", [job({ id: "l-preserved" })]);
    }
    return [job({ id: `linkedin-${source.searchTerm}` })];
  };
  const indeedFetch = async (source) => [
    job({ id: `indeed-${source.searchTerm}` }),
  ];

  const linkedinJobs = await collectSearchBatch(
    linkedinSearches,
    linkedinFetch,
    describe,
  );
  const indeedJobs = await collectSearchBatch(
    indeedSearches,
    indeedFetch,
    describe,
  );

  assert.deepEqual(
    linkedinJobs.map((item) => item.id),
    ["l-preserved"],
  );
  assert.deepEqual(
    indeedJobs.map((item) => item.id),
    ["indeed-i1", "indeed-i2"],
  );
});

test("collectSearchBatch propaga erros que não são rate limiting", async () => {
  const searches = ["s1", "s2"].map(linkedinSearch);

  const fetchJobs = async () => {
    throw new Error("falha genérica");
  };

  await assert.rejects(
    () => collectSearchBatch(searches, fetchJobs, describe),
    /falha genérica/,
  );
});

test("collectSearchBatch segue após falha comum isolada (retorno vazio)", async () => {
  const searches = ["s1", "s2"].map(indeedSearch);

  const fetchJobs = async (source) =>
    source.searchTerm === "s1" ? [] : [job({ id: "s2-ok" })];

  const result = await collectSearchBatch(searches, fetchJobs, describe);

  assert.deepEqual(
    result.map((item) => item.id),
    ["s2-ok"],
  );
});

test("collectSearchBatch registra provider, vagas preservadas e pesquisas ignoradas", async () => {
  const searches = ["s1", "s2", "s3", "s4"].map(linkedinSearch);

  const fetchJobs = async (source) => {
    if (source.searchTerm === "s2") {
      throw new RateLimitError("linkedin", [job({ id: "p1" }), job({ id: "p2" })]);
    }
    return [];
  };

  const messages = [];
  const originalWarn = console.warn;
  console.warn = (message) => messages.push(String(message));
  try {
    await collectSearchBatch(searches, fetchJobs, describe);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(messages.length, 1);
  const log = messages[0];
  assert.match(log, /HTTP 429/);
  assert.match(log, /linkedin \(s2\)/);
  assert.match(log, /2 vaga\(s\) preservada\(s\)/);
  // Só "s1" rodou antes do bloqueio em "s2": restam "s3" e "s4".
  assert.match(log, /2 pesquisa\(s\) restante\(s\)/);
});

/** Monta uma rejeição com a mensagem real de RateLimitException da biblioteca. */
function rateLimitRejection(message) {
  const error = new Error(message);
  error.name = "RateLimitException";
  return error;
}

test("withRateLimitGuard converte rejeição de RateLimitException em RateLimitError", async () => {
  // Simula a promessa de coleta rejeitada diretamente, sem meta.sites.
  await assert.rejects(
    () => withRateLimitGuard(() => Promise.reject(rateLimitRejection(LINKEDIN_RATE_LIMIT)), "linkedin"),
    (error) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.source, "linkedin");
      // A promessa rejeitada não devolve resultados: nada a preservar.
      assert.equal(error.preservedJobs.length, 0);
      assert.equal(error.message, LINKEDIN_RATE_LIMIT);
      return true;
    },
  );
});

test("withRateLimitGuard converte rejeição com mensagem HTTP 429 (fallback)", async () => {
  await assert.rejects(
    () => withRateLimitGuard(() => Promise.reject(new Error(INDEED_RATE_LIMIT)), "indeed"),
    (error) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.source, "indeed");
      return true;
    },
  );
});

test("withRateLimitGuard preserva erros não relacionados a rate limiting", async () => {
  const original = new Error("falha genérica de coleta");

  await assert.rejects(
    () => withRateLimitGuard(() => Promise.reject(original), "linkedin"),
    (error) => {
      // Erro original repropagado sem conversão.
      assert.equal(error, original);
      assert.equal(error instanceof RateLimitError, false);
      assert.equal(error.message, "falha genérica de coleta");
      return true;
    },
  );
});

test("withRateLimitGuard não converte 429 sem o prefixo HTTP (sem falso positivo)", async () => {
  const original = new Error("LinkedIn responded with status code 429");

  await assert.rejects(
    () => withRateLimitGuard(() => Promise.reject(original), "linkedin"),
    (error) => {
      assert.equal(error, original);
      return true;
    },
  );
});

test("withRateLimitGuard repassa o resultado quando a coleta conclui com sucesso", async () => {
  const payload = { jobs: [job({ id: "ok" })] };
  const result = await withRateLimitGuard(
    () => Promise.resolve(payload),
    "linkedin",
  );

  assert.equal(result, payload);
});

test("rejeição direta da coleta interrompe apenas o provider afetado", async () => {
  const linkedinSearches = ["l1", "l2", "l3"].map(linkedinSearch);
  const indeedSearches = ["i1", "i2"].map(indeedSearch);
  const linkedinCalls = [];

  // O provider inteiro é uma promessa única: rejeita em "l1" sem devolver
  // meta.sites, então apenas o guard pode identificá-la como rate limiting.
  const linkedinFetch = (source) => {
    linkedinCalls.push(source.searchTerm);
    return withRateLimitGuard(() => {
      if (source.searchTerm === "l1") {
        return Promise.reject(rateLimitRejection(LINKEDIN_RATE_LIMIT));
      }
      return Promise.resolve([job({ id: `linkedin-${source.searchTerm}` })]);
    }, "linkedin");
  };
  const indeedFetch = (source) =>
    withRateLimitGuard(
      () => Promise.resolve([job({ id: `indeed-${source.searchTerm}` })]),
      "indeed",
    );

  const linkedinJobs = await collectSearchBatch(
    linkedinSearches,
    linkedinFetch,
    describe,
  );
  const indeedJobs = await collectSearchBatch(
    indeedSearches,
    indeedFetch,
    describe,
  );

  // Sem retry: "l1" rejeita e as demais pesquisas do LinkedIn são ignoradas.
  assert.deepEqual(linkedinCalls, ["l1"]);
  assert.deepEqual(linkedinJobs, []);
  // O Indeed não é afetado pela rejeição do LinkedIn.
  assert.deepEqual(
    indeedJobs.map((item) => item.id),
    ["indeed-i1", "indeed-i2"],
  );
});
