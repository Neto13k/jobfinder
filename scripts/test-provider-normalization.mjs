// Testes determinísticos da normalização estruturada dos providers.
//
// Uso:  npm run build
//       node scripts/test-provider-normalization.mjs
//
// Não realizam chamadas externas: substituem `globalThis.fetch` por um stub.
// Cobrem os campos estruturados adicionados ao contrato Job (modalidade de
// trabalho, tipos de contratação e localidades adicionais) nos providers de
// board, além dos utilitários de normalização compartilhados.

import { test } from "node:test";
import assert from "node:assert/strict";

const { fetchLeverJobs } = await import("../dist/providers/lever.js");
const { fetchGreenhouseJobs } = await import("../dist/providers/greenhouse.js");
const { fetchAshbyJobs } = await import("../dist/providers/ashby.js");
const { fetchInhireJobs } = await import("../dist/providers/inhire.js");
const { toWorkplaceType, toStringList } = await import(
  "../dist/providers/normalize.js"
);

/** Resposta mínima compatível com o uso dos providers. */
function response(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
  };
}

/** Executa `run` com `globalThis.fetch` substituído, restaurando ao final. */
async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// --- Utilitários de normalização --------------------------------------------

test("toWorkplaceType distingue remoto, híbrido, presencial e desconhecido", () => {
  assert.equal(toWorkplaceType("Remote"), "remote");
  assert.equal(toWorkplaceType("remoto"), "remote");
  assert.equal(toWorkplaceType("Hybrid"), "hybrid");
  assert.equal(toWorkplaceType("híbrido"), "hybrid");
  assert.equal(toWorkplaceType("on-site"), "onsite");
  assert.equal(toWorkplaceType("OnSite"), "onsite");
  assert.equal(toWorkplaceType("In-office"), "onsite");
  assert.equal(toWorkplaceType("presencial"), "onsite");
  // Rótulo presente porém não classificável: explicitamente desconhecido.
  assert.equal(toWorkplaceType("unspecified"), "unknown");
  assert.equal(toWorkplaceType("Flexible"), "unknown");
});

test("toWorkplaceType não inventa modalidade para valores ausentes ou inválidos", () => {
  assert.equal(toWorkplaceType(undefined), undefined);
  assert.equal(toWorkplaceType(null), undefined);
  assert.equal(toWorkplaceType("   "), undefined);
  assert.equal(toWorkplaceType(42), undefined);
  assert.equal(toWorkplaceType({}), undefined);
});

test("toStringList normaliza arrays de strings sem inventar valores", () => {
  assert.deepEqual(toStringList(["a", " a ", "", "b", "a", 3]), ["a", "b"]);
  assert.deepEqual(toStringList([1, 2]), []);
  assert.deepEqual(toStringList("CLT"), []);
  assert.deepEqual(toStringList(undefined), []);
});

// --- Provider Lever ----------------------------------------------------------

test("Lever preserva a descrição completa (principal + seções + adicional) sem duplicar", async () => {
  const posting = {
    id: "l1",
    text: "Desenvolvedor",
    categories: {
      location: "São Paulo",
      commitment: "Full-time",
      allLocations: ["São Paulo", "Rio de Janeiro"],
    },
    descriptionPlain: "Descrição principal.",
    description: "<p>Descrição principal.</p>",
    lists: [
      { text: "Responsabilidades", content: "<ul><li>Codar</li></ul>" },
      { text: "", content: "<p>Requisitos</p>" },
    ],
    additionalPlain: "Sobre a empresa.",
    additional: "<p>Sobre a empresa.</p>",
    workplaceType: "Hybrid",
    hostedUrl: "https://jobs.lever.co/acme/l1",
  };

  const [job] = await withFetch(
    async () => response([posting]),
    () => fetchLeverJobs("acme"),
  );

  const expected = [
    "Descrição principal.",
    "Responsabilidades\n<ul><li>Codar</li></ul>",
    "<p>Requisitos</p>",
    "Sobre a empresa.",
  ].join("\n\n");

  assert.equal(job.description, expected);
  // Nenhum bloco aparece duplicado (versão textual priorizada sobre o HTML).
  assert.equal(job.description.split("Descrição principal.").length - 1, 1);
  assert.equal(job.description.split("Sobre a empresa.").length - 1, 1);

  assert.equal(job.workplaceType, "hybrid");
  assert.deepEqual(job.contractTypes, ["Full-time"]);
  // Localidade principal removida; apenas a adicional é preservada.
  assert.deepEqual(job.additionalLocations, ["Rio de Janeiro"]);
  assert.equal(job.remote, false);
});

test("Lever usa HTML como fallback quando o texto puro não existe", async () => {
  const posting = {
    id: "l2",
    text: "Vaga",
    categories: { location: "Remote" },
    description: "<p>HTML principal</p>",
    additional: "<p>HTML extra</p>",
    workplaceType: "Remote",
  };

  const [job] = await withFetch(
    async () => response([posting]),
    () => fetchLeverJobs("acme"),
  );

  assert.equal(job.description, "<p>HTML principal</p>\n\n<p>HTML extra</p>");
  assert.equal(job.workplaceType, "remote");
  assert.equal(job.remote, true);
});

test("Lever omite campos estruturados ausentes (nada é inventado)", async () => {
  const [job] = await withFetch(
    async () => response([{ id: "l3", text: "Vaga" }]),
    () => fetchLeverJobs("acme"),
  );

  assert.equal(job.description, "");
  assert.equal(job.remote, false);
  assert.equal(job.publishedAt, undefined);
  assert.equal("workplaceType" in job, false);
  assert.equal("contractTypes" in job, false);
  assert.equal("additionalLocations" in job, false);
});

test("Lever ignora campos de tipos inesperados sem abortar a coleta", async () => {
  const [job] = await withFetch(
    async () =>
      response([
        {
          id: "l4",
          text: "Vaga",
          categories: { commitment: 5, allLocations: [1, "  ", "Belém"] },
          lists: "não é array",
          workplaceType: 99,
        },
      ]),
    () => fetchLeverJobs("acme"),
  );

  // Modalidade de tipo inválido não é convertida em informação.
  assert.equal("workplaceType" in job, false);
  // Tipo de contratação inválido é descartado.
  assert.equal("contractTypes" in job, false);
  // Apenas a localidade adicional válida é preservada.
  assert.deepEqual(job.additionalLocations, ["Belém"]);
});

test("o resultado do Lever é compatível com o contrato Job", async () => {
  const [job] = await withFetch(
    async () => response([{ id: "l5", text: "Vaga", hostedUrl: "https://x" }]),
    () => fetchLeverJobs("acme"),
  );

  assert.equal(typeof job.id, "string");
  assert.equal(typeof job.title, "string");
  assert.equal(typeof job.company, "string");
  assert.equal(typeof job.location, "string");
  assert.equal(typeof job.remote, "boolean");
  assert.equal(typeof job.description, "string");
  assert.equal(typeof job.url, "string");
  assert.equal(job.source, "lever");
});

// --- Provider InHire ---------------------------------------------------------

/** Resumo de vaga publicado no formato real do endpoint de listagem. */
function inhireSummary(jobId, displayName, extra = {}) {
  return {
    jobId,
    displayName,
    status: "published",
    ...extra,
  };
}

const INHIRE_LIST_URL = "https://api.inhire.app/job-posts/public/pages";

test("InHire diferencia modalidades remoto, presencial, híbrido e desconhecido", async () => {
  const summaries = [
    inhireSummary("r", "Remota", { workplaceType: "Remote" }),
    inhireSummary("o", "Presencial", { workplaceType: "On-site" }),
    inhireSummary("h", "Híbrida", { workplaceType: "Hybrid" }),
    inhireSummary("u", "Flexível", { workplaceType: "Flexible" }),
  ];
  const byId = {
    r: "Remote",
    o: "On-site",
    h: "Hybrid",
    u: "Flexible",
  };

  const jobs = await withFetch(
    async (url) => {
      if (url === INHIRE_LIST_URL) {
        return response({ tenantName: "Acme", jobsPage: summaries });
      }
      const jobId = url.slice(INHIRE_LIST_URL.length + 1);
      return response({ displayName: jobId, workplaceType: byId[jobId] });
    },
    () => fetchInhireJobs("acme"),
  );

  const byJobId = new Map(jobs.map((job) => [job.id, job]));
  assert.equal(byJobId.get("r").workplaceType, "remote");
  assert.equal(byJobId.get("o").workplaceType, "onsite");
  assert.equal(byJobId.get("h").workplaceType, "hybrid");
  // Rótulo presente porém não classificável: explicitamente desconhecido.
  assert.equal(byJobId.get("u").workplaceType, "unknown");
});

test("InHire omite workplaceType quando a fonte não informa modalidade", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === INHIRE_LIST_URL) {
        return response({
          jobsPage: [inhireSummary("x", "Sem modalidade")],
        });
      }
      return response({ displayName: "Sem modalidade", description: "x" });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs.length, 1);
  assert.equal("workplaceType" in jobs[0], false);
  assert.equal("contractTypes" in jobs[0], false);
});

test("InHire preserva os tipos de contratação em campo próprio e na descrição", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === INHIRE_LIST_URL) {
        return response({ jobsPage: [inhireSummary("c", "Vaga CLT")] });
      }
      return response({
        displayName: "Vaga CLT",
        workplaceType: "Remote",
        contractType: ["CLT"],
        description: "<p>Anúncio</p>",
      });
    },
    () => fetchInhireJobs("acme"),
  );

  const [job] = jobs;
  assert.deepEqual(job.contractTypes, ["CLT"]);
  // A evidência de contratação continua presente na descrição (compatibilidade).
  assert.equal(
    job.description,
    "Tipo de contratação (InHire): CLT\n\n<p>Anúncio</p>",
  );
  assert.equal(job.workplaceType, "remote");
});

test("o resultado do InHire é compatível com o contrato Job", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === INHIRE_LIST_URL) {
        return response({ jobsPage: [inhireSummary("k", "Vaga")] });
      }
      return response({ displayName: "Vaga", description: "x" });
    },
    () => fetchInhireJobs("acme"),
  );

  const [job] = jobs;
  assert.equal(typeof job.id, "string");
  assert.equal(typeof job.remote, "boolean");
  assert.equal(typeof job.description, "string");
  assert.equal(job.source, "inhire");
});

// --- Provider Ashby ----------------------------------------------------------

test("Ashby preserva modalidade, contratação e localidades adicionais", async () => {
  const posting = {
    title: "Dev",
    jobUrl: "https://jobs.ashbyhq.com/acme/1",
    location: "São Paulo",
    secondaryLocations: [
      { location: "Rio de Janeiro" },
      { location: "São Paulo" },
    ],
    workplaceType: "Hybrid",
    employmentType: "FullTime",
    descriptionPlain: "Desc",
    publishedAt: "2026-01-01T00:00:00.000Z",
  };

  const [job] = await withFetch(
    async () => response({ jobs: [posting] }),
    () => fetchAshbyJobs("acme"),
  );

  assert.equal(job.workplaceType, "hybrid");
  assert.deepEqual(job.contractTypes, ["FullTime"]);
  assert.deepEqual(job.additionalLocations, ["Rio de Janeiro"]);
  // `location` mantém a composição usada pelo pipeline (compatibilidade).
  assert.equal(job.location, "São Paulo | Rio de Janeiro");
  assert.equal(job.publishedAt, "2026-01-01T00:00:00.000Z");
});

test("Ashby omite campos estruturados ausentes (nada é inventado)", async () => {
  const [job] = await withFetch(
    async () =>
      response({
        jobs: [{ title: "Dev", jobUrl: "https://jobs.ashbyhq.com/acme/2" }],
      }),
    () => fetchAshbyJobs("acme"),
  );

  assert.equal(job.remote, false);
  assert.equal("workplaceType" in job, false);
  assert.equal("contractTypes" in job, false);
  assert.equal("additionalLocations" in job, false);
});

// --- Provider Greenhouse -----------------------------------------------------

test("Greenhouse preserva localidades adicionais e tipo de contratação", async () => {
  const job = {
    id: 123,
    title: "Dev",
    absolute_url: "https://boards.greenhouse.io/acme/jobs/123",
    content: "<p>desc</p>",
    updated_at: "2026-11-19T00:00:00.000Z",
    location: { name: "São Paulo" },
    offices: [{ name: "São Paulo" }, { name: "Rio de Janeiro" }],
    metadata: [
      { name: "Employment Type", value: "Full-time" },
      { name: "Outro", value: "ignorado" },
    ],
  };

  const [result] = await withFetch(
    async () => response({ jobs: [job] }),
    () => fetchGreenhouseJobs("acme"),
  );

  assert.deepEqual(result.additionalLocations, ["Rio de Janeiro"]);
  assert.deepEqual(result.contractTypes, ["Full-time"]);
  // `updated_at` nunca é usada como data de publicação.
  assert.equal(result.publishedAt, undefined);
});

test("Greenhouse omite campos estruturados ausentes (nada é inventado)", async () => {
  const [result] = await withFetch(
    async () =>
      response({
        jobs: [
          {
            id: 1,
            title: "Dev",
            absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          },
        ],
      }),
    () => fetchGreenhouseJobs("acme"),
  );

  assert.equal("additionalLocations" in result, false);
  assert.equal("contractTypes" in result, false);
  assert.equal(result.location, "");
});
