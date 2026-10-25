# Contrato compartilhado (para os agentes)

Stack: Node 22 + Express + SQLite (`node:sqlite`). Frontend em HTML/CSS/JS puro servido de `public/` (sem build).
Bibliotecas de front só via `https://cdn.jsdelivr.net/npm/<pkg>@<versão exata>` (é o único CDN liberado na CSP em server.js).
Fontes: Google Fonts liberado. Imagens: qualquer https.

Rodar: `ADMIN_EMAIL=dono@garageburger.com ADMIN_PASSWORD=garage123 PORT=3000 npm start`
Apagar banco e re-seedar: `rm -rf data` (o seed lê `server/menu-source.json`).
Playwright + Chromium já instalados (`require('playwright')`) para screenshots/testes.

## Arquivos de cada um (NÃO edite arquivos de outro dono; peça ao coordenador)
- Coordenador: `server.js`, `server/db.js`, `server/auth.js`, `server/seed.js`, `server/menu-source.json`, `public/js/cart.js`, `CONTRACT.md`, `README.md`, `package.json`.
- Design: `public/index.html`, `public/css/menu.css`, `public/js/menu.js`, `public/images/ui/*`, `public/css/theme.css` (tokens de cor/fonte que os outros podem importar).
- Painel: `server/routes/admin.js`, `public/admin/**` (index.html = login + painel).
- Pagamento: `server/routes/orders.js`, `server/nfe/**`, `public/checkout.html`, `public/css/checkout.css`, `public/js/checkout.js`, `public/pedido.html` (acompanhamento do pedido).

Se precisar de coluna/tabela nova, adicione com `ALTER TABLE` idempotente no topo do SEU arquivo de rota (try/catch), não em db.js.

## Banco (ver server/db.js)
Valores em centavos (`*_cents`). Tabelas: settings, admins, sessions, categories, products, ingredients,
product_ingredients (receita/estoque), addons, orders, order_items, invoices, transactions, stock_movements.
Settings úteis: `store` ({name, tagline, logo, banner, address, phone, whatsapp, hours, instagram}), `delivery` ({fee_cents, min_order_cents, eta_min, eta_max}), `nfe` (config do emissor; dono = pagamento/painel).
Helpers: `const { db, getSetting, setSetting, tx } = require('../db')`.

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
