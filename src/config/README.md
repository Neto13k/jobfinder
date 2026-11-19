# Configuração

Configurações da aplicação carregadas em tempo de execução.

- `job-sources.ts` — verdade única das fontes de vagas: a união discriminada
  `JobSource` (`BoardJobSource | LinkedInJobSource | IndeedJobSource`) e a lista
  `BOARD_JOB_SOURCES` com os **59 boards públicos** (Greenhouse, Lever, Ashby e
  InHire). Cada identificador foi validado contra o endpoint público do provider.
- `linkedin-searches.ts` — 100 pesquisas do LinkedIn Jobs (20 locais em Maceió/AL
  + 80 remotas no Brasil).
- `indeed-searches.ts` — 100 pesquisas do Indeed Jobs (20 locais em Maceió/AL +
  80 remotas no Brasil).

As pesquisas são agrupadas em 20 lotes e selecionadas por hora UTC (rotação
determinística e sem estado): 5 do LinkedIn e 5 do Indeed por execução. Para
adicionar um board, confirme antes o identificador aceito pela API e a identidade
da empresa no metadado oficial.

As variáveis de ambiente (credenciais, backend de persistência, limites e
controles de envio) estão documentadas no `README.md` da raiz e em
`.env.example`.
