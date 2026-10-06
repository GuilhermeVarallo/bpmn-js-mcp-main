# bpmn-js-mcp — publicação na web

Servidor [MCP](https://modelcontextprotocol.io) que permite a assistentes de IA
(Claude Code, Claude Desktop, VS Code/Copilot e outros clientes MCP) criar e
editar diagramas BPMN 2.0 válidos, com layout automático, validação bpmnlint e
exportação em XML, SVG e PNG. Usa o [bpmn-js](https://bpmn.io) sem navegador,
via jsdom. Fork de [datakurre/bpmn-js-mcp](https://github.com/datakurre/bpmn-js-mcp);
a documentação original das ferramentas está em
[docs/README-upstream.md](docs/README-upstream.md).

O projeto original só funciona **localmente** (stdio: o cliente abre o servidor
como processo filho). Este repositório acrescenta o **modo HTTP** (`--http`),
que permite publicá-lo numa URL e usá-lo de qualquer máquina:

|                                 | stdio (original)                          | `--http` (web)                                                                   |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| Quem acessa                     | o próprio usuário, na máquina dele        | qualquer cliente com token                                                       |
| Autenticação                    | não precisa                               | `Authorization: Bearer <token>` obrigatório                                      |
| Diagramas                       | um conjunto por processo                  | **isolados por sessão MCP** — um usuário nunca vê o do outro                     |
| `filePath` (ler/gravar arquivo) | permitido                                 | **desligado** (seria leitura/escrita arbitrária no servidor)                     |
| Exportação                      | xml, svg, png, gif, apng, mp4, webp, html | xml, svg, both, png (imagem no próprio resultado)                                |
| Persistência em disco           | `--persist-dir`                           | não há: o diagrama vive enquanto a sessão durar; o agente exporta o XML ao final |

Decisão de arquitetura: [agents/adrs/ADR-033-http-transport.md](agents/adrs/ADR-033-http-transport.md).

Há duas formas de publicar:

|                         | Container (Docker + nginx)                            | Vercel (`--stateless`)                    |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Onde                    | infra da FGV, qualquer host com Docker                | Vercel Functions                          |
| Diagramas ficam         | na memória da sessão MCP                              | no **Upstash Redis**, por 7 dias sem uso  |
| Isolamento              | por sessão MCP                                        | por **token**                             |
| Cabeçalhos de segurança | nginx (`deploy/nginx/nginx.conf`)                     | `vercel.json`                             |
| Seção                   | [Subir com Docker Compose](#subir-com-docker-compose) | [Publicar na Vercel](#publicar-na-vercel) |

Decisão do modo Vercel: [agents/adrs/ADR-034-stateless-http-vercel.md](agents/adrs/ADR-034-stateless-http-vercel.md).

## Arquitetura de deploy

```
cliente MCP ──HTTPS──▶ F5 / balanceador ──HTTP──▶ nginx :8080 ──▶ app :3000
                       (TLS da FGV)               cabeçalhos de      /mcp  /health
                                                  segurança, SSE
```

- **app** (`Dockerfile`): Node 22, usuário não-root, sistema de arquivos
  somente-leitura. Porta 3000, só na rede interna do compose.
- **nginx** (`deploy/nginx/`): nginx **1.30.5** (fora da lista vetada pela SI;
  a 1.27.5 é proibida). É a **única** fonte dos cabeçalhos de segurança
  exigidos pelo pentest do ESI — o app não os emite, para que cada um saia uma
  vez só. **O F5 não deve injetar os mesmos cabeçalhos** (CSP duplicada vira
  interseção; COOP duplicado é ignorado).
- Sem banco de dados e sem volume.

## Pré-requisitos

- Docker 24+ com Docker Compose v2.
- No **build**: acesso HTTPS a `registry.npmjs.org` **e a `github.com`** — duas
  dependências (`bpmn-auto-layout` e `bpmn-to-image`) vêm direto do GitHub e são
  compiladas no `npm ci`. Se o ambiente de build da FGV não alcançar o GitHub,
  construir a imagem fora e publicá-la no registro interno.
- Em **execução**: nenhum acesso externo.
- TLS terminado na frente (F5/balanceador). O nginx escuta HTTP puro em 8080.

## Subir com Docker Compose

```bash
cp .env.docker.example .env.docker
# editar .env.docker e preencher MCP_AUTH_TOKENS (openssl rand -hex 32)
docker compose --env-file .env.docker up -d --build
curl -i http://localhost:8080/health
```

O arquivo chama-se `.env.docker` (e não `.env`) para o token nunca ir para o
git por engano; ele já está no `.gitignore`.

### Variáveis de ambiente

| Variável                      | Obrigatória | Default   | O que faz                                                                                                                                                                |
| ----------------------------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MCP_AUTH_TOKENS`             | **sim**     | —         | Tokens aceitos, separados por vírgula, cada um com ≥ 32 caracteres. Vazio ou curto: o app **recusa subir** (de propósito). Um token por equipe/usuário facilita revogar. |
| `HTTP_PORT`                   | não         | `8080`    | Porta do **host** onde o nginx é publicado (no container é 8080).                                                                                                        |
| `MCP_ALLOWED_ORIGINS`         | não         | vazio     | Origens de navegador autorizadas a chamar `/mcp`. Clientes de desktop/CLI não mandam `Origin` e funcionam com o default.                                                 |
| `MCP_MAX_SESSIONS`            | não         | `50`      | Sessões MCP abertas ao mesmo tempo. Acima disso: `503`.                                                                                                                  |
| `MCP_SESSION_IDLE_MINUTES`    | não         | `30`      | Inatividade até a sessão (e seus diagramas) ser descartada.                                                                                                              |
| `MCP_MAX_BODY_BYTES`          | não         | `4194304` | Corpo máximo da requisição (4 MB). Acompanha `client_max_body_size` do nginx.                                                                                            |
| `MCP_MAX_CONCURRENT_REQUESTS` | não         | `8`       | Chamadas processadas em paralelo (trabalho de CPU). Acima disso: `503` com `Retry-After`.                                                                                |
| `BPMN_MCP_MAX_DIAGRAMS`       | não         | `20`      | Diagramas por sessão; ao estourar, descarta o mais antigo.                                                                                                               |
| `BPMN_MCP_TOOLS`              | não         | `full`    | `core` expõe só as 10 ferramentas mais usadas.                                                                                                                           |
| `IMAGE_TAG`                   | não         | `latest`  | Tag das imagens geradas pelo compose.                                                                                                                                    |

## Build e `docker run` manuais

```bash
docker build -t bpmn-js-mcp:1.0.0 .
docker build -t bpmn-js-mcp-nginx:1.0.0 deploy/nginx
docker network create bpmn-mcp
docker run -d --name app --network bpmn-mcp --read-only --tmpfs /tmp \
  -e MCP_AUTH_TOKENS="<token de 64 hex>" bpmn-js-mcp:1.0.0
docker run -d --name nginx --network bpmn-mcp --read-only --tmpfs /tmp \
  -p 8080:8080 bpmn-js-mcp-nginx:1.0.0
```

O container do nginx procura o app pelo nome **`app`** (`deploy/nginx/nginx.conf`,
bloco `upstream`); com outro nome, ajustar ali. Conferir a versão do nginx na
imagem construída: `docker run --rm --entrypoint nginx bpmn-js-mcp-nginx:1.0.0 -v`.

## Publicar na Vercel

Na Vercel cada chamada pode cair numa instância diferente, então o servidor
roda **sem sessão** e guarda os diagramas num Redis (Upstash, pelo Marketplace
da Vercel). Antes de cada chamada recarrega o diagrama citado se outra
instância o alterou; depois, grava de volta o que mudou — antes de responder.

Arquivos: `vercel.json` (build, região `gru1`/São Paulo, rotas e cabeçalhos),
`api/mcp.js` (a função; o código vem de `dist/vercel.js`), `public/` (só um
`robots.txt`; impede a Vercel de servir o repositório como site estático) e
`.vercelignore`. Variáveis comentadas em `.env.vercel.example`.

1. **Login e vínculo do projeto** (uma vez, na raiz do repositório):

   ```bash
   npx vercel login
   npx vercel link
   ```

2. **Redis**: no painel da Vercel, _Storage → Create Database → Upstash for
   Redis_, região **São Paulo (sa-east-1)**, e conecte ao projeto. A integração
   cria `KV_REST_API_URL` e `KV_REST_API_TOKEN` sozinha.

3. **Token** de acesso (gere com `openssl rand -hex 32` e guarde num cofre):

   ```bash
   npx vercel env add MCP_AUTH_TOKENS production
   ```

4. **Deploy de produção** (as URLs de _preview_ ficam atrás do login da Vercel e
   clientes MCP não passam por ele):

   ```bash
   npx vercel deploy --prod
   ```

5. **Conferir**: `curl -i https://<projeto>.vercel.app/health` deve dar `200`
   com os cabeçalhos de segurança; `/mcp` sem token, `401`. Se `/health`
   der `500`, falta token ou Redis — o log da função diz qual.

Limites e diferenças em relação ao modo container:

- Diagramas isolados **por token**: quem usa o mesmo token vê os mesmos diagramas.
- Corpo até 4,5 MB e cada chamada até 120 s (`maxDuration` no `vercel.json`).
- Duas instâncias alterando o mesmo diagrama ao mesmo tempo: vale a última gravação.
- O desfazer/refazer recomeça quando o diagrama é recarregado por outra instância.
- Sem notificações de progresso (respostas JSON simples).

Para reproduzir o modo Vercel localmente, com Redis e o emulador da API REST
do Upstash: `docker compose --env-file .env.docker --profile vercel-dev up -d --build`
e use `http://127.0.0.1:8081/mcp`.

## Conectar um cliente

Claude Code:

```bash
claude mcp add --transport http bpmn https://<host-publicado>/mcp --header "Authorization: Bearer <token>"
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "bpmn": {
      "type": "http",
      "url": "https://<host-publicado>/mcp",
      "headers": { "Authorization": "Bearer ${input:bpmn-token}" }
    }
  },
  "inputs": [
    {
      "id": "bpmn-token",
      "type": "promptString",
      "password": true,
      "description": "Token do bpmn-js-mcp"
    }
  ]
}
```

Clientes que só aceitam conector remoto com **OAuth** (por exemplo, conectores
adicionados pela interface web do claude.ai) não funcionam com token fixo; para
eles seria preciso uma camada OAuth (ex.: SSO da FGV) na frente.

## Desenvolvimento sem Docker

Node.js 22+.

```bash
npm ci                 # também compila (script prepare)
npm test               # vitest (~1600 testes)
npm run lint && npm run typecheck && npm run format:check
node dist/index.js     # modo stdio, como no projeto original
MCP_AUTH_TOKENS=$(openssl rand -hex 32) node dist/index.js --http   # modo HTTP em :3000
```

Os testes do modo HTTP estão em `test/http-server.test.ts` (sessões) e
`test/stateless-http.test.ts` (modo Vercel, com duas instâncias alternadas).

## Ambientes

| Ambiente              | URL                                | Observação                                 |
| --------------------- | ---------------------------------- | ------------------------------------------ |
| Produção              | _a definir com a infra_            | atrás do F5, com TLS                       |
| Teste na Vercel       | `https://<projeto>.vercel.app/mcp` | modo `--stateless`, token próprio          |
| Réplica / homologação | _a definir_                        | mesmo compose, token próprio               |
| Desenvolvimento       | `http://localhost:8080/mcp`        | `docker compose --env-file .env.docker up` |

Use **tokens diferentes** em cada ambiente.

## Segurança (checklist do pentest ESI/FGV)

Conferido em container real (`curl -I` em `/health`, numa rota inexistente,
em `/mcp` sem token, em `413` e em `502`):

- `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Content-Security-Policy` e
  `Cache-Control: no-store` em **todas** as respostas, uma vez cada, inclusive
  nos erros gerados pelo próprio nginx.
- Não há página HTML, então a CSP é a base mínima, sem exceções.
- Autenticação por token com comparação em tempo constante; sessão presa ao
  token que a abriu; `Origin` de navegador validada.
- `filePath` desligado: sem leitura nem escrita de arquivos do servidor.
- Limites de corpo, de sessões, de chamadas simultâneas e de diagramas.
- Dependências de produção sem vulnerabilidades conhecidas (`npm audit --omit=dev`).
- Não se aplicam (não há usuários com senha): política de senha e limite de
  tentativas de login. Os tokens têm ≥ 256 bits de entropia, o que torna
  tentativa por força bruta inviável; por isso não há bloqueio por IP, que
  atrás do F5 viraria um bloqueio global.

## Documentação

- [docs/README-upstream.md](docs/README-upstream.md) — ferramentas, recursos e prompts do MCP (original)
- [docs/architecture.md](docs/architecture.md) — arquitetura interna
- [docs/modeling-best-practices.md](docs/modeling-best-practices.md) — boas práticas de modelagem BPMN
- [docs/common-workflows.md](docs/common-workflows.md) — fluxos de uso
- [AGENTS.md](AGENTS.md) e [agents/adrs/](agents/adrs/) — decisões de arquitetura

## Estrutura de pastas

```
src/
  index.ts             entrada: escolhe stdio, --http ou --http --stateless
  vercel.ts            função da Vercel (vira dist/vercel.js)
  server.ts            monta o servidor MCP (uma instância por sessão no HTTP)
  http-server.ts       transporte HTTP com sessões (Docker): limites, /health
  stateless-http.ts    transporte HTTP sem sessão (Vercel): sincroniza com o Redis
  diagram-store.ts     armazenamento dos diagramas (Upstash Redis ou memória)
  http-common.ts       token, leitura do corpo, respostas de erro
  session-scope.ts     isolamento do estado por sessão (AsyncLocalStorage)
  filesystem-policy.ts desliga filePath no modo HTTP
  handlers/            uma pasta por domínio de ferramenta
test/                  vitest (inclui http-server.test.ts)
deploy/nginx/          imagem e configuração do nginx de borda
api/mcp.js             função da Vercel
vercel.json            configuração da Vercel (rotas, cabeçalhos, região)
public/                estático da Vercel (só robots.txt)
Dockerfile             imagem do app
docker-compose.yml     app + nginx; perfil vercel-dev = modo Vercel local
.env.docker.example    variáveis do compose, comentadas
.env.vercel.example    variáveis da Vercel, comentadas
docs/, agents/adrs/    documentação e ADRs
```

## Licença

MIT (ver [LICENSE](LICENSE)).
