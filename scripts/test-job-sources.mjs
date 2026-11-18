// Testes determinísticos da configuração de fontes (boards públicos).
//
// Uso:  npm run build
//       node scripts/test-job-sources.mjs
//
// Não realizam scraping nem chamadas externas: validam apenas a estrutura da
// lista `BOARD_JOB_SOURCES` (identificadores, duplicidades e compatibilidade
// com os providers implementados).

import { test } from "node:test";
import assert from "node:assert/strict";

const { BOARD_JOB_SOURCES } = await import("../dist/config/job-sources.js");

/** Providers de board efetivamente implementados no pipeline. */
const SUPPORTED_BOARD_PROVIDERS = ["greenhouse", "lever", "ashby"];

/** Identificador usado nas chaves (provider + identificador). */
const sourceKey = (source) => `${source.provider}:${source.identifier}`;

test("a configuração de fontes não está vazia", () => {
  assert.ok(Array.isArray(BOARD_JOB_SOURCES));
  assert.ok(BOARD_JOB_SOURCES.length > 0);
});

test("todos os providers são suportados pelos providers implementados", () => {
  for (const source of BOARD_JOB_SOURCES) {
    assert.ok(
      SUPPORTED_BOARD_PROVIDERS.includes(source.provider),
      `provider não suportado: ${source.provider}`,
    );
  }

  // Os três providers de board devem estar efetivamente representados.
  const providers = new Set(BOARD_JOB_SOURCES.map((s) => s.provider));
  for (const provider of SUPPORTED_BOARD_PROVIDERS) {
    assert.ok(providers.has(provider), `nenhuma fonte do provider ${provider}`);
  }
});

test("cada identificador é uma string não vazia e segura como segmento de URL", () => {
  for (const source of BOARD_JOB_SOURCES) {
    assert.equal(typeof source.identifier, "string");
    assert.ok(source.identifier.length > 0, "identificador vazio");
    // Sem espaços nem barras: o valor é usado como segmento de caminho.
    assert.doesNotMatch(source.identifier, /\s/, `espaço em "${source.identifier}"`);
    assert.doesNotMatch(source.identifier, /\//, `barra em "${source.identifier}"`);
    // Sem espaços nas bordas já cobertos acima; garante ausência de vazio.
    assert.equal(source.identifier, source.identifier.trim());
  }
});

test("não há fontes duplicadas (provider + identificador)", () => {
  const seen = new Set();

  for (const source of BOARD_JOB_SOURCES) {
    const key = sourceKey(source);
    assert.equal(seen.has(key), false, `fonte duplicada: ${key}`);
    seen.add(key);
  }
});

test("as fontes validadas na etapa 8 estão presentes", () => {
  const keys = new Set(BOARD_JOB_SOURCES.map(sourceKey));

  // Ancoragens de regressão: uma amostra de cada provider e de empresas
  // brasileiras/internacionais confirmadas na validação controlada.
  const expected = [
    "greenhouse:ifoodcarreiras",
    "greenhouse:xpinc",
    "greenhouse:inter",
    "greenhouse:c6bank",
    "greenhouse:stone",
    "lever:ciandt",
    "lever:bluelightconsulting",
    "lever:oowlish",
    "ashby:nubank",
    "ashby:canals",
    "ashby:truelogic",
  ];

  for (const key of expected) {
    assert.ok(keys.has(key), `fonte esperada ausente: ${key}`);
  }
});

test("a expansão cobre uma quantidade relevante de fontes por provider", () => {
  const countByProvider = { greenhouse: 0, lever: 0, ashby: 0 };

  for (const source of BOARD_JOB_SOURCES) {
    countByProvider[source.provider]++;
  }

  // Limites mínimos: garantem que a expansão não regrediu silenciosamente.
  assert.ok(countByProvider.greenhouse >= 20, "Greenhouse abaixo do esperado");
  assert.ok(countByProvider.lever >= 3, "Lever abaixo do esperado");
  assert.ok(countByProvider.ashby >= 8, "Ashby abaixo do esperado");
});
