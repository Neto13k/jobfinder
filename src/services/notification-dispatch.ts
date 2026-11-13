import type { JobAnalysis } from "./ai-analyzer.js";
import {
  confirmJobNotification,
  releaseJobNotification,
  reserveJobNotification,
  type NotificationReservation,
} from "./deduplication.js";
import {
  sendJobNotification,
  sendReviewNotification,
  TelegramDeliveryError,
} from "./telegram.js";
import type { Job } from "../types/job.js";

/** Vaga escolhida para notificação, com a análise correspondente. */
export interface NotificationCandidate {
  job: Job;
  analysis: JobAnalysis;
}

/** Tipo de notificação (vaga compatível ou aviso de revisão manual). */
export type NotificationKind = "compatible" | "manual_review";

/** Envia a notificação ao Telegram; deve lançar TelegramDeliveryError em falha. */
export type SendNotificationFn = (
  job: Job,
  analysis: JobAnalysis,
) => Promise<void>;

/**
 * Substituições opcionais das dependências do despacho.
 *
 * Usadas em testes para simular falhas de envio e de banco sem tocar no
 * Telegram nem no PostgreSQL reais.
 */
export interface DispatchOverrides {
  send?: SendNotificationFn;
  reserve?: typeof reserveJobNotification;
  confirm?: typeof confirmJobNotification;
  release?: typeof releaseJobNotification;
}

/** Mensagem de erro sem expor detalhes sensíveis. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reserva a vaga e envia a notificação, tratando os três desfechos distintos.
 *
 * - Envio confirmadamente não entregue: libera a reserva para nova tentativa.
 * - Envio com resultado incerto: mantém a reserva pendente, sem reenvio
 *   automático, para recuperação manual.
 * - Envio aceito pelo Telegram: confirma no banco. Se a confirmação falhar, a
 *   reserva permanece pendente (a mensagem já saiu) e nunca é liberada aqui.
 *
 * A confirmação só afeta a reserva desta execução, identificada pelo token.
 *
 * @param candidate Vaga e análise escolhidas.
 * @param kind Tipo de notificação.
 * @param overrides Dependências alternativas (uso em testes).
 * @returns true se o Telegram aceitou a mensagem; false se a vaga já estava
 *   reservada ou notificada por outra execução.
 */
export async function notifyWithReservation(
  candidate: NotificationCandidate,
  kind: NotificationKind,
  overrides: DispatchOverrides = {},
): Promise<boolean> {
  const reserve = overrides.reserve ?? reserveJobNotification;
  const confirm = overrides.confirm ?? confirmJobNotification;
  const release = overrides.release ?? releaseJobNotification;
  const send =
    overrides.send ??
    (kind === "compatible" ? sendJobNotification : sendReviewNotification);

  const { job, analysis } = candidate;

  const reservation = await reserve(job);
  if (!reservation) {
    console.log(
      `Vaga já reservada/notificada em outra execução: ${job.title} (${job.company})`,
    );
    return false;
  }

  // 1) Envio: separa falha confirmada de resultado incerto.
  try {
    await send(job, analysis);
  } catch (error) {
    if (
      error instanceof TelegramDeliveryError &&
      error.confidence === "not_delivered"
    ) {
      // A mensagem não saiu: a reserva pode ser liberada com segurança.
      await safeRelease(release, reservation);
      throw error;
    }

    // Resultado incerto: NÃO libera, para não reenviar algo já entregue.
    console.error(
      `Envio com resultado incerto para "${job.title}" (${job.company}); ` +
        "reserva mantida como pending para revisão manual.",
    );
    throw error;
  }

  // 2) Confirmação no banco, após o Telegram aceitar a mensagem.
  try {
    const confirmed = await confirm(reservation);
    if (!confirmed) {
      console.error(
        `A reserva de "${job.title}" (${job.company}) não pôde ser confirmada ` +
          "(não pertence a esta execução ou já foi resolvida).",
      );
    }
  } catch (error) {
    // A mensagem já foi entregue: NÃO libera. Mantém pending para recuperação.
    console.error(
      `Falha ao confirmar "${job.title}" (${job.company}) no banco após envio ` +
        `aceito; reserva mantida como pending. Detalhe: ${describeError(error)}`,
    );
  }

  return true;
}

/** Libera a reserva ignorando falhas secundárias, preservando o erro de envio. */
async function safeRelease(
  release: (reservation: NotificationReservation) => Promise<boolean>,
  reservation: NotificationReservation,
): Promise<void> {
  try {
    await release(reservation);
  } catch (error) {
    console.error(
      `Falha ao liberar a reserva de "${reservation.key}": ${describeError(error)}`,
    );
  }
}
