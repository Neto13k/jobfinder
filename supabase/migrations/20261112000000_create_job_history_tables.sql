-- JobFinder v1.1 — Estrutura inicial de persistência no PostgreSQL (Supabase).
--
-- Substitui, de forma incremental, os históricos JSON hoje em data/:
--   data/analyzed-jobs.json -> public.analyzed_jobs
--   data/notified-jobs.json -> public.notified_jobs
--
-- A chave única preserva o formato usado pelo código: "source:id".
-- O backend acessa por conexão PostgreSQL direta (credenciais em variáveis de
-- ambiente). O RLS é habilitado sem políticas para impedir o acesso às linhas
-- por papéis sujeitos ao RLS.

-- Vagas já analisadas, com o resultado preservado (inclusive "review").
create table if not exists public.analyzed_jobs (
  key text primary key,
  decision text not null
    check (decision in ('compatible', 'incompatible', 'review')),
  score integer not null
    check (score between 0 and 100),
  reason text not null
    check (btrim(reason) <> ''),
  location_status text not null
    check (location_status in ('allowed', 'blocked', 'unknown')),
  contract_status text not null
    check (contract_status in ('allowed', 'blocked', 'unknown')),
  analyzed_at timestamptz not null default now()
);

-- Vagas já notificadas; o registro ocorre só após a confirmação do envio.
create table if not exists public.notified_jobs (
  key text primary key,
  notified_at timestamptz not null default now()
);

-- RLS habilitado sem políticas para impedir acesso
-- às linhas por papéis sujeitos ao RLS.
-- O acesso do backend dependerá das permissões
-- do usuário PostgreSQL configurado.
-- Não utilizar credenciais administrativas no frontend.
alter table public.analyzed_jobs enable row level security;
alter table public.notified_jobs enable row level security;
