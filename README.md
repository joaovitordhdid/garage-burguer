# Garage Burger 79: cardápio digital

Cardápio online com pedido, checkout, nota fiscal automática (NFC-e) e painel do dono.
Roda na **Vercel** (site e API) com banco **Supabase** (Postgres e armazenamento das fotos).

Site no ar: https://garage-burger-delta.vercel.app (painel do dono em `/admin/`).

- **Cardápio** (`/`): as 10 categorias e os 79 itens copiados do InstaDelivery, com fotos. O cliente pode tirar ingredientes, pôr adicionais e escrever uma observação.
- **Checkout** (`/checkout`): nome, CPF (validado), WhatsApp e localização atual (GPS) são obrigatórios. Também tem retirada no balcão e pagamento por Pix, cartão ou dinheiro com troco.
- **Acompanhamento** (`/pedido?c=CÓDIGO`): status do pedido, QR do Pix, nota fiscal e botão do WhatsApp.
- **Painel do dono** (`/admin/`, link discreto no rodapé): login com e-mail e senha validado no servidor. Tem pedidos em tempo real, preços, itens, ingredientes, adicionais, estoque, financeiro com gráficos e configurações (loja, entrega, Pix e nota fiscal).

## Colocar no ar (Vercel + Supabase)

### 1. Criar o banco no Supabase

1. Entre em [supabase.com](https://supabase.com), clique em **New project** e escolha a região **South America (São Paulo)**. Guarde a senha do banco que você criar.
2. Você **não precisa criar tabelas**: o site cria tudo sozinho no primeiro acesso (arquivo `server/schema.sql`) e importa o cardápio.
3. Anote três valores:
   - **DATABASE_URL**: *Project Settings → Database → Connection string*, aba **Transaction pooler** (porta **6543**). Copie a URI e troque `[YOUR-PASSWORD]` pela senha do banco.
   - **SUPABASE_URL**: *Project Settings → API → Project URL* (ex.: `https://abcd1234.supabase.co`).
   - **SUPABASE_SERVICE_ROLE_KEY**: *Project Settings → API → Project API keys → `service_role`* (clique em *Reveal*). Essa chave é secreta: use só na Vercel e nunca no navegador.

### 2. Publicar na Vercel

1. Entre em [vercel.com](https://vercel.com) com a sua conta do GitHub.
2. **Add New… → Project** e importe o repositório **`joaovitordhdid/garage-burguer`**.
3. Em *Framework Preset* deixe **Other**. Não precisa mudar o comando de build nem a pasta: o `vercel.json` já configura tudo.
4. Abra **Environment Variables** e cadastre:

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | a connection string do *Transaction pooler* (passo 1) |
   | `ADMIN_EMAIL` | o seu e-mail de login no painel |
   | `ADMIN_PASSWORD` | uma senha forte (só vale no primeiro acesso, depois troque pelo painel) |
   | `SUPABASE_URL` | Project URL do Supabase |
   | `SUPABASE_SERVICE_ROLE_KEY` | chave `service_role` do Supabase |
   | `FOCUS_NFE_TOKEN`, `NFE_MODE` | opcionais: token e modo da nota fiscal (senão vale o que estiver no painel) |

5. Clique em **Deploy**. Em um ou dois minutos o site está no ar no endereço `https://<projeto>.vercel.app`.
6. Abra o site uma vez (o primeiro acesso cria as tabelas, a conta do dono e o cardápio) e entre em `/admin/`.

Daqui em diante, **cada `git push` no GitHub publica sozinho** uma nova versão. Para usar um domínio próprio: *Project → Settings → Domains*.

Se alguma variável mudar, refaça o deploy (*Deployments → ⋯ → Redeploy*) para ela valer.

### Como funciona na Vercel

- `public/` é servido direto pela CDN da Vercel (`/checkout`, `/pedido` e `/admin/` funcionam sem `.html`).
- Toda rota `/api/*` vai para uma única função serverless (`api/index.js`), que é o mesmo app Express do `npm start`.
- Não há servidor ligado o tempo todo. Por isso a nota fiscal é emitida na hora do pedido. Se a SEFAZ demorar, a nota fica "processando" e é consultada de novo quando alguém abre o pedido (no máximo a cada 20 s por nota) ou quando a automação do painel roda.
- As fotos enviadas pelo painel vão para o Supabase Storage (bucket público `uploads`, criado sozinho no primeiro envio), porque o disco da Vercel é somente leitura.
- O banco só é acessado pelo servidor. O `schema.sql` liga o RLS em todas as tabelas, e assim a API pública do Supabase não expõe nada.

## Rodar no computador

Precisa do Node.js 22.

```bash
npm install
ADMIN_EMAIL=seu@email.com ADMIN_PASSWORD=umaSenhaForte npm start
# abre http://localhost:3000
```

Sem `DATABASE_URL`, o sistema usa um **Postgres embutido (PGlite)** salvo na pasta `data/`, e você não precisa instalar nada. Para usar o banco do Supabase no computador, coloque a `DATABASE_URL` no ambiente (veja `.env.example`).
Sem as variáveis do Supabase Storage, as fotos enviadas ficam em `public/images/uploads/`.

A conta do dono é criada no primeiro start com o `ADMIN_EMAIL` e o `ADMIN_PASSWORD` informados. Se você não informar, uma senha aleatória aparece no terminal. Depois dá para trocar a senha no painel, em Configurações.

Para recomeçar do zero com o cardápio original no computador: `npm run reset-db` (apaga `data/`) e reinicie.

## Variáveis de ambiente

Veja também o arquivo [`.env.example`](.env.example).

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Postgres do Supabase (Transaction pooler, porta 6543). Sem ela, roda o banco embutido em `./data` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Conta do dono, criada no primeiro acesso |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Envio de fotos pelo painel (Supabase Storage) |
| `FOCUS_NFE_TOKEN`, `NFE_MODE` | Opcional: substitui o token e o modo configurados no painel |
| `NODE_ENV=production` | Cookie seguro e desliga os dados de exemplo (na Vercel isso já é automático no deploy de produção) |
| `ORDER_RATE_LIMIT` | Pedidos por IP a cada 10 min (padrão 8, contado por instância) |
| `DATABASE_POOL_MAX` | Conexões por instância (padrão 3) |
| `DATA_DIR` | Só local: pasta do banco embutido (padrão `./data`) |

## Nota fiscal

Veja [docs/NOTA-FISCAL.md](docs/NOTA-FISCAL.md). O sistema começa em **modo teste**: as notas saem como "sem valor fiscal". Para emitir de verdade, você precisa do certificado digital A1, do CSC da Sefaz-SE e de uma conta na Focus NFe.

## Estrutura

```
server.js                 app Express: API pública do cardápio, login, preparo do banco
api/index.js              função serverless da Vercel (exporta o app)
vercel.json               rotas, arquivos estáticos e cabeçalhos de segurança
server/schema.sql         tabelas do Postgres (idempotente, roda a cada start)
server/db.js              banco: Supabase via DATABASE_URL ou PGlite local
server/auth.js            senha bcrypt + sessão em cookie httpOnly
server/seed.js            importa server/menu-source.json se o cardápio estiver vazio
server/routes/orders.js   checkout, Pix, acompanhamento
server/routes/admin.js    API do painel (toda protegida)
server/nfe/               emissor NFC-e (teste e Focus NFe), DANFE, Pix, QR code
public/                   cardápio, checkout, pedido e painel (/admin)
scripts/                  extração do cardápio original
```

A versão de demonstração em HTML puro (`demo/`, `npm run demo`) foi feita para o banco SQLite antigo e **não gera mais**. Ela fica congelada como está.
