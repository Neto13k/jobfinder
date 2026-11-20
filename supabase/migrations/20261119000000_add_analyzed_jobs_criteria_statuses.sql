-- JobFinder v2.2.0 — Persistência dos quatro critérios de análise.
--
-- Incremento sobre public.analyzed_jobs que adiciona os dois critérios que
-- passaram a ser avaliados pela IA (ver TASK-05), preservando
-- location_status e contract_status já existentes:
--   seniority_status    -> classificação da senioridade;
--   technologies_status -> classificação da aderência à stack.
--
-- Cada coluna aceita apenas 'allowed', 'blocked' e 'unknown', espelhando a
-- validação em tempo de execução de parseAnalysis (ai-analyzer.ts).
--
-- Linhas já existentes recebem 'unknown' (classificação conservadora: exige
-- revisão). O default 'unknown' é MANTIDO: garante compatibilidade com a
-- v2.2.0 em produção, que grava análises sem informar essas colunas, e é
-- preservado em reexecuções. O histórico e as demais colunas permanecem
-- intactos.
--
-- Requisitos: PostgreSQL 15+ (Supabase 17). A migration é atômica (o Supabase
-- executa cada arquivo dentro de uma única transação) e idempotente:
-- reexecuções não alteram o resultado nem recriam objetos já existentes.

-- 1) Novas colunas. O default garante valor às linhas existentes; o NOT NULL
--    é aplicado na criação (a coluna já nasce consistente).
alter table public.analyzed_jobs
  add column if not exists seniority_status text not null default 'unknown';

alter table public.analyzed_jobs
  add column if not exists technologies_status text not null default 'unknown';

-- 2) Restringe os valores aceitos. Verificação de existência restrita à
--    própria tabela, garantindo a idempotência.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'analyzed_jobs_seniority_status_check'
       and conrelid = 'public.analyzed_jobs'::regclass
  ) then
    alter table public.analyzed_jobs
      add constraint analyzed_jobs_seniority_status_check
      check (seniority_status in ('allowed', 'blocked', 'unknown'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'analyzed_jobs_technologies_status_check'
       and conrelid = 'public.analyzed_jobs'::regclass
  ) then
    alter table public.analyzed_jobs
      add constraint analyzed_jobs_technologies_status_check
      check (technologies_status in ('allowed', 'blocked', 'unknown'));
  end if;
end $$;
