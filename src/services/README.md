# Services

Serviços e regras de negócio do pipeline.

## Triagem e priorização

- `job-filter.ts` — filtro de cargo (desenvolvimento); exclui áreas não técnicas.
- `seniority-filter.ts` — exclui senioridade alta por palavra inteira.
- `location-filter.ts` — remove apenas vagas claramente incompatíveis; mantém
  localização ambígua/ausente para a IA.
- `job-priority.ts` — pontuação determinística (0–100) por stack, senioridade,
  localização, recência e contratação; ordena por pontuação decrescente sem
  descartar vagas.

## Análise e histórico

- `ai-analyzer.ts` — análise via Google Gemini com resposta JSON estruturada.
  Avalia **quatro critérios independentes** — senioridade, tecnologias,
  localização e contratação — e classifica cada um como `allowed`, `blocked` ou
  `unknown`. A decisão final é **derivada** dos critérios (qualquer `blocked` ⇒
  `incompatible`; qualquer `unknown` ⇒ `review`; todos `allowed` ⇒
  `compatible`), nunca aceita da IA. `ANALYSIS_CRITERIA_VERSION` versiona os
  critérios e `classifyGeminiError` categoriza as falhas. O orçamento da
  descrição enviada à IA é configurável por
  `JOBFINDER_ANALYSIS_DESCRIPTION_BUDGET` (padrão de 4000 caracteres, apenas
  inteiro positivo), preservando o início, um trecho do meio e o fim do anúncio.
  - **Análise em lote (`analyzeJobs`):** envia várias vagas em **uma única**
    requisição `generateContent` (não a Batch API). `DEFAULT_BATCH_SIZE = 5` e
    `MAX_BATCH_SIZE = 10`; `JOBFINDER_ANALYSIS_BATCH_SIZE` (padrão 5, teto 10)
    define o tamanho do lote de forma **independente** do limite por execução
    (`resolveConfiguredBatchSize`), e `resolveBatchSize(balance, desired?)`
    limita cada lote ao saldo de tentativas **restante**, recalculado antes de
    formar e enviar — de modo que `JOBFINDER_MAX_ANALYSES` nunca seja
    ultrapassado, inclusive quando o limite não é múltiplo do lote.
    `buildBatchPrompt` monta blocos `<<<VAGA key=<chave>`/`VAGA>>>` com a chave
    única (`source:id`) e aplica o mesmo orçamento de descrição da análise
    individual. Cada item é **validado individualmente** por `parseBatchAnalyses`,
    que casa a `key`, deriva a decisão e devolve um `Map<string, JobAnalysis>`;
    resultados ausentes, inválidos ou com chave desconhecida são descartados, e
    duplicados **conflitantes** para a mesma chave invalidam apenas aquela chave
    — sempre **sem invalidar os demais resultados válidos**. `analyzeJob` (vaga
    única) permanece disponível.
- `analysis-history.ts` — histórico de análises; reutiliza somente a versão
  vigente de critérios e preserva versões anteriores. Registros legados, sem os
  critérios `seniorityStatus`/`technologiesStatus`, são lidos normalizando-os
  como `unknown`, sem reutilizá-los nem alterar decisões históricas.
- `gemini-quota.ts` — controle persistente da cota do Gemini: **450
  requisições/dia** (teto operacional; configurável) com renovação à meia-noite
  de `America/Los_Angeles`, **intervalo mínimo compartilhado** de 6 s (piso em
  produção), **limite conservador de tokens de entrada por minuto** (250k TPM,
  sobre o prompt completo) e orçamento de tempo **contado desde o início do
  pipeline** (coleta e esperas inclusas; padrão 8 min, abaixo do
  `timeout-minutes: 10` do Actions, com margem `CALL_RESERVE_MS`). A reserva por
  requisição é **atômica** e avalia, na MESMA operação sobre o **estado
  persistido**, a cota, os tokens e o intervalo (UPDATE condicional no PostgreSQL;
  `withStorageLock` no JSON) — impedindo que execuções simultâneas (inclusive
  entre gerenciadores) ultrapassem qualquer limite; cada **tentativa** consome uma
  reserva (inclusive falhas e retries). O **dia de cota** e a **janela de minuto**
  são **revalidados antes de cada reserva** (inclusive após esperas e na virada da
  meia-noite). `planExecutionAllowance` distribui o saldo diário entre as execuções
  previstas (reaproveitando o não utilizado) e `planJobBudget` converte o orçamento
  de requisições em limite de vagas (orçamento × tamanho do lote). Ao esgotar a
  cota, os tokens, o orçamento ou o tempo — ou ao **falhar** o controle — `acquire`
  lança `GeminiAnalysisError` e o pipeline interrompe novas chamadas, preservando
  o reaproveitamento do histórico. Persistência em `data/gemini-quota.json` (JSON,
  com `tokenMinute`/`tokens`) ou na tabela `public.gemini_quota` (colunas
  `token_minute`/`tokens_used`).
- `deduplication.ts` — chave `source:id`, reserva e histórico de notificações.
- `storage.ts` — seleção explícita do backend (`json` ou `postgres`), sem fallback
  silencioso.

## Fila de pendências

- `pending-jobs.ts` — fila persistente de vagas **elegíveis** não concluídas numa
  execução, recuperadas nas seguintes **mesmo sem nova coleta** pelas fontes.
  Motivos: `analysis_limit`, `gemini_unavailable` (falha da IA que exige nova
  tentativa — indisponibilidade, rede, autenticação, cota/tokens/orçamento/tempo,
  resposta vazia/estruturalmente inválida do lote ou vaga sem resultado válido,
  incluindo as vagas do **próprio lote que falhou**) e `notification_limit`. Guarda
  o objeto `Job` **completo** (`data/pending-jobs.json` no JSON; `public.pending_jobs`
  no PostgreSQL, migração `20261121000000_create_pending_jobs.sql`); a integridade
  é validada pela **mesma** função nos dois backends (chave `source:id` coerente,
  motivo permitido, `Job` válido e datas válidas) e fila vazia/corrompida **lança**
  (sem fallback silencioso; nada é apagado). No JSON a gravação é **atômica**
  (temporário + `rename`, sem sobrescrever a fila original quando falha).
  `loadPendingJobs` exclui — registrando, não em silêncio — as pendências já
  **notificadas/reservadas** e as **obsoletas (TTL)** (`JOBFINDER_PENDING_JOB_TTL_DAYS`,
  padrão 7). `savePendingJobs` reconcilia a fila (mantém as pendentes + remove as
  resolvidas), aplica o teto `JOBFINDER_PENDING_MAX_JOBS` (padrão 200, descartando
  as mais antigas) e é **serializada** — advisory lock transacional no PostgreSQL e
  `withStorageLock` no JSON — com a remoção das chaves resolvidas protegida por
  `updatedAt`/`updated_at` anterior ao início da execução (`runStartedAtIso`),
  evitando perdas/duplicações entre execuções concorrentes. Desligável por
  `JOBFINDER_PENDING_JOBS_ENABLED` (padrão `true`).

## Notificação e utilidades

- `notification-policy.ts` — classifica a vaga (`compatible`, `manual_review`).
- `notification-dispatch.ts` — ciclo reserva → envio → confirmação/liberação. A
  reserva é **atômica** (`source:id`), impedindo envios duplicados mesmo entre
  execuções simultâneas; uma falha confirmada libera a reserva, e um resultado
  incerto a mantém `pending`, sem reenvio automático. O pipeline
  (`processJobs`) envia até `JOBFINDER_MAX_NOTIFICATIONS` (padrão 3, teto 10)
  notificações por execução, priorizando TODAS as compatíveis antes das de
  revisão manual (na ordem de prioridade) e isolando falhas individuais de
  envio — apenas envios aceitos consomem o limite.
- `telegram.ts` — envio de mensagens (texto simples).
- `rate-limit.ts` — detecção de HTTP 429 (`RateLimitError`, `withRateLimitGuard`,
  `collectSearchBatch`) e interrupção parcial preservando vagas.
- `linkedin-search-rotation.ts` / `indeed-search-rotation.ts` — rotação
  determinística e sem estado dos 22 lotes de pesquisas (ciclo de 22 horas).
