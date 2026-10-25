# Contrato compartilhado (para os agentes)

Stack: Node 22 + Express 5 + Postgres (Supabase em produção via `DATABASE_URL`; PGlite embutido em `./data` no local). Deploy na Vercel:
`public/` vai para a CDN e `/api/*` vai para a função `api/index.js` (o mesmo app). Frontend em HTML/CSS/JS puro (sem build).
Serverless: nada de `setTimeout`/trabalho em segundo plano nem gravação em disco. Faça o trabalho dentro da requisição.
A CSP está em DOIS lugares: `helmet` em server.js (respostas da API e `npm start`) e `headers` no vercel.json (páginas estáticas na Vercel). Mude os dois juntos.
Bibliotecas de front só via `https://cdn.jsdelivr.net/npm/<pkg>@<versão exata>` (é o único CDN liberado na CSP em server.js).
Fontes: Google Fonts liberado. Imagens: qualquer https.

Rodar: `ADMIN_EMAIL=dono@garageburger.com ADMIN_PASSWORD=garage123 PORT=3000 npm start`
Apagar banco local e re-seedar: `rm -rf data` (ou `DATA_DIR=/tmp/x`). O seed lê `server/menu-source.json`.
Playwright + Chromium já instalados (`require('playwright')`) para screenshots/testes.

## Arquivos de cada um (NÃO edite arquivos de outro dono; peça ao coordenador)
- Coordenador: `server.js`, `server/db.js`, `server/auth.js`, `server/seed.js`, `server/menu-source.json`, `public/js/cart.js`, `CONTRACT.md`, `README.md`, `package.json`.
- Design: `public/index.html`, `public/css/menu.css`, `public/js/menu.js`, `public/images/ui/*`, `public/css/theme.css` (tokens de cor/fonte que os outros podem importar).
- Painel: `server/routes/admin.js`, `public/admin/**` (index.html = login + painel).
- Pagamento: `server/routes/orders.js`, `server/nfe/**`, `public/checkout.html`, `public/css/checkout.css`, `public/js/checkout.js`, `public/pedido.html` (acompanhamento do pedido).

Coluna/tabela nova: adicione em `server/schema.sql` de forma idempotente (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), com `ENABLE ROW LEVEL SECURITY` para tabela nova. Ele roda a cada cold start numa transação com trava.

## Banco (ver server/db.js)
Valores em centavos (`*_cents`). Tabelas: settings, admins, sessions, categories, products, ingredients,
product_ingredients (receita/estoque), addons, orders, order_items, invoices, transactions, stock_movements.
Settings úteis: `store` ({name, tagline, logo, banner, address, phone, whatsapp, hours, instagram}), `delivery` ({fee_cents, min_order_cents, eta_min, eta_max}), `nfe` (config do emissor; dono = pagamento/painel).
Helpers (TUDO assíncrono): `const { db, getSetting, setSetting, tx } = require('../db')`.
`await db.get(sql, [params])`, `await db.all(...)`, `await db.run(...)` → `{rowCount, rows}` (use `RETURNING id`), `await tx(async t => { await t.get/all/run })`,
`await getSetting(key, fallback, t?)`, `await setSetting(key, value, t?)`. Placeholders `$1, $2`. Dentro de transação, use sempre `t`.
Datas `timestamptz` voltam como `'YYYY-MM-DD HH:MM:SS'` (UTC); `date` como `'YYYY-MM-DD'`; `count`/`sum` como Number (use `COALESCE(SUM(...),0)`).
Dia/hora local: `(x AT TIME ZONE 'America/Sao_Paulo')::date`; nunca dependa do fuso da sessão. Booleanos continuam INTEGER 0/1.
Ids: rejeite > 2147483647 antes de consultar (coluna INTEGER).
NFC-e (`require('../nfe')`, tudo async): `getConfig()`, `emitForOrder(orderId, {waitMs})`, `retryForOrder(orderId)`, `refreshPending({limit, retryErrors})`,
`refreshIfStale(invoice)`, `cancelForOrder(orderId, reason)`, `latestInvoice(orderId)`, `publicInvoice(inv, cfg?)`, `loadDoc(orderId)`.

## API pública (pronta)
`GET /api/menu` →
```
{ store: {...}, categories: [ { id, name, position, active, products: [
   { id, name, description, price_cents, original_price_cents|null, image|null, featured, active,
     ingredients: [{id, name, removable, out_of_stock}], addons: [{id, name, price_cents}] } ] } ] }
```

## Carrinho (pronto) — `public/js/cart.js`
`GB.Cart.add({product_id, name, image, unit_price_cents, qty, removed:[nomes], addons:[{id,name,price_cents}], notes})`,
`GB.Cart.items()`, `setQty(key, n)`, `remove(key)`, `clear()`, `count()`, `subtotalCents()`, `onChange(fn)`; `GB.money(cents)`.
`unit_price_cents` já inclui adicionais. O cardápio leva o cliente para `/checkout` (checkout.html).

## Pedidos (agente de pagamento implementa)
`POST /api/orders` body: `{ customer:{name, cpf, phone}, delivery_type:'delivery'|'retirada', address, address_ref, lat, lng,
payment_method:'pix'|'cartao'|'dinheiro', change_for_cents, notes, items:[{product_id, qty, removed:[nomes], addon_ids:[ids], notes}] }`
O servidor RECALCULA preços a partir do banco (nunca confia no preço do cliente), valida CPF/telefone, baixa estoque
(stock_movements reason 'pedido'), lança receita, emite NFC-e e retorna `{ code, total_cents, invoice:{status, danfe_url, ...} }`.
`GET /api/orders/:code` → status do pedido + nota (público por código).

## Admin (agente do painel implementa) — tudo sob `/api/admin/*`, já protegido por `requireAdmin` (cookie httpOnly)
Auth pronta: `POST /api/auth/login {email,password}`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password {current,next}`.
Frontend sempre com `fetch(url, {credentials:'same-origin'})`; 401 → mostrar login.
Acesso pelo link discreto no rodapé do cardápio para `/admin/`.

Idioma de toda interface: português do Brasil. Moeda BRL.
