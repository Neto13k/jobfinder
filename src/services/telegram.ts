import type { JobAnalysis } from "./ai-analyzer.js";
import type { Job } from "../types/job.js";

/** Resposta mínima esperada do método sendMessage. */
interface TelegramResponse {
  ok: boolean;
  description?: string;
}

// Monta a mensagem da vaga compatível em texto simples, sem HTML ou Markdown.
function buildMessage(job: Job, analysis: JobAnalysis): string {
  return [
    `Cargo: ${job.title}`,
    `Empresa: ${job.company}`,
    `Localização: ${job.location}`,
    `Pontuação: ${analysis.score}`,
    `Decisão: ${analysis.decision}`,
    `Justificativa: ${analysis.reason}`,
    `URL: ${job.url}`,
  ].join("\n");
}

// Monta a mensagem de revisão manual, deixando claro que a vaga não foi confirmada.
function buildReviewMessage(job: Job, analysis: JobAnalysis): string {
  return [
    "⚠️ VAGA PARA REVISÃO MANUAL — NÃO CONFIRMADA",
    `Cargo: ${job.title}`,
    `Empresa: ${job.company}`,
    `Localização: ${job.location}`,
    `Pontuação da IA: ${analysis.score}`,
    `Motivo da revisão: ${analysis.reason}`,
    `Status da contratação: ${analysis.contractStatus}`,
    `Link: ${job.url}`,
    "",
    "Verifique a modalidade de contratação e os requisitos antes de se candidatar. " +
      "Esta vaga não está confirmada como CLT ou estágio.",
  ].join("\n");
}

// Valida as credenciais, envia o texto e confirma a resposta do Telegram.
async function sendMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    throw new Error("A variável de ambiente TELEGRAM_BOT_TOKEN não está definida.");
  }
  if (!chatId) {
    throw new Error("A variável de ambiente TELEGRAM_CHAT_ID não está definida.");
  }

  // A URL contém o token, por isso nunca é incluída em mensagens de erro.
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Falha ao enviar notificação ao Telegram (HTTP ${response.status}).`,
    );
  }

  const data = (await response.json()) as TelegramResponse;

  if (!data.ok) {
    throw new Error(
      `Telegram recusou a mensagem: ${data.description ?? "motivo desconhecido"}.`,
    );
  }
}

/**
 * Envia uma vaga compatível para o Telegram.
 *
 * @param job Vaga analisada.
 * @param analysis Resultado estruturado da análise.
 * @throws Error se as variáveis de ambiente faltarem ou se o envio falhar.
 */
export async function sendJobNotification(
  job: Job,
  analysis: JobAnalysis,
): Promise<void> {
  await sendMessage(buildMessage(job, analysis));
}

/**
 * Envia uma vaga em revisão manual para o Telegram.
 *
 * A mensagem alerta que a vaga não foi confirmada e pede verificação de
 * modalidade de contratação e requisitos antes de qualquer candidatura.
 *
 * @param job Vaga analisada.
 * @param analysis Resultado estruturado da análise.
 * @throws Error se as variáveis de ambiente faltarem ou se o envio falhar.
 */
export async function sendReviewNotification(
  job: Job,
  analysis: JobAnalysis,
): Promise<void> {
  await sendMessage(buildReviewMessage(job, analysis));
}
