# JobFinder

**Versão 1.0 — MVP local (execução manual)**

O JobFinder é um projeto em **Node.js e TypeScript** que reúne vagas de quadros públicos de empresas, aplica filtros de compatibilidade, utiliza o **Google Gemini** para analisar oportunidades e, quando habilitado, envia alertas pelo **Telegram**. O objetivo é apoiar a descoberta de vagas de desenvolvimento sem realizar candidaturas automaticamente.

> **Escopo desta versão:** a v1.0 roda localmente, mediante comando no terminal. Ela **não** executa buscas automaticamente, **não** funciona 24 horas por dia por conta própria e **não** utiliza banco de dados na nuvem. As informações de análise e notificações são guardadas em arquivos JSON locais.

## Funcionalidades incluídas

- Coleta de vagas nos job boards públicos **Greenhouse**, **Lever** e **Ashby**, por empresa configurada.
- Normalização de vagas para um modelo comum e deduplicação por origem e identificador.
- Filtros iniciais para cargos de desenvolvimento, senioridade e localização.
- Priorização geográfica das vagas, sem excluir oportunidades apenas por terem prioridade baixa.
- Análise de até **1 a 5 novas vagas por execução**, conforme configuração, por meio do Gemini.
- Reaproveitamento local das análises já realizadas, para evitar novas chamadas desnecessárias ao modelo.
- Notificações de vagas aprovadas via Telegram, quando habilitadas.
- Alertas opcionais de **revisão manual** para vagas com localização permitida e contratação não informada, sem apresentá-las como confirmadas.
- Registro local das vagas analisadas e notificadas, com redução de envios repetidos.

O JobFinder **não** envia currículos, não se candidata a vagas e não confirma por conta própria que os processos seletivos permanecem abertos.

## Tecnologias

- Node.js, TypeScript e módulos ESM/NodeNext
- API pública de vagas da Greenhouse
- API pública de vagas da Lever
- API pública de vagas da Ashby
- Google Gemini (`@google/genai`)
- Telegram Bot API
- Arquivos JSON locais para histórico

## Requisitos

- **Node.js** com suporte a `--env-file` (recomendado Node.js 22 ou mais recente; desenvolvimento validado com Node.js 25).
- **npm** e acesso à internet para coleta, Gemini e Telegram.
- Chave da **Gemini API** para análises.
- Para notificações: bot do Telegram, token e identificador do chat de destino.

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
| `JOBFINDER_MAX_ANALYSES` | Número máximo de novas análises por execução | `1` (teto de `5`) |
| `JOBFINDER_SEND_NOTIFICATIONS` | Permite o envio real de notificações | `false` |
| `JOBFINDER_SEND_REVIEWS` | Permite avisos de revisão manual, além do envio geral | `false` |

O valor `true` deve ser escrito exatamente assim. Para ativar alertas de revisão manual, **as duas variáveis de envio** precisam ser `true`.

O arquivo `.env.example` contém somente valores de exemplo. A configuração do modelo Gemini está implementada no código, não por uma variável de ambiente documentada aqui.

## Como executar

**1. Compilar o projeto:**

```bash
npm run build
```

**2. Fazer uma execução manual em modo seguro (sem mensagens):**

```bash
JOBFINDER_SEND_NOTIFICATIONS=false node --env-file=.env dist/index.js
```

A execução consulta fontes externas e pode consumir chamadas da Gemini API. Ela pode atualizar o histórico local de análises, mas não envia nem registra notificações como enviadas.

**3. Analisar até três vagas novas, ainda sem enviar mensagens:**

```bash
JOBFINDER_MAX_ANALYSES=3 JOBFINDER_SEND_NOTIFICATIONS=false node --env-file=.env dist/index.js
```

**4. Permitir uma notificação normal por execução:**

```bash
JOBFINDER_SEND_NOTIFICATIONS=true JOBFINDER_SEND_REVIEWS=false node --env-file=.env dist/index.js
```

**5. Permitir também uma notificação de revisão manual (opcional):**

```bash
JOBFINDER_SEND_NOTIFICATIONS=true JOBFINDER_SEND_REVIEWS=true node --env-file=.env dist/index.js
```

> **Atenção:** os comandos 4 e 5 podem enviar uma mensagem **real** ao Telegram. Antes de utilizá-los, confirme as credenciais, o chat de destino e as regras de seleção. A versão 1.0 limita a saída a **uma notificação total por execução**.

É possível deixar as flags no `.env` para não repeti-las no comando. As variáveis definidas diretamente no terminal prevalecem no respectivo processo.

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
    Histórico local: vaga já analisada?
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
      Alerta normal  Alerta opcional   Sem alerta
             \          /
              \        /
           Telegram (até 1 envio)
                    |
                    v
        Histórico local de notificação
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

## Históricos locais

A v1.0 utiliza arquivos JSON no diretório `data/`:

- `data/analyzed-jobs.json`: análises já realizadas, incluindo compatíveis, incompatíveis e em revisão.
- `data/notified-jobs.json`: identificadores das vagas já notificadas.

Os históricos sobrevivem a novas execuções **no mesmo ambiente local**, desde que os arquivos permaneçam disponíveis. Não há sincronização entre computadores, recuperação automática em nuvem ou garantia transacional de entrega exatamente uma vez. Não edite esses arquivos manualmente enquanto o programa estiver executando.

Esses históricos podem conter informações sobre vagas e devem ficar fora do controle de versão. Da mesma forma, `.env` deve estar ignorado pelo Git. Confirme a configuração de `.gitignore` antes de publicar.

## Estrutura principal

```text
jobfinder/
├── src/
│   ├── config/job-sources.ts          # Quadros de vagas consultados
│   ├── providers/
│   │   ├── greenhouse.ts
│   │   ├── lever.ts
│   │   └── ashby.ts
│   ├── services/
│   │   ├── ai-analyzer.ts
│   │   ├── analysis-history.ts
│   │   ├── deduplication.ts
│   │   ├── job-filter.ts
│   │   ├── seniority-filter.ts
│   │   ├── location-filter.ts
│   │   ├── job-priority.ts
│   │   ├── notification-policy.ts
│   │   └── telegram.ts
│   ├── types/job.ts
│   └── index.ts
├── scripts/smoke-test.mjs           # Verificação manual opcional
├── data/                            # Históricos locais (não versionar)
├── .env.example                     # Referência de configuração, sem segredos
├── package.json
└── tsconfig.json
```

`dist/` contém o código JavaScript gerado na compilação e não deve ser editado manualmente.

## Segurança e boas práticas

1. Não colocar chaves, tokens ou `TELEGRAM_CHAT_ID` real em arquivos versionados.
2. Conferir que `.env` e os históricos locais não estão sendo rastreados pelo Git.
3. Iniciar com `JOBFINDER_SEND_NOTIFICATIONS=false`; ativar envios conscientemente.
4. Respeitar as cotas e condições das APIs de terceiros. A coleta e a análise exigem conexão à internet e podem estar sujeitas a limites ou cobranças.
5. Validar a vaga original antes de realizar qualquer candidatura; o JobFinder não garante disponibilidade, modalidade de contratação ou elegibilidade.

## Limitações conhecidas da v1.0

- **Execução manual:** não possui agendamento, hospedagem ou execução contínua.
- **Históricos apenas locais:** sem persistência compartilhada/nuvem ou sincronização.
- **Fontes limitadas:** somente Greenhouse, Lever e Ashby, pelos boards configurados; sem scraping do LinkedIn, Gupy, BNE, Indeed ou Catho nesta versão.
- **Filtros heurísticos:** podem aceitar vagas para revisão ou priorizar incorretamente regiões ambíguas; `remote: true` não significa disponibilidade no Brasil.
- **Uma mensagem por execução:** oportunidades aprovadas adicionais ficam pendentes para execuções seguintes.
- **Validação limitada:** as integrações e algumas regras foram testadas manualmente; não há suíte automatizada abrangente de testes de fluxo.
- **Falhas operacionais:** a ausência de autenticação e acesso a recursos externos, erros de rede e limites da API podem interromper etapas. O tratamento de erro do processo principal ainda não sinaliza necessariamente falhas por código de saída diferente de zero.

## Próximas versões (fora do escopo da v1.0)

- Agendamento e execução na nuvem, com armazenamento persistente.
- Expansão de fontes e provedores brasileiros (após validação de acesso e permissões).
- Estudo de Actors do Apify para **LinkedIn Jobs** e **publicações de recrutamento**, como fluxos separados da ferramenta de networking.
- Testes automatizados de integração, controle de falhas e observabilidade mais completos.

## Referências técnicas

- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)
- [Lever Postings API](https://github.com/lever/postings-api)
- [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [Gemini API](https://ai.google.dev/gemini-api/docs)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Node.js — arquivos `.env`](https://nodejs.org/api/environment_variables.html)

---

**Status:** MVP v1.0 de execução local. A versão só deve ser marcada como lançada depois da revisão final de configuração, segurança e documentação no repositório.
