// Script TEMPORÁRIO de validação manual do provider do LinkedIn.
//
// Executa EXCLUSIVAMENTE `fetchLinkedInJobs` (sem Gemini, Supabase ou Telegram)
// e NÃO passa por `src/index.ts`.
//
// Uso manual:
//   npm run build && node scripts/validate-linkedin.mjs
import { fetchLinkedInJobs } from "../dist/providers/linkedin.js";

/** Parâmetros fixos desta validação. */
const PARAMS = {
  searchTerm: "estágio desenvolvimento",
  location: "Maceio, Alagoas, Brazil",
  geoId: "102957102",
  resultsWanted: 5,
  timeoutMs: 30_000,
};

/** Executa a busca e imprime um resumo por vaga. */
async function main() {
  console.log("[validate-linkedin] Parâmetros:", PARAMS);

  let jobs;

  try {
    jobs = await fetchLinkedInJobs(PARAMS);
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[validate-linkedin] Erro inesperado: ${message}`);
  process.exitCode = 1;
});
