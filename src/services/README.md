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
- `deduplication.ts` — chave `source:id`, reserva e histórico de notificações.
- `storage.ts` — seleção explícita do backend (`json` ou `postgres`), sem fallback
  silencioso.

## Notificação e utilidades

- `notification-policy.ts` — classifica a vaga (`compatible`, `manual_review`).
- `notification-dispatch.ts` — ciclo reserva → envio → confirmação/liberação.
- `telegram.ts` — envio de mensagens (texto simples).
- `rate-limit.ts` — detecção de HTTP 429 (`RateLimitError`, `withRateLimitGuard`,
  `collectSearchBatch`) e interrupção parcial preservando vagas.
- `linkedin-search-rotation.ts` / `indeed-search-rotation.ts` — rotação
  determinística e sem estado dos 22 lotes de pesquisas (ciclo de 22 horas).
