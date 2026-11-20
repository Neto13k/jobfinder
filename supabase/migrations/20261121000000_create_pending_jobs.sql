-- JobFinder v2.3.0 — Fila persistente de vagas pendentes entre execuções.
--
-- Substitui, de forma incremental, o arquivo data/pending-jobs.json por
-- public.pending_jobs. Guarda vagas ELEGÍVEIS que não puderam ser concluídas em
-- uma execução (limite de análises, indisponibilidade da IA/orçamento de tempo)
-- ou que ficaram sem notificação EXCLUSIVAMENTE pelo limite de envios da
-- execução, para recuperação nas execuções seguintes — inclusive quando a fonte
-- não as coleta novamente.
--
--   key           -> chave de negócio "source:id" (mesma dos demais históricos);
--   job           -> objeto Job COMPLETO (jsonb), preservando a vaga sem nova
--                    coleta; a integridade é validada no código (type guards);
--   reason        -> motivo pelo qual permaneceu pendente:
--                      analysis_limit | gemini_unavailable | notification_limit;
--   first_seen_at -> entrada na fila (base da expiração por TTL);
--   updated_at    -> última atualização (base do teto e da guarda de remoção).
--
-- A reconciliação (upsert das pendentes + remoção das resolvidas/obsoletas) é
-- serializada por um advisory lock transacional no código
-- (src/services/pending-jobs.ts), evitando perdas e duplicações entre execuções
-- concorrentes. A migration é idempotente: reexecuções não alteram o resultado
-- nem recriam objetos já existentes.
--
-- Requisitos: PostgreSQL 15+ (Supabase 17).

create table if not exists public.pending_jobs (
  key text primary key,
  job jsonb not null,
  reason text not null
    check (reason in ('analysis_limit', 'gemini_unavailable', 'notification_limit')),
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS habilitado sem políticas para impedir o acesso às linhas por papéis
-- sujeitos ao RLS. O acesso do backend depende das permissões do usuário
-- PostgreSQL configurado. Não utilizar credenciais administrativas no frontend.
alter table public.pending_jobs enable row level security;
