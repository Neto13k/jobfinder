// Testes de persistência e deduplicação no backend JSON (modo local).
//
// Uso:   npm run build
//        node scripts/test-storage.mjs
//
// Roda em diretório temporário, sem tocar em data/ real.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();

// Garante o backend JSON (padrão) antes de importar os serviços.
delete process.env.JOBFINDER_STORAGE;

const dedup = await import("../dist/services/deduplication.js");
const history = await import("../dist/services/analysis-history.js");

const tempDir = await mkdtemp(join(tmpdir(), "jobfinder-storage-"));
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
    source: "test",
    ...overrides,
  };
}

/** Cria um diretório temporário isolado e executa a tarefa nele. */
async function withTempDir(task) {
  const dir = await mkdtemp(join(tmpdir(), "jobfinder-storage-sub-"));
  process.chdir(dir);
  try {
    await task();
  } finally {
    process.chdir(tempDir);
    await rm(dir, { recursive: true, force: true });
  }
}

test("generateJobKey e deduplicateJobs", () => {
  assert.equal(dedup.generateJobKey(job({ source: "s", id: "7" })), "s:7");
  const unique = dedup.deduplicateJobs([job({ id: "a" }), job({ id: "a" }), job({ id: "b" })]);
  assert.equal(unique.length, 2);
});

test("reserva impede duplicidade e liberação permite nova tentativa", async () => {
  const target = job({ id: "reserve-1" });

  assert.equal(await dedup.isJobNotified(target), false);

  const reservation = await dedup.reserveJobNotification(target);
  assert.ok(reservation, "deveria obter uma reserva");
  assert.equal(await dedup.isJobNotified(target), true);

  // Segunda reserva da mesma vaga falha (já reservada).
  assert.equal(await dedup.reserveJobNotification(target), undefined);

  // Simula falha confirmada no envio: libera a reserva.
  assert.equal(await dedup.releaseJobNotification(reservation), true);
  assert.equal(await dedup.isJobNotified(target), false);

  // Nova tentativa pode reservar de novo.
  assert.ok(await dedup.reserveJobNotification(target));
});

test("reservas simultâneas só concedem uma única reserva", async () => {
  const target = job({ id: "concurrent-1" });
  const results = await Promise.all([
    dedup.reserveJobNotification(target),
    dedup.reserveJobNotification(target),
    dedup.reserveJobNotification(target),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("confirmação só afeta a reserva da própria execução", async () => {
  const target = job({ id: "owner-1" });
  const reservation = await dedup.reserveJobNotification(target);
  assert.ok(reservation);

  // Token de outra execução não confirma nem libera a reserva.
  const other = { key: reservation.key, token: "token-de-outra-execucao" };
  assert.equal(await dedup.confirmJobNotification(other), false);
  assert.equal(await dedup.releaseJobNotification(other), false);
  assert.equal(await dedup.isJobNotified(target), true);
  assert.ok(
    (await dedup.listPendingReservations()).some((item) => item.key === reservation.key),
  );

  // A execução dona confirma a própria reserva.
  assert.equal(await dedup.confirmJobNotification(reservation), true);
  assert.equal(
    (await dedup.listPendingReservations()).some((item) => item.key === reservation.key),
    false,
  );
});

test("reserva pendente abandonada é marcada como enviada ou liberada", async () => {
  const sent = job({ id: "pending-sent" });
  const sentReservation = await dedup.reserveJobNotification(sent);
  assert.ok(sentReservation);

  // Reserva recém-criada não aparece no filtro por idade.
  assert.equal(
    (await dedup.listPendingReservations(60_000)).some(
      (item) => item.key === sentReservation.key,
    ),
    false,
  );

  assert.equal(await dedup.resolvePendingReservation(sentReservation.key, "sent"), true);
  assert.equal(await dedup.isJobNotified(sent), true);

  const released = job({ id: "pending-released" });
  const releasedReservation = await dedup.reserveJobNotification(released);
  assert.ok(releasedReservation);
  assert.equal(
    await dedup.resolvePendingReservation(releasedReservation.key, "released"),
    true,
  );
  assert.equal(await dedup.isJobNotified(released), false);
  assert.ok(await dedup.reserveJobNotification(released));
});

test("markJobAsNotified registra a vaga", async () => {
  const target = job({ id: "mark-1" });
  await dedup.markJobAsNotified(target);
  assert.equal(await dedup.isJobNotified(target), true);
});

test("histórico de análise grava, recupera e é idempotente", async () => {
  const target = job({ id: "analysis-1" });
  const analysis = {
    decision: "compatible",
    score: 88,
    reason: "CLT remoto Brasil",
    locationStatus: "allowed",
    contractStatus: "allowed",
  };

  assert.equal(await history.getAnalyzedJob(target), undefined);

  await history.markJobAsAnalyzed(target, analysis);
  const saved = await history.getAnalyzedJob(target);
  assert.equal(saved.decision, "compatible");
  assert.equal(saved.score, 88);
  assert.equal(await history.isJobAnalyzed(target), true);

  // Segunda gravação não sobrescreve o resultado existente.
  await history.markJobAsAnalyzed(target, { ...analysis, score: 1, decision: "incompatible" });
  const again = await history.getAnalyzedJob(target);
  assert.equal(again.score, 88);
  assert.equal(again.decision, "compatible");
});

test("histórico corrompido falha em vez de silenciar (sem fallback)", async () => {
  await withTempDir(async () => {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    await writeFile(join(process.cwd(), "data", "notified-jobs.json"), "   ", "utf8");

    await assert.rejects(
      () => dedup.reserveJobNotification(job({ id: "corrupt-1" })),
      /Histórico de notificações vazio/,
    );
  });
});
