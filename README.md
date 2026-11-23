# JobFinder

**Versão 2.0 — LinkedIn Jobs + Indeed Jobs**

O JobFinder é um projeto em **Node.js e TypeScript** que reúne vagas de quadros públicos de empresas e das plataformas de busca **LinkedIn Jobs** e **Indeed Jobs**, aplica filtros de compatibilidade, utiliza o **Google Gemini** para analisar oportunidades e, quando habilitado, envia alertas pelo **Telegram**. O objetivo é apoiar a descoberta de vagas de desenvolvimento sem realizar candidaturas automaticamente.

> **Escopo desta versão:** a v2.0 amplia a coleta multi-fonte com **LinkedIn Jobs** e **Indeed Jobs** (via `ts-jobspy@3.0.1`), mantendo a execução **manual** e **agendada pelo GitHub Actions**, a **persistência no PostgreSQL (Supabase)** e o envio opcional de alertas. Ela continua **não** realizando candidaturas e **não** oferecendo interface de frontend. Análises e notificações ficam nas **tabelas do Supabase**. **Publicações de recrutadores (LinkedIn Posts) não fazem parte da v2.0** — estão planejadas para a v2.1.

## Novidades da v2.0

- **LinkedIn Jobs:** coleta de vagas por termo de busca via `ts-jobspy@3.0.1`, com **100 pesquisas** — 20 locais em Maceió/AL e 80 remotas no Brasil — e limite de **10 vagas por pesquisa**.
- **Indeed Jobs:** coleta de vagas por termo de busca via `ts-jobspy@3.0.1`, com **100 pesquisas** — 20 locais em Maceió/AL e 80 remotas no Brasil — e limite de **15 vagas por pesquisa**.
- **Rotação determinística e sem estado:** as 100 pesquisas de cada plataforma são divididas em **20 lotes**; a cada execução são selecionados **5 pesquisas do LinkedIn e 5 do Indeed** (1 local de Maceió e 4 remotas nacionais por plataforma), escolhidas pela hora UTC e sem persistir estado.
- **Coleta sequencial entre plataformas:** os lotes do LinkedIn e do Indeed rodam **um após o outro**, e cada lote executa **uma pesquisa por vez**, para não concorrerem na mesma sessão da biblioteca `ts-jobspy`.
- **`patch-package` para `geoId`:** um patch local (`patches/ts-jobspy+3.0.1.patch`) habilita o parâmetro `geoId`, usado para fixar as pesquisas locais do LinkedIn em Maceió/AL.
- **Mapeamento de falhas por plataforma:** o desfecho de cada coleta (`ok`, `empty`, `partial`, `error`) é tratado explicitamente; falhas de um provider são isoladas e não derrubam as demais fontes.

### Recursos herdados da v1.1 (mantidos)

- **Persistência no PostgreSQL (Supabase):** históricos de análises e de notificações ficam em `public.analyzed_jobs` e `public.notified_jobs`, com consultas e gravações parametrizadas. Falha do banco interrompe a execução.
- **Controle de duplicações:** reserva da vaga antes do envio, com estados de entrega (`pending`/`sent`) e **propriedade da reserva** (`reserved_by`/`reserved_at`).
- **Automação controlada com GitHub Actions:** execução agendada **a cada hora, aos 17 minutos (`cron: "17 * * * *"`), em UTC**, **desativada por padrão** (`JOBFINDER_AUTOMATION_ENABLED=false`), execução manual (`workflow_dispatch`) e controle de concorrência.
- **Script de migração dos históricos:** importa os JSON existentes para o PostgreSQL com modo de simulação e importação idempotente.
- **Correção do filtro de estágios:** vagas como *Estágio em Desenvolvimento de Software* deixam de ser descartadas, mantendo o reconhecimento de desenvolvimento júnior/estágio em português e inglês.
- **Validação:** `npm test` compila o projeto e executa `scripts/smoke-test.mjs` (chamadas externas reais; exige credenciais).

## Funcionalidades incluídas

- Coleta de vagas nos job boards públicos **Greenhouse**, **Lever** e **Ashby**, por empresa configurada.
- Coleta de vagas no **LinkedIn Jobs** e no **Indeed Jobs**, por termo de busca (júnior e estágio), com rotação de lotes por hora UTC.
- Normalização de vagas para um modelo comum e deduplicação por origem e identificador (`source:id`).
- Filtros de cargo (desenvolvimento), senioridade (exclui sênior/pleno/lead), localização e **contratação** (CLT ou estágio; PJ não é apresentado como aprovado).
- Priorização geográfica das vagas, sem excluir oportunidades apenas por terem prioridade baixa.
- Análise de **no máximo uma nova vaga por execução** na configuração atual (valor padrão de `JOBFINDER_MAX_ANALYSES`, ajustável de `1` a `5`), por meio do Gemini, reaproveitando análises salvas.
- Persistência no **PostgreSQL (Supabase)**.
- **Reserva de notificação** antes do envio, com recuperação manual de reservas pendentes, evitando duplicidade.
- Notificações de vagas aprovadas via Telegram, quando habilitadas.
- Alertas opcionais de **revisão manual** para vagas com localização permitida e contratação não informada, sem apresentá-las como confirmadas.
- Execução **manual** (local) e **agendada** (GitHub Actions, desativada por padrão), com limite de **uma notificação por execução**.
- **Sem envio quando não há vagas elegíveis:** se nenhuma vaga passar pelos filtros, pela análise e pela política de notificação (ou se todas já tiverem sido notificadas), **nenhuma mensagem é enviada**.

O JobFinder **não** envia currículos, não se candidata a vagas e não confirma por conta própria que os processos seletivos permanecem abertos.

## Tecnologias

- Node.js, TypeScript e módulos ESM/NodeNext
- APIs públicas de vagas da Greenhouse, Lever e Ashby
- **`ts-jobspy@3.0.1`** para a coleta de vagas do LinkedIn Jobs e do Indeed Jobs
- **`patch-package`** para o suporte a `geoId` nas pesquisas locais do LinkedIn
- Google Gemini (`@google/genai`)
- Telegram Bot API
- PostgreSQL no Supabase (`pg`), com TLS validado
- GitHub Actions para agendamento

## Requisitos

- **Node.js** com suporte a `--env-file` (recomendado Node.js 22 ou mais recente).
- **npm** e acesso à internet para coleta, Gemini e Telegram.
- Chave da **Gemini API** para análises.
- Para notificações: bot do Telegram, token e identificador do chat de destino.
- Projeto **Supabase** e a `DATABASE_URL` para o histórico de análises e notificações.

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
| `JOBFINDER_MAX_ANALYSES` | Número máximo de novas análises por execução | `1` (teto de `5`) |
| `JOBFINDER_SEND_NOTIFICATIONS` | Permite o envio real de notificações | `false` |
| `JOBFINDER_SEND_REVIEWS` | Permite avisos de revisão manual, além do envio geral | `false` |
| `JOBFINDER_AUTOMATION_ENABLED` | Habilita o job **agendado** do GitHub Actions | `false` |
| `DATABASE_URL` | Conexão PostgreSQL do Supabase | Obrigatória |
| `DATABASE_CA_CERT_PATH` | Caminho do certificado CA do Supabase | `./certs/prod-ca-2021.crt` |

O valor `true` deve ser escrito exatamente assim. Para ativar alertas de revisão manual, **as duas variáveis de envio** precisam ser `true`.

Sobre a automação: `JOBFINDER_AUTOMATION_ENABLED=true` **habilita a execução automática** do job agendado do GitHub Actions; `false` é a **configuração segura padrão** e mantém os agendamentos inativos (sem chamadas ao Gemini e sem envios). Essa variável controla apenas a execução **agendada** — a execução manual (`workflow_dispatch`) e a execução local **não** dependem dela.

O arquivo `.env.example` contém somente valores de exemplo.

## Coleta de vagas (LinkedIn Jobs e Indeed Jobs)

As pesquisas do LinkedIn e do Indeed são configuradas em `src/config/linkedin-searches.ts` e `src/config/indeed-searches.ts` e atendidas pelos providers `src/providers/linkedin.ts` e `src/providers/indeed.ts`, sobre a biblioteca `ts-jobspy@3.0.1`.

| Plataforma | Pesquisas totais | Locais (Maceió/AL) | Remotas (Brasil) | Limite por pesquisa |
|---|---|---|---|---|
| LinkedIn Jobs | 100 | 20 | 80 | 10 vagas |
| Indeed Jobs | 100 | 20 | 80 | 15 vagas |

- **Rotação de lotes:** as 100 pesquisas de cada plataforma formam **20 lotes**; cada lote contém **1 pesquisa local de Maceió** e **4 pesquisas remotas nacionais**. A seleção é determinística e **sem estado**: converte a data atual em horas UTC absolutas e aplica módulo 20, então cada hora do calendário mapeia sempre para o mesmo lote e o ciclo se repete a cada 20 horas. As rotações do LinkedIn e do Indeed são independentes.
- **Por execução:** são executadas **5 pesquisas do LinkedIn e 5 do Indeed** (10 no total). As 200 pesquisas **não** são executadas simultaneamente — a cobertura completa ocorre ao longo do ciclo de 20 horas.
- **Coleta sequencial:** os lotes do LinkedIn e do Indeed são executados **um após o outro** e cada lote roda **uma pesquisa por vez**, pois ambos compartilham a mesma biblioteca `ts-jobspy` e pesquisas concorrentes entrariam em conflito.
- **`geoId` via patch:** as pesquisas locais do LinkedIn fixam a cidade com `geoId` (`102957102` para Maceió/AL), suporte fornecido pelo patch `patches/ts-jobspy+3.0.1.patch`. A versão do `ts-jobspy` fica **fixada exatamente** (`3.0.1`) para garantir a compatibilidade do patch.
- **Descrição completa:** o provider do LinkedIn busca a descrição completa de cada vaga (`fetchDescription: true`), necessária à análise da IA.
- **Modalidade:** a modalidade é inferida dos sinais do próprio anúncio (título, localização e descrição), considerando termos em português, e não apenas o filtro de busca.
- **Falhas isoladas:** o desfecho de cada coleta (`ok`, `empty`, `partial`, `error`) é tratado explicitamente. Em `error`, a fonte falha isoladamente; em `partial`, as vagas já coletadas são preservadas e a interrupção é registrada. A falha de um provider não interrompe a execução.

## Persistência no PostgreSQL

Os históricos ficam em `public.analyzed_jobs` e `public.notified_jobs` do Supabase, identificados pela chave `source:id`.

- **Sem fallback:** se o banco falhar, a execução falha com erro.
- **Sem envio sem estado de deduplicação:** a vaga é **reservada no banco antes do envio**. Se a reserva não puder ser feita, nenhuma notificação é enviada.
- **TLS validado:** a conexão exige validação do certificado do servidor. O certificado público do Supabase já está em `certs/prod-ca-2021.crt`; parâmetros de SSL na `DATABASE_URL` (como `sslmode`) são ignorados para não sobrepor essa validação.

Arquivos JSON em `data/` não fazem mais parte do pipeline. O script `scripts/migrate-json-to-postgres.mjs` continua disponível para importar um histórico local antigo, se ainda existir.

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

Aplique-as pelo painel/SQL Editor do Supabase ou pelo Supabase CLI:

```bash
supabase db push
```

Todas as migrations são aditivas (`add column if not exists`); podem ser aplicadas com segurança sobre o banco já existente.

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

O script apenas lê, confirma (`sent`) ou libera (`released`) reservas existentes no PostgreSQL; ele **não** envia mensagens.

## Como executar

**1. Compilar o projeto:**

```bash
npm run build
```

**2. Execução manual em modo seguro (sem mensagens), com PostgreSQL:**

```bash
JOBFINDER_SEND_NOTIFICATIONS=false node --env-file=.env dist/index.js
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
- **Persistência:** PostgreSQL via `DATABASE_URL`. O workflow ainda define `JOBFINDER_STORAGE=postgres`; o código não lê mais essa variável.
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
Fontes (Greenhouse, Lever, Ashby, LinkedIn Jobs, Indeed Jobs)
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
   Histórico: vaga já analisada? (PostgreSQL)
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

**Regra de alerta de revisão manual:** uma análise com decisão `review`, localização `allowed` e contratação `unknown` pode gerar um aviso separado **somente quando explicitamente habilitado**. Localização desconhecida ou bloqueada não satisfaz essa regra.

## Fontes configuradas

As empresas/boards utilizados são definidos em `src/config/job-sources.ts`, e as pesquisas do LinkedIn e do Indeed em arquivos próprios. A configuração inicial testada no desenvolvimento contém:

| Plataforma | Referência de exemplo |
|---|---|
| Greenhouse | `stripe` |
| Lever | `Flex` |
| Ashby | `Ashby` |
| LinkedIn Jobs | 100 pesquisas (20 locais em Maceió/AL + 80 remotas no Brasil) |
| Indeed Jobs | 100 pesquisas (20 locais em Maceió/AL + 80 remotas no Brasil) |

Essas fontes foram usadas para validar os providers e **não garantem oportunidades compatíveis com candidatos residentes no Brasil**. Adicionar uma nova empresa à lista exige confirmar previamente o identificador aceito pela respectiva API. A cobertura completa das pesquisas do LinkedIn e do Indeed ocorre ao longo do ciclo de 20 lotes; cada execução roda apenas 5 pesquisas de cada plataforma.

## Testes e validações realizadas

```bash
# Build (TypeScript em modo estrito/ESM)
npm run build

# Compila e roda o smoke test (Gemini, PostgreSQL e, se habilitado, Telegram)
npm test
```

`npm test` executa `scripts/smoke-test.mjs` depois do build. Esse roteiro faz chamadas externas reais: análise no Gemini, leitura e gravação no PostgreSQL e, somente com `JOBFINDER_SMOKE_SEND=true`, envio ao Telegram. Ele **não** isola o histórico.

**Resultados das validações realizadas:**

- **Build:** o projeto compila com `npm run build` (TypeScript em modo estrito, ESM/NodeNext), sem erros de tipo.
- **Roteiro de fumaça:** `scripts/smoke-test.mjs` exercita deduplicação → filtros → análise → persistência no PostgreSQL → (envio opcional).

> **Importante:** essas validações são **isoladas** e verificam a **lógica interna** do projeto. Elas **não** garantem o funcionamento integral em produção: a coleta real depende de `ts-jobspy` e de serviços de terceiros (sujeitos a mudanças de layout, bloqueios, limites e termos de uso), e as integrações com Gemini, Telegram e Supabase dependem de credenciais, cotas e conectividade. A cobertura completa das 200 pesquisas ocorre ao longo de 20 execuções e não é exercitada de uma só vez.

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
│   │   ├── linkedin-searches.ts       # 100 pesquisas do LinkedIn Jobs
│   │   └── indeed-searches.ts         # 100 pesquisas do Indeed Jobs
│   ├── db/postgres.ts                 # Pool PostgreSQL com TLS validado
│   ├── providers/
│   │   ├── greenhouse.ts
│   │   ├── lever.ts
│   │   ├── ashby.ts
│   │   ├── linkedin.ts                # LinkedIn Jobs via ts-jobspy
│   │   └── indeed.ts                  # Indeed Jobs via ts-jobspy
│   ├── services/
│   │   ├── ai-analyzer.ts
│   │   ├── analysis-history.ts        # Histórico de análises (PostgreSQL)
│   │   ├── deduplication.ts           # Chave, reserva e histórico de notificações
│   │   ├── job-filter.ts
│   │   ├── seniority-filter.ts
│   │   ├── location-filter.ts
│   │   ├── job-priority.ts
│   │   ├── linkedin-search-rotation.ts # Rotação dos 20 lotes do LinkedIn
│   │   ├── indeed-search-rotation.ts   # Rotação dos 20 lotes do Indeed
│   │   ├── notification-policy.ts
│   │   ├── notification-dispatch.ts   # Reserva + envio + confirmação/liberação
│   │   └── telegram.ts
│   ├── types/job.ts
│   └── index.ts
├── supabase/migrations/               # Migrations SQL
├── scripts/                           # Smoke tests, migração e diagnóstico
├── .env.example                       # Referência de configuração, sem segredos
├── package.json
└── tsconfig.json
```

`dist/` contém o código JavaScript gerado na compilação e não deve ser editado manualmente.

## Segurança e boas práticas

1. Não colocar chaves, tokens ou `TELEGRAM_CHAT_ID` real em arquivos versionados.
2. Conferir que `.env` não está sendo rastreado pelo Git.
3. Iniciar com `JOBFINDER_SEND_NOTIFICATIONS=false`; ativar envios conscientemente.
4. Manter `JOBFINDER_AUTOMATION_ENABLED=false` até validar o fluxo; a execução manual (`workflow_dispatch`) permite testar sem habilitar o agendamento.
5. Manter a validação TLS; nunca usar `rejectUnauthorized: false`.
6. Respeitar as cotas e condições das APIs de terceiros. A coleta e a análise exigem conexão à internet e podem estar sujeitas a limites ou cobranças. A coleta via `ts-jobspy` baseia-se em scraping e pode estar sujeita aos termos de uso das plataformas consultadas.
7. Validar a vaga original antes de realizar qualquer candidatura; o JobFinder não garante disponibilidade, modalidade de contratação ou elegibilidade.

## Limitações conhecidas da v2.0

- **Não há garantia de entrega exatamente uma vez:** o Telegram e o banco não compartilham transação. A reserva antes do envio reduz duplicidades em condições normais, mas não elimina a possibilidade de envio perdido ou de reserva `pending` após uma falha entre o envio e a confirmação. Essas reservas **não** são reenviadas automaticamente e exigem resolução manual (ver *Recuperação de reservas pendentes*).
- **Atraso do agendamento:** execuções do GitHub Actions podem ocorrer com atraso e não em tempo real.
- **Cobertura por execução:** apenas 5 pesquisas do LinkedIn e 5 do Indeed rodam por execução; a cobertura completa das 200 pesquisas depende do ciclo de 20 horas. As pesquisas **não** são executadas simultaneamente.
- **Dependência de scraping:** a coleta das vagas do LinkedIn e do Indeed depende da `ts-jobspy@3.0.1` e do patch local (`geoId`); mudanças nas plataformas ou atualizações da biblioteca podem exigir ajustes. A versão fica fixada exatamente para preservar a compatibilidade do patch.
- **Filtros heurísticos:** podem aceitar vagas para revisão ou priorizar incorretamente regiões ambíguas; `remote: true` não significa disponibilidade no Brasil.
- **Uma mensagem por execução:** oportunidades aprovadas adicionais ficam pendentes para execuções seguintes.
- **Falhas parciais:** falhas individuais de **provider** (Greenhouse, Lever, Ashby, LinkedIn Jobs ou Indeed Jobs) são registradas e **isoladas** — a execução continua com as fontes que responderem, sem interromper o fluxo por causa de uma delas, mas essa falha **não** gera, por si só, código de saída diferente de zero. Já falhas de **banco**, **Gemini** ou **Telegram** interrompem a execução e são sinalizadas com código de saída diferente de zero.

## Roadmap

### Versão 2.1 — Planejada

- **Integração de LinkedIn Posts.**
- **Descoberta de oportunidades divulgadas por recrutadores.**
- **Estudos de viabilidade, custos e limites de APIs de publicações.**

> **LinkedIn Posts não faz parte da v2.0.** A v2.0 cobre apenas **LinkedIn Jobs** e **Indeed Jobs** (vagas publicadas em formato de anúncio). A coleta de **publicações** de recrutadores no feed do LinkedIn será avaliada na v2.1, incluindo estudos de viabilidade, custos e limites de APIs de publicações.

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

**Status:** v2.0 implementada e validada em build e testes automatizados (LinkedIn Jobs + Indeed Jobs). A versão só deve ser marcada como lançada depois da revisão final de configuração, segurança e documentação no repositório.
