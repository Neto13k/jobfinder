-- JobFinder v1.1 — Estado de entrega das notificações.
--
-- Incremento aditivo sobre public.notified_jobs, sem alterar a migration anterior.
--
-- Suporta reserva antes do envio e recuperação de falhas, com dois estados:
--   pending -> reservada por uma execução; envio ainda não confirmado.
--   sent    -> confirmada após o Telegram aceitar a mensagem.
--
-- A vaga é reservada (pending) antes de enviar. Em caso de falha no envio, a
-- reserva é removida para permitir nova tentativa. Linhas anteriores, já
-- confirmadas, recebem 'sent' por padrão.

alter table public.notified_jobs
  add column if not exists status text not null default 'sent'
  check (status in ('pending', 'sent'));
