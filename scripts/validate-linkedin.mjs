// Validação do provider do LinkedIn.
//
// Dois modos:
//   node scripts/validate-linkedin.mjs            → validação LOCAL (sem rede).
//   node scripts/validate-linkedin.mjs --collect   → coleta real (fetchLinkedInJobs).
//
// Apenas a validação local é executada no `npm test`: é determinística e não
// faz chamadas externas. A coleta real (--collect) permanece manual e passa
// EXCLUSIVAMENTE por `fetchLinkedInJobs` (sem Gemini, Supabase ou Telegram).
//
// Requer build prévio: `npm run build`.
import assert from "node:assert/strict";
import {
  LINKEDIN_LOCAL_SEARCHES,
  LINKEDIN_REMOTE_SEARCHES,
  LINKEDIN_RESULTS_WANTED,
} from "../dist/config/linkedin-searches.js";
import {
  LINKEDIN_REMOTES_PER_BATCH,
  LINKEDIN_TOTAL_BATCHES,
  selectLinkedInBatch,
} from "../dist/services/linkedin-search-rotation.js";

/** Duração de uma hora em milissegundos, base da rotação por hora UTC. */
const MS_PER_HOUR = 3_600_000;

/** Localização e `geoId` das pesquisas locais de Maceió/AL. */
const LOCAL_LOCATION = "Maceio, Alagoas, Brazil";
const LOCAL_GEO_ID = "102957102";

/** Localização das pesquisas remotas nacionais. */
const REMOTE_LOCATION = "Brazil";

/** Parâmetros fixos da coleta real (modo --collect). */
const COLLECT_PARAMS = {
  searchTerm: "estágio desenvolvimento",
  location: LOCAL_LOCATION,
  geoId: LOCAL_GEO_ID,
  resultsWanted: 5,
  timeoutMs: 30_000,
};

/**
 * Validação local determinística da matriz de buscas e das regras de rotação.
 *
 * Não faz chamadas externas: confere apenas as configurações e a seleção de
 * lote para horas UTC fixas (sem depender do relógio).
 */
function validateRotationLocally() {
  // 1) Dimensões da matriz: 20 locais + 80 remotas (20 lotes de 5).
  assert.equal(LINKEDIN_LOCAL_SEARCHES.length, LINKEDIN_TOTAL_BATCHES);
  assert.equal(
    LINKEDIN_REMOTE_SEARCHES.length,
    LINKEDIN_TOTAL_BATCHES * LINKEDIN_REMOTES_PER_BATCH,
  );

  // 2) Termos sem duplicatas dentro de cada grupo.
  const localTerms = LINKEDIN_LOCAL_SEARCHES.map((search) => search.searchTerm);
  const remoteTerms = LINKEDIN_REMOTE_SEARCHES.map(
    (search) => search.searchTerm,
  );
  assert.equal(new Set(localTerms).size, localTerms.length);
  assert.equal(new Set(remoteTerms).size, remoteTerms.length);

  // 3) Atributos das pesquisas locais e remotas.
  for (const search of LINKEDIN_LOCAL_SEARCHES) {
    assert.equal(search.provider, "linkedin");
    assert.equal(search.location, LOCAL_LOCATION);
    assert.equal(search.geoId, LOCAL_GEO_ID);
    assert.equal(search.isRemote, undefined);
    assert.equal(search.resultsWanted, LINKEDIN_RESULTS_WANTED);
  }
  for (const search of LINKEDIN_REMOTE_SEARCHES) {
    assert.equal(search.provider, "linkedin");
    assert.equal(search.location, REMOTE_LOCATION);
    assert.equal(search.isRemote, true);
    assert.equal(search.resultsWanted, LINKEDIN_RESULTS_WANTED);
  }

  // 4) Rotação: cada hora UTC mapeia para um lote fixo de 1 local + 4 remotas.
  const seenBatches = new Set();
  for (let hour = 0; hour < LINKEDIN_TOTAL_BATCHES; hour++) {
    const date = new Date(hour * MS_PER_HOUR);
    const batch = selectLinkedInBatch(date);

    seenBatches.add(batch.batchNumber);
    assert.equal(batch.searches.length, 1 + LINKEDIN_REMOTES_PER_BATCH);
    assert.equal(batch.remotes.length, LINKEDIN_REMOTES_PER_BATCH);
    assert.equal(batch.local, LINKEDIN_LOCAL_SEARCHES[batch.batchNumber - 1]);
    assert.equal(batch.searches[0], batch.local);
    for (const remote of batch.remotes) {
      assert.equal(remote.isRemote, true);
      assert.equal(remote.location, REMOTE_LOCATION);
    }

    // Determinismo: a mesma hora sempre produz o mesmo lote.
    assert.deepEqual(selectLinkedInBatch(date).searches, batch.searches);

    // Ciclo de 20 horas: a hora + 20 repete o mesmo lote.
    const nextCycle = selectLinkedInBatch(
      new Date((hour + LINKEDIN_TOTAL_BATCHES) * MS_PER_HOUR),
    );
    assert.equal(nextCycle.batchNumber, batch.batchNumber);
  }

  // As 20 horas do ciclo cobrem os 20 lotes, uma vez cada.
  assert.equal(seenBatches.size, LINKEDIN_TOTAL_BATCHES);
}

/** Coleta real via `fetchLinkedInJobs`; executada apenas no modo --collect. */
async function collectReal() {
  const { fetchLinkedInJobs } = await import("../dist/providers/linkedin.js");

  console.log("[validate-linkedin] Parâmetros:", COLLECT_PARAMS);

  let jobs;
  try {
    jobs = await fetchLinkedInJobs(COLLECT_PARAMS);
  } catch (error) {
    // Falha reportada explicitamente; não segue silenciosamente.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[validate-linkedin] Falha na coleta: ${message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[validate-linkedin] Vagas coletadas: ${jobs.length}`);

  jobs.forEach((job, index) => {
    console.log(`\n--- Vaga ${index + 1} ---`);
    console.log(`Título:      ${job.title}`);
    console.log(`Empresa:     ${job.company}`);
    console.log(`Localização: ${job.location}`);
    console.log(`Remoto:      ${job.remote}`);
    console.log(`ID:          ${job.id}`);
    console.log(`URL:         ${job.url}`);
    console.log(`Descrição:   ${job.description.length} caracteres`);
  });
}

/** Executa a validação local (padrão) ou a coleta real (--collect). */
async function main() {
  if (process.argv.includes("--collect")) {
    await collectReal();
    return;
  }

  validateRotationLocally();
  console.log(
    "[validate-linkedin] Matriz de buscas e rotação validadas localmente (determinístico, sem rede).",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[validate-linkedin] Erro inesperado: ${message}`);
  process.exitCode = 1;
});
