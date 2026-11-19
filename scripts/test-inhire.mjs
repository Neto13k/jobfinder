// Testes determinísticos do provider InHire (etapa 9).
//
// Uso:  npm run build
//       node scripts/test-inhire.mjs
//
// Não realizam chamadas externas: substituem `globalThis.fetch` por um stub
// local. Cobrem normalização, respostas vazias/inválidas, campos opcionais,
// identificadores e links, datas, localização/modalidade, erros HTTP, HTTP 429,
// timeout e isolamento entre empresas. O cancelamento por timeout é simulado
// com o mesmo erro nativo do `AbortSignal.timeout` (DOMException "TimeoutError").

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  fetchInhireJobs,
  INHIRE_MAX_CONCURRENT_TENANTS,
  MIN_REQUEST_INTERVAL_MS,
} = await import("../dist/providers/inhire.js");
const { BoardTimeoutError } = await import("../dist/providers/board-http.js");
const { BOARD_JOB_SOURCES } = await import("../dist/config/job-sources.js");

/** Drena o laço de eventos até `predicate()` virar verdadeiro (com limite). */
async function flushUntil(predicate, maxTurns = 200) {
  for (let i = 0; i < maxTurns && !predicate(); i++) {
    // Espera um intervalo real curto: o teto agregado da InHire espaça as
    // requisições por temporizadores (60 ms), que não disparam em meros turnos
    // de setImmediate — seria preciso consumir tempo real.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "condição não satisfeita no tempo esperado");
}

/** URL do endpoint de listagem pública. */
const LIST_URL = "https://api.inhire.app/job-posts/public/pages";

/** Erro nativo de timeout, idêntico ao propagado pelo AbortSignal.timeout. */
function timeoutError() {
  return new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError",
  );
}

/** Resposta mínima compatível com o uso do provider. */
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

/** Resumo de vaga publicado, com os campos reais da listagem (apenas 7). */
function summary(jobId, displayName, extra = {}) {
  return {
    careerPageId: "default",
    careerPageIds: ["default"],
    jobId,
    displayName,
    status: "published",
    workplaceType: "On-site",
    location: "Barueri, SP, BR",
    ...extra,
  };
}

/** Detalhe de vaga publicado, no formato real do endpoint de detalhe. */
function detail(jobId, displayName, extra = {}) {
  return {
    jobId,
    displayName,
    status: "published",
    workplaceType: "On-site",
    location: "Barueri, SP, BR",
    description: "<p>Descrição</p>",
    contractType: ["CLT"],
    ...extra,
  };
}

test("normaliza uma vaga válida (listagem + detalhe) e envia X-Tenant", async () => {
  const calls = [];

  const jobs = await withFetch(
    async (url, init) => {
      calls.push({ url, init });

      if (url === LIST_URL) {
        return response({
          tenantName: "Acme",
          jobsPage: [
            summary("abc-123", "Pessoa Desenvolvedora Júnior", {
              workplaceType: "Remote",
              location: "São Paulo, SP, BR",
            }),
          ],
        });
      }

      return response({
        jobId: "abc-123",
        displayName: "Pessoa Desenvolvedora Júnior",
        tenantName: "Acme",
        status: "published",
        workplaceType: "Remote",
        location: "São Paulo, SP, BR",
        description: "<p>Vaga <strong>júnior</strong> de desenvolvimento</p>",
        contractType: ["CLT"],
        publishedAt: "2026-10-01T12:00:00.000Z",
      });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs.length, 1);
  const [job] = jobs;

  assert.equal(job.id, "abc-123");
  assert.equal(job.title, "Pessoa Desenvolvedora Júnior");
  assert.equal(job.company, "Acme");
  assert.equal(job.location, "São Paulo, SP, BR");
  assert.equal(job.remote, true);
  assert.equal(
    job.description,
    "Tipo de contratação (InHire): CLT\n\n" +
      "<p>Vaga <strong>júnior</strong> de desenvolvimento</p>",
  );
  assert.equal(job.url, "https://acme.inhire.app/vagas/abc-123");
  assert.equal(job.source, "inhire");
  assert.equal(job.publishedAt, "2026-10-01T12:00:00.000Z");

  // O cabeçalho obrigatório X-Tenant é enviado na listagem e no detalhe.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, LIST_URL);
  assert.equal(calls[1].url, `${LIST_URL}/abc-123`);
  for (const call of calls) {
    assert.equal(call.init.headers["X-Tenant"], "acme");
  }
});

test("workspace vazio (jobsPage ausente) retorna lista vazia", async () => {
  const jobs = await withFetch(
    async () => response({ tenantName: "Vazia" }),
    () => fetchInhireJobs("vazia"),
  );

  assert.deepEqual(jobs, []);
});

test("jobsPage vazio retorna lista vazia (board válido sem vagas)", async () => {
  const jobs = await withFetch(
    async () => response({ tenantName: "Vazia", jobsPage: [] }),
    () => fetchInhireJobs("vazia"),
  );

  assert.deepEqual(jobs, []);
});

test("jobsPage com formato inesperado lança erro", async () => {
  await withFetch(
    async () => response({ jobsPage: { inesperado: true } }),
    async () => {
      await assert.rejects(
        () => fetchInhireJobs("quebrada"),
        (error) => {
          assert.match(error.message, /inválida/);
          return true;
        },
      );
    },
  );
});

test("resposta que não é objeto lança erro", async () => {
  await withFetch(
    async () => response(null),
    async () => {
      await assert.rejects(
        () => fetchInhireJobs("nula"),
        (error) => {
          assert.match(error.message, /inválida/);
          return true;
        },
      );
    },
  );
});

test("resumos sem jobId ou displayName são ignorados", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          tenantName: "Acme",
          jobsPage: [
            { displayName: "Sem id" },
            { jobId: "s-id" },
            summary("ok-1", "Vaga válida"),
          ],
        });
      }
      return response({ displayName: "Vaga válida" });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "ok-1");
});

test("vaga com status não publicado é ignorada", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          tenantName: "Acme",
          jobsPage: [
            summary("a", "Publicada"),
            summary("b", "Fora do ar", { status: "unlisted" }),
            summary("c", "Despublicada", { status: "unpublished" }),
          ],
        });
      }
      return response({ displayName: "Publicada", description: "x" });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "a");
});

test("campos opcionais ausentes não viram informação inventada", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          jobsPage: [{ jobId: "sem-extras", displayName: "Vaga mínima" }],
        });
      }
      // Detalhe sem location, workplaceType, description nem publishedAt.
      return response({ jobId: "sem-extras", displayName: "Vaga mínima" });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job.location, "");
  assert.equal(job.remote, false);
  assert.equal(job.description, "");
  assert.equal(job.publishedAt, undefined);
  // Sem tenantName na listagem, a empresa recorre ao identificador do tenant.
  assert.equal(job.company, "acme");
});

test("descrição completa é preservada sem truncamento", async () => {
  const longDescription = `<p>${"descrição detalhada ".repeat(500)}</p>`;

  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({ jobsPage: [summary("d1", "Vaga com descrição longa")] });
      }
      return response({ displayName: "Vaga com descrição longa", description: longDescription });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].description, longDescription);
  assert.ok(jobs[0].description.length > 4000);
});

/** Coleta uma vaga cujo detalhe recebe os campos informados em `extra`. */
async function collectWithDetail(extra) {
  return withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({ jobsPage: [summary("ct", "Vaga de teste")] });
      }
      return response({ displayName: "Vaga de teste", ...extra });
    },
    () => fetchInhireJobs("acme"),
  );
}

test("preserva o tipo de contratação CLT como evidência explícita", async () => {
  const jobs = await collectWithDetail({
    description: "<p>Anúncio original</p>",
    contractType: ["CLT"],
  });

  assert.equal(jobs.length, 1);
  assert.equal(
    jobs[0].description,
    "Tipo de contratação (InHire): CLT\n\n<p>Anúncio original</p>",
  );
});

test("preserva o tipo de contratação PJ como evidência explícita", async () => {
  const jobs = await collectWithDetail({
    description: "<p>Anúncio original</p>",
    contractType: ["PJ"],
  });

  assert.equal(
    jobs[0].description,
    "Tipo de contratação (InHire): PJ\n\n<p>Anúncio original</p>",
  );
});

test("preserva o tipo de contratação Estágio como evidência explícita", async () => {
  const jobs = await collectWithDetail({
    description: "<p>Programa de estágio</p>",
    contractType: ["Estágio"],
  });

  assert.equal(
    jobs[0].description,
    "Tipo de contratação (InHire): Estágio\n\n<p>Programa de estágio</p>",
  );
});

test("junta múltiplos tipos de contratação em uma única evidência", async () => {
  const jobs = await collectWithDetail({
    description: "<p>Anúncio</p>",
    contractType: ["CLT", "PJ"],
  });

  assert.equal(
    jobs[0].description,
    "Tipo de contratação (InHire): CLT, PJ\n\n<p>Anúncio</p>",
  );
});

test("sem contractType a descrição não é alterada (nada é inventado)", async () => {
  const jobs = await collectWithDetail({ description: "<p>Anúncio original</p>" });

  assert.equal(jobs[0].description, "<p>Anúncio original</p>");
});

test("contractType vazio ou de tipo inesperado não gera evidência", async () => {
  const empty = await collectWithDetail({
    description: "x",
    contractType: [],
  });
  assert.equal(empty[0].description, "x");

  const blanks = await collectWithDetail({
    description: "x",
    contractType: ["", "   "],
  });
  assert.equal(blanks[0].description, "x");

  const wrongType = await collectWithDetail({
    description: "x",
    contractType: "CLT",
  });
  assert.equal(wrongType[0].description, "x");
});

test("com descrição vazia, a evidência de contratação ainda é registrada", async () => {
  const jobs = await collectWithDetail({ description: "", contractType: ["CLT"] });

  assert.equal(jobs[0].description, "Tipo de contratação (InHire): CLT");
});

test("a evidência de contratação antecede a descrição longa (sobrevive ao truncamento)", async () => {
  const longDescription = `<p>${"conteúdo do anúncio ".repeat(400)}</p>`;

  const jobs = await collectWithDetail({
    description: longDescription,
    contractType: ["CLT"],
  });

  // O prompt de IA trunca a descrição; a evidência precisa encabeçar o texto.
  assert.ok(
    jobs[0].description.startsWith("Tipo de contratação (InHire): CLT"),
  );
  assert.ok(
    jobs[0].description.slice(0, 4000).includes("Tipo de contratação (InHire): CLT"),
  );
  assert.ok(jobs[0].description.endsWith(longDescription));
});

test("a data da coleta nunca é usada como data de publicação", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({ jobsPage: [summary("t1", "Vaga de hoje")] });
      }
      // Detalhe sem publishedAt.
      return response({ displayName: "Vaga de hoje", description: "x" });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs[0].publishedAt, undefined);
});

test("publishedAt do detalhe é preservado como data real de publicação", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({ jobsPage: [summary("p1", "Vaga datada")] });
      }
      return response({ displayName: "Vaga datada", publishedAt: "2026-09-15T08:30:00.000Z" });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs[0].publishedAt, "2026-09-15T08:30:00.000Z");
});

test("modalidade Hybrid/On-site não é marcada como remota", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          jobsPage: [
            summary("h", "Híbrida", { workplaceType: "Hybrid" }),
            summary("o", "Presencial", { workplaceType: "On-site" }),
          ],
        });
      }
      if (url.endsWith("/h")) {
        return response({ displayName: "Híbrida", workplaceType: "Hybrid" });
      }
      return response({ displayName: "Presencial", workplaceType: "On-site" });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].remote, false);
  assert.equal(jobs[1].remote, false);
});

test("resposta HTTP de erro na listagem lança erro com o status", async () => {
  await withFetch(
    async () => response(undefined, { ok: false, status: 500, statusText: "Internal Server Error" }),
    async () => {
      await assert.rejects(
        () => fetchInhireJobs("quebrada"),
        (error) => {
          assert.match(error.message, /500/);
          return true;
        },
      );
    },
  );
});

test("HTTP 429 na listagem lança erro (sem vagas para preservar)", async () => {
  await withFetch(
    async () => response(undefined, { ok: false, status: 429, statusText: "Too Many Requests" }),
    async () => {
      await assert.rejects(
        () => fetchInhireJobs("limitada"),
        (error) => {
          assert.match(error.message, /429/);
          return true;
        },
      );
    },
  );
});

test("HTTP 429 no detalhe preserva as vagas já coletadas e interrompe", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          tenantName: "Acme",
          jobsPage: [
            summary("j1", "Primeira"),
            summary("j2", "Segunda"),
            summary("j3", "Terceira"),
          ],
        });
      }
      if (url.endsWith("/j1")) {
        return response({ displayName: "Primeira", description: "ok" });
      }
      // Bloqueio na segunda vaga: as seguintes são abandonadas.
      return response(undefined, { ok: false, status: 429, statusText: "Too Many Requests" });
    },
    () => fetchInhireJobs("acme"),
  );

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "j1");
  assert.equal(jobs[0].description, "ok");
});

test("falha pontual de detalhe isola apenas a vaga afetada", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          tenantName: "Acme",
          jobsPage: [summary("j1", "Primeira"), summary("j2", "Segunda"), summary("j3", "Terceira")],
        });
      }
      if (url.endsWith("/j2")) {
        throw new Error("ECONNRESET");
      }
      return response({ displayName: "Vaga", description: "ok" });
    },
    () => fetchInhireJobs("acme"),
  );

  // A vaga com falha é descartada; as demais permanecem.
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs.map((job) => job.id),
    ["j1", "j3"],
  );
});

test("campos de tipos inesperados não abortam a coleta (isolamento por vaga)", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          tenantName: "Acme",
          jobsPage: [
            summary("a", "Válida A", { workplaceType: "Remote" }),
            // workplaceType/description também anômalos na própria listagem.
            summary("b", "Tipos inesperados", { workplaceType: 99 }),
            summary("c", "Válida C", { workplaceType: "Remote" }),
          ],
        });
      }
      if (url.endsWith("/b")) {
        // Tipos inesperados (número/objeto) no detalhe: nada deve lançar.
        return response({
          jobId: "b",
          displayName: "Tipos inesperados",
          workplaceType: 123,
          description: { html: "<p>x</p>" },
          contractType: { tipo: "CLT" },
        });
      }
      return response({ displayName: "Vaga", workplaceType: "Remote", description: "<p>ok</p>" });
    },
    () => fetchInhireJobs("acme"),
  );

  // As três vagas seguem coletadas: a vaga com tipos estranhos não derruba nada.
  assert.deepEqual(
    jobs.map((job) => job.id),
    ["a", "b", "c"],
  );
  const anomalia = jobs.find((job) => job.id === "b");
  // Número não é confundido com modalidade remota e objeto não vira descrição.
  assert.equal(anomalia.remote, false);
  assert.equal(anomalia.description, "");
});

test("falha de normalização descarta apenas a vaga afetada e segue as demais", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          tenantName: "Acme",
          jobsPage: [
            summary("j1", "Primeira"),
            summary("j2", "Segunda"),
            summary("j3", "Terceira"),
          ],
        });
      }
      if (url.endsWith("/j2")) {
        // O acesso a `description` lança durante a normalização (`toJob`).
        return response({
          displayName: "Segunda",
          get description() {
            throw new Error("falha de normalização");
          },
        });
      }
      return response({ displayName: "Vaga", description: "ok" });
    },
    () => fetchInhireJobs("acme"),
  );

  // A vaga cuja normalização falhou é descartada; as demais permanecem.
  assert.deepEqual(
    jobs.map((job) => job.id),
    ["j1", "j3"],
  );
});

test("timeout na listagem é convertido em BoardTimeoutError", async () => {
  await withFetch(
    async () => {
      throw timeoutError();
    },
    async () => {
      await assert.rejects(
        () => fetchInhireJobs("lenta"),
        (error) => {
          assert.ok(error instanceof BoardTimeoutError);
          assert.equal(error.source, "inhire");
          assert.equal(error.timeoutMs, 15000);
          return true;
        },
      );
    },
  );
});

test("timeout durante a leitura do corpo do detalhe isola apenas a vaga afetada", async () => {
  await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          jobsPage: [summary("j1", "Vaga em timeout"), summary("j2", "Vaga ok")],
        });
      }
      if (url.endsWith("/j1")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => {
            throw timeoutError();
          },
        };
      }
      return response(detail("j2", "Vaga ok"));
    },
    async () => {
      const jobs = await fetchInhireJobs("acme");

      // A vaga cujo detalhe falhou é descartada; a coleta não é abortada.
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].id, "j2");
    },
  );
});

test("falha de uma empresa não afeta as demais (isolamento)", async () => {
  await withFetch(
    async (url, init) => {
      if (init.headers["X-Tenant"] === "lenta") {
        throw timeoutError();
      }
      return response({ tenantName: "Rápida", jobsPage: [] });
    },
    async () => {
      const results = await Promise.allSettled([
        fetchInhireJobs("lenta"),
        fetchInhireJobs("rapida"),
      ]);

      assert.equal(results[0].status, "rejected");
      assert.ok(results[0].reason instanceof BoardTimeoutError);
      assert.equal(results[0].reason.source, "inhire");

      assert.equal(results[1].status, "fulfilled");
      assert.deepEqual(results[1].value, []);
    },
  );
});

test("tenant vazio ou em branco lança erro", async () => {
  await assert.rejects(() => fetchInhireJobs("   "), /tenant is required/i);
});

test("o limite de concorrência entre empresas é quatro", () => {
  assert.equal(INHIRE_MAX_CONCURRENT_TENANTS, 4);
});

test("a concorrência entre empresas nunca excede o limite configurado", async () => {
  const tenants = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];

  let active = 0;
  let maxActive = 0;
  const gates = [];

  await withFetch(
    async (url) => {
      if (url !== LIST_URL) {
        return response(detail("x", "x"));
      }

      // Cada listagem fica presa até o teste liberar, permitindo medir quantas
      // empresas estão simultaneamente em voo.
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => {
        gates.push(() => {
          active--;
          resolve();
        });
      });

      return response({ jobsPage: [] });
    },
    async () => {
      const promises = tenants.map((tenant) => fetchInhireJobs(tenant));

      // Com todas as vagas ocupadas, exatamente o limite fica em voo.
      await flushUntil(() => gates.length === INHIRE_MAX_CONCURRENT_TENANTS);
      assert.equal(maxActive, INHIRE_MAX_CONCURRENT_TENANTS);

      // Liberar uma empresa dá lugar à próxima da fila, sem exceder o limite.
      gates.shift()();
      await flushUntil(() => gates.length === INHIRE_MAX_CONCURRENT_TENANTS);
      assert.equal(maxActive, INHIRE_MAX_CONCURRENT_TENANTS);

      // Libera as listagens restantes conforme chegam, até todas concluírem.
      // A espera consome tempo real para o teto agregado (60 ms) liberar as
      // próximas empresas da fila.
      const all = Promise.all(promises);
      let done = false;
      all.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );

      while (!done) {
        if (gates.length > 0) {
          gates.shift()();
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const results = await all;
      assert.equal(results.length, tenants.length);
      for (const result of results) {
        assert.deepEqual(result, []);
      }
    },
  );

  assert.equal(maxActive, INHIRE_MAX_CONCURRENT_TENANTS);
});

test("o resultado é compatível com o contrato Job do pipeline", async () => {
  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({ tenantName: "Acme", jobsPage: [summary("k1", "Vaga")] });
      }
      return response({ displayName: "Vaga", description: "x", publishedAt: "2026-10-01T00:00:00.000Z" });
    },
    () => fetchInhireJobs("acme"),
  );

  const [job] = jobs;
  assert.equal(typeof job.id, "string");
  assert.equal(typeof job.title, "string");
  assert.equal(typeof job.company, "string");
  assert.equal(typeof job.location, "string");
  assert.equal(typeof job.remote, "boolean");
  assert.equal(typeof job.description, "string");
  assert.equal(typeof job.url, "string");
  assert.equal(job.source, "inhire");
  assert.ok("publishedAt" in job);
});

test("as fontes InHire configuradas apontam para o provider suportado", () => {
  const inhireSources = BOARD_JOB_SOURCES.filter(
    (source) => source.provider === "inhire",
  );

  assert.ok(inhireSources.length >= 10, "poucas fontes InHire configuradas");

  for (const source of inhireSources) {
    assert.equal(typeof source.identifier, "string");
    assert.ok(source.identifier.trim().length > 0, "identificador vazio");
  }
});

test("o teto agregado compartilhado espaça listagens e detalhes de empresas simultâneas", async () => {
  // Cada empresa tem exatamente uma vaga: além da listagem, há o detalhe do
  // índice 0 (que não recebe o pacing por empresa). Só o teto compartilhado
  // separa as requisições, inclusive as listagens, que sem ele sairiam juntas.
  const tenants = Array.from(
    { length: INHIRE_MAX_CONCURRENT_TENANTS },
    (_, index) => `t${index + 1}`,
  );
  const requestTimes = [];

  await withFetch(
    async (url) => {
      requestTimes.push(Date.now());
      if (url === LIST_URL) {
        return response({ jobsPage: [summary("unica", "Vaga única")] });
      }
      return response({ displayName: "Vaga única", description: "x" });
    },
    async () => {
      const results = await Promise.all(
        tenants.map((tenant) => fetchInhireJobs(tenant)),
      );
      assert.equal(results.length, tenants.length);
    },
  );

  // Quatro empresas × (1 listagem + 1 detalhe) = 8 requisições espaçadas.
  assert.equal(requestTimes.length, tenants.length * 2);

  const sorted = [...requestTimes].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    assert.ok(
      gap >= MIN_REQUEST_INTERVAL_MS - 15,
      `intervalo agregado curto entre requisições: ${gap} ms`,
    );
  }
});

test("três timeouts consecutivos abandonam os detalhes preservando os coletados", async () => {
  const detailRequests = [];

  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          tenantName: "Acme",
          jobsPage: [
            summary("j1", "Primeira"),
            summary("j2", "Segunda"),
            summary("j3", "Terceira"),
            summary("j4", "Quarta"),
          ],
        });
      }
      detailRequests.push(url);
      if (url.endsWith("/j1")) {
        return response({ displayName: "Primeira", description: "ok" });
      }
      throw timeoutError();
    },
    () => fetchInhireJobs("acme"),
  );

  // j1 é coletada; j2, j3 e j4 são timeouts consecutivos → abandona no terceiro,
  // preservando a vaga já coletada e sem tocar em j5+.
  assert.deepEqual(
    jobs.map((job) => job.id),
    ["j1"],
  );
  assert.equal(detailRequests.length, 4);
});

test("uma requisição bem-sucedida reinicia a contagem de timeouts", async () => {
  const detailRequests = [];

  const jobs = await withFetch(
    async (url) => {
      if (url === LIST_URL) {
        return response({
          tenantName: "Acme",
          jobsPage: [
            summary("j1", "Primeira"),
            summary("j2", "Segunda"),
            summary("j3", "Terceira"),
            summary("j4", "Quarta"),
            summary("j5", "Quinta"),
          ],
        });
      }
      detailRequests.push(url);
      // j3 é bem-sucedida e reinicia o contador; j4 e j5 são novos timeouts.
      if (url.endsWith("/j3")) {
        return response({ displayName: "Terceira", description: "ok" });
      }
      throw timeoutError();
    },
    () => fetchInhireJobs("acme"),
  );

  // Sem o reset, o break ocorreria em j4 (3º timeout consecutivo); com o reset,
  // toda a lista é percorrida e apenas a vaga bem-sucedida é coletada.
  assert.deepEqual(
    jobs.map((job) => job.id),
    ["j3"],
  );
  assert.equal(detailRequests.length, 5);
});

test("empresa saudável com coleta acima de 45 s não é truncada", async () => {
  // Sem orçamento fixo de tempo: a coleta inteira de uma empresa saudável deve
  // ser preservada, mesmo quando o tempo acumulado ultrapassa os antigos 45 s.
  // O relógio monotônico é simulado (avança a cada requisição) para não
  // depender de espera real; o estado do teto compartilhado fica à frente das
  // reservas, então nenhuma espera artificial é introduzida.
  //
  // Este teste avança o relógio monotônico muito à frente e é, por isso, o
  // ÚLTIMO do arquivo: o estado compartilhado do teto (por módulo) não pode
  // contaminar os demais testes com esperas artificiais.
  const STEP_MS = 30_000;
  const realNow = globalThis.performance.now.bind(globalThis.performance);
  let fake = 0;
  globalThis.performance.now = () => (fake += STEP_MS);

  const detailRequests = [];

  try {
    const jobs = await withFetch(
      async (url) => {
        if (url === LIST_URL) {
          return response({
            tenantName: "Acme",
            jobsPage: [
              summary("j1", "Primeira"),
              summary("j2", "Segunda"),
              summary("j3", "Terceira"),
            ],
          });
        }
        detailRequests.push(url);
        return response({ displayName: "Vaga", description: "ok" });
      },
      () => fetchInhireJobs("acme"),
    );

    // ~120 s simulados: com o antigo orçamento de 45 s, j3 seria descartada.
    assert.deepEqual(
      jobs.map((job) => job.id),
      ["j1", "j2", "j3"],
    );
    assert.equal(detailRequests.length, 3);
  } finally {
    globalThis.performance.now = realNow;
  }
});
