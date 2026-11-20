# JobFinder — Checklist de implantação da v2.3.0

Documento de apoio para **auditoria integrada e lançamento** da versão 2.3.0.
Ele **não** executa a implantação: a aplicação das migrações, a revisão final e a
publicação são conduzidas manualmente pelo responsável. Nenhum passo aqui altera o
banco de produção por conta própria.

> Escopo da v2.3.0: análise por IA com **quatro critérios independentes**, **análise
> em lote** (`generateContent`), **controle persistente de cota do Gemini**,
> **múltiplas notificações por execução** e **fila persistente de vagas pendentes
> entre execuções**. Permanecem os **seis providers** (LinkedIn Jobs, Indeed Jobs,
> Greenhouse, Lever, Ashby, InHire) sobre **59 boards** e **220 pesquisas**.

---

## 1. Ordem das migrações SQL

**Não presuma que o banco de produção esteja vazio.** Antes de aplicar qualquer
migration, **verifique o estado atual** do Supabase (por exemplo, consultando
`information_schema.tables`/`information_schema.columns` ou o histórico de
migrations) e **aplique, na ordem, apenas as que estiverem faltando**. As
migrations são **idempotentes**, mas **não são todas puramente aditivas**: as
migrations 1–3 e 5–7 apenas criam objetos/colunas; a migration **4**
(`criteria_version`) é uma **mudança de schema** — ela **altera a chave primária**
de `analyzed_jobs` (troca por um `id` substituto) e cria uma nova unicidade de
negócio. Recomenda-se **backup antes de qualquer mudança de schema** (ver §9).

| # | Arquivo | Efeito |
|---|---|---|
| 1 | `supabase/migrations/20261112000000_create_job_history_tables.sql` | cria `analyzed_jobs` e `notified_jobs` (RLS habilitado) |
| 2 | `supabase/migrations/20261113000000_add_notified_jobs_status.sql` | adiciona `status` (`pending`/`sent`) em `notified_jobs` |
| 3 | `supabase/migrations/20261114000000_add_notified_jobs_reservation_owner.sql` | adiciona `reserved_by` e `reserved_at` em `notified_jobs` |
| 4 | `supabase/migrations/20261115000000_add_analyzed_jobs_criteria_version.sql` | **muda a chave primária**: adiciona `criteria_version`, troca a PK por `id` substituto e cria `UNIQUE NULLS NOT DISTINCT (key, criteria_version)` |
| 5 | `supabase/migrations/20261119000000_add_analyzed_jobs_criteria_statuses.sql` | adiciona `seniority_status` e `technologies_status` (`DEFAULT 'unknown'`) |
| 6 | `supabase/migrations/20261120000000_create_gemini_quota.sql` | cria `gemini_quota` (uma linha por dia; colunas `token_minute`/`tokens_used`) |
| 7 | `supabase/migrations/20261121000000_create_pending_jobs.sql` | cria `pending_jobs` (`key`, `job` jsonb, `reason`, `first_seen_at`, `updated_at`) |

- **Requisito:** PostgreSQL 15+ (Supabase 17) — a migração 4 usa
  `unique nulls not distinct` e `generated always as identity`.
- **Aplicação:** pelo SQL Editor/painel do Supabase ou por `supabase db push`.
- **Verificação:** as migrações 1–5 são pré-requisito para o modo `postgres`; as
  migrações **6 e 7** (cota e fila de pendências) são as **novidades de schema da
  v2.3.0** e devem ser confirmadas como presentes antes do lançamento.
- **Idempotência:** reexecuções não alteram o resultado nem recriam objetos — ainda
  assim, **aplique somente o que faltar** e trate a migração 4 com cuidado por ser
  uma **mudança de chave primária**.

## 2. Variáveis de ambiente

Referência completa em `.env.example` (sem segredos). Categorias:

### Obrigatórias (credenciais)

| Variável | Uso |
|---|---|
| `GEMINI_API_KEY` | chave da Gemini API |
| `TELEGRAM_BOT_TOKEN` | token do bot do Telegram |
| `TELEGRAM_CHAT_ID` | chat de destino das notificações |
| `DATABASE_URL` | string de conexão do Supabase (obrigatória só no modo `postgres`) |

Em produção, essas quatro vão para os **GitHub Secrets** (ver §3). A validação TLS
é fixada no código (`rejectUnauthorized: true`); parâmetros `sslmode`/`ssl*` na URL
são ignorados. `DATABASE_CA_CERT_PATH` (opcional) aponta para
`certs/prod-ca-2021.crt`.

### Comportamento e limites

| Variável | Padrão | Notas |
|---|---|---|
| `JOBFINDER_STORAGE` | `json` | `json` (local) ou `postgres` (Supabase); **sem fallback silencioso** |
| `JOBFINDER_MAX_ANALYSES` | `5` | piso do limite de vagas/execução (tetos 5–10) |
| `JOBFINDER_ANALYSIS_BATCH_SIZE` | `5` | vagas por requisição (teto 10), independente do anterior |
| `JOBFINDER_ANALYSIS_DESCRIPTION_BUDGET` | `4000` | caracteres da descrição enviada à IA |
| `JOBFINDER_SEND_NOTIFICATIONS` | `false` | habilitar envios reais **conscientemente** |
| `JOBFINDER_SEND_REVIEWS` | `false` | avisos de revisão manual |
| `JOBFINDER_MAX_NOTIFICATIONS` | `3` | notificações/execução (teto 10) |
| `JOBFINDER_PENDING_JOBS_ENABLED` | `true` | liga/desliga a fila de pendências |
| `JOBFINDER_PENDING_JOB_TTL_DAYS` | `7` | idade máxima de uma pendência (mín. 1) |
| `JOBFINDER_PENDING_MAX_JOBS` | `200` | teto de pendências (mín. 1) |
| `JOBFINDER_AUTOMATION_ENABLED` | `false` | **variável de repositório**; controla o job agendado |

### Cota do Gemini

| Variável | Padrão | Notas |
|---|---|---|
| `JOBFINDER_GEMINI_DAILY_QUOTA` | `450` | teto operacional 450 RPD; renovação à meia-noite de `America/Los_Angeles` |
| `JOBFINDER_GEMINI_EXECUTIONS_PER_DAY` | `24` | base da distribuição do orçamento diário |
| `JOBFINDER_GEMINI_MIN_INTERVAL_MS` | `6000` | intervalo mínimo entre requisições (piso de 6 s em produção) |
| `JOBFINDER_GEMINI_TPM_LIMIT` | `250000` | teto de tokens de entrada por minuto |
| `JOBFINDER_GEMINI_TIME_BUDGET_MS` | `480000` | orçamento de tempo (8 min) contado desde o início do pipeline |

### Testes de banco (opcional)

| Variável | Padrão | Notas |
|---|---|---|
| `JOBFINDER_RUN_DB_TESTS` | `false` | habilita `npm run test:db` (grava e limpa chaves `db-test:`) |

## 3. GitHub Actions

- **Workflow principal:** `.github/workflows/jobfinder.yml`
  - Cron `"17 * * * *"` (UTC, a cada hora, desativado por padrão).
  - `concurrency: jobfinder` (evita execuções simultâneas);
    `permissions: contents: read`; `timeout-minutes: 10`.
  - `JOBFINDER_STORAGE: postgres`; usa `DATABASE_CA_CERT_PATH`.
  - Só executa o job agendado quando a **variável de repositório**
    `JOBFINDER_AUTOMATION_ENABLED` for `true`. A execução manual
    (`workflow_dispatch`) não depende dela.
- **Workflow de teste do Telegram:** `.github/workflows/telegram-smoke.yml`
  (exclusivamente `workflow_dispatch`; envia **uma** mensagem fictícia; isolado de
  Gemini/Supabase/histórico).
- **Secrets (Settings → Secrets and variables → Actions → Secrets):**
  `DATABASE_URL`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- **Variável de repositório:** `JOBFINDER_AUTOMATION_ENABLED`.

## 4. Supabase

- **Verifique o estado atual** das migrações (não presuma banco vazio) e **aplique,
  na ordem, apenas as que estiverem faltando** (§1). A migração 4 é uma **mudança
  de chave primária** de `analyzed_jobs`.
- Faça **backup** antes de qualquer mudança de schema (§9).
- Confirmar RLS habilitado em `analyzed_jobs`, `notified_jobs`, `gemini_quota` e
  `pending_jobs`.
- Definir `DATABASE_URL` (pooler/Session) e `DATABASE_CA_CERT_PATH` no ambiente.
- Confirmar que TLS é validado (o certificado público já está versionado).
- Opcional: importar históricos JSON existentes com
  `npm run db:migrate:dry` (simulação) e depois `npm run db:migrate`
  (idempotente, preserva os arquivos originais).

## 5. Gemini

- Confirmar `GEMINI_API_KEY` válida e cota disponível.
- Modelo: `gemini-3.5-flash-lite` via `@google/genai`, com `temperature: 0`,
  `responseSchema` e timeout de 30 s.
- Validar os limites operacionais conforme §7 (cota diária, TPM, intervalo e
  orçamento de tempo) e revisar os padrões das variáveis da cota do Gemini.
- A cota é **persistida e compartilhada** (JSON ou `public.gemini_quota`): cada
  **tentativa** consome reserva, inclusive falhas e retries.

## 6. Telegram

- Confirmar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`.
- Executar o **Telegram Smoke Test** (workflow manual) antes de habilitar envios
  reais, para validar credenciais sem tocar no pipeline principal.
- Manter `JOBFINDER_SEND_NOTIFICATIONS=false` e `JOBFINDER_SEND_REVIEWS=false` até
  validar as credenciais e a regra de seleção; só então habilitar envios.
- Reservas `pending` (resultado incerto) **não** são reenviadas automaticamente;
  resolvê-las manualmente por `npm run notifications:pending` e pelo script
  `scripts/recover-pending-notifications.mjs`.

## 7. Como validar (auditoria integrada)

Execução local e determinística (sem rede nem serviços externos), salvo onde
indicado. Todos os comandos abaixo pressupõem `npm run build` antes.

### 7.1 Recuperação de pendências

- **Suíte dedicada:** `node scripts/test-pending-jobs.mjs` (integrante do
  `npm test`). Cobre:
  - persistência por motivo (`analysis_limit`, `gemini_unavailable`,
    `notification_limit`);
  - recuperação na execução seguinte **sem nova coleta**;
  - combinação e deduplicação com a coleta fresca (a coleta prevalece);
  - descarte explícito de pendências já **notificadas** ou **reservadas
    (`pending`, sem envio confirmado)** e das **obsoletas (TTL)**;
  - erro alto em fila corrompida/vazia (sem fallback silencioso);
  - teto (`JOBFINDER_PENDING_MAX_JOBS`) e gravações concorrentes serializadas;
  - preservação das vagas do **próprio lote que falhou** e das sem resultado válido;
  - guarda `runStartedAtIso` na **remoção e na sobrescrita** (execução antiga que
    grava depois não regride pendência atualizada por execução mais recente);
  - validação dos registros do PostgreSQL sem conexão real.
- **Inspeção manual (modo JSON):** observar `data/pending-jobs.json` após uma
  execução — cada registro traz `key`, `job`, `reason`, `firstSeenAt`, `updatedAt`.
  Na próxima execução, a pendência é recuperada mesmo sem nova coleta.

### 7.2 Prevenção de notificações duplicadas

- **Reserva atômica:** `node scripts/test-dispatch.mjs` — cobre o ciclo
  reserva → envio → confirmação/liberação e o cenário de **execuções concorrentes
  que não duplicam o envio da mesma vaga** (a segunda vê a vaga já reservada).
- **Reserva x pendência:** em `test-pending-jobs.mjs`, uma reserva `pending` (não
  confirmada) **bloqueia** a recuperação da vaga pela fila de pendências.
- **Backend de notificações:** `node scripts/test-storage.mjs` — reserva e
  propriedade (`reserved_by`), confirmando que só a execução dona confirma/libera.
- **Inspeção manual:** `npm run notifications:pending` lista as reservas `pending`;
  confirmar (`--mark-sent`) só se a mensagem chegou; liberar (`--release`) só se
  **não** chegou.

### 7.3 Cota do Gemini

- **Suíte dedicada:** `node scripts/test-gemini-quota.mjs` (integrante do
  `npm test`). Cobre: padrões e tetos; fuso `America/Los_Angeles`; distribuição e
  reaproveitamento do saldo; conversão de orçamento em vagas; reserva atômica sob
  concorrência; TPM com reinício de janela; gerenciadores concorrentes; virada da
  meia-noite revalidando o dia; parada ao esgotar cota/orçamento/tokens; intervalo
  mínimo (compartilhado e na virada do dia); orçamento de tempo **desde o início do
  pipeline**, revalidado a cada tentativa; interrupção quando o controle falha.
- **Inspeção manual (modo JSON):** observar `data/gemini-quota.json` (dia, saldo,
  `tokenMinute`/`tokens`). No modo `postgres`, consultar `public.gemini_quota`.

### 7.4 Limites operacionais

- **Limite de análises/lote:** `node scripts/test-analysis-batch-size.mjs`
  (limite não múltiplo do lote, histórico intercalado, configuração independente do
  batch) e `node scripts/test-ai-batch.mjs` (dimensionamento 5/10 e validação
  individual das respostas).
- **Resiliência do pipeline:** `node scripts/test-process-jobs.mjs` — falha global
  do Gemini, reuso de análises, limite de tentativas por vaga do lote e
  aproveitamento dos resultados válidos sem persistir/enviar falhas.
- **Limite de envios:** `node scripts/test-pending-jobs.mjs` — a 4ª vaga compatível
  com `JOBFINDER_MAX_NOTIFICATIONS=3` fica pendente por `notification_limit`.
- **Suíte completa:** `npm test` (roda `build` + todas as suítes acima + filtros,
  versionamento, storage, rate-limit, timeout de boards, InHire, job-sources,
  auditoria, normalização de providers e validações LinkedIn/Indeed).
- **Banco (opt-in):** `JOBFINDER_RUN_DB_TESTS=true npm run test:db`
  (exige `DATABASE_URL`; usa chaves `db-test:` e limpa ao final).

## 8. Ordem sugerida de implantação

1. **Backup:** fazer backup do banco antes de qualquer mudança de schema (§9).
2. **Schema:** verificar o estado atual das migrações e aplicar, na ordem, **apenas
   as que estiverem faltando** no Supabase (§1) — atenção à migração 4 (mudança de
   chave primária) — e confirmar RLS.
3. **Segredos:** cadastrar os 4 GitHub Secrets e a variável de repositório (§3).
4. **CI:** conferir os workflows `jobfinder.yml` e `telegram-smoke.yml`.
5. **Telegram:** rodar o Smoke Test; validar recebimento (§6).
6. **Gemini:** validar a chave e os limites operacionais (§5 e §7.3).
7. **Dry-run:** executar uma vez com `JOBFINDER_SEND_NOTIFICATIONS=false` para
   conferir coleta, análise e ausência de envios.
8. **Testes e auditoria integrada:** rodar `npm test` (§7) e a revisão final de
   documentação e segurança **antes** de qualquer ativação.
9. **Envios:** habilitar `JOBFINDER_SEND_NOTIFICATIONS=true` de forma consciente.
10. **Automação:** só então definir `JOBFINDER_AUTOMATION_ENABLED=true`.

## 9. Rollback e segurança

- **Backup obrigatório:** faça um backup (dump) do banco **antes** de aplicar
  qualquer mudança de schema, especialmente a migração 4 (`criteria_version`), que
  **altera a chave primária** de `analyzed_jobs`.
- **Rollback compatível com a versão anterior:** as migrações 1–3 e 5–7 são
  aditivas e podem permanecer no banco se você voltar o código; o código anterior
  simplesmente ignora as tabelas/colunas novas. Já a migração 4 é uma **mudança de
  chave primária** e **não é revertida apenas voltando o código** — o schema
  alterado é incompatível com o código antigo que esperava a PK original. Nesse
  caso, o retorno à versão anterior exige **restaurar o backup** (ou reverter a
  migração 4 explicitamente). **Não há garantia de que basta reverter o código** em
  todos os cenários.
- **Antes de reverter:** confirme o estado do schema, prefira **janela de
  manutenção** (envios e automação desativados) e valide em ambiente de teste
  quando possível.
- Nunca versionar `.env`, credenciais ou chaves; conferir que `.env` e os
  históricos locais não estão rastreados.
- Nunca usar `rejectUnauthorized: false`; manter a validação TLS.
- Em caso de reservas `pending` ou pendências obsoletas, resolver de forma
  registrada — nada é descartado em silêncio.
