import { fetchGreenhouseJobs } from "./providers/greenhouse.js";

async function main() {
  try {
    const jobs = await fetchGreenhouseJobs("stripe");

    console.log(`Vagas encontradas: ${jobs.length}`);

    console.log(
      jobs.slice(0, 5).map((job) => ({
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