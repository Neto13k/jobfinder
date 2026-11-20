// Testes determinísticos da análise em LOTE do Gemini (funções puras).
//
// Não realiza chamadas reais à API: valida o dimensionamento do lote, a
// montagem do prompt com múltiplas vagas (cada uma identificada por chave
// única) e a validação individual das respostas, aproveitando apenas os
// resultados válidos.
//
// Uso:   npm run build
//        node scripts/test-ai-batch.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  buildBatchPrompt,
  parseBatchAnalyses,
  resolveBatchSize,
  resolveConfiguredBatchSize,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
} = await import("../dist/services/ai-analyzer.js");
const { generateJobKey } = await import("../dist/services/deduplication.js");

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
    source: "batch-test",
    ...overrides,
  };
}

/** Monta uma análise completa (campos da IA + chave) com sobreposições. */
function item(key, overrides) {
  return {
    key,
    score: 80,
    reason: "CLT remoto Brasil",
    seniorityStatus: "allowed",
    technologiesStatus: "allowed",
    locationStatus: "allowed",
    contractStatus: "allowed",
    ...overrides,
  };
}

// --- Dimensionamento do lote -----------------------------------------------

test("os tamanhos padrão e máximo do lote são 5 e 10", () => {
  assert.equal(DEFAULT_BATCH_SIZE, 5);
  assert.equal(MAX_BATCH_SIZE, 10);
});

test("resolveBatchSize limita pelo saldo, pelo teto e pelo valor desejado", () => {
  // Saldo suficiente: usa o valor desejado (padrão 5).
  assert.equal(resolveBatchSize(100), DEFAULT_BATCH_SIZE);
  assert.equal(resolveBatchSize(5), 5);

  // Saldo menor que o desejado: limitado ao saldo.
  assert.equal(resolveBatchSize(3), 3);

  // Saldo nulo ou inválido: nenhuma vaga deve ser enviada.
  assert.equal(resolveBatchSize(0), 0);
  assert.equal(resolveBatchSize(-4), 0);
  assert.equal(resolveBatchSize(2.5), 0);

  // Valor desejado explícito é limitado pelo teto absoluto.
  assert.equal(resolveBatchSize(100, 10), 10);
  assert.equal(resolveBatchSize(100, 50), MAX_BATCH_SIZE);
  assert.equal(resolveBatchSize(4, 10), 4);

  // Valor desejado inválido também resulta em 0.
  assert.equal(resolveBatchSize(10, 0), 0);
  assert.equal(resolveBatchSize(10, 2.5), 0);
});

test("testes de regressão para a configuração independente do tamanho do lote", () => {
  // Variável própria: padrão 5 quando ausente ou inválida, teto de 10.
  assert.equal(resolveConfiguredBatchSize({}), DEFAULT_BATCH_SIZE);
  assert.equal(
    resolveConfiguredBatchSize({ JOBFINDER_ANALYSIS_BATCH_SIZE: "8" }),
    8,
  );
  assert.equal(
    resolveConfiguredBatchSize({ JOBFINDER_ANALYSIS_BATCH_SIZE: "1" }),
    1,
  );
  // Teto absoluto: valores acima de 10 são limitados.
  assert.equal(
    resolveConfiguredBatchSize({ JOBFINDER_ANALYSIS_BATCH_SIZE: "50" }),
    MAX_BATCH_SIZE,
  );
  // Valores inválidos mantêm o padrão.
  for (const raw of ["0", "-3", "2.5", "abc", "  ", "10 x"]) {
    assert.equal(
      resolveConfiguredBatchSize({ JOBFINDER_ANALYSIS_BATCH_SIZE: raw }),
      DEFAULT_BATCH_SIZE,
    );
  }
});

// --- Montagem do prompt do lote --------------------------------------------

test("buildBatchPrompt delimita uma vaga por bloco, identificada pela chave", () => {
  const jobs = [
    job({ id: "a", source: "src" }),
    job({ id: "b", source: "src" }),
    job({ id: "c", source: "src" }),
  ];
  const prompt = buildBatchPrompt(jobs);

  // Um bloco por vaga, com a chave única repetida exatamente.
  assert.equal(prompt.split("<<<VAGA key=").length - 1, jobs.length);
  assert.equal(prompt.split("VAGA>>>").length - 1, jobs.length);
  for (const current of jobs) {
    assert.ok(prompt.includes(`<<<VAGA key=${generateJobKey(current)}`));
  }

  // Instrui a análise independente e reaproveita o corpo de cada vaga.
  assert.ok(prompt.includes("INDEPENDENTE"));
  assert.ok(prompt.includes("analyses"));
  assert.ok(prompt.includes("Título:"));
  assert.ok(prompt.includes("<<<DESCRICAO"));
});

// --- Validação individual das respostas ------------------------------------

test("parseBatchAnalyses deriva a decisão de cada item válido", () => {
  const keys = new Set(["src:1", "src:2"]);
  const result = parseBatchAnalyses(
    {
      analyses: [
        item("src:1", { score: 70 }),
        item("src:2", { seniorityStatus: "blocked", score: 40 }),
      ],
    },
    keys,
  );

  assert.equal(result.size, 2);
  assert.equal(result.get("src:1").decision, "compatible");
  assert.equal(result.get("src:1").score, 70);
  // A decisão é derivada dos critérios: senioridade bloqueada => incompatível.
  assert.equal(result.get("src:2").decision, "incompatible");

  // A decisão enviada pela IA é ignorada.
  const derived = parseBatchAnalyses(
    { analyses: [item("src:1", { decision: "incompatible" })] },
    keys,
  );
  assert.equal(derived.get("src:1").decision, "compatible");
});

test("parseBatchAnalyses aproveita os válidos e descarta os demais", () => {
  const keys = new Set(["src:1", "src:2", "src:3"]);
  const result = parseBatchAnalyses(
    {
      analyses: [
        item("src:1", { score: 70 }),
        // Chave desconhecida: ignorada.
        item("outro:9"),
        // Repetição IDÊNTICA: redundante, mantém o resultado válido.
        item("src:1", { score: 70 }),
        // Item estruturalmente inválido: ignorado sem invalidar os demais.
        item("src:2", { contractStatus: "talvez" }),
        // Item que não é objeto: ignorado.
        "não é um objeto",
        null,
      ],
    },
    keys,
  );

  // Somente "src:1" é válido; "src:3" está ausente da resposta.
  assert.equal(result.size, 1);
  assert.equal(result.get("src:1").score, 70);
  assert.equal(result.has("src:2"), false);
  assert.equal(result.has("src:3"), false);
  assert.equal(result.has("outro:9"), false);
});

test("parseBatchAnalyses descarta duplicados conflitantes e preserva os demais", () => {
  const keys = new Set(["src:1", "src:2", "src:3"]);
  const result = parseBatchAnalyses(
    {
      analyses: [
        item("src:1", { score: 70 }),
        item("src:2", { score: 55 }),
        // Mesma chave com análise DIVERGENTE: ambígua => chave descartada.
        item("src:1", { score: 10 }),
        // Repetição idêntica à conflitante não reabilita a chave.
        item("src:1", { score: 10 }),
      ],
    },
    keys,
  );

  // A chave conflitante é descartada; o resultado independente é preservado.
  assert.equal(result.has("src:1"), false);
  assert.equal(result.get("src:2").score, 55);
  assert.equal(result.size, 1);
});

test("parseBatchAnalyses rejeita respostas sem o formato mínimo", () => {
  const keys = new Set(["src:1"]);
  assert.throws(() => parseBatchAnalyses(null, keys), /formato inválido/);
  assert.throws(() => parseBatchAnalyses("texto", keys), /formato inválido/);
  assert.throws(() => parseBatchAnalyses({}, keys), /analyses/);
  assert.throws(() => parseBatchAnalyses({ analyses: "x" }, keys), /analyses/);
});
