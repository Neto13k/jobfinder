// Testes determinísticos do analisador Gemini (funções puras).
//
// Não realiza chamadas reais à API: valida apenas as regras do prompt e a
// consistência da validação das respostas estruturadas.
//
// Uso:   npm run build
//        node scripts/test-ai-analyzer.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { buildPrompt, parseAnalysis, SYSTEM_INSTRUCTION } = await import(
  "../dist/services/ai-analyzer.js"
);
const { classifyGeminiError, GeminiAnalysisError } = await import(
  "../dist/services/ai-analyzer.js"
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

// --- Regras do prompt ------------------------------------------------------

test("instrução do sistema cobre contratação, localização, senioridade e tecnologias", () => {
  const rules = SYSTEM_INSTRUCTION.toLowerCase();

  // Contratação: aceitar CLT/estágio, bloquear PJ, não presumir o tipo.
  assert.ok(rules.includes("clt"));
  assert.ok(rules.includes("estágio"));
  assert.ok(rules.includes("pj"));
  assert.ok(rules.includes("unknown"));

  // Localização: Maceió/AL, remoto no Brasil, regiões amplas e restrições.
  assert.ok(rules.includes("maceió"));
  assert.ok(rules.includes("latam"));
  assert.ok(rules.includes("worldwide"));
  assert.ok(rules.includes("global"));
  assert.ok(rules.includes("restrições explícitas de residência"));

  // Senioridade: júnior/estágio/trainee e ausência de senioridade.
  assert.ok(rules.includes("trainee"));
  assert.ok(rules.includes("sem senioridade informada"));

  // Tecnologias obrigatórias e desejáveis.
  assert.ok(rules.includes("next.js"));
  assert.ok(rules.includes("sass"));
  assert.ok(rules.includes("node.js"));
  assert.ok(rules.includes("postgresql"));
  assert.ok(rules.includes("rest"));
  assert.ok(rules.includes("obrigatórias"));
  assert.ok(rules.includes("desejáveis"));

  // Consistência e proteção contra injeção de prompt.
  assert.ok(rules.includes("não invente"));
  assert.ok(rules.includes("insuficientes"));
  assert.ok(rules.includes("dado"));
});

test("buildPrompt inclui os dados da vaga e a evidência auxiliar de localização", () => {
  const prompt = buildPrompt(job({ location: "Remoto - Brasil" }));

  assert.ok(prompt.includes("Título:"));
  assert.ok(prompt.includes("Empresa:"));
  assert.ok(prompt.includes("Localização:"));
  assert.ok(prompt.includes("Remota (flag):"));
  assert.ok(prompt.includes("evidência auxiliar"));
  assert.ok(prompt.includes("DESCRICAO"));
  assert.ok(prompt.includes("allowed"));
});

test("buildPrompt reflete a triagem geográfica como evidência auxiliar", () => {
  const allowed = buildPrompt(job({ location: "Remoto - Brasil" }));
  const blocked = buildPrompt(
    job({ location: "US residents only", remote: true }),
  );
  const unknown = buildPrompt(job({ location: "", remote: true }));

  assert.ok(allowed.includes("evidência auxiliar, não é prova absoluta): allowed"));
  assert.ok(blocked.includes("evidência auxiliar, não é prova absoluta): blocked"));
  assert.ok(unknown.includes("evidência auxiliar, não é prova absoluta): unknown"));
});

test("buildPrompt trata a descrição como dado delimitado e a trunca", () => {
  const longDescription = "a".repeat(5000);
  const prompt = buildPrompt(job({ description: longDescription }));

  // Descrição limitada a 4000 caracteres, mantendo os delimitadores.
  assert.ok(!prompt.includes("a".repeat(4001)));
  assert.ok(prompt.includes("conteúdo não confiável"));
  assert.ok(prompt.includes("<<<DESCRICAO"));
  assert.ok(prompt.includes("DESCRICAO>>>"));
});

// --- Validação das respostas estruturadas ----------------------------------

const VALID = {
  decision: "compatible",
  score: 90,
  reason: "ok",
  locationStatus: "allowed",
  contractStatus: "allowed",
};

test("parseAnalysis preserva a decisão quando os critérios são válidos", () => {
  assert.deepEqual(parseAnalysis({ ...VALID }), { ...VALID });
  assert.equal(
    parseAnalysis({ ...VALID, decision: "incompatible" }).decision,
    "incompatible",
  );
  assert.equal(parseAnalysis({ ...VALID, decision: "review" }).decision, "review");
});

test("parseAnalysis aplica a regra de negócio de bloqueio e revisão", () => {
  // Bloqueio em qualquer critério torna a vaga incompatível.
  assert.equal(
    parseAnalysis({ ...VALID, locationStatus: "blocked" }).decision,
    "incompatible",
  );
  assert.equal(
    parseAnalysis({ ...VALID, contractStatus: "blocked" }).decision,
    "incompatible",
  );

  // "compatible" com critério indefinido é rebaixado para "review".
  assert.equal(
    parseAnalysis({ ...VALID, locationStatus: "unknown" }).decision,
    "review",
  );
  assert.equal(
    parseAnalysis({ ...VALID, contractStatus: "unknown" }).decision,
    "review",
  );
});

test("parseAnalysis normaliza o score para o intervalo 0..100", () => {
  assert.equal(parseAnalysis({ ...VALID, score: 150 }).score, 100);
  assert.equal(parseAnalysis({ ...VALID, score: -10 }).score, 0);
  assert.equal(parseAnalysis({ ...VALID, score: 89.6 }).score, 90);
});

test("parseAnalysis normaliza a justificativa", () => {
  assert.equal(parseAnalysis({ ...VALID, reason: "  ok  " }).reason, "ok");
});

test("parseAnalysis rejeita respostas estruturalmente inválidas", () => {
  assert.throws(() => parseAnalysis(null), /formato inválido/);
  assert.throws(() => parseAnalysis("texto"), /formato inválido/);
  assert.throws(() => parseAnalysis({ ...VALID, decision: "talvez" }), /decision/);
  assert.throws(
    () => parseAnalysis({ ...VALID, locationStatus: "maybe" }),
    /locationStatus/,
  );
  assert.throws(
    () => parseAnalysis({ ...VALID, contractStatus: "maybe" }),
    /contractStatus/,
  );
  assert.throws(() => parseAnalysis({ ...VALID, score: "90" }), /score/);
  assert.throws(() => parseAnalysis({ ...VALID, score: Number.NaN }), /score/);
  assert.throws(() => parseAnalysis({ ...VALID, reason: "   " }), /reason/);
});

// --- Classificação das falhas do Gemini ------------------------------------
//
// A resiliência do pipeline depende de distinguir falhas temporárias/globais
// (cota, indisponibilidade, rede, autenticação) das falhas da própria resposta.
// A classificação usa apenas sinais estruturados (status HTTP e nome do erro de
// cancelamento), então pode ser validada sem chamar a API.

test("classifyGeminiError categoriza falhas HTTP por status", () => {
  // 429: limite de requisições ou cota esgotada.
  assert.deepEqual(classifyGeminiError({ status: 429 }), {
    kind: "rate_limit",
    status: 429,
  });

  // 401/403: credencial ausente, inválida ou sem permissão.
  assert.equal(classifyGeminiError({ status: 401 }).kind, "auth");
  assert.equal(classifyGeminiError({ status: 403 }).kind, "auth");

  // 408 e 5xx: indisponibilidade temporária do serviço.
  for (const status of [408, 500, 502, 503, 504]) {
    assert.deepEqual(classifyGeminiError({ status }), {
      kind: "unavailable",
      status,
    });
  }
});

test("classifyGeminiError trata o cancelamento por timeout", () => {
  const abort = new Error("abortado");
  abort.name = "AbortError";
  assert.deepEqual(classifyGeminiError(abort), { kind: "timeout" });

  const timeout = new Error("timeout");
  timeout.name = "TimeoutError";
  assert.deepEqual(classifyGeminiError(timeout), { kind: "timeout" });
});

test("classifyGeminiError trata status desconhecido e erros sem status", () => {
  // Status fora das faixas conhecidas permanece com o status preservado.
  assert.deepEqual(classifyGeminiError({ status: 400 }), {
    kind: "unknown",
    status: 400,
  });

  // Erro sem status (falha de rede local) é "unknown" sem status.
  assert.deepEqual(classifyGeminiError(new Error("ECONNRESET")), {
    kind: "unknown",
  });

  // Valores que não são inteiros não são aceitos como status.
  assert.deepEqual(classifyGeminiError({ status: "429" }), { kind: "unknown" });
  assert.deepEqual(classifyGeminiError(null), { kind: "unknown" });
});

test("GeminiAnalysisError preserva categoria, status e identidade", () => {
  const error = new GeminiAnalysisError("rate_limit", "cota", { status: 429 });

  assert.ok(error instanceof GeminiAnalysisError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "GeminiAnalysisError");
  assert.equal(error.kind, "rate_limit");
  assert.equal(error.status, 429);
});
