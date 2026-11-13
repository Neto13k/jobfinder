import type { JobAnalysis } from "./ai-analyzer.js";
import type { Job } from "../types/job.js";

/** Resposta mínima esperada do método sendMessage. */
interface TelegramResponse {
  ok: boolean;
  description?: string;
}

/**
 * Falha no envio ao Telegram com indicação da confiança do resultado.
 *
 * A distinção evita dois erros opostos: liberar a reserva e reenviar uma
 * mensagem possivelmente já entregue, ou descartar uma notificação que
 * seguramente não saiu.
 *
 * - "not_delivered": o Telegram respondeu com erro explícito ou o envio nem
 *   começou (credenciais ausentes). A mensagem NÃO foi entregue.
 * - "unknown": a requisição falhou sem resposta conclusiva (rede, timeout ou
 *   corpo ilegível). A mensagem PODE ter sido entregue.
 */
export class TelegramDeliveryError extends Error {
  readonly confidence: "not_delivered" | "unknown";

  constructor(message: string, confidence: "not_delivered" | "unknown") {
    super(message);
    this.name = "TelegramDeliveryError";
    this.confidence = confidence;
  }
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
//
// Toda falha vira TelegramDeliveryError, distinguindo envio confirmadamente
// não entregue de resultado incerto, informação usada pelo despachante.
async function sendMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    throw new TelegramDeliveryError(
      "A variável de ambiente TELEGRAM_BOT_TOKEN não está definida.",
      "not_delivered",
    );
  }
  if (!chatId) {
    throw new TelegramDeliveryError(
      "A variável de ambiente TELEGRAM_CHAT_ID não está definida.",
      "not_delivered",
    );
  }

  // A URL contém o token, por isso nunca é incluída em mensagens de erro.
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;

  // Falha de rede/timeout: a requisição pode ter chegado ao Telegram.
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });
  } catch {
    throw new TelegramDeliveryError(
      "Falha de rede ao enviar notificação ao Telegram (resultado incerto).",
      "unknown",
    );
  }

  // Resposta HTTP de erro: o Telegram rejeitou o envio.
  if (!response.ok) {
    throw new TelegramDeliveryError(
      `Falha ao enviar notificação ao Telegram (HTTP ${response.status}).`,
      "not_delivered",
    );
  }

  // Corpo ilegível após HTTP 200: não é possível confirmar a entrega.
  let data: TelegramResponse;
  try {
    data = (await response.json()) as TelegramResponse;
  } catch {
    throw new TelegramDeliveryError(
      "Resposta ilegível do Telegram (resultado incerto).",
      "unknown",
    );
  }

  // ok:false significa que o Telegram recusou a mensagem.
  if (!data.ok) {
    throw new TelegramDeliveryError(
      `Telegram recusou a mensagem: ${data.description ?? "motivo desconhecido"}.`,
      "not_delivered",
    );
  }
}

/**
 * Envia uma vaga compatível para o Telegram.
 *
 * @param job Vaga analisada.
 * @param analysis Resultado estruturado da análise.
 * @throws TelegramDeliveryError se as variáveis faltarem ou o envio falhar.
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
 * @throws TelegramDeliveryError se as variáveis faltarem ou o envio falhar.
 */
export async function sendReviewNotification(
  job: Job,
  analysis: JobAnalysis,
): Promise<void> {
  await sendMessage(buildReviewMessage(job, analysis));
}
