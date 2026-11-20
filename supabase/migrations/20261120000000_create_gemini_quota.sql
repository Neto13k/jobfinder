-- JobFinder v2.2.0 — Controle persistente da cota diária do Gemini.
--
-- Uma linha por DIA DE COTA (fuso America/Los_Angeles), atualizada de forma
-- atômica por todas as execuções:
--   used            -> requisições já consumidas no dia (tentativas, inclusive
--                      falhas e retries);
--   executions      -> execuções iniciadas no dia (base da distribuição do
--                      orçamento entre as execuções programadas);
--   last_request_at -> instante da última requisição (base do intervalo mínimo
--                      compartilhado entre execuções);
--   token_minute    -> janela de minuto (YYYY-MM-DDTHH:MM) da contagem de tokens
--                      de entrada; quando muda, o consumo de tokens reinicia;
--   tokens_used     -> tokens de entrada consumidos na janela de minuto atual
--                      (controle conservador de TPM, 250k);
--   updated_at      -> marca de atualização, para observabilidade.
--
-- A cota se renova à meia-noite do fuso: um novo quota_day começa com used = 0.
-- A reserva é uma única instrução atômica
-- (update ... where quota_day = $1 and used < $2 and tokens <= tpm and intervalo
-- satisfeito), o que impede que execuções simultâneas ultrapassem a cota diária,
-- os tokens por minuto ou o intervalo mínimo. Ver src/services/gemini-quota.ts.
--
-- Requisitos: PostgreSQL 15+ (Supabase 17). A migration é idempotente:
-- reexecuções não alteram o resultado nem recriam objetos já existentes.

create table if not exists public.gemini_quota (
  quota_day text primary key
    check (quota_day ~ '^\d{4}-\d{2}-\d{2}$'),
  used integer not null default 0
    check (used >= 0),
  executions integer not null default 0
    check (executions >= 0),
  last_request_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Colunas de tokens (controle de TPM). Adicionadas de forma idempotente para que
-- bancos criados pela versão anterior da migration sejam atualizados sem erro.
alter table public.gemini_quota
  add column if not exists token_minute text;

alter table public.gemini_quota
  add column if not exists tokens_used integer not null default 0
    check (tokens_used >= 0);

-- RLS habilitado sem políticas para impedir o acesso às linhas por papéis
-- sujeitos ao RLS. O acesso do backend depende das permissões do usuário
-- PostgreSQL configurado. Não utilizar credenciais administrativas no frontend.
alter table public.gemini_quota enable row level security;
