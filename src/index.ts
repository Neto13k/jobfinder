import { fetchGreenhouseJobs } from "./providers/greenhouse.js";
import { analyzeJob, type JobAnalysis } from "./services/ai-analyzer.js";
import {
  getAnalyzedJob,
  markJobAsAnalyzed,
} from "./services/analysis-history.js";
import {
  deduplicateJobs,
  isJobNotified,
  markJobAsNotified,
} from "./services/deduplication.js";
import { filterDeveloperJobs } from "./services/job-filter.js";
import { filterByLocation } from "./services/location-filter.js";
import { filterBySeniority } from "./services/seniority-filter.js";
import { sendJobNotification } from "./services/telegram.js";
import type { Job } from "./types/job.js";

/** Quadro consultado nesta etapa (MVP 1.0). */
const BOARD_TOKEN = "stripe";

// Envio real só quando a variável for exatamente "true"; padrão é modo de teste.
const SEND_NOTIFICATIONS = process.env.JOBFINDER_SEND_NOTIFICATIONS === "true";

// Próxima ação a executar: analisar uma vaga nova ou reenviar uma já compatível.
type NextAction =
  | { kind: "analyze"; job: Job }
  | { kind: "send"; job: Job; analysis: JobAnalysis };

/**
 * Encontra a primeira vaga que precisa de ação.
 *
 * Ignora vagas já notificadas e vagas já analisadas como incompatíveis ou em
 * revisão. Vagas compatíveis ainda não notificadas são reaproveitadas para
 * envio, sem nova chamada à IA.
 */
async function findNextAction(jobs: Job[]): Promise<NextAction | undefined> {
  for (const job of jobs) {
    if (await isJobNotified(job)) {
      continue;
    }

    const saved = await getAnalyzedJob(job);
    if (!saved) {
      return { kind: "analyze", job };
    }

    // Incompatível ou revisão já resolvida: nada a fazer.
    if (saved.decision !== "compatible") {
      continue;
    }

    return { kind: "send", job, analysis: saved };
  }

  return undefined;
}

/**
 * Coleta, filtra, analisa uma vaga e (opcionalmente) notifica.
 *
 * No máximo uma nova chamada à IA e uma notificação por execução.
 */
async function main() {
  try {
    const jobs = await fetchGreenhouseJobs(BOARD_TOKEN);
    const uniqueJobs = deduplicateJobs(jobs);
    const developerJobs = filterDeveloperJobs(uniqueJobs);
    const seniorityJobs = filterBySeniority(developerJobs);
    const eligibleJobs = filterByLocation(seniorityJobs);

    console.log(`Coletadas: ${jobs.length} | após dedupe: ${uniqueJobs.length}`);
    console.log(`Desenvolvimento: ${developerJobs.length}`);
    console.log(`Após senioridade: ${seniorityJobs.length}`);
    console.log(`Após localização: ${eligibleJobs.length}`);

    const action = await findNextAction(eligibleJobs);
    if (!action) {
      console.log("Nenhuma vaga pendente para processamento.");
      return;
    }

    const { job } = action;
    let analysis: JobAnalysis;

    if (action.kind === "send") {
      // Reaproveita o resultado salvo, sem chamar a IA novamente.
      analysis = action.analysis;
      console.log(`Reutilizando análise salva: ${job.title} (${job.company})`);
    } else {
      console.log(`Analisando: ${job.title} (${job.company})`);
      analysis = await analyzeJob(job);
      // Salva a nova análise imediatamente, inclusive as compatíveis.
      await markJobAsAnalyzed(job, analysis);
    }

    console.log(
      `Resultado da IA: ${analysis.decision} | score ${analysis.score} | ` +
        `localização ${analysis.locationStatus} | contratação ${analysis.contractStatus}`,
    );

    const isSendable =
      analysis.decision === "compatible" &&
      analysis.locationStatus === "allowed" &&
      analysis.contractStatus === "allowed";

    if (!isSendable) {
      console.log("Vaga não elegível para envio.");
      return;
    }

    // Modo de teste: salva a análise, mas não envia nem registra notificação.
    if (!SEND_NOTIFICATIONS) {
      console.log(
        "Modo de teste (JOBFINDER_SEND_NOTIFICATIONS != true): análise salva, notificação não enviada nem registrada.",
      );
      return;
    }

    // Só registra como notificada após o Telegram confirmar o envio. Uma falha
    // aqui mantém a análise salva, permitindo nova tentativa.
    await sendJobNotification(job, analysis);
    await markJobAsNotified(job);
    console.log("Notificação enviada e vaga registrada no histórico.");
  } catch (error) {
    // Loga apenas a mensagem, sem expor tokens ou chaves.
    const message = error instanceof Error ? error.message : String(error);
    console.error("Erro na execução do JobFinder:", message);
  }
}

main();
