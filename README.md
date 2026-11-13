# JobFinder

**Versão 1.1 — Persistência, Automação e Estabilidade**

O JobFinder é um projeto em **Node.js e TypeScript** que reúne vagas de quadros públicos de empresas, aplica filtros de compatibilidade, utiliza o **Google Gemini** para analisar oportunidades e, quando habilitado, envia alertas pelo **Telegram**. O objetivo é apoiar a descoberta de vagas de desenvolvimento sem realizar candidaturas automaticamente.

> **Escopo desta versão:** a v1.1 mantém a execução **manual** e local e adiciona **persistência no PostgreSQL (Supabase)** e **execução agendada pelo GitHub Actions**. Ela continua **não** realizando candidaturas, **não** integrando LinkedIn/Gupy/Indeed e **não** oferecendo interface de frontend. As informações de análise e notificações podem ser guardadas em **arquivos JSON locais** ou nas **tabelas do Supabase**, conforme configuração.

## Novidades da v1.1

- **Persistência no PostgreSQL (Supabase):** históricos de análises e de notificações deixam os arquivos JSON locais e passam a viver em `public.analyzed_jobs` e `public.notified_jobs`, com consultas e gravações parametrizadas.
- **Seleção explícita de armazenamento:** `JOBFINDER_STORAGE` escolhe entre `json` (padrão) e `postgres`, **sem fallback silencioso** — falhas do banco interrompem a execução.
- **Controle de duplicações:** reserva da vaga antes do envio, com estados de entrega (`pending`/`sent`) e **propriedade da reserva** (`reserved_by`/`reserved_at`). Uma execução só confirma ou libera a reserva que ela mesma criou. A reserva é liberada **somente** quando há confirmação de que o Telegram **não** entregou a mensagem; resultados incertos e falhas de confirmação são mantidos como `pending`.
- **Automação controlada com GitHub Actions:** execução agendada a cada 15 minutos (UTC) **desativada por padrão** (`JOBFINDER_AUTOMATION_ENABLED=false`), execução manual (`workflow_dispatch`) e controle de concorrência, sem depender de arquivos JSON locais.
- **Script de migração dos históricos:** importa os JSON existentes para o PostgreSQL com modo de simulação e importação idempotente, preservando os arquivos originais.
- **Correção do filtro de estágios:** vagas como *Estágio em Desenvolvimento de Software* deixam de ser descartadas, mantendo o reconhecimento de desenvolvimento júnior/estágio em português e inglês.
- **Testes automatizados:** filtros, persistência, deduplicação, concorrência e tratamento de falhas (`npm test`).

## Funcionalidades incluídas

- Coleta de vagas nos job boards públicos **Greenhouse**, **Lever** e **Ashby**, por empresa configurada.
- Normalização de vagas para um modelo comum e deduplicação por origem e identificador (`source:id`).
- Filtros de cargo (desenvolvimento), senioridade (exclui sênior/pleno/lead) e localização.
- Priorização geográfica das vagas, sem excluir oportunidades apenas por terem prioridade baixa.
- Análise de até **1 a 5 novas vagas por execução**, conforme configuração, por meio do Gemini, reaproveitando análises salvas.
- Persistência em **arquivo JSON** ou **PostgreSQL**, com seleção explícita por variável de ambiente.
- **Reserva de notificação** antes do envio, com recuperação manual de reservas pendentes, evitando duplicidade.
- Notificações de vagas aprovadas via Telegram, quando habilitadas.
- Alertas opcionais de **revisão manual** para vagas com localização permitida e contratação não informada, sem apresentá-las como confirmadas.
- Execução **manual** (local) e **agendada** (GitHub Actions, desativada por padrão), com limite de uma notificação por execução.

O JobFinder **não** envia currículos, não se candidata a vagas e não confirma por conta própria que os processos seletivos permanecem abertos.

## Tecnologias

- Node.js, TypeScript e módulos ESM/NodeNext
- APIs públicas de vagas da Greenhouse, Lever e Ashby
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

O comando `cp` funciona no Git Bash, Linux e macOS. Edite o `.env` com suas credenciais. **Nunca publique nem compartilhe esse arquivo.**

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

O valor `true` deve ser escrito exatamente assim. Para ativar alertas de revisão manual, **as duas variáveis de envio** precisam ser `true`. O `JOBFINDER_AUTOMATION_ENABLED` controla apenas a execução **agendada**; a execução manual (`workflow_dispatch`) e a execução local não dependem dele. O arquivo `.env.example` contém somente valores de exemplo.

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

> **Atenção:** os comandos de envio podem enviar uma mensagem **real** ao Telegram. Antes de utilizá-los, confirme as credenciais, o chat de destino e as regras de seleção. A execução limita a saída a **uma notificação total por execução**, com prioridade para vagas compatíveis.

## Automação com GitHub Actions

O workflow `.github/workflows/jobfinder.yml` executa o JobFinder automaticamente:

- **Agendamento:** a cada 15 minutos, em **UTC** (`cron: "*/15 * * * *"`), **desativado por padrão**.
- **Ativação controlada:** o job agendado só executa quando a variável de repositório `JOBFINDER_AUTOMATION_ENABLED` for `true`. Enquanto ela não existir ou for diferente de `true`, os agendamentos **não** chamam o Gemini nem enviam nada.
- **Execução manual:** pela aba **Actions** do GitHub (`workflow_dispatch`), sempre permitida para disparo controlado.
- **Concorrência:** `concurrency: jobfinder` evita execuções simultâneas.
- **Permissões mínimas:** `contents: read` e `timeout-minutes: 10`.
- **Persistência:** `JOBFINDER_STORAGE=postgres`; não usa arquivos JSON locais.
- **TLS:** usa o certificado versionado `certs/prod-ca-2021.crt` via `DATABASE_CA_CERT_PATH`.
- **Envios desativados por padrão:** só enviam se as variáveis do repositório forem definidas como `true`.

> O agendamento do GitHub Actions **pode atrasar** e **não é tempo real**. Em repositórios sem atividade, execuções agendadas podem ser adiadas. Para diagnosticar falhas, verifique os logs na aba **Actions**.

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
Fontes configuradas (Greenhouse, Lever, Ashby)
                  |
                  v
            Coleta das vagas
                  |
                  v
        Normalização e deduplicação
                  |
                  v
     Filtros: cargo, senioridade, localização
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

**Regra de alerta de revisão manual:** uma análise com decisão `review`, localização `allowed` e contratação `unknown` pode gerar um aviso separado **somente quando explicitamente habilitado**. Localização desconhecida ou bloqueada não satisfaz essa regra.

## Fontes configuradas

As empresas/boards utilizados são definidos em `src/config/job-sources.ts`. A configuração inicial testada no desenvolvimento contém:

| Plataforma | Board de exemplo |
|---|---|
| Greenhouse | `stripe` |
| Lever | `Flex` |
| Ashby | `Ashby` |

Essas fontes foram usadas para validar os providers e **não garantem oportunidades compatíveis com candidatos residentes no Brasil**. Adicionar uma nova empresa à lista exige confirmar previamente o identificador aceito pela respectiva API.

## Testes

```bash
# Filtros, persistência JSON, deduplicação, concorrência e falhas de despacho
npm test

# Testes que gravam no PostgreSQL (opt-in; usa chaves de teste e limpa ao final)
JOBFINDER_RUN_DB_TESTS=true npm run test:db
```

`npm test` cobre: filtros de cargo/senioridade/localização, política de notificação, persistência JSON com reserva e propriedade (`reserved_by`), e o despacho de notificações (falha na confirmação após envio aceito, envio confirmadamente não entregue, resultado incerto sem reenvio, e recuperação de reserva pendente).

Os testes de banco **não** são executados por `npm test`: exigem `DATABASE_URL` e `JOBFINDER_RUN_DB_TESTS=true` e só rodam quando você autoriza explicitamente. Eles usam o prefixo `db-test:` e removem suas linhas ao final; sem as variáveis, apenas informam e não tocam no Supabase.

## Estrutura principal

```text
jobfinder/
├── .github/workflows/jobfinder.yml    # Automação agendada (GitHub Actions)
├── certs/prod-ca-2021.crt             # Certificado CA público do Supabase
├── src/
│   ├── config/job-sources.ts          # Quadros de vagas consultados
│   ├── db/postgres.ts                 # Pool PostgreSQL com TLS validado
│   ├── providers/
│   │   ├── greenhouse.ts
│   │   ├── lever.ts
│   │   └── ashby.ts
│   ├── services/
│   │   ├── ai-analyzer.ts
│   │   ├── analysis-history.ts        # Histórico de análises (JSON ou PostgreSQL)
│   │   ├── deduplication.ts           # Chave, reserva e histórico de notificações
│   │   ├── storage.ts                 # Seleção do backend de persistência
│   │   ├── job-filter.ts
│   │   ├── seniority-filter.ts
│   │   ├── location-filter.ts
│   │   ├── job-priority.ts
│   │   ├── notification-policy.ts
│   │   ├── notification-dispatch.ts   # Reserva + envio + confirmação/liberação
│   │   └── telegram.ts
│   ├── types/job.ts
│   └── index.ts
├── supabase/migrations/               # Migrations SQL
├── scripts/                           # Testes e utilitários manuais
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
6. Respeitar as cotas e condições das APIs de terceiros. A coleta e a análise exigem conexão à internet e podem estar sujeitas a limites ou cobranças.
7. Validar a vaga original antes de realizar qualquer candidatura; o JobFinder não garante disponibilidade, modalidade de contratação ou elegibilidade.

## Limitações conhecidas da v1.1

- **Não há garantia de entrega exatamente uma vez:** o Telegram e o banco não compartilham transação. A reserva antes do envio reduz duplicidades em condições normais, mas não elimina a possibilidade de envio perdido ou de reserva `pending` após uma falha entre o envio e a confirmação. Essas reservas **não** são reenviadas automaticamente e exigem resolução manual (ver *Recuperação de reservas pendentes*).
- **Persistência JSON não é compartilhada:** no modo `json`, os históricos ficam apenas na máquina local; o GitHub Actions usa `postgres`.
- **Atraso do agendamento:** execuções do GitHub Actions podem ocorrer com atraso e não em tempo real.
- **Fontes limitadas:** somente Greenhouse, Lever e Ashby; sem scraping do LinkedIn, Gupy, BNE, Indeed ou Catho nesta versão.
- **Filtros heurísticos:** podem aceitar vagas para revisão ou priorizar incorretamente regiões ambíguas; `remote: true` não significa disponibilidade no Brasil.
- **Uma mensagem por execução:** oportunidades aprovadas adicionais ficam pendentes para execuções seguintes.
- **Falhas parciais:** erros de banco, Gemini, providers ou Telegram são registrados; o JobFinder sinaliza a falha com código de saída diferente de zero e continua as fontes que forem seguras.

## Próximas versões (fora do escopo da v1.1)

- Novos providers brasileiros (Apify/LinkedIn Jobs, LinkedIn Posts, Gupy, Indeed, InfoJobs, BNE), após validação de acesso e permissões.
- Interface de frontend.
- Observabilidade e testes de fluxo mais abrangentes.

## Referências técnicas

- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)
- [Lever Postings API](https://github.com/lever/postings-api)
- [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [Gemini API](https://ai.google.dev/gemini-api/docs)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Supabase — conexão com o banco](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [GitHub Actions — agendamento](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule)
- [Node.js — arquivos `.env`](https://nodejs.org/api/environment_variables.html)

---

**Status:** v1.1 implementada e validada em build e testes automatizados. A versão só deve ser marcada como lançada depois da revisão final de configuração, segurança e documentação no repositório.
