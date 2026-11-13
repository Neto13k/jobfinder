// Testes do despacho de notificações e da recuperação de reservas pendentes.
//
// Uso:   npm run build
//        node scripts/test-dispatch.mjs
//
// Roda em diretório temporário (backend JSON) e injeta envios falsos para
// simular os desfechos de envio sem acionar o Telegram real.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();

// Garante o backend JSON (padrão) antes de importar os serviços.
delete process.env.JOBFINDER_STORAGE;

const dedup = await import("../dist/services/deduplication.js");
const { notifyWithReservation } = await import(
  "../dist/services/notification-dispatch.js"
);
const { TelegramDeliveryError } = await import("../dist/services/telegram.js");

const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-dispatch-"));
process.chdir(tempDir);

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

/** Monta uma vaga mínima com os campos sobrepostos. */
function job(overrides) {
  return {
    id: "1",
    title: "Desenvolvedor",
    company: "Empresa",
    location: "Remoto - Brasil",
    remote: true,
    description: "",
    url: "https://example.com",
    source: "dispatch-test",
    ...overrides,
  };
}

const analysis = {
  decision: "compatible",
  score: 90,
  reason: "CLT remoto Brasil",
  locationStatus: "allowed",
  contractStatus: "allowed",
};

test("envio aceito + falha na confirmação mantém a reserva pendente", async () => {
  const target = job({ id: "confirm-fail" });

  const result = await notifyWithReservation({ job: target, analysis }, "compatible", {
    // Telegram aceitou a mensagem.
    send: async () => {},
    // A confirmação no banco falha após o envio.
    confirm: async () => {
      throw new Error("banco indisponível");
    },
  });

  assert.equal(result, true);
  // Não libera: a mensagem já saiu; a reserva fica pendente para recuperação.
  assert.equal(await dedup.isJobNotified(target), true);
  assert.ok(
    (await dedup.listPendingReservations()).some(
      (item) => item.key === dedup.generateJobKey(target),
    ),
  );
});

test("falha de envio confirmada libera a reserva", async () => {
  const target = job({ id: "not-delivered" });

  await assert.rejects(
    () =>
      notifyWithReservation({ job: target, analysis }, "compatible", {
        send: async () => {
          throw new TelegramDeliveryError("HTTP 400", "not_delivered");
        },
      }),
    /HTTP 400/,
  );

  assert.equal(await dedup.isJobNotified(target), false);
  assert.ok(await dedup.reserveJobNotification(target));
});

test("resultado de envio incerto mantém a reserva pendente (sem reenvio)", async () => {
  const target = job({ id: "unknown-result" });

  await assert.rejects(
    () =>
      notifyWithReservation({ job: target, analysis }, "manual_review", {
        send: async () => {
          throw new TelegramDeliveryError("timeout", "unknown");
        },
      }),
    /timeout/,
  );

  assert.equal(await dedup.isJobNotified(target), true);
  assert.ok(
    (await dedup.listPendingReservations()).some(
      (item) => item.key === dedup.generateJobKey(target),
    ),
  );
  // Enquanto pendente, uma nova reserva não é concedida.
  assert.equal(await dedup.reserveJobNotification(target), undefined);
});

test("reserva pendente abandonada pode ser resolvida manualmente", async () => {
  const target = job({ id: "recover" });
  const reservation = await dedup.reserveJobNotification(target);
  assert.ok(reservation);

  // Filtro por idade exclui a reserva recém-criada.
  assert.equal(
    (await dedup.listPendingReservations(60_000)).some(
      (item) => item.key === reservation.key,
    ),
    false,
  );
  assert.ok(
    (await dedup.listPendingReservations()).some(
      (item) => item.key === reservation.key,
    ),
  );

  assert.equal(await dedup.resolvePendingReservation(reservation.key, "sent"), true);
  assert.equal(await dedup.isJobNotified(target), true);
});
