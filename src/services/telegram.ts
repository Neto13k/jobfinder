import type { JobAnalysis } from "./ai-analyzer.js";
import type { Job } from "../types/job.js";

/** Resposta mínima esperada do método sendMessage. */
interface TelegramResponse {
  ok: boolean;
  description?: string;
}

// Tempo máximo de cada requisição ao Telegram, em milissegundos. Um estouro de
// tempo resulta em resultado INCERTO: a mensagem pode ter sido entregue antes
// do corte, por isso é tratado como "unknown" (nunca como "não entregue").
const REQUEST_TIMEOUT_MS = 10_000;

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

/**
 * Rótulo de modalidade a partir dos sinais estruturados da fonte.
 *
 * O campo `workplaceType` é autoritativo quando presente; o booleano `remote` é
 * usado como reserva. Retorna null quando a modalidade é desconhecida — nunca é
 * inferida por ausência de sinal.
 */
function describeModality(job: Job): string | null {
  switch (job.workplaceType) {
    case "remote":
      return "Remoto";
    case "hybrid":
      return "Híbrido";
    case "onsite":
      return "Presencial";
  }

  if (job.remote === true) {
    return "Remoto";
  }

  return null;
}

/**
 * Tipos de contratação informados pela fonte, sem duplicatas; null quando
 * ausentes. O Telegram precisa da informação explícita, então nada é inferido.
 */
function describeContract(job: Job): string | null {
  const types = (job.contractTypes ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  if (types.length === 0) {
    return null;
  }

  return Array.from(new Set(types)).join(", ");
}

/**
 * Acrescenta à mensagem as informações da vaga conhecidas (modalidade, tipo de
 * contratação e data de publicação), omitindo as que a fonte não informou.
 */
function appendKnownDetails(lines: string[], job: Job): void {
  const modality = describeModality(job);
  if (modality) {
    lines.push(`Modalidade: ${modality}`);
  }

  const contract = describeContract(job);
  if (contract) {
    lines.push(`Contratação: ${contract}`);
  }

  if (job.publishedAt && job.publishedAt.trim() !== "") {
    lines.push(`Publicado em: ${job.publishedAt}`);
  }
}

// Monta a mensagem da vaga compatível em texto simples, sem HTML ou Markdown.
function buildMessage(job: Job, analysis: JobAnalysis): string {
  const lines = [
    `Cargo: ${job.title}`,
    `Empresa: ${job.company}`,
    `Localização: ${job.location}`,
  ];

  appendKnownDetails(lines, job);

  lines.push(
    `Pontuação: ${analysis.score}`,
    `Decisão: ${analysis.decision}`,
    `Justificativa: ${analysis.reason}`,
    `URL: ${job.url}`,
  );

  return lines.join("\n");
}

// Monta a mensagem de revisão manual, deixando claro que a vaga não foi
// confirmada e exatamente quais informações ainda precisam de verificação.
function buildReviewMessage(job: Job, analysis: JobAnalysis): string {
  // Critérios não confirmados (pode ficar vazio quando a revisão decorre de
  // outros requisitos, ex.: senioridade ou tecnologias).
  const pending: string[] = [];
  if (analysis.locationStatus !== "allowed") {
    pending.push("localização");
  }
  if (analysis.contractStatus !== "allowed") {
    pending.push("modalidade de contratação");
  }

  // Sem pendências geográficas: orientar a verificação dos requisitos e do
  // motivo da revisão, evitando uma linha com lista vazia.
  const confirmation =
    pending.length > 0
      ? `Confirmar antes de se candidatar: ${pending.join(" e ")}.`
      : "Confirmar antes de se candidatar: os requisitos da vaga e o motivo da revisão acima.";

  const lines = [
    "⚠️ VAGA PARA REVISÃO MANUAL — NÃO CONFIRMADA",
    `Cargo: ${job.title}`,
    `Empresa: ${job.company}`,
    `Localização: ${job.location}`,
  ];

  appendKnownDetails(lines, job);

  lines.push(
    `Pontuação da IA: ${analysis.score}`,
    `Motivo da revisão: ${analysis.reason}`,
    `Status da localização: ${analysis.locationStatus}`,
    `Status da contratação: ${analysis.contractStatus}`,
    `Link: ${job.url}`,
    "",
    confirmation,
  );

  return lines.join("\n");
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

  // Falha de rede/timeout: a requisição pode ter chegado ao Telegram. O
  // AbortSignal.timeout encerra a requisição presa e cai neste mesmo tratamento
  // (resultado incerto).
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new TelegramDeliveryError(
      "Falha de rede ou tempo esgotado ao enviar notificação ao Telegram (resultado incerto).",
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
