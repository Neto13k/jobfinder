import type { JobAnalysis } from "./ai-analyzer.js";

/**
 * Política de notificação de uma análise.
 *
 * - "compatible": vaga aprovada, pode ser notificada normalmente.
 * - "manual_review": vaga possivelmente compatível, exige verificação manual.
 * - null: não notificar.
 */
export type NotificationKind = "compatible" | "manual_review" | null;

/**
 * Classifica se uma análise deve gerar notificação e de qual tipo.
 *
 * Função pura: sem chamadas externas.
 *
 * Só dois casos geram alerta. `review` com localização e contratação
 * `allowed` devolve null de propósito: a dúvida da IA não é sobre o tipo de
 * contrato (já conhecido), e o aviso de revisão existe apenas quando a
 * localização é permitida e a contratação continua indefinida. Localização ou
 * contratação `blocked`/`unknown` fora desse par também não notifica.
 *
 * @param analysis Resultado estruturado da análise da vaga.
 * @returns "compatible" para vagas aprovadas, "manual_review" quando a
 * localização é permitida mas a contratação é indefinida, ou null caso
 * contrário (inclusive quando localização ou contratação estão bloqueadas).
 */
export function classifyNotification(
  analysis: JobAnalysis,
): NotificationKind {
  if (
    analysis.decision === "compatible" &&
    analysis.locationStatus === "allowed" &&
    analysis.contractStatus === "allowed"
  ) {
    return "compatible";
  }

  if (
    analysis.decision === "review" &&
    analysis.locationStatus === "allowed" &&
    analysis.contractStatus === "unknown"
  ) {
    return "manual_review";
  }

  return null;
}
