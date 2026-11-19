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
 * Matriz de decisão (localização × contratação):
 *
 * | Localização | Contratação | Notificação   |
 * |-------------|-------------|---------------|
 * | allowed     | allowed     | compatible*   |
 * | allowed     | unknown     | manual_review |
 * | unknown     | allowed     | manual_review |
 * | unknown     | unknown     | manual_review |
 * | blocked     | qualquer    | null          |
 * | qualquer    | blocked     | null          |
 *
 * (*) A linha `allowed` + `allowed` só gera "compatible" quando a decisão da IA
 * também é `compatible`. Uma decisão `review` permanece `manual_review`, mesmo
 * com os dois critérios permitidos.
 *
 * Uma vaga rejeitada pela IA (`decision === "incompatible"`, inclusive por
 * senioridade ou tecnologias) nunca é notificada, ainda que os dois critérios
 * estejam permitidos. Informação indefinida (`unknown`) nunca é promovida a
 * elegibilidade confirmada: no máximo gera aviso de revisão manual.
 *
 * Função pura: sem chamadas externas ou alterações em arquivos.
 *
 * @param analysis Resultado estruturado da análise da vaga.
 * @returns "compatible" (decisão `compatible` e dois critérios permitidos),
 * "manual_review" (decisão `review` ou critério indefinido, sem bloqueio) ou
 * null.
 */
export function classifyNotification(
  analysis: JobAnalysis,
): NotificationKind {
  // Rejeição explícita da IA: nunca notificar, mesmo com os dois critérios
  // permitidos (ex.: incompatibilidade de senioridade ou de tecnologias).
  if (analysis.decision === "incompatible") {
    return null;
  }

  // Bloqueio em qualquer critério: nunca notificar.
  if (
    analysis.locationStatus === "blocked" ||
    analysis.contractStatus === "blocked"
  ) {
    return null;
  }

  // Compatível apenas com a decisão `compatible` e ambos os critérios
  // permitidos. Uma decisão `review` com critérios permitidos NÃO é confirmada
  // aqui e segue para revisão manual.
  if (
    analysis.decision === "compatible" &&
    analysis.locationStatus === "allowed" &&
    analysis.contractStatus === "allowed"
  ) {
    return "compatible";
  }

  // Demais combinações não bloqueadas (decisão `review` ou critério indefinido):
  // revisão manual. Informação indefinida nunca é promovida a compatível.
  return "manual_review";
}
