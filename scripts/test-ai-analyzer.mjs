// Testes determinísticos do analisador Gemini (funções puras).
//
// Não realiza chamadas reais à API: valida apenas as regras do prompt e a
// consistência da validação das respostas estruturadas.
//
// Uso:   npm run build
//        node scripts/test-ai-analyzer.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  buildPrompt,
  parseAnalysis,
  SYSTEM_INSTRUCTION,
  resolveDescriptionBudget,
  DEFAULT_DESCRIPTION_BUDGET,
} = await import("../dist/services/ai-analyzer.js");
const { classifyGeminiError, GeminiAnalysisError } = await import(
  "../dist/services/ai-analyzer.js"
);
const {
  classifyGeminiHttpStatus,
  formatGeminiFailureDiagnostic,
} = await import("../dist/services/ai-analyzer.js");
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

// --- Regras do prompt ------------------------------------------------------

test("instrução do sistema cobre os quatro critérios independentes", () => {
  // Normaliza quebras de linha/indentação para comparar frases contíguas.
  const rules = SYSTEM_INSTRUCTION.toLowerCase().replace(/\s+/g, " ");

  // Contratação: aceitar CLT/estágio, bloquear PJ, não presumir o tipo.
  assert.ok(rules.includes("clt"));
  assert.ok(rules.includes("estágio"));
  assert.ok(rules.includes("pj"));
  assert.ok(rules.includes("unknown"));
  // CLT oferecida como alternativa real ao PJ é aceita.
  assert.ok(rules.includes("alternativa real ao pj"));

  // Localização: Maceió/AL, remoto no Brasil, regiões amplas e restrições.
  assert.ok(rules.includes("maceió"));
  assert.ok(rules.includes("latam"));
  assert.ok(rules.includes("worldwide"));
  assert.ok(rules.includes("global"));
  assert.ok(rules.includes("restrição explícita incompatível"));

  // Senioridade: entrada (júnior/estágio/trainee) e ausência de informação.
  assert.ok(rules.includes("júnior"));
  assert.ok(rules.includes("trainee"));
  assert.ok(rules.includes("sem senioridade informada"));

  // Tecnologias: aderência à stack, distinguindo obrigatórios, diferenciais
  // e menções incidentais.
  assert.ok(rules.includes("javascript"));
  assert.ok(rules.includes("typescript"));
  assert.ok(rules.includes("react"));
  assert.ok(rules.includes("node.js"));
  assert.ok(rules.includes("express"));
  assert.ok(rules.includes("postgresql"));
  // Tecnologias complementares do perfil (restauradas na TASK-05).
  assert.ok(rules.includes("next.js, html, css, sass, rest ou postgresql"));
  assert.ok(rules.includes("obrigatórios"));
  assert.ok(rules.includes("diferenciais"));
  assert.ok(rules.includes("incidentais"));
  // Funções alheias ao desenvolvimento são bloqueadas.
  assert.ok(rules.includes("não é de desenvolvimento"));

  // Combinação dos critérios e proteção contra injeção de prompt.
  assert.ok(rules.includes("blocked"));
  assert.ok(rules.includes("allowed"));
  assert.ok(rules.includes("não invente"));
  assert.ok(rules.includes("insuficientes"));
  assert.ok(rules.includes("dado"));
  assert.ok(rules.includes("ignore"));
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
  // Remoto sem restrição geográfica: presumido elegível (allowed).
  const allowedNoRestriction = buildPrompt(job({ location: "", remote: true }));
  // Restrição geográfica explícita: bloqueada.
  const blocked = buildPrompt(
    job({ location: "US residents only", remote: true }),
  );
  // Modalidade desconhecida (sem sinal textual nem flag): indefinida.
  const unknown = buildPrompt(job({ location: "Brazil", remote: false }));

  assert.ok(allowed.includes("evidência auxiliar, não é prova absoluta): allowed"));
  assert.ok(
    allowedNoRestriction.includes(
      "evidência auxiliar, não é prova absoluta): allowed",
    ),
  );
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

test("resolveDescriptionBudget usa o padrão e aceita override válido", () => {
  // Sem a variável de ambiente, mantém o orçamento padrão.
  assert.equal(resolveDescriptionBudget({}), DEFAULT_DESCRIPTION_BUDGET);

  // Inteiro positivo é aceito como orçamento.
  assert.equal(
    resolveDescriptionBudget({ JOBFINDER_ANALYSIS_DESCRIPTION_BUDGET: "1200" }),
    1200,
  );

  // Valores inválidos são ignorados (mantêm o padrão).
  for (const raw of ["0", "-5", "abc", "", "1200abc", "12.5", "1e3", "+30"]) {
    assert.equal(
      resolveDescriptionBudget({ JOBFINDER_ANALYSIS_DESCRIPTION_BUDGET: raw }),
      DEFAULT_DESCRIPTION_BUDGET,
    );
  }
});

test("buildPrompt respeita um orçamento explícito e preserva início e fim", () => {
  const description = `INICIO ${"x".repeat(500)} FIM`;
  const prompt = buildPrompt(job({ description }), 120);

  // O início e o fim do anúncio são preservados; o miolo é marcado como omitido.
  assert.ok(prompt.includes("INICIO"));
  assert.ok(prompt.includes("FIM"));
  assert.ok(prompt.includes("trecho omitido"));

  // A descrição efetivamente enviada cabe no orçamento.
  const sent = prompt.split("<<<DESCRICAO\n")[1].split("\nDESCRICAO>>>")[0];
  assert.ok(sent.length <= 120);
  assert.ok(sent.length < description.length);
});

test("buildPrompt preserva um trecho do meio da descrição", () => {
  // Requisito no MIOLO do anúncio não deve ser descartado no truncamento.
  const description = `INICIO ${"x".repeat(400)} MEIO_IMPORTANTE ${"y".repeat(400)} FIM`;
  const prompt = buildPrompt(job({ description }), 200);

  const sent = prompt.split("<<<DESCRICAO\n")[1].split("\nDESCRICAO>>>")[0];
  assert.ok(sent.length <= 200);
  assert.ok(sent.includes("INICIO"));
  assert.ok(sent.includes("FIM"));
  assert.ok(sent.includes("MEIO_IMPORTANTE"));
});

// --- Validação das respostas estruturadas ----------------------------------

const VALID = {
  score: 90,
  reason: "ok",
  seniorityStatus: "allowed",
  technologiesStatus: "allowed",
  locationStatus: "allowed",
  contractStatus: "allowed",
};

test("parseAnalysis deriva a decisão dos quatro critérios", () => {
  // Quatro critérios permitidos => compatível.
  assert.equal(parseAnalysis({ ...VALID }).decision, "compatible");

  // A decisão enviada pela IA é ignorada: a decisão é sempre derivada.
  assert.equal(
    parseAnalysis({ ...VALID, decision: "incompatible" }).decision,
    "compatible",
  );
  assert.equal(parseAnalysis({ ...VALID, decision: "review" }).decision, "compatible");
});

test("parseAnalysis aplica a regra de negócio de bloqueio e revisão", () => {
  const criteria = [
    "seniorityStatus",
    "technologiesStatus",
    "locationStatus",
    "contractStatus",
  ];

  // Bloqueio em qualquer critério torna a vaga incompatível, inclusive nas
  // dimensões de senioridade e tecnologias introduzidas na TASK-05.
  for (const field of criteria) {
    assert.equal(parseAnalysis({ ...VALID, [field]: "blocked" }).decision, "incompatible");
  }

  // "compatible" com qualquer critério indefinido é rebaixado para "review".
  for (const field of criteria) {
    assert.equal(parseAnalysis({ ...VALID, [field]: "unknown" }).decision, "review");
  }

  // O bloqueio tem precedência sobre a indefinição.
  assert.equal(
    parseAnalysis({
      ...VALID,
      seniorityStatus: "unknown",
      technologiesStatus: "blocked",
    }).decision,
    "incompatible",
  );
});

test("TASK-08: parser e política de notificação são coerentes na matriz", () => {
  // Os quatro critérios são permitidos; a política notifica.
  const base = {
    score: 80,
    reason: "ok",
    seniorityStatus: "allowed",
    technologiesStatus: "allowed",
  };

  assert.equal(
    classifyNotification(
      parseAnalysis({
        ...base,
        locationStatus: "allowed",
        contractStatus: "allowed",
      }),
    ),
    "compatible",
  );

  // Qualquer critério indefinido (sem bloqueio) exige revisão manual.
  for (const [locationStatus, contractStatus] of [
    ["allowed", "unknown"],
    ["unknown", "allowed"],
    ["unknown", "unknown"],
  ]) {
    assert.equal(
      classifyNotification(
        parseAnalysis({ ...base, locationStatus, contractStatus }),
      ),
      "manual_review",
    );
  }

  // Indefinição em senioridade ou tecnologias também exige revisão manual,
  // ainda que localização e contratação estejam permitidas.
  for (const field of ["seniorityStatus", "technologiesStatus"]) {
    assert.equal(
      classifyNotification(
        parseAnalysis({
          ...base,
          [field]: "unknown",
          locationStatus: "allowed",
          contractStatus: "allowed",
        }),
      ),
      "manual_review",
    );
  }

  // Bloqueio em qualquer critério rebaixa para "incompatible" e não notifica.
  for (const field of [
    "seniorityStatus",
    "technologiesStatus",
    "locationStatus",
    "contractStatus",
  ]) {
    assert.equal(
      classifyNotification(
        parseAnalysis({
          ...base,
          [field]: "blocked",
          locationStatus: field === "locationStatus" ? "blocked" : "allowed",
          contractStatus: field === "contractStatus" ? "blocked" : "allowed",
        }),
      ),
      null,
    );
  }
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
  assert.throws(
    () => parseAnalysis({ ...VALID, seniorityStatus: "maybe" }),
    /seniorityStatus/,
  );
  assert.throws(
    () => parseAnalysis({ ...VALID, technologiesStatus: "maybe" }),
    /technologiesStatus/,
  );
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

  // Campo obrigatório ausente também é rejeitado.
  const missing = { ...VALID };
  delete missing.seniorityStatus;
  assert.throws(() => parseAnalysis(missing), /seniorityStatus/);
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

test("classifyGeminiHttpStatus distingue 408/5xx, outros status e ausência", () => {
  // 408 e 5xx: indisponibilidade do serviço.
  for (const status of [408, 500, 502, 503, 504, 599]) {
    assert.equal(classifyGeminiHttpStatus(status), "server");
  }

  // Demais status HTTP identificáveis (inclui 429 e 4xx).
  for (const status of [400, 404, 429]) {
    assert.equal(classifyGeminiHttpStatus(status), "client");
  }

  // Sem status identificável.
  assert.equal(classifyGeminiHttpStatus(undefined), "none");
});

test("formatGeminiFailureDiagnostic expõe categoria e status, sem dados sensíveis", () => {
  // 5xx: marcado como indisponibilidade.
  const unavailable = new GeminiAnalysisError(
    "unavailable",
    "Falha ao consultar a API Gemini.",
    { status: 503 },
  );
  assert.equal(
    formatGeminiFailureDiagnostic(unavailable),
    "categoria: unavailable | HTTP: 503 (indisponibilidade 408/5xx)",
  );

  // 408 também é indisponibilidade.
  assert.equal(
    formatGeminiFailureDiagnostic(
      new GeminiAnalysisError("unavailable", "x", { status: 408 }),
    ),
    "categoria: unavailable | HTTP: 408 (indisponibilidade 408/5xx)",
  );

  // 429: status preservado, sem rótulo de indisponibilidade.
  assert.equal(
    formatGeminiFailureDiagnostic(
      new GeminiAnalysisError("rate_limit", "x", { status: 429 }),
    ),
    "categoria: rate_limit | HTTP: 429",
  );

  // Sem status identificável (ex.: falha de cota/rede sem HTTP).
  assert.equal(
    formatGeminiFailureDiagnostic(
      new GeminiAnalysisError("unavailable", "x"),
    ),
    "categoria: unavailable | HTTP: sem status identificável",
  );

  // Erro não reconhecido: categoria "unknown" e sem status; a mensagem bruta
  // do SDK NÃO é incluída no diagnóstico.
  const diagnostic = formatGeminiFailureDiagnostic(
    new Error("detalhe-interno-do-sdk-que-nao-deve-vazar"),
  );
  assert.equal(diagnostic, "categoria: unknown | HTTP: sem status identificável");
  assert.ok(!diagnostic.includes("detalhe-interno"));
});
