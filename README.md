# JobFinder

**Versão 2.2.0 — seis providers: LinkedIn Jobs, Indeed Jobs, Greenhouse, Lever, Ashby e InHire**

O JobFinder é um projeto em **Node.js e TypeScript** que reúne vagas de **59 boards públicos de empresas** (Greenhouse, Lever, Ashby e InHire) e das plataformas de busca **LinkedIn Jobs** e **Indeed Jobs**, aplica filtros de compatibilidade, usa o **Google Gemini** para analisar oportunidades e, quando habilitado, envia alertas pelo **Telegram**. O objetivo é apoiar a descoberta de vagas de desenvolvimento sem realizar candidaturas automaticamente.

> **Escopo desta versão:** a v2.2.0 mantém a coleta multi-fonte com **LinkedIn Jobs** e **Indeed Jobs** (via `ts-jobspy@3.0.1`) e com os boards públicos **Greenhouse**, **Lever**, **Ashby** e **InHire** — **seis providers** no total, sobre **59 boards** configurados — a execução **manual** e **agendada pelo GitHub Actions**, a **persistência no PostgreSQL (Supabase)** e o envio opcional de alertas. Esta versão adota uma **presunção operacional de elegibilidade** para vagas remotas sem restrições geográficas explícitas, expande a matriz de pesquisas do LinkedIn e do Indeed para **220 pesquisas** (110 por provider, em **22 lotes** com ciclo de **22 horas**) e integra as validações determinísticas do LinkedIn e do Indeed ao `npm test`. Ela continua **não** realizando candidaturas e **não** oferecendo interface de frontend. As informações de análise e notificações podem ser guardadas em **arquivos JSON locais** ou nas **tabelas do Supabase**, conforme configuração. **Publicações de recrutadores (LinkedIn Posts) não fazem parte da v2.2.0** — seguem planejadas, sem versão definitiva estabelecida.

## Novidades da v2.2.0

- **Presunção operacional de elegibilidade remota:** vagas **remotas sem restrição geográfica explícita** passam a ser classificadas como `allowed` na triagem (presunção operacional de elegibilidade), e não mais como `unknown`. É uma **presunção de triagem**, distinta da **elegibilidade confirmada pelo Gemini**: a IA continua validando a vaga e pode descartá-la. Os bloqueios explícitos são preservados — residência restrita a outro país, exclusão explícita do Brasil e localizações estrangeiras permanecem `blocked`; sinais contraditórios (localização estrangeira com descrição que declara aceitar residentes no Brasil) permanecem `unknown`.
- **Expansão da matriz de pesquisas:** LinkedIn e Indeed passam a **110 pesquisas cada** (22 locais em Maceió/AL + 88 remotas no Brasil), totalizando **220 pesquisas** (antes 200). Os **200 termos anteriores foram preservados** em ordem e composição; os novos termos foram acrescentados ao final (2 locais e 8 remotos por provider).
- **Rotação de 22 lotes:** as 110 pesquisas de cada plataforma formam **22 lotes** (1 local + 4 remotas por hora UTC), com ciclo determinístico de **22 horas** (antes 20).
- **Validações determinísticas do LinkedIn e do Indeed:** `scripts/validate-linkedin.mjs` e `scripts/validate-indeed.mjs` validam localmente (sem rede) as matrizes e a rotação de cada plataforma e foram integrados ao `npm test`.
- **Critérios de análise versionados:** `ANALYSIS_CRITERIA_VERSION` atualizado para `2026-11-19.2`, disparando a reanálise das vagas não notificadas sem apagar o histórico e preservando a deduplicação de notificações.

## Novidades da v2.1.0 (mantidas)

- **Limite operacional de cinco análises por execução:** o Gemini analisa no máximo **cinco novas vagas por execução** (`JOBFINDER_MAX_ANALYSES`, teto de `5`), com padrão seguro de `1` análise por execução.
- **Correção da elegibilidade geográfica:** vagas remotas passaram a exigir evidência **explícita** de elegibilidade a candidatos residentes no Brasil (país, região LATAM/global, cidade/estado brasileiro reconhecido ou descrição que declare aceitar residentes no Brasil), e a **ausência** de restrição não era tratada como elegibilidade. *(Esta regra foi refinada na v2.2.0, que passou a presumir elegibilidade para vagas remotas sem restrição geográfica explícita — ver a seção "Novidades da v2.2.0".)*
- **Expressões regulares geográficas centralizadas:** os padrões geográficos compartilhados por triagem e priorização foram reunidos em `src/config/geo-patterns.ts` (`location-filter.ts` e `job-priority.ts` importam o mesmo vocabulário), evitando divergência entre módulos.
- **Normalização de acentos nos filtros:** o filtro de cargo (`filterDeveloperJobs`) normaliza títulos e palavras-chave com Unicode NFD, remoção de diacríticos e minúsculas, tornando a comparação insensível a acentos e maiúsculas.
- **Política de revisão manual ampliada:** além da decisão `review`, também geram **revisão manual** os casos com localização ou contratação indefinidas (`unknown`). A notificação `compatible` exige decisão `compatible` da IA **e** ambos os critérios `allowed`; qualquer indício indefinido nunca é promovido a elegibilidade confirmada.
- **Validação determinística da rotação do LinkedIn:** `scripts/validate-linkedin.mjs` passou a validar a matriz de pesquisas e a rotação dos lotes **localmente** e **sem rede** (à época, 100 pesquisas em 20 lotes; atualmente 110 em 22), e foi integrado ao `npm test`. A coleta real é manual e explícita (`node scripts/validate-linkedin.mjs --collect`).
- **Critérios de análise versionados:** `ANALYSIS_CRITERIA_VERSION` foi atualizado para `2026-11-19.1` (revisado para `2026-11-19.2` na v2.2.0), disparando a reanálise das vagas não notificadas sem apagar o histórico e preservando a deduplicação de notificações.

### Recursos herdados da v2.0 (mantidos)

- **LinkedIn Jobs:** coleta de vagas por termo de busca via `ts-jobspy@3.0.1`, com **110 pesquisas** — 22 locais em Maceió/AL e 88 remotas no Brasil — e limite de **10 vagas por pesquisa**.
- **Indeed Jobs:** coleta de vagas por termo de busca via `ts-jobspy@3.0.1`, com **110 pesquisas** — 22 locais em Maceió/AL e 88 remotas no Brasil — e limite de **15 vagas por pesquisa**.
- **Rotação determinística e sem estado:** as 110 pesquisas de cada plataforma são divididas em **22 lotes**; a cada execução são selecionados **5 pesquisas do LinkedIn e 5 do Indeed** (1 local de Maceió e 4 remotas nacionais por plataforma), escolhidas pela hora UTC e sem persistir estado.
- **Coleta sequencial entre plataformas:** os lotes do LinkedIn e do Indeed rodam **um após o outro**, e cada lote executa **uma pesquisa por vez**, para não concorrerem na mesma sessão da biblioteca `ts-jobspy`.
- **`patch-package` para `geoId`:** um patch local (`patches/ts-jobspy+3.0.1.patch`) habilita o parâmetro `geoId`, usado para fixar as pesquisas locais do LinkedIn em Maceió/AL.
- **Mapeamento de falhas por plataforma:** o desfecho de cada coleta (`ok`, `empty`, `partial`, `error`) é tratado explicitamente; falhas de um provider são isoladas e não derrubam as demais fontes.
- **59 boards públicos de empresas:** coleta em quadros das plataformas **Greenhouse**, **Lever**, **Ashby** e **InHire** — 37 boards nas três primeiras e 22 empresas na InHire.
- **Integração InHire:** listagem pública por empresa (cabeçalho `X-Tenant`) complementada por uma requisição de detalhe por vaga, com pacing por empresa, teto agregado de requisições, concorrência limitada a quatro empresas e política de timeouts consecutivos.
- **Versionamento das análises:** cada análise é vinculada a uma versão centralizada de critérios; mudanças de regra disparam reanálise sem apagar o histórico anterior.
- **Resiliência do pipeline:** falha global do Gemini, rate limiting (HTTP 429) e timeouts são tratados de forma isolada, preservando as vagas já coletadas e mantendo o fluxo.

### Recursos herdados da v1.1 (mantidos)

- **Persistência no PostgreSQL (Supabase):** históricos de análises e de notificações podem viver em `public.analyzed_jobs` e `public.notified_jobs`, com consultas e gravações parametrizadas.
- **Seleção explícita de armazenamento:** `JOBFINDER_STORAGE` escolhe entre `json` (padrão) e `postgres`, **sem fallback silencioso** — falhas do banco interrompem a execução.
- **Controle de duplicações:** reserva da vaga antes do envio, com estados de entrega (`pending`/`sent`) e **propriedade da reserva** (`reserved_by`/`reserved_at`).
- **Automação controlada com GitHub Actions:** execução agendada **a cada hora, aos 17 minutos (`cron: "17 * * * *"`), em UTC**, **desativada por padrão** (`JOBFINDER_AUTOMATION_ENABLED=false`), execução manual (`workflow_dispatch`) e controle de concorrência.
- **Script de migração dos históricos:** importa os JSON existentes para o PostgreSQL com modo de simulação e importação idempotente.
- **Correção do filtro de estágios:** vagas como *Estágio em Desenvolvimento de Software* deixam de ser descartadas, mantendo o reconhecimento de desenvolvimento júnior/estágio em português e inglês.
- **Testes automatizados:** filtros, persistência, deduplicação, concorrência e tratamento de falhas (`npm test`).

## Funcionalidades incluídas

- Coleta de vagas em **59 boards públicos** de empresas: **Greenhouse**, **Lever**, **Ashby** e **InHire**, por empresa configurada.
- Coleta de vagas no **LinkedIn Jobs** e no **Indeed Jobs**, por termo de busca (júnior e estágio), com rotação de lotes por hora UTC.
- Normalização de vagas para um modelo comum e deduplicação por origem e identificador (`source:id`).
- Filtros de cargo (desenvolvimento), senioridade (exclui sênior/pleno/lead), localização e **contratação** (CLT ou estágio; PJ não é apresentado como aprovado).
- Priorização determinística (0–100) das vagas por stack, senioridade, localização, recência e contratação; ordena da maior para a menor pontuação, sem excluir oportunidades.
- Análise de vagas com **limite operacional de cinco análises por execução** (`JOBFINDER_MAX_ANALYSES`, padrão `1`, teto `5`), por meio do Gemini, reaproveitando análises salvas.
- Persistência em **arquivo JSON** ou **PostgreSQL**, com seleção explícita por variável de ambiente.
- **Reserva de notificação** antes do envio, com recuperação manual de reservas pendentes, evitando duplicidade.
- Notificações de vagas aprovadas via Telegram, quando habilitadas.
- Alertas opcionais de **revisão manual** para vagas possivelmente compatíveis cuja decisão não é confirmada (decisão `review` da IA ou localização/contratação indefinidas), sem apresentá-las como confirmadas.
- Execução **manual** (local) e **agendada** (GitHub Actions, desativada por padrão), com limite de **uma notificação por execução**.
- **Sem envio quando não há vagas elegíveis:** se nenhuma vaga passar pelos filtros, pela análise e pela política de notificação (ou se todas já tiverem sido notificadas), **nenhuma mensagem é enviada**.

O JobFinder **não** envia currículos, não se candidata a vagas e não confirma por conta própria que os processos seletivos permanecem abertos.

## Tecnologias

- Node.js, TypeScript e módulos ESM/NodeNext
- APIs públicas de vagas da Greenhouse, Lever, Ashby e InHire
- **`ts-jobspy@3.0.1`** para a coleta de vagas do LinkedIn Jobs e do Indeed Jobs
- **`patch-package`** para o suporte a `geoId` nas pesquisas locais do LinkedIn
- Google Gemini (`@google/genai`)
- Telegram Bot API
- PostgreSQL no Supabase (`pg`), com TLS validado
- GitHub Actions para agendamento
- Arquivos JSON locais como alternativa de histórico

## Requisitos

- **Node.js** com suporte a `--env-file` (recomendado Node.js 22 ou mais recente).
- **npm** e acesso à internet para coleta, Gemini e Telegram.
- Chave da **Gemini API** para análises.
- Para notificações: bot do Telegram, token e identificador do chat de destino.
- Para persistência na nuvem: projeto **Supabase** e a `DATABASE_URL`.

## Instalação e configuração

No terminal, na pasta do projeto:

```bash
npm install
cp .env.example .env
npm run build
```

O `npm install` executa o `postinstall` (`patch-package`), que aplica o patch local em `ts-jobspy@3.0.1` para habilitar o `geoId`. O comando `cp` funciona no Git Bash, Linux e macOS. Edite o `.env` com suas credenciais. **Nunca publique nem compartilhe esse arquivo.**

### Variáveis de ambiente

| Variável | Finalidade | Padrão recomendado |
|---|---|---|
| `NODE_ENV` | Identifica o ambiente | `development` |
| `GEMINI_API_KEY` | Chave para a Gemini API | Obrigatória para analisar |
| `TELEGRAM_BOT_TOKEN` | Token do bot | Necessário para enviar mensagens |
| `TELEGRAM_CHAT_ID` | Chat de destino | Necessário para enviar mensagens |
| `JOBFINDER_STORAGE` | Backend de histórico: `json` ou `postgres` | `json` |
| `JOBFINDER_MAX_ANALYSES` | Número máximo de novas análises por execução | `1` (teto de `5`) |
| `JOBFINDER_SEND_NOTIFICATIONS` | Permite o envio real de notificações | `false` |
| `JOBFINDER_SEND_REVIEWS` | Permite avisos de revisão manual, além do envio geral | `false` |
| `JOBFINDER_AUTOMATION_ENABLED` | Habilita o job **agendado** do GitHub Actions | `false` |
| `DATABASE_URL` | Conexão PostgreSQL do Supabase | Obrigatória no modo `postgres` |
| `DATABASE_CA_CERT_PATH` | Caminho do certificado CA do Supabase | `./certs/prod-ca-2021.crt` |
| `JOBFINDER_RUN_DB_TESTS` | Autoriza testes que gravam no banco | `false` |

O valor `true` deve ser escrito exatamente assim. Para ativar alertas de revisão manual, **as duas variáveis de envio** precisam ser `true`.

Sobre a automação: `JOBFINDER_AUTOMATION_ENABLED=true` **habilita a execução automática** do job agendado do GitHub Actions; `false` é a **configuração segura padrão** e mantém os agendamentos inativos (sem chamadas ao Gemini e sem envios). Essa variável controla apenas a execução **agendada** — a execução manual (`workflow_dispatch`) e a execução local **não** dependem dela.

O arquivo `.env.example` contém somente valores de exemplo.

## Coleta de vagas (LinkedIn Jobs e Indeed Jobs)

As pesquisas do LinkedIn e do Indeed são configuradas em `src/config/linkedin-searches.ts` e `src/config/indeed-searches.ts` e atendidas pelos providers `src/providers/linkedin.ts` e `src/providers/indeed.ts`, sobre a biblioteca `ts-jobspy@3.0.1`.

| Plataforma | Pesquisas totais | Locais (Maceió/AL) | Remotas (Brasil) | Limite por pesquisa |
|---|---|---|---|---|
| LinkedIn Jobs | 110 | 22 | 88 | 10 vagas |
| Indeed Jobs | 110 | 22 | 88 | 15 vagas |

- **Rotação de lotes:** as 110 pesquisas de cada plataforma formam **22 lotes**; cada lote contém **1 pesquisa local de Maceió** e **4 pesquisas remotas nacionais**. A seleção é determinística e **sem estado**: converte a data atual em horas UTC absolutas e aplica módulo 22, então cada hora do calendário mapeia sempre para o mesmo lote e o ciclo se repete a cada 22 horas. As rotações do LinkedIn e do Indeed são independentes.
- **Por execução:** são executadas **5 pesquisas do LinkedIn e 5 do Indeed** (10 no total). As 220 pesquisas **não** são executadas simultaneamente — a cobertura completa ocorre ao longo do ciclo de 22 horas.
- **Coleta sequencial:** os lotes do LinkedIn e do Indeed são executados **um após o outro** e cada lote roda **uma pesquisa por vez**, pois ambos compartilham a mesma biblioteca `ts-jobspy` e pesquisas concorrentes entrariam em conflito.
- **`geoId` via patch:** as pesquisas locais do LinkedIn fixam a cidade com `geoId` (`102957102` para Maceió/AL), suporte fornecido pelo patch `patches/ts-jobspy+3.0.1.patch`. A versão do `ts-jobspy` fica **fixada exatamente** (`3.0.1`) para garantir a compatibilidade do patch.
- **Descrição completa:** o provider do LinkedIn busca a descrição completa de cada vaga (`fetchDescription: true`), necessária à análise da IA.
- **Modalidade:** a modalidade é inferida dos sinais do próprio anúncio (título, localização e descrição), considerando termos em português, e não apenas o filtro de busca.
- **Falhas isoladas:** o desfecho de cada coleta (`ok`, `empty`, `partial`, `error`) é tratado explicitamente. Em `error`, a fonte falha isoladamente; em `partial`, as vagas já coletadas são preservadas e a interrupção é registrada. A falha de um provider não interrompe a execução.

## Providers e boards públicos

O JobFinder possui **seis providers**, em duas famílias: **boards públicos de empresa** (Greenhouse, Lever, Ashby e InHire) e **plataformas de busca por termo** (LinkedIn Jobs e Indeed Jobs). Todos usam o `fetch` nativo do Node.js.

### Boards públicos de empresa

| Provider | Endpoint público | Identificação da empresa |
|---|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards` | `identifier` do board |
| Lever | `https://api.lever.co/v0/postings` | `identifier` do board |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board` | `identifier` do board |
| InHire | `https://api.inhire.app/job-posts/public/pages` | cabeçalho `X-Tenant` |

- **Requisições com timeout:** toda requisição a board público é limitada a **15 segundos** por requisição (conexão, cabeçalhos e leitura do corpo). O timeout é convertido em `BoardTimeoutError`, diferenciado nos logs, e não interrompe os demais providers.
- **Validação de identidade:** um board só é adicionado depois de confirmar a identidade da empresa no endpoint/metadado oficial, evitando homônimos.
- **Boards temporariamente vazios:** um board válido que esteja sem vagas publicadas é mantido (a fonte continua sendo consultada).

### Integração InHire

A API pública da InHire exige o cabeçalho **`X-Tenant`** em todas as requisições e expõe apenas uma **listagem rasa** por empresa. Como a listagem não traz descrição, data de publicação nem tipo de contratação, cada vaga publicada é complementada por uma **requisição de detalhe** (`/job-posts/public/pages/{jobId}`). Nenhuma informação ausente é inventada e a data da coleta nunca é usada como data de publicação.

Para respeitar o limite da API sem perder cobertura:

- **Pacing por empresa:** intervalo de **250 ms** entre requisições sequenciais de detalhe de uma mesma empresa.
- **Teto agregado compartilhado:** intervalo mínimo de **60 ms** entre os **inícios efetivos** de *todas* as requisições InHire — listagens **e** detalhes, de todas as empresas (≈ 16 req/s, abaixo do limite de 20 req/s documentado pela InHire). O intervalo é medido por **relógio monotônico**; a espera pela resposta HTTP **não** é serializada.
- **Concorrência limitada:** no máximo **4 empresas** coletadas simultaneamente.
- **Timeouts consecutivos:** os detalhes de uma empresa são abandonados somente após **3 timeouts consecutivos**; uma requisição bem-sucedida **reinicia** o contador. Não há limite de quantidade de vagas nem de tempo fixo por empresa, portanto empresas lentas porém saudáveis não são truncadas.
- **Rate limiting imediato:** ao receber **HTTP 429** em um detalhe, os detalhes restantes daquela empresa são ignorados, preservando as vagas já coletadas.
- **Isolamento por vaga:** falha de um detalhe (ou da normalização) descarta apenas a vaga afetada, sem interromper a coleta das demais empresas.

## Filtros, priorização e triagem

A ordem do funil é: **deduplicação → cargo → senioridade → localização → priorização**.

- **Deduplicação:** chave única `source:id`; a mesma vaga vinda de fontes distintas é mantida como registros separados.
- **Cargo (desenvolvimento):** mantém títulos de desenvolvimento de software (ex.: *developer*, *frontend*, *backend*, *full stack*, *desenvolvedor*, *engenheiro de software*) e **descarta** áreas não técnicas (vendas, marketing, RH/recrutamento) com precedência sobre qualquer termo de tecnologia. A comparação normaliza acentos e maiúsculas (Unicode NFD + remoção de diacríticos), sem alterar o sentido das palavras-chave.
- **Senioridade:** remove títulos com senioridade alta por **palavra inteira** (`sênior`, `pleno`, `lead`, `staff`, `principal`, `especialista`/`specialist`, `mid-level`), preservando júnior, estágio, trainee e vagas sem senioridade informada.
- **Localização:** remove apenas vagas **claramente incompatíveis** (presencial/híbrido fora de Maceió/AL, restrição explícita a residentes de outro país ou exclusão explícita do Brasil). Para vagas **remotas sem restrição geográfica explícita**, a triagem presume **elegibilidade operacional** (`allowed`) — uma presunção de triagem, **não** uma confirmação de disponibilidade no Brasil. Os bloqueios explícitos são preservados: localização estrangeira, restrição de residência a outro país e exclusão explícita do Brasil permanecem `blocked`; sinais contraditórios (localização estrangeira com descrição que declara aceitar residentes no Brasil) permanecem `unknown`. `remote: true` **não** significa disponibilidade no Brasil e `remote: false` **não** confirma presencial — a modalidade é inferida do próprio anúncio, considerando negações e contradições. Vagas **indefinidas** são preservadas para a IA avaliar.
- **Padrões geográficos centralizados:** as expressões regulares geográficas compartilhadas por `location-filter.ts` e `job-priority.ts` ficam reunidas em `src/config/geo-patterns.ts`, evitando divergência entre triagem e priorização.
- **Priorização (pontuação 0–100):** ordena sem descartar, somando cinco critérios: **stack (35)** — JavaScript, TypeScript, React, Node.js, Express e PostgreSQL, distinguindo requisito obrigatório, diferencial e menção incidental; **senioridade (30)** — prioriza júnior e estágio; **localização (20)** — prioriza remoto no Brasil e, em seguida, presencial/híbrido em Maceió/AL; **recência (10)** — favorece publicações recentes sem excluir vagas sem data; **contratação (5)** — favorece CLT e estágio confirmados. Informações desconhecidas recebem pontuação neutra e **nunca** causam exclusão. Desempate por publicação mais recente e, por fim, ordem original (ordenação estável). Datas ausentes, inválidas ou futuras recebem pontuação neutra de recência.

> Os filtros e a IA são mecanismos de **triagem**, não garantias de elegibilidade. A classificação geográfica dos filtros (`allowed`) para vagas remotas sem restrição é uma **presunção operacional de elegibilidade**, distinta da **elegibilidade confirmada pelo Gemini**: a análise de IA em `src/services/ai-analyzer.ts` continua validando a vaga (aceita júnior/estágio/trainee, remoto para residentes no Brasil, presencial/híbrido apenas em Maceió/AL e contratação CLT ou estágio) e pode descartá-la; informação ausente retorna `unknown` e **nunca** é presumida.

## Tratamento de HTTP 429 (rate limiting)

A coleta do **LinkedIn** e do **Indeed** (via `ts-jobspy@3.0.1`) pode responder **HTTP 429**. O tratamento:

- O rate limiting é detectado prioritariamente pelo sinal estruturado (`RateLimitException`) e, como fallback restrito, pelo **literal `HTTP 429`** na mensagem agregada (`ScrapeInterrupted`). Um "429" isolado, sem o prefixo HTTP, é ignorado para evitar falso positivo.
- Ao detectar 429, as **pesquisas restantes daquele provider são interrompidas**, preservando as vagas já coletadas — inclusive as devolvidas pelo próprio retorno parcial. Os demais providers **continuam** normalmente.
- **Não há retries adicionais** para 429: a interrupção é propagada e o tratamento permanece determinístico.
- O helper `withRateLimitGuard` converte rejeições diretas de `scrapeJobs` em `RateLimitError`, cobrindo o caso em que a promessa rejeita antes de retornar resultados.

## Versionamento das análises

Cada análise do Gemini é vinculada a uma **versão centralizada de critérios** (`ANALYSIS_CRITERIA_VERSION = "2026-11-19.2"`, em `src/services/ai-analyzer.ts`).

- **Reutilização estrita:** uma análise salva só é reaproveitada quando a `criteriaVersion` for **idêntica** à versão vigente. Análises de versões anteriores — inclusive registros legados, sem versão — são **reanalisadas**.
- **Histórico cumulativo:** ao reanalisar, a nova análise é **acrescentada**; nenhum resultado anterior é apagado ou alterado. No PostgreSQL, a unicidade é `UNIQUE NULLS NOT DISTINCT (key, criteria_version)` (uma linha por vaga e versão, no máximo uma legada), e a chave primária passa a ser um `id` substituto.
- **Notificadas não são reanalisadas:** uma vaga já notificada (ou reservada) **não** consome cota do Gemini, mesmo após mudança de versão de critérios.
- **Incrementar a versão** sempre que as regras do prompt ou o schema da resposta mudarem, para disparar a reanálise.

## Resiliência do pipeline

- **Falhas de provider são isoladas:** cada fonte é coletada individualmente; a falha de uma não derruba as demais.
- **Falhas do Gemini são categorizadas** (`classifyGeminiError`): `rate_limit`, `unavailable`, `timeout`, `auth`, `invalid` e `unknown`. Respostas vazias ou estruturalmente inválidas isolam apenas a vaga afetada; falhas **globais** (cota, indisponibilidade, rede, autenticação) interrompem **novas chamadas** à IA pelo resto da execução **sem parar o laço**: as análises já salvas continuam sendo reaproveitadas e as vagas pendentes ficam elegíveis para a próxima execução.
- **Nenhuma falha vira análise válida:** uma análise malsucedida **não** é persistida nem notificada.
- **Limite por tentativas:** `JOBFINDER_MAX_ANALYSES` limita **tentativas** (não apenas sucessos), impedindo repetição quando a API está indisponível ou com cota esgotada.
- **Contadores distintos no resumo:** `failedAnalyses` (falhas), `unanalyzedByLimit` (barradas pelo limite, com histórico consultado), `unanalyzedByGemini` (sem análise por indisponibilidade da IA) e `unscannedByLimit` (nem percorridas pelo limite).
- **Encerramento explícito:** falhas de **banco**, **Gemini** ou **Telegram** interrompem a execução com código de saída diferente de zero; falhas individuais de provider são registradas e isoladas.

## Persistência: JSON ou PostgreSQL

O backend é escolhido por `JOBFINDER_STORAGE`:

- **`json` (padrão):** históricos em `data/analyzed-jobs.json` e `data/notified-jobs.json`. Ideal para uso local. Não há sincronização entre máquinas.
- **`postgres`:** históricos em `public.analyzed_jobs` e `public.notified_jobs` do Supabase, identificados pela mesma chave `source:id`.

Regras importantes do modo `postgres`:

- **Sem fallback silencioso:** se o banco falhar, a execução falha com erro. O JobFinder **não** cai para JSON automaticamente.
- **Sem envio sem estado de deduplicação:** a vaga é **reservada no banco antes do envio**. Se a reserva não puder ser feita, nenhuma notificação é enviada.
- **TLS validado:** a conexão exige validação do certificado do servidor. O certificado público do Supabase já está em `certs/prod-ca-2021.crt`; parâmetros de SSL na `DATABASE_URL` (como `sslmode`) são ignorados para não sobrepor essa validação.

### Segurança das notificações

Cada envio segue um ciclo com **reserva atômica** e **propriedade**:

1. **Reserva (`pending`):** a vaga é reservada com um token de execução (`reserved_by`) e registro de horário (`reserved_at`). A operação é atômica: se a vaga já tiver reserva ou já estiver enviada, a reserva falha e **nada é enviado**.
2. **Envio:** a mensagem é entregue ao Telegram.
3. **Confirmação (`sent`):** a reserva só é confirmada pela **mesma execução** que a criou (`where status='pending' and reserved_by=<token>`). Uma execução não confirma nem libera reserva de outra.
4. **Desfechos possíveis:**
   - **Envio confirmadamente não entregue** (ex.: `HTTP 4xx` do Telegram): a reserva é **liberada**, permitindo nova tentativa futura.
   - **Resultado incerto** (ex.: timeout/erro de rede sem resposta): a reserva é **mantida como `pending`** e **não** há reenvio automático.
   - **Falha só na confirmação do banco** (Telegram aceitou, mas o `update` de confirmação falhou): a reserva **não** é liberada, pois a mensagem já pode ter chegado.

Reservas `pending` contam como **já notificadas**, bloqueando reenvios automáticos. Para recuperá-las manualmente, use o script descrito em *Recuperação de reservas pendentes*.

### Migrations do banco

As migrations ficam em `supabase/migrations/`:

1. `20261112000000_create_job_history_tables.sql` — cria `analyzed_jobs` e `notified_jobs` com RLS habilitado.
2. `20261113000000_add_notified_jobs_status.sql` — adiciona a coluna `status` (`pending`/`sent`) em `notified_jobs`.
3. `20261114000000_add_notified_jobs_reservation_owner.sql` — adiciona `reserved_by` e `reserved_at` (propriedade da reserva) em `notified_jobs`.
4. `20261115000000_add_analyzed_jobs_criteria_version.sql` — adiciona `criteria_version` em `analyzed_jobs`, troca a chave primária por um `id` substituto e cria a unicidade de negócio `UNIQUE NULLS NOT DISTINCT (key, criteria_version)`, preservando o histórico por versão de critérios.

Aplique-as pelo painel/SQL Editor do Supabase ou pelo Supabase CLI:

```bash
supabase db push
```

Todas as migrations são aditivas (`add column if not exists`) e idempotentes; podem ser aplicadas com segurança sobre o banco já existente. A migration de `criteria_version` exige PostgreSQL 15+ (Supabase 17) por usar `unique nulls not distinct` e `generated always as identity`.

## Migração dos históricos locais

Para importar os JSON existentes para o PostgreSQL, use o script dedicado. Ele **não** roda automaticamente, **preserva os arquivos originais** e é **idempotente** (`ON CONFLICT DO NOTHING`). O modo `--dry-run` **valida cada registro** (chave, `status` e campos obrigatórios) sem abrir conexão nem gravar nada — registros inválidos interrompem o comando tanto na simulação quanto na importação real.

```bash
# 1) Simular e validar (não abre conexão nem grava nada)
npm run db:migrate:dry

# 2) Importar de verdade (requer DATABASE_URL no .env)
npm run db:migrate
```

Equivalente sem npm scripts:

```bash
npm run build
node --env-file=.env scripts/migrate-json-to-postgres.mjs --dry-run
node --env-file=.env scripts/migrate-json-to-postgres.mjs
```

Os npm scripts carregam o `.env` local via `--env-file=.env`. A migração real **não** é executada por padrão; rodá-la exige ação manual e consciente.

## Recuperação de reservas pendentes

Reservas `pending` indicam envios cujo resultado é desconhecido. O JobFinder **nunca** reenvia automaticamente essas vagas. Para inspecionar e resolver manualmente:

```bash
# Listar reservas pendentes (todas)
npm run notifications:pending

# Listar apenas as mais antigas que 30 minutos
npm run build
node --env-file=.env scripts/recover-pending-notifications.mjs --older-than=30

# Confirmar entrega (após verificar no Telegram que a mensagem chegou)
node --env-file=.env scripts/recover-pending-notifications.mjs --mark-sent="source:id"

# Liberar para nova tentativa (somente se a mensagem NÃO chegou)
node --env-file=.env scripts/recover-pending-notifications.mjs --release="source:id"
```

O script apenas lê, confirma (`sent`) ou libera (`released`) reservas existentes; ele **não** envia mensagens. Respeita `JOBFINDER_STORAGE` (`json` ou `postgres`).

## Como executar

**1. Compilar o projeto:**

```bash
npm run build
```

**2. Execução manual em modo seguro (sem mensagens), com PostgreSQL:**

```bash
JOBFINDER_STORAGE=postgres JOBFINDER_SEND_NOTIFICATIONS=false node --env-file=.env dist/index.js
```

**3. Analisar até três vagas novas, ainda sem enviar mensagens:**

```bash
JOBFINDER_MAX_ANALYSES=3 JOBFINDER_SEND_NOTIFICATIONS=false node --env-file=.env dist/index.js
```

**4. Permitir uma notificação normal por execução:**

```bash
JOBFINDER_SEND_NOTIFICATIONS=true JOBFINDER_SEND_REVIEWS=false node --env-file=.env dist/index.js
```

> **Atenção:** os comandos de envio podem enviar uma mensagem **real** ao Telegram. Antes de utilizá-los, confirme as credenciais, o chat de destino e as regras de seleção. Na configuração atual, cada execução analisa **no máximo uma nova vaga** (padrão de `JOBFINDER_MAX_ANALYSES`) e envia **no máximo uma notificação**, com prioridade para vagas compatíveis. Se **não houver vagas elegíveis**, **nenhuma mensagem é enviada**.

## Automação com GitHub Actions

O workflow `.github/workflows/jobfinder.yml` executa o JobFinder automaticamente:

- **Agendamento:** **a cada hora, aos 17 minutos (`cron: "17 * * * *"`), em UTC**, **desativado por padrão**.
- **Ativação controlada:** o job agendado só executa quando a variável de repositório `JOBFINDER_AUTOMATION_ENABLED` for `true`. Enquanto ela não existir ou for diferente de `true`, os agendamentos **não** chamam o Gemini nem enviam nada.
- **Execução manual:** pela aba **Actions** do GitHub (`workflow_dispatch`), sempre permitida para disparo controlado.
- **Concorrência:** `concurrency: jobfinder` evita execuções simultâneas.
- **Permissões mínimas:** `contents: read` e `timeout-minutes: 10`.
- **Persistência:** `JOBFINDER_STORAGE=postgres`; não usa arquivos JSON locais.
- **TLS:** usa o certificado versionado `certs/prod-ca-2021.crt` via `DATABASE_CA_CERT_PATH`.
- **Envios desativados por padrão:** só enviam se as variáveis do repositório forem definidas como `true`.
- **Sem envio sem vagas elegíveis:** se nenhuma vaga passar pelos filtros e pela análise (ou se todas já estiverem notificadas), a execução termina **sem enviar nenhuma mensagem**.

> O agendamento do GitHub Actions **pode atrasar** e **não é tempo real**. Para diagnosticar falhas, verifique os logs na aba **Actions**.

### Teste manual do Telegram (Telegram Smoke Test)

O workflow independente `.github/workflows/telegram-smoke.yml` valida o envio ao Telegram **manualmente**, sem envolver a rotina principal:

- **Gatilho:** exclusivamente `workflow_dispatch` — **sem** `schedule`, `push` ou outros gatilhos automáticos.
- **Passos:** `checkout` → Node.js 22 → `npm ci --include=dev` → `npm run build` → `node scripts/telegram-smoke.mjs`.
- **Mensagem:** envia **uma única** mensagem fictícia, identificada como `TESTE — JobFinder GitHub Actions`, deixando claro que é apenas um teste técnico e **não** uma oportunidade real.
- **Credenciais:** usa **somente** os Secrets `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`; reutiliza `sendJobNotification`, sem duplicar a lógica HTTP.
- **Isolamento:** **não** consulta o Gemini, **não** acessa o PostgreSQL/Supabase, **não** lê nem grava históricos, **não** altera reservas de notificação e **não** usa `src/index.ts`.
- **Segurança:** não imprime tokens nem chat IDs; encerra com código diferente de zero se o envio falhar.

Para executá-lo: abra a aba **Actions**, selecione **Telegram Smoke Test** e clique em **Run workflow**. Este workflow **não** interfere na automação principal nem na variável `JOBFINDER_AUTOMATION_ENABLED`.

### GitHub Secrets (obrigatórios)

Em **Settings → Secrets and variables → Actions → Secrets**, crie:

| Secret | Descrição |
|---|---|
| `DATABASE_URL` | String de conexão PostgreSQL do Supabase |
| `GEMINI_API_KEY` | Chave da Gemini API |
| `TELEGRAM_BOT_TOKEN` | Token do bot do Telegram |
| `TELEGRAM_CHAT_ID` | Chat de destino |

Os segredos são mascarados nos logs e nunca são impressos pelo código.

### Variáveis do repositório (opcionais)

Em **Settings → Secrets and variables → Actions → Variables**, crie conforme necessário:

| Variável | Descrição | Padrão |
|---|---|---|
| `JOBFINDER_AUTOMATION_ENABLED` | Habilita o job **agendado** | `false` |
| `JOBFINDER_MAX_ANALYSES` | Novas análises por execução (1–5) | `1` |
| `JOBFINDER_SEND_NOTIFICATIONS` | Habilita envios reais | `false` |
| `JOBFINDER_SEND_REVIEWS` | Habilita avisos de revisão | `false` |

Para ativar o agendamento, defina `JOBFINDER_AUTOMATION_ENABLED=true`. Para ativar os envios, defina também `JOBFINDER_SEND_NOTIFICATIONS=true` **conscientemente**, após validar as credenciais. A execução manual (`workflow_dispatch`) não depende de `JOBFINDER_AUTOMATION_ENABLED`.

## Fluxo de processamento

```text
Fontes (Greenhouse, Lever, Ashby, InHire, LinkedIn Jobs, Indeed Jobs)
                  |
                  v
   Coleta: boards em paralelo + lotes rotativos em sequência
                  |
                  v
        Normalização e deduplicação
                  |
                  v
 Filtros: cargo, senioridade, localização, contratação
                  |
                  v
           Prioridade geográfica
                  |
                  v
   Histórico: vaga já analisada? (JSON ou PostgreSQL)
           |                 |
          Sim               Não
           |                 |
   Reutiliza análise     Gemini (até limite)
           |                 |
           +--------+--------+
                    |
                    v
          Política de notificação
             /          |          \
       Compatível     Revisão      Bloqueada
             |          |              |
             v          v              |
      Reserva antes do envio           Sem alerta
             |
             v
      Telegram (até 1 envio)
             |
     +-------+-----------------------------+
     |                  |                  |
  Envio OK         Não entregue       Resultado incerto
     |                  |                  |
     v                  v                  v
 confirma (sent)   libera reserva   mantém pending
 (mesma execução)  (nova tentativa)  (sem reenvio)
```

**Critérios gerais de triagem:** priorizar vagas de entrada em desenvolvimento (júnior/estágio) e tecnologias como JavaScript, TypeScript, React, Node.js e PostgreSQL; remoto disponível no Brasil ou presencial/híbrido viável em Maceió/AL; contratação CLT ou estágio. Vagas PJ explícitas ou com localidade bloqueada não devem ser apresentadas como aprovadas. Os filtros e a IA são mecanismos de triagem, **não garantias de elegibilidade**.

**Regra de alerta de revisão manual:** uma análise não bloqueada cuja decisão não seja `compatible` com localização **e** contratação `allowed` pode gerar um aviso separado **somente quando explicitamente habilitado**. São candidatas a revisão as análises com decisão `review` da IA ou com localização/contratação indefinidas (`unknown`). Localização ou contratação **bloqueada**, bem como decisão `incompatible`, **nunca** geram alerta. A notificação `compatible` exige decisão `compatible` **e** ambos os critérios `allowed`; informação indefinida nunca é promovida a elegibilidade confirmada.

## Fontes configuradas

As empresas/boards utilizados são definidos em `src/config/job-sources.ts`, e as pesquisas do LinkedIn e do Indeed em arquivos próprios. A configuração atual reúne **59 boards públicos de empresas**, distribuídos entre os quatro providers de board, além das pesquisas por termo:

| Provider | Boards configurados | Referência de exemplo |
|---|---|---|
| Greenhouse | 24 | `ifoodcarreiras`, `xpinc`, `c6bank`, `stone` |
| InHire | 22 | `celcoin`, `contabilizei`, `olist`, `cielo` |
| Ashby | 9 | `nubank`, `deel`, `truelogic` |
| Lever | 4 | `Flex`, `ciandt`, `oowlish` |
| LinkedIn Jobs | 110 pesquisas (22 locais em Maceió/AL + 88 remotas no Brasil) | — |
| Indeed Jobs | 110 pesquisas (22 locais em Maceió/AL + 88 remotas no Brasil) | — |

**Total: 59 boards públicos** (37 em Greenhouse/Lever/Ashby + 22 empresas na InHire) **e 220 pesquisas** (110 do LinkedIn + 110 do Indeed).

Cada identificador de board foi confirmado contra o endpoint público do respectivo provider (resposta HTTP 200 com corpo válido) e a identidade da empresa foi conferida no metadado/portal oficial antes de ser adicionada. Boards que responderam erro HTTP, apontaram para empresa sem evidência de contratação no Brasil ou cuja identidade não pôde ser confirmada ficaram de fora. Alguns boards válidos podem estar **temporariamente sem vagas publicadas** e mesmo assim permanecem configurados.

Essas fontes foram usadas para validar os providers e **não garantem oportunidades compatíveis com candidatos residentes no Brasil**. Adicionar uma nova empresa à lista exige confirmar previamente o identificador aceito pela respectiva API. A cobertura completa das pesquisas do LinkedIn e do Indeed ocorre ao longo do ciclo de 22 lotes; cada execução roda apenas 5 pesquisas de cada plataforma.

## Testes e validações realizadas

```bash
# Build (TypeScript em modo estrito/ESM)
npm run build

# Filtros, persistência JSON, deduplicação, concorrência e falhas de despacho
npm test

# Testes que gravam no PostgreSQL (opt-in; usa chaves de teste e limpa ao final)
JOBFINDER_RUN_DB_TESTS=true npm run test:db
```

`npm test` executa, em sequência, dez suítes de teste e duas validações determinísticas, todas locais (com `node:test`, sem rede nem chamadas reais a APIs externas):

| Script | Cobre |
|---|---|
| `test-filters.mjs` | filtros de cargo (com normalização de acentos), senioridade e localização |
| `test-ai-analyzer.mjs` | captura de dados, prompt, schema de resposta e coerência com a política de notificação |
| `test-analysis-versioning.mjs` | reutilização estrita por `criteria_version` e histórico cumulativo |
| `test-storage.mjs` | persistência JSON, reserva e propriedade (`reserved_by`), deduplicação |
| `test-dispatch.mjs` | desfechos do despacho (confirmação, não entregue, resultado incerto, recuperação pendente) |
| `test-rate-limit.mjs` | detecção estruturada/textual de HTTP 429 e interrupção preservando vagas |
| `test-board-timeout.mjs` | timeout de boards públicos (`BoardTimeoutError`) |
| `test-inhire.mjs` | teto agregado de requisições, política de 3 timeouts consecutivos e reset |
| `test-job-sources.mjs` | integridade da configuração de fontes/boards |
| `test-process-jobs.mjs` | resiliência do `processJobs` (falha global do Gemini, reuso de análises, limite por tentativas, ausência de persistência/envio em falhas) |
| `validate-linkedin.mjs` (modo local) | matriz de 110 pesquisas do LinkedIn (22 locais + 88 remotas), rotação de 22 lotes (1 local + 4 remotas por hora UTC), determinismo e ciclo de 22 h, sem rede |
| `validate-indeed.mjs` (modo local) | matriz de 110 pesquisas do Indeed (22 locais + 88 remotas), rotação de 22 lotes (1 local + 4 remotas por hora UTC), determinismo e ciclo de 22 h, sem rede |

Os testes de banco **não** são executados por `npm test`: exigem `DATABASE_URL` e `JOBFINDER_RUN_DB_TESTS=true` e só rodam quando você autoriza explicitamente. Eles usam o prefixo `db-test:` e removem suas linhas ao final; sem as variáveis, apenas informam e não tocam no Supabase.

**Resultados das validações realizadas:**

- **Build:** o projeto compila com `npm run build` (TypeScript em modo estrito, ESM/NodeNext), sem erros de tipo.
- **Testes automatizados:** `npm test` valida a lógica interna de filtros, deduplicação, versionamento das análises, persistência JSON com reserva e propriedade, rate limiting, timeout de boards, integração InHire, resiliência do pipeline e as matrizes/rotações do LinkedIn e do Indeed.
- **Roteiro de fumaça:** `scripts/smoke-test.mjs` exercita, em um diretório temporário, o fluxo de deduplicação → filtros → análise → persistência → (envio opcional), sem tocar nos históricos reais.
- **Validação dos providers:** `scripts/validate-linkedin.mjs` e `scripts/validate-indeed.mjs` rodam por padrão em **modo local e determinístico** (validam as matrizes de 110 pesquisas e a rotação dos 22 lotes de cada plataforma, sem rede) e são executados por `npm test`. Para o LinkedIn, a coleta real é manual e explícita: `node scripts/validate-linkedin.mjs --collect` executa **apenas** `fetchLinkedInJobs`, sem Gemini, Supabase ou Telegram, para inspeção da coleta.

> **Importante:** essas validações são **isoladas** e verificam a **lógica interna** do projeto. Elas **não** garantem o funcionamento integral em produção: a coleta real depende de `ts-jobspy` e de serviços de terceiros (sujeitos a mudanças de layout, bloqueios, limites e termos de uso), e as integrações com Gemini, Telegram e Supabase dependem de credenciais, cotas e conectividade. A cobertura completa das 220 pesquisas ocorre ao longo de 22 execuções e não é exercitada de uma só vez.

## Estrutura principal

```text
jobfinder/
├── .github/workflows/
│   ├── jobfinder.yml                  # Automação agendada (GitHub Actions)
│   └── telegram-smoke.yml             # Teste manual de envio ao Telegram
├── certs/prod-ca-2021.crt             # Certificado CA público do Supabase
├── patches/ts-jobspy+3.0.1.patch      # Patch local: suporte a geoId no ts-jobspy
├── src/
│   ├── config/
│   │   ├── job-sources.ts             # União de fontes e quadros de vagas
│   │   ├── geo-patterns.ts            # Expressões regulares geográficas compartilhadas
│   │   ├── linkedin-searches.ts       # 110 pesquisas do LinkedIn Jobs
│   │   └── indeed-searches.ts         # 110 pesquisas do Indeed Jobs
│   ├── db/postgres.ts                 # Pool PostgreSQL com TLS validado
│   ├── providers/
│   │   ├── board-http.ts              # Requisições a boards com timeout (BoardTimeoutError)
│   │   ├── greenhouse.ts
│   │   ├── lever.ts
│   │   ├── ashby.ts
│   │   ├── inhire.ts                  # Listagem + detalhe, pacing/teto agregado e timeouts
│   │   ├── linkedin.ts                # LinkedIn Jobs via ts-jobspy
│   │   └── indeed.ts                  # Indeed Jobs via ts-jobspy
│   ├── services/
│   │   ├── ai-analyzer.ts             # Análise via Gemini e versão dos critérios
│   │   ├── analysis-history.ts        # Histórico de análises (JSON ou PostgreSQL)
│   │   ├── deduplication.ts           # Chave, reserva e histórico de notificações
│   │   ├── storage.ts                 # Seleção do backend de persistência
│   │   ├── rate-limit.ts              # Detecção de HTTP 429 e interrupção parcial
│   │   ├── job-filter.ts
│   │   ├── seniority-filter.ts
│   │   ├── location-filter.ts
│   │   ├── job-priority.ts            # Pontuação/priorização determinística (0–100)
│   │   ├── linkedin-search-rotation.ts # Rotação dos 22 lotes do LinkedIn
│   │   ├── indeed-search-rotation.ts   # Rotação dos 22 lotes do Indeed
│   │   ├── notification-policy.ts
│   │   ├── notification-dispatch.ts   # Reserva + envio + confirmação/liberação
│   │   └── telegram.ts
│   ├── types/job.ts
│   └── index.ts                       # Pipeline (processJobs, geminiBlocked)
├── supabase/migrations/               # Migrations SQL
├── scripts/                           # Testes e utilitários manuais (test-*.mjs, smoke-test.mjs, ...)
├── data/                              # Históricos JSON locais (não versionar)
├── .env.example                       # Referência de configuração, sem segredos
├── package.json
└── tsconfig.json
```

`dist/` contém o código JavaScript gerado na compilação e não deve ser editado manualmente.

## Segurança e boas práticas

1. Não colocar chaves, tokens ou `TELEGRAM_CHAT_ID` real em arquivos versionados.
2. Conferir que `.env` e os históricos locais não estão sendo rastreados pelo Git.
3. Iniciar com `JOBFINDER_SEND_NOTIFICATIONS=false`; ativar envios conscientemente.
4. Manter `JOBFINDER_AUTOMATION_ENABLED=false` até validar o fluxo; a execução manual (`workflow_dispatch`) permite testar sem habilitar o agendamento.
5. Manter a validação TLS; nunca usar `rejectUnauthorized: false`.
6. Respeitar as cotas e condições das APIs de terceiros. A coleta e a análise exigem conexão à internet e podem estar sujeitas a limites ou cobranças. A coleta via `ts-jobspy` baseia-se em scraping e pode estar sujeita aos termos de uso das plataformas consultadas.
7. Validar a vaga original antes de realizar qualquer candidatura; o JobFinder não garante disponibilidade, modalidade de contratação ou elegibilidade.

## Limitações conhecidas da v2.2.0

- **Não há garantia de entrega exatamente uma vez:** o Telegram e o banco não compartilham transação. A reserva antes do envio reduz duplicidades em condições normais, mas não elimina a possibilidade de envio perdido ou de reserva `pending` após uma falha entre o envio e a confirmação. Essas reservas **não** são reenviadas automaticamente e exigem resolução manual (ver *Recuperação de reservas pendentes*).
- **Persistência JSON não é compartilhada:** no modo `json`, os históricos ficam apenas na máquina local; o GitHub Actions usa `postgres`.
- **Atraso do agendamento:** execuções do GitHub Actions podem ocorrer com atraso e não em tempo real.
- **Cobertura por execução:** apenas 5 pesquisas do LinkedIn e 5 do Indeed rodam por execução; a cobertura completa das 220 pesquisas depende do ciclo de 22 horas. As pesquisas **não** são executadas simultaneamente.
- **Dependência de scraping:** a coleta das vagas do LinkedIn e do Indeed depende da `ts-jobspy@3.0.1` e do patch local (`geoId`); mudanças nas plataformas ou atualizações da biblioteca podem exigir ajustes. A versão fica fixada exatamente para preservar a compatibilidade do patch.
- **Filtros heurísticos:** podem aceitar vagas para revisão ou priorizar incorretamente regiões ambíguas. A elegibilidade presumida para vagas remotas sem restrição geográfica explícita é uma **presunção de triagem**, e `remote: true` **não** significa disponibilidade no Brasil.
- **Uma mensagem por execução:** oportunidades aprovadas adicionais ficam pendentes para execuções seguintes.
- **Risco residual de tempo de execução:** o workflow do GitHub Actions tem `timeout-minutes: 10`, mas **não há garantia de duração máxima do pipeline**. Em cenários de alta latência ou volume elevado — sobretudo na InHire, em que cada vaga exige uma requisição de detalhe adicional — a execução pode se aproximar ou ultrapassar esse teto e ser interrompida pelo próprio Actions. As vagas já coletadas e as análises já persistidas são preservadas, e o restante fica para a próxima execução; contudo, a interrupção externa pode ocorrer sem que o pipeline finalize e registre um resumo.
- **Falhas parciais:** falhas individuais de **provider** (Greenhouse, Lever, Ashby, InHire, LinkedIn Jobs ou Indeed Jobs) são registradas e **isoladas** — a execução continua com as fontes que responderem, sem interromper o fluxo por causa de uma delas, mas essa falha **não** gera, por si só, código de saída diferente de zero. Já falhas de **banco**, **Gemini** ou **Telegram** interrompem a execução e são sinalizadas com código de saída diferente de zero.

## Roadmap

### Próximas versões (planejadas)

- **Integração de LinkedIn Posts.**
- **Descoberta de oportunidades divulgadas por recrutadores.**
- **Estudos de viabilidade, custos e limites de APIs de publicações.**

> **LinkedIn Posts não faz parte da v2.2.0** e permanece **planejado, sem versão definitiva estabelecida**. A v2.2.0 cobre apenas **LinkedIn Jobs** e **Indeed Jobs** (vagas publicadas em formato de anúncio). A coleta de **publicações** de recrutadores no feed do LinkedIn será avaliada em versão futura, incluindo estudos de viabilidade, custos e limites de APIs de publicações.

Observabilidade e testes de fluxo mais abrangentes também ficam previstos para as próximas versões.

O JobFinder permanece **exclusivamente backend** — sem interface de frontend — e continua usando o **Telegram** para as notificações.

## Referências técnicas

- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)
- [Lever Postings API](https://github.com/lever/postings-api)
- [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [ts-jobspy](https://github.com/speedyapply/ts-jobspy)
- [patch-package](https://github.com/ds300/patch-package)
- [Gemini API](https://ai.google.dev/gemini-api/docs)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Supabase — conexão com o banco](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [GitHub Actions — agendamento](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule)
- [Node.js — arquivos `.env`](https://nodejs.org/api/environment_variables.html)

---

**Status:** v2.2.0 implementada e validada em build e testes automatizados, com **seis providers** — LinkedIn Jobs, Indeed Jobs, Greenhouse, Lever, Ashby e InHire — sobre **59 boards públicos** e **220 pesquisas** (110 do LinkedIn + 110 do Indeed). Os critérios de análise estão versionados em `ANALYSIS_CRITERIA_VERSION = "2026-11-19.2"`. A versão só deve ser marcada como lançada depois da revisão final de configuração, segurança e documentação no repositório.
