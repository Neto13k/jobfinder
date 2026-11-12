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
 * Função pura: sem chamadas externas ou alterações em arquivos.
 *
 * @param analysis Resultado estruturado da análise da vaga.
 * @returns "compatible" para vagas aprovadas, "manual_review" quando a
 * localização é permitida mas a contratação é indefinida, ou null caso
 * contrário (inclusive quando localização ou contratação estão bloqueadas).
 */
export function classifyNotification(
  analysis: JobAnalysis,
): NotificationKind {
  // Aprovada: localização e contratação explicitamente permitidas.
  if (
    analysis.decision === "compatible" &&
    analysis.locationStatus === "allowed" &&
    analysis.contractStatus === "allowed"
  ) {
    return "compatible";
  }

  // Revisão manual: localização ok, mas contratação ainda indefinida.
  if (
    analysis.decision === "review" &&
    analysis.locationStatus === "allowed" &&
    analysis.contractStatus === "unknown"
  ) {
    return "manual_review";
  }

  return null;
}
