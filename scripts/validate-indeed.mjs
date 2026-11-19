// Validação determinística LOCAL da matriz de buscas e da rotação do Indeed.
//
// Exclusivamente local: não faz chamadas externas. Confere apenas as
// configurações e a seleção de lote para horas UTC fixas (sem depender do
// relógio). É executada pelo `npm test`.
//
// Requer build prévio: `npm run build`.
import assert from "node:assert/strict";
import {
  INDEED_LOCAL_SEARCHES,
  INDEED_REMOTE_SEARCHES,
  INDEED_RESULTS_WANTED,
} from "../dist/config/indeed-searches.js";
import {
  INDEED_REMOTES_PER_BATCH,
  INDEED_TOTAL_BATCHES,
  selectIndeedBatch,
} from "../dist/services/indeed-search-rotation.js";

/** Duração de uma hora em milissegundos, base da rotação por hora UTC. */
const MS_PER_HOUR = 3_600_000;

/** Localização das pesquisas locais de Maceió/AL. */
const LOCAL_LOCATION = "Maceió, AL";

/** Localização das pesquisas remotas nacionais. */
const REMOTE_LOCATION = "Brazil";

/**
 * Validação local determinística da matriz de buscas e das regras de rotação.
 *
 * Não faz chamadas externas: confere apenas as configurações e a seleção de
 * lote para horas UTC fixas (sem depender do relógio).
 */
function validateRotationLocally() {
  // 1) Dimensões da matriz: 22 locais + 88 remotas (22 lotes de 5).
  assert.equal(INDEED_LOCAL_SEARCHES.length, INDEED_TOTAL_BATCHES);
  assert.equal(
    INDEED_REMOTE_SEARCHES.length,
    INDEED_TOTAL_BATCHES * INDEED_REMOTES_PER_BATCH,
  );

  // 2) Termos sem duplicatas dentro de cada grupo.
  const localTerms = INDEED_LOCAL_SEARCHES.map((search) => search.searchTerm);
  const remoteTerms = INDEED_REMOTE_SEARCHES.map((search) => search.searchTerm);
  assert.equal(new Set(localTerms).size, localTerms.length);
  assert.equal(new Set(remoteTerms).size, remoteTerms.length);

  // 3) Atributos das pesquisas locais e remotas.
  for (const search of INDEED_LOCAL_SEARCHES) {
    assert.equal(search.provider, "indeed");
    assert.equal(search.location, LOCAL_LOCATION);
    assert.equal(search.isRemote, undefined);
    assert.equal(search.resultsWanted, INDEED_RESULTS_WANTED);
  }
  for (const search of INDEED_REMOTE_SEARCHES) {
    assert.equal(search.provider, "indeed");
    assert.equal(search.location, REMOTE_LOCATION);
    assert.equal(search.isRemote, true);
    assert.equal(search.resultsWanted, INDEED_RESULTS_WANTED);
  }

  // 4) Rotação: cada hora UTC mapeia para um lote fixo de 1 local + 4 remotas.
  const seenBatches = new Set();
  const seenLocals = new Set();
  const seenRemotes = new Set();
  for (let hour = 0; hour < INDEED_TOTAL_BATCHES; hour++) {
    const date = new Date(hour * MS_PER_HOUR);
    const batch = selectIndeedBatch(date);

    seenBatches.add(batch.batchNumber);
    seenLocals.add(batch.local.searchTerm);
    assert.equal(batch.searches.length, 1 + INDEED_REMOTES_PER_BATCH);
    assert.equal(batch.remotes.length, INDEED_REMOTES_PER_BATCH);
    assert.equal(batch.local, INDEED_LOCAL_SEARCHES[batch.batchNumber - 1]);
    assert.equal(batch.searches[0], batch.local);
    for (const remote of batch.remotes) {
      seenRemotes.add(remote.searchTerm);
      assert.equal(remote.isRemote, true);
      assert.equal(remote.location, REMOTE_LOCATION);
    }

    // Determinismo: a mesma hora sempre produz o mesmo lote.
    assert.deepEqual(selectIndeedBatch(date).searches, batch.searches);

    // Ciclo de 22 horas: a hora + 22 repete o mesmo lote.
    const nextCycle = selectIndeedBatch(
      new Date((hour + INDEED_TOTAL_BATCHES) * MS_PER_HOUR),
    );
    assert.equal(nextCycle.batchNumber, batch.batchNumber);
  }

  // As 22 horas do ciclo cobrem os 22 lotes, uma vez cada.
  assert.equal(seenBatches.size, INDEED_TOTAL_BATCHES);

  // Cobertura completa: cada termo (local e remoto) é selecionado exatamente
  // uma vez no ciclo (os termos são únicos, validado no passo 2).
  assert.equal(seenLocals.size, INDEED_LOCAL_SEARCHES.length);
  assert.equal(seenRemotes.size, INDEED_REMOTE_SEARCHES.length);
}

/** Executa a validação local determinística. */
function main() {
  validateRotationLocally();
  console.log(
    "[validate-indeed] Matriz de buscas e rotação validadas localmente (determinístico, sem rede).",
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[validate-indeed] Erro inesperado: ${message}`);
  process.exitCode = 1;
}
