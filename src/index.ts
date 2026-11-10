import { fetchGreenhouseJobs } from "./providers/greenhouse.js";
import { filterDeveloperJobs } from "./services/job-filter.js";
import { filterBySeniority } from "./services/seniority-filter.js";

/** Busca vagas da Greenhouse e exibe os resultados filtrados. */
async function main() {
  try {
    const jobs = await fetchGreenhouseJobs("stripe");
    const developerJobs = filterDeveloperJobs(jobs);
    const eligibleJobs = filterBySeniority(developerJobs);

    console.log(`Total de vagas: ${jobs.length}`);
    console.log(`Vagas de desenvolvimento: ${developerJobs.length}`);
    console.log(`Vagas após filtro de senioridade: ${eligibleJobs.length}`);

    console.log(
      eligibleJobs.slice(0, 5).map((job) => ({
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
      })),
    );
  } catch (error) {
    console.error("Erro ao buscar vagas:", error);
  }
}

main();