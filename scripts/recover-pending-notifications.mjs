// Recuperação manual de reservas pendentes de notificação.
//
// Uso:
//   npm run build
//   node --env-file=.env scripts/recover-pending-notifications.mjs                 # lista
//   node --env-file=.env scripts/recover-pending-notifications.mjs --older-than=30
//   node --env-file=.env scripts/recover-pending-notifications.mjs --mark-sent="source:id"
//   node --env-file=.env scripts/recover-pending-notifications.mjs --release="source:id"
//
// Este script NÃO reenvia mensagens. Reservas pendentes são mantidas porque o
// resultado do envio é desconhecido; cabe a você confirmar no Telegram se a
// mensagem chegou e então:
//   --mark-sent  confirma a entrega (a mensagem foi recebida);
//   --release    libera a vaga (é seguro tentar novamente).
//
// Respeita JOBFINDER_STORAGE (json ou postgres).

import process from "node:process";

import { closePool } from "../dist/db/postgres.js";
import {
  listPendingReservations,
  resolvePendingReservation,
} from "../dist/services/deduplication.js";

/** Lê o valor de um argumento no formato --nome=valor. */
function argValue(prefix) {
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

/** Idade aproximada em minutos a partir de um instante ISO. */
function ageMinutes(iso) {
  if (!iso) {
    return "?";
  }
  const diff = Date.now() - Date.parse(iso);
  return Number.isFinite(diff) ? String(Math.floor(diff / 60000)) : "?";
}

async function main() {
  const markSent = argValue("--mark-sent=");
  const release = argValue("--release=");
  const olderThanRaw = argValue("--older-than=");

  if (markSent && release) {
    throw new Error("Use apenas uma ação: --mark-sent ou --release.");
  }

  if (markSent) {
    const changed = await resolvePendingReservation(markSent, "sent");
    console.log(
      changed
        ? `Reserva marcada como enviada: ${markSent}`
        : `Nenhuma reserva pendente encontrada para: ${markSent}`,
    );
    return;
  }

  if (release) {
    const changed = await resolvePendingReservation(release, "released");
    console.log(
      changed
        ? `Reserva liberada para nova tentativa: ${release}`
        : `Nenhuma reserva pendente encontrada para: ${release}`,
    );
    return;
  }

  const olderThanMs = olderThanRaw ? Number(olderThanRaw) * 60_000 : 0;
  if (olderThanRaw && (!Number.isFinite(olderThanMs) || olderThanMs < 0)) {
    throw new Error(
      "Valor inválido para --older-than (em minutos, ex.: --older-than=30).",
    );
  }

  const pending = await listPendingReservations(olderThanMs);

  if (pending.length === 0) {
    console.log("Nenhuma reserva pendente encontrada.");
    return;
  }

  console.log(`Reservas pendentes: ${pending.length}`);
  for (const item of pending) {
    console.log(
      `- ${item.key} | reservada em ${item.reservedAt ?? "?"} | há ${ageMinutes(item.reservedAt)} min`,
    );
  }

  console.log("");
  console.log("Nada foi alterado. Confirme no Telegram se a mensagem chegou e então:");
  console.log('  --mark-sent="source:id"   (mensagem recebida)');
  console.log('  --release="source:id"     (mensagem não chegou; seguro tentar de novo)');
}

try {
  await main();
} catch (error) {
  console.error(
    "[recover-pending-notifications] Falha:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
