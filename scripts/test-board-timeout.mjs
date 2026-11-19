// Testes determinísticos do timeout (15s) dos boards públicos.
//
// Uso:  npm run build
//       node scripts/test-board-timeout.mjs
//
// Não realizam scraping nem chamadas externas: substituem `globalThis.fetch`
// por um stub local. Não dependem de esperas reais de 15 segundos — o
// cancelamento por timeout é simulado com o mesmo erro nativo que o
// `AbortSignal.timeout` propaga (DOMException de nome "TimeoutError"),
// confirmado localmente no runtime do projeto.

import { test } from "node:test";
import assert from "node:assert/strict";

const { BOARD_REQUEST_TIMEOUT_MS, BoardTimeoutError, isTimeoutError, fetchBoardWithTimeout } =
  await import("../dist/providers/board-http.js");
const { fetchGreenhouseJobs } = await import("../dist/providers/greenhouse.js");
const { fetchLeverJobs } = await import("../dist/providers/lever.js");
const { fetchAshbyJobs } = await import("../dist/providers/ashby.js");

/** Erro nativo de timeout, idêntico ao propagado pelo AbortSignal.timeout. */
function timeoutError() {
  return new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError",
  );
}

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

test("timeout dos boards públicos é de 15 segundos", () => {
  assert.equal(BOARD_REQUEST_TIMEOUT_MS, 15000);
});

test("isTimeoutError reconhece apenas cancelamentos por timeout", () => {
  assert.equal(isTimeoutError(timeoutError()), true);

  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  assert.equal(isTimeoutError(abortError), true);

  assert.equal(isTimeoutError(new Error("falha comum")), false);
  assert.equal(isTimeoutError(undefined), false);
  assert.equal(isTimeoutError("429"), false);
});

test("requisição concluída normalmente devolve as vagas e anexa o sinal de timeout", async () => {
  const calls = [];

  const jobs = await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      return response({
        jobs: [
          {
            id: 7,
            title: "Desenvolvedor",
            absolute_url: "https://boards.greenhouse.io/acme/jobs/7",
            content: "<p>vaga</p>",
            location: { name: "Remote - Brazil" },
          },
        ],
      });
    },
    () => fetchGreenhouseJobs("acme"),
  );

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "7");
  assert.equal(jobs[0].source, "greenhouse");

  // O cancelamento é feito por um sinal nativo anexado à requisição.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.signal.aborted, false);
});

test("cancelamento por timeout é convertido em BoardTimeoutError", async () => {
  await withFetch(
    async () => {
      throw timeoutError();
    },
    async () => {
      await assert.rejects(
        () => fetchGreenhouseJobs("acme"),
        (error) => {
          assert.ok(error instanceof BoardTimeoutError);
          assert.equal(error.source, "greenhouse");
          assert.equal(error.timeoutMs, 15000);
          return true;
        },
      );
    },
  );
});

test("timeout durante a leitura do corpo da resposta é tratado", async () => {
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw timeoutError();
      },
    }),
    async () => {
      await assert.rejects(
        () => fetchLeverJobs("acme"),
        (error) => {
          assert.ok(error instanceof BoardTimeoutError);
          assert.equal(error.source, "lever");
          return true;
        },
      );
    },
  );
});

test("erros HTTP que não são timeout são preservados (sem conversão)", async () => {
  await withFetch(
    async () =>
      response(undefined, {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      }),
    async () => {
      await assert.rejects(
        () => fetchAshbyJobs("acme"),
        (error) => {
          assert.equal(error instanceof BoardTimeoutError, false);
          assert.match(error.message, /503/);
          return true;
        },
      );
    },
  );
});

test("erros que não são timeout são repropagados sem alteração", async () => {
  const original = new Error("ECONNRESET");

  await withFetch(
    async () => {
      throw original;
    },
    async () => {
      await assert.rejects(
        () => fetchBoardWithTimeout("https://exemplo.test", "greenhouse", async () => 1),
        (error) => {
          assert.equal(error, original);
          return true;
        },
      );
    },
  );
});

test("falha de um board não afeta os demais (isolamento entre providers)", async () => {
  await withFetch(
    async (url) => {
      if (url.includes("greenhouse")) {
        throw timeoutError();
      }

      if (url.includes("lever")) {
        return response([
          {
            id: "l1",
            text: "Desenvolvedor",
            categories: { location: "Remote" },
            hostedUrl: "https://jobs.lever.co/acme/l1",
          },
        ]);
      }

      return response({
        jobs: [
          {
            title: "Desenvolvedor",
            jobUrl: "https://jobs.ashbyhq.com/acme/1",
            workplaceType: "Remote",
          },
        ],
      });
    },
    async () => {
      const results = await Promise.allSettled([
        fetchGreenhouseJobs("acme"),
        fetchLeverJobs("acme"),
        fetchAshbyJobs("acme"),
      ]);

      // Somente o provider em timeout falha; os demais concluem normalmente.
      assert.equal(results[0].status, "rejected");
      assert.ok(results[0].reason instanceof BoardTimeoutError);
      assert.equal(results[0].reason.source, "greenhouse");

      assert.equal(results[1].status, "fulfilled");
      assert.equal(results[1].value.length, 1);
      assert.equal(results[1].value[0].source, "lever");

      assert.equal(results[2].status, "fulfilled");
      assert.equal(results[2].value.length, 1);
      assert.equal(results[2].value[0].source, "ashby");
    },
  );
});
