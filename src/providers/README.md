# Providers

Provedores externos de vagas. Cada provider busca vagas em uma fonte, normaliza
para o modelo comum (`src/types/job.ts`) e devolve o desfecho da coleta (`ok`,
`empty`, `partial`, `error`). Todos usam o `fetch` nativo do Node.js.

## Boards públicos de empresa

- `greenhouse.ts` — Greenhouse (`boards-api.greenhouse.io/v1/boards`).
- `lever.ts` — Lever (`api.lever.co/v0/postings`).
- `ashby.ts` — Ashby (`api.ashbyhq.com/posting-api/job-board`).
- `inhire.ts` — InHire (`api.inhire.app/job-posts/public/pages`, cabeçalho
  `X-Tenant`). A listagem é rasa; cada vaga exige uma requisição de detalhe.
  Usa pacing por empresa (250 ms), teto agregado compartilhado entre listagens e
  detalhes (60 ms entre inícios efetivos, por relógio monotônico), concorrência
  máxima de 4 empresas e abandono dos detalhes após 3 timeouts consecutivos
  (reiniciando no sucesso).
- `board-http.ts` — utilidade compartilhada: `fetchBoardWithTimeout` (timeout de
  15 s por requisição), `BoardTimeoutError` e `isTimeoutError`.

## Plataformas de busca por termo

- `linkedin.ts` — LinkedIn Jobs via `ts-jobspy@3.0.1` (busca a descrição completa
  de cada vaga).
- `indeed.ts` — Indeed Jobs via `ts-jobspy@3.0.1` (descrições embutidas na busca).

As pesquisas de LinkedIn e Indeed ficam em `src/config/` e são selecionadas por
lote em `src/services/*-search-rotation.ts`. A detecção de HTTP 429 preserva as
vagas já coletadas e interrompe o provider afetado (ver
`src/services/rate-limit.ts`).
