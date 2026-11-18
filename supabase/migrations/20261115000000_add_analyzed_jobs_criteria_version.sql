-- JobFinder v6.2 — Versionamento dos critérios de análise.
--
-- Incremento sobre public.analyzed_jobs que:
--   1. adiciona a coluna criteria_version (versão dos critérios do Gemini que
--      produziu cada análise — ANALYSIS_CRITERIA_VERSION em ai-analyzer.ts);
--   2. adiciona uma chave primária substituta (id) independente da chave de
--      negócio, permitindo que (key) deixe de ser única isoladamente;
--   3. passa a permitir uma linha por (vaga, versão), preservando o histórico
--      de versões anteriores em vez de sobrescrevê-las.
--
-- O histórico só reutiliza uma análise quando criteria_version é igual à versão
-- vigente; análises de versões anteriores são refeitas SEM excluir nem alterar
-- os resultados já armazenados.
--
-- Linhas já existentes ficam com criteria_version nulo e passam a ser tratadas
-- como análises legadas (reanalisáveis), preservando todo o histórico.
--
-- Requisitos: PostgreSQL 15+ (Supabase 17). Usa "unique nulls not distinct" e
-- "generated always as identity". A migration é atômica (o Supabase executa cada
-- arquivo dentro de uma única transação) e idempotente: reexecuções não alteram
-- o resultado nem recriam objetos já existentes.

-- 1) Coluna de versão (nula para registros legados).
alter table public.analyzed_jobs
  add column if not exists criteria_version text;

-- 2) Chave primária substituta (identity), independente de "key".
--    A definição original da tabela não possui a coluna "id" (somente key,
--    decision, score, reason, location_status, contract_status e analyzed_at),
--    portanto não há conflito com colunas existentes. "if not exists" garante
--    a idempotência em reexecuções.
alter table public.analyzed_jobs
  add column if not exists id bigint generated always as identity;

-- 3) A versão não pode ser vazia quando informada (nula = registro legado).
--    Verificação de existência restrita à própria tabela.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'analyzed_jobs_criteria_version_not_blank'
       and conrelid = 'public.analyzed_jobs'::regclass
  ) then
    alter table public.analyzed_jobs
      add constraint analyzed_jobs_criteria_version_not_blank
      check (criteria_version is null or btrim(criteria_version) <> '');
  end if;
end $$;

-- 4) Substitui a chave primária original (definida em "key") pela nova chave em
--    "id". A remoção só ocorre se a PK atual ainda estiver em "key"; uma PK já
--    migrada para "id" não é afetada em reexecuções. Preserva todos os registros.
do $$
declare
  current_pk text;
  pk_columns text[];
begin
  select con.conname,
         array_agg(att.attname::text order by att.attnum)
    into current_pk, pk_columns
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = any (con.conkey)
   where con.contype = 'p'
     and con.conrelid = 'public.analyzed_jobs'::regclass
   group by con.conname;

  if current_pk is not null and pk_columns = array['key'] then
    execute format(
      'alter table public.analyzed_jobs drop constraint %I',
      current_pk
    );
  end if;
end $$;

-- 5) Cria a PK sobre "id" somente se a tabela ainda não possuir uma chave
--    primária (idempotente e restrita à tabela).
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where contype = 'p'
       and conrelid = 'public.analyzed_jobs'::regclass
  ) then
    alter table public.analyzed_jobs
      add constraint analyzed_jobs_id_pkey primary key (id);
  end if;
end $$;

-- 6) Unicidade de negócio por (vaga, versão): versões distintas da mesma vaga
--    coexistem; o mesmo par (vaga, versão) permanece único, garantindo a
--    idempotência por vaga e versão exigida por
--    "on conflict (key, criteria_version)".
--
--    "nulls not distinct" assegura, ainda, no máximo uma linha legada (versão
--    nula) por vaga. Criação idempotente e restrita à tabela.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'analyzed_jobs_key_criteria_version_key'
       and conrelid = 'public.analyzed_jobs'::regclass
  ) then
    alter table public.analyzed_jobs
      add constraint analyzed_jobs_key_criteria_version_key
      unique nulls not distinct (key, criteria_version);
  end if;
end $$;
