-- JobFinder v1.1 — Dono e instante da reserva de notificação.
--
-- Incremento aditivo sobre public.notified_jobs, sem alterar as migrations
-- anteriores.
--
-- Guarda qual execução reservou a vaga (reserved_by) e quando (reserved_at),
-- permitindo:
--   - confirmar ou liberar apenas a reserva da própria execução;
--   - identificar reservas pendentes abandonadas para recuperação manual.
--
-- Linhas já existentes (confirmadas) ficam com reserved_by/reserved_at nulos.

alter table public.notified_jobs
  add column if not exists reserved_by text,
  add column if not exists reserved_at timestamptz;
