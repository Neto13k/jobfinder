# Services

Serviços e regras de negócio do pipeline.

## Triagem e priorização

- `job-filter.ts` — filtro de cargo (desenvolvimento); exclui áreas não técnicas.
- `seniority-filter.ts` — exclui senioridade alta por palavra inteira.
- `location-filter.ts` — remove apenas vagas claramente incompatíveis; mantém
  localização ambígua/ausente para a IA.
- `job-priority.ts` — priorização (categoria temporal → prioridade geográfica →
  recência → ordem estável), sem descartar vagas.

## Análise e histórico

- `ai-analyzer.ts` — análise via Google Gemini com resposta JSON estruturada;
  `ANALYSIS_CRITERIA_VERSION` versiona os critérios e `classifyGeminiError`
  categoriza as falhas.
- `analysis-history.ts` — histórico de análises; reutiliza somente a versão
  vigente de critérios e preserva versões anteriores.
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
