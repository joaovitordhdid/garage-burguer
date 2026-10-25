// Painel do dono (todas as rotas já passam por requireAdmin em server.js).
// Cardápio, receitas/adicionais, estoque, financeiro, pedidos, configurações e nota fiscal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, getSetting, setSetting, tx } = require('../db');

const router = express.Router();

// ---------- Migrações idempotentes (colunas extras do painel) ----------
for (const sql of [
  'ALTER TABLE stock_movements ADD COLUMN note TEXT',
  'ALTER TABLE stock_movements ADD COLUMN cost_cents INTEGER',
]) { try { db.exec(sql); } catch { /* coluna já existe */ } }

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'images', 'uploads');

// Brasil (America/Sao_Paulo) não tem horário de verão desde 2019: UTC-3 fixo.
const TZ = '-3 hours';

// ---------- Helpers de validação ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const notFound = (msg = 'Não encontrado') => new HttpError(404, msg);

function wrap(fn) {
  return (req, res, next) => {
    try { const r = fn(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); }
    catch (e) { next(e); }
  };
}

function id(v, label = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${label} inválido`);
  return n;
}
function str(v, label, { max = 200, required = false, def = '' } = {}) {
  if (v === undefined || v === null) { if (required) throw bad(`${label} é obrigatório`); return def; }
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${label} inválido`);
  const s = String(v).trim();
  if (required && !s) throw bad(`${label} é obrigatório`);
  if (s.length > max) throw bad(`${label}: máximo de ${max} caracteres`);
  return s;
}
function cents(v, label, { required = false, allowNull = false, min = 0, max = 100_000_000 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} é obrigatório`);
    return allowNull ? null : 0;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} inválido (use centavos inteiros)`);
  return n;
}
function num(v, label, { min = -1e9, max = 1e9, required = false, def = 0 } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${label} é obrigatório`); return def; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} inválido`);
  return Math.round(n * 1000) / 1000;
}
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
function date(v, label) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw bad(`${label} inválida (AAAA-MM-DD)`);
  return v;
}
function imageRef(v) {
  const s = str(v, 'Imagem', { max: 500 });
  if (!s) return null;
  if (/^\/images\/[\w\-./]+$/.test(s) && !s.includes('..')) return s;
  try { const u = new URL(s); if (u.protocol === 'https:') return u.href; } catch { /* inválida */ }
  throw bad('Imagem: use um endereço https:// ou envie um arquivo');
}
function urlOrEmpty(v, label) {
  const s = str(v, label, { max: 300 });
  if (!s) return '';
  if (s.startsWith('/images/') && !s.includes('..')) return s;
  try { const u = new URL(s); if (u.protocol === 'https:') return u.href; } catch { /* inválida */ }
  throw bad(`${label}: use um endereço https://`);
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lastId = (r) => Number(r.lastInsertRowid);

// Data local (Brasil) YYYY-MM-DD com deslocamento em dias
function localDate(offsetDays = 0) {
  const d = new Date(Date.now() - 3 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
}
function period(q) {
  const to = q.to ? date(q.to, 'Data final') : localDate(0);
  const from = q.from ? date(q.from, 'Data inicial') : localDate(-29);
  if (from > to) throw bad('A data inicial deve ser anterior à final');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400e3) + 1;
  if (days > 731) throw bad('Período máximo: 2 anos');
  return { from, to, days };
}

function maskCpf(cpf) {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11) return d ? '***' : '';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}
function parseJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

// =====================================================================
// CARDÁPIO
// =====================================================================

router.get('/menu', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY position, id').all();
  const products = db.prepare('SELECT * FROM products ORDER BY position, id').all();
  const recipe = db.prepare(`SELECT pi.product_id, pi.ingredient_id, pi.qty, i.name, i.unit, i.removable, i.stock_qty, i.cost_cents_per_unit
                             FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id ORDER BY i.name`).all();
  const addons = db.prepare('SELECT * FROM addons ORDER BY id').all();
  const byProd = {};
  for (const r of recipe) (byProd[r.product_id] ||= []).push({
    ingredient_id: r.ingredient_id, name: r.name, unit: r.unit, qty: r.qty, removable: !!r.removable,
    out_of_stock: r.stock_qty <= 0, cost_cents: Math.round(r.qty * r.cost_cents_per_unit),
  });
  const mapP = (p) => ({
    ...p, active: !!p.active, featured: !!p.featured,
    ingredients: byProd[p.id] || [],
    recipe_cost_cents: (byProd[p.id] || []).reduce((s, i) => s + i.cost_cents, 0),
    addons: addons.filter(a => a.product_id === p.id).map(a => ({ ...a, active: !!a.active })),
  });
  res.json({
    categories: categories.map(c => ({ ...c, active: !!c.active, products: products.filter(p => p.category_id === c.id).map(mapP) })),
    uncategorized: products.filter(p => p.category_id == null || !categories.some(c => c.id === p.category_id)).map(mapP),
    global_addons: addons.filter(a => a.product_id == null).map(a => ({ ...a, active: !!a.active })),
  });
});

// ----- Categorias -----
router.post('/categories', wrap((req, res) => {
  const b = req.body || {};
  const name = str(b.name, 'Nome', { required: true, max: 60 });
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories').get().p;
  const r = db.prepare('INSERT INTO categories (name, position, active) VALUES (?, ?, ?)').run(name, pos, has(b, 'active') ? bool(b.active) : 1);
  res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(lastId(r)));
}));

router.put('/categories/:id', wrap((req, res) => {
  const cid = id(req.params.id);
  const cur = db.prepare('SELECT * FROM categories WHERE id = ?').get(cid);
  if (!cur) throw notFound('Categoria não encontrada');
  const b = req.body || {};
  const name = has(b, 'name') ? str(b.name, 'Nome', { required: true, max: 60 }) : cur.name;
  const active = has(b, 'active') ? bool(b.active) : cur.active;
  db.prepare('UPDATE categories SET name = ?, active = ? WHERE id = ?').run(name, active, cid);
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(cid));
}));

router.delete('/categories/:id', wrap((req, res) => {
  const cid = id(req.params.id);
  const n = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(cid).n;
  if (n > 0 && req.query.force !== '1') throw bad(`A categoria tem ${n} produto(s). Mova-os ou exclua-os antes.`);
  const r = db.prepare('DELETE FROM categories WHERE id = ?').run(cid);
  if (!r.changes) throw notFound('Categoria não encontrada');
  res.json({ ok: true });
}));

function reorder(table) {
  return wrap((req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids) || ids.length > 1000) throw bad('Lista de ids inválida');
    const clean = ids.map(v => id(v));
    const st = db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`); // nome de tabela fixo (não vem do cliente)
    tx(() => clean.forEach((v, i) => st.run(i, v)));
    res.json({ ok: true });
  });
}
router.post('/categories/reorder', reorder('categories'));
router.post('/products/reorder', reorder('products'));

// ----- Produtos -----
function productFields(b, cur = {}) {
  const out = {};
  const pick = (k, fn) => { if (has(b, k)) out[k] = fn(b[k]); else if (has(cur, k)) out[k] = cur[k]; };
  pick('name', v => str(v, 'Nome', { required: true, max: 80 }));
  pick('description', v => str(v, 'Descrição', { max: 600 }));
  pick('price_cents', v => cents(v, 'Preço', { required: true }));
  pick('original_price_cents', v => cents(v, 'Preço "de"', { allowNull: true }));
  pick('cost_cents', v => cents(v, 'Custo'));
  pick('image', v => imageRef(v));
  pick('active', v => bool(v));
  pick('featured', v => bool(v));
  pick('category_id', v => {
    if (v === null || v === '') return null;
    const c = id(v, 'Categoria');
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(c)) throw bad('Categoria não existe');
    return c;
  });
  if (out.name === undefined) throw bad('Nome é obrigatório');
  if (out.price_cents === undefined) throw bad('Preço é obrigatório');
  if (out.original_price_cents != null && out.original_price_cents <= out.price_cents) {
    throw bad('O preço "de" precisa ser maior que o preço atual (ou deixe vazio)');
  }
  return out;
}

router.post('/products', wrap((req, res) => {
  const f = productFields(req.body || {});
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM products WHERE category_id IS ?').get(f.category_id ?? null).p;
  const r = db.prepare(`INSERT INTO products (category_id, name, description, price_cents, original_price_cents, cost_cents, image, active, featured, position)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(f.category_id ?? null, f.name, f.description ?? '', f.price_cents, f.original_price_cents ?? null, f.cost_cents ?? 0,
      f.image ?? null, f.active ?? 1, f.featured ?? 0, pos);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(lastId(r)));
}));

// PUT aceita atualização parcial (ex.: só {price_cents} na edição rápida de preço)
router.put('/products/:id', wrap((req, res) => {
  const pid = id(req.params.id);
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
  if (!cur) throw notFound('Produto não encontrado');
  const f = productFields(req.body || {}, cur);
  db.prepare(`UPDATE products SET category_id = ?, name = ?, description = ?, price_cents = ?, original_price_cents = ?, cost_cents = ?,
              image = ?, active = ?, featured = ? WHERE id = ?`)
    .run(f.category_id ?? null, f.name, f.description ?? '', f.price_cents, f.original_price_cents ?? null, f.cost_cents ?? 0,
      f.image ?? null, f.active, f.featured, pid);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(pid));
}));

router.delete('/products/:id', wrap((req, res) => {
  const r = db.prepare('DELETE FROM products WHERE id = ?').run(id(req.params.id));
  if (!r.changes) throw notFound('Produto não encontrado');
  res.json({ ok: true });
}));

// Receita do produto (substitui a lista inteira)
router.put('/products/:id/ingredients', wrap((req, res) => {
  const pid = id(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(pid)) throw notFound('Produto não encontrado');
  const items = (req.body || {}).items;
  if (!Array.isArray(items) || items.length > 100) throw bad('Lista de ingredientes inválida');
  const seen = new Set();
  const clean = items.map(it => {
    const iid = id(it && it.ingredient_id, 'Ingrediente');
    if (seen.has(iid)) throw bad('Ingrediente repetido na receita');
    seen.add(iid);
    if (!db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(iid)) throw bad('Ingrediente não existe');
    return { iid, qty: num(it.qty, 'Quantidade', { min: 0.001, max: 100000, def: 1 }) };
  });
  tx(() => {
    db.prepare('DELETE FROM product_ingredients WHERE product_id = ?').run(pid);
    const ins = db.prepare('INSERT INTO product_ingredients (product_id, ingredient_id, qty) VALUES (?, ?, ?)');
    for (const c of clean) ins.run(pid, c.iid, c.qty);
  });
  res.json({ ok: true });
}));

// ----- Adicionais -----
function addonFields(b, cur = {}) {
  const name = has(b, 'name') ? str(b.name, 'Nome', { required: true, max: 60 }) : cur.name;
  const price = has(b, 'price_cents') ? cents(b.price_cents, 'Preço', { required: true }) : cur.price_cents;
  const active = has(b, 'active') ? bool(b.active) : (cur.active ?? 1);
  let product_id = has(cur, 'product_id') ? cur.product_id : null;
  if (has(b, 'product_id')) {
    product_id = (b.product_id === null || b.product_id === '') ? null : id(b.product_id, 'Produto');
    if (product_id && !db.prepare('SELECT 1 FROM products WHERE id = ?').get(product_id)) throw bad('Produto não existe');
  }
  if (!name) throw bad('Nome é obrigatório');
  if (price === undefined) throw bad('Preço é obrigatório');
  return { name, price, active, product_id };
}
router.get('/addons', (req, res) => res.json(db.prepare('SELECT * FROM addons ORDER BY product_id IS NOT NULL, product_id, id').all()));
router.post('/addons', wrap((req, res) => {
  const f = addonFields(req.body || {});
  const r = db.prepare('INSERT INTO addons (product_id, name, price_cents, active) VALUES (?, ?, ?, ?)').run(f.product_id, f.name, f.price, f.active);
  res.status(201).json(db.prepare('SELECT * FROM addons WHERE id = ?').get(lastId(r)));
}));
router.put('/addons/:id', wrap((req, res) => {
  const aid = id(req.params.id);
  const cur = db.prepare('SELECT * FROM addons WHERE id = ?').get(aid);
  if (!cur) throw notFound('Adicional não encontrado');
  const f = addonFields(req.body || {}, cur);
  db.prepare('UPDATE addons SET product_id = ?, name = ?, price_cents = ?, active = ? WHERE id = ?').run(f.product_id, f.name, f.price, f.active, aid);
  res.json(db.prepare('SELECT * FROM addons WHERE id = ?').get(aid));
}));
router.delete('/addons/:id', wrap((req, res) => {
  const r = db.prepare('DELETE FROM addons WHERE id = ?').run(id(req.params.id));
  if (!r.changes) throw notFound('Adicional não encontrado');
  res.json({ ok: true });
}));

// ----- Upload de imagem (corpo binário cru, sem dependências) -----
// fetch('/api/admin/upload', {method:'POST', headers:{'Content-Type': file.type}, body: file})
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
router.post('/upload',
  express.raw({ type: () => true, limit: 3 * 1024 * 1024 }),
  wrap((req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) throw bad('Formato não suportado. Use JPG, PNG ou WEBP.');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw bad('Arquivo vazio');
    const real = sniff(buf);
    if (!real) throw bad('O arquivo não é uma imagem JPG, PNG ou WEBP válida');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${IMAGE_TYPES[real]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    res.status(201).json({ url: `/images/uploads/${name}`, bytes: buf.length });
  }));

// =====================================================================
// ESTOQUE
// =====================================================================
const UNITS = ['un', 'g', 'kg', 'ml', 'L', 'fatia', 'pct', 'cx'];

function ingredientRow(i) {
  return { ...i, removable: !!i.removable, low: i.stock_qty <= i.min_qty, out: i.stock_qty <= 0 };
}
router.get('/ingredients', (req, res) => {
  const rows = db.prepare(`SELECT i.*, (SELECT COUNT(*) FROM product_ingredients pi WHERE pi.ingredient_id = i.id) AS used_in
                           FROM ingredients i ORDER BY i.name COLLATE NOCASE`).all().map(ingredientRow);
  res.json({ ingredients: rows, low_count: rows.filter(r => r.low).length, units: UNITS });
});

function ingFields(b, cur = {}) {
  const out = {
    name: has(b, 'name') ? str(b.name, 'Nome', { required: true, max: 60 }) : cur.name,
    unit: has(b, 'unit') ? str(b.unit, 'Unidade', { required: true, max: 10 }) : (cur.unit || 'un'),
    min_qty: has(b, 'min_qty') ? num(b.min_qty, 'Estoque mínimo', { min: 0 }) : (cur.min_qty ?? 0),
    cost: has(b, 'cost_cents_per_unit') ? cents(b.cost_cents_per_unit, 'Custo por unidade') : (cur.cost_cents_per_unit ?? 0),
    removable: has(b, 'removable') ? bool(b.removable) : (cur.removable ?? 1),
  };
  if (!out.name) throw bad('Nome é obrigatório');
  if (!UNITS.includes(out.unit)) throw bad('Unidade inválida');
  return out;
}
router.post('/ingredients', wrap((req, res) => {
  const b = req.body || {};
  const f = ingFields(b);
  const stock = num(b.stock_qty, 'Estoque inicial', { min: 0 });
  if (db.prepare('SELECT 1 FROM ingredients WHERE name = ? COLLATE NOCASE').get(f.name)) throw bad('Já existe um ingrediente com esse nome');
  const newId = tx(() => {
    const r = db.prepare('INSERT INTO ingredients (name, unit, stock_qty, min_qty, cost_cents_per_unit, removable) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.name, f.unit, stock, f.min_qty, f.cost, f.removable);
    const nid = lastId(r);
    if (stock > 0) db.prepare("INSERT INTO stock_movements (ingredient_id, delta, reason, note) VALUES (?, ?, 'ajuste', 'Estoque inicial')").run(nid, stock);
    return nid;
  });
  res.status(201).json(ingredientRow(db.prepare('SELECT * FROM ingredients WHERE id = ?').get(newId)));
}));
router.put('/ingredients/:id', wrap((req, res) => {
  const iid = id(req.params.id);
  const cur = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(iid);
  if (!cur) throw notFound('Ingrediente não encontrado');
  const f = ingFields(req.body || {}, cur);
  if (db.prepare('SELECT 1 FROM ingredients WHERE name = ? COLLATE NOCASE AND id <> ?').get(f.name, iid)) throw bad('Já existe um ingrediente com esse nome');
  db.prepare('UPDATE ingredients SET name = ?, unit = ?, min_qty = ?, cost_cents_per_unit = ?, removable = ? WHERE id = ?')
    .run(f.name, f.unit, f.min_qty, f.cost, f.removable, iid);
  res.json(ingredientRow(db.prepare('SELECT * FROM ingredients WHERE id = ?').get(iid)));
}));
router.delete('/ingredients/:id', wrap((req, res) => {
  const r = db.prepare('DELETE FROM ingredients WHERE id = ?').run(id(req.params.id));
  if (!r.changes) throw notFound('Ingrediente não encontrado');
  res.json({ ok: true });
}));

// Movimentação manual: compra (entrada), ajuste (+/-, ou contagem absoluta) e perda (saída)
router.post('/stock/movements', wrap((req, res) => {
  const b = req.body || {};
  const iid = id(b.ingredient_id, 'Ingrediente');
  const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(iid);
  if (!ing) throw notFound('Ingrediente não encontrado');
  const type = b.type;
  if (!['compra', 'ajuste', 'perda'].includes(type)) throw bad('Tipo inválido (compra, ajuste ou perda)');
  const note = str(b.note, 'Observação', { max: 200 });
  let delta;
  if (type === 'ajuste' && b.set_qty !== undefined && b.set_qty !== null && b.set_qty !== '') {
    delta = num(b.set_qty, 'Quantidade contada', { min: 0, max: 1e7 }) - ing.stock_qty;
  } else {
    const q = num(b.qty, 'Quantidade', { required: true, min: type === 'ajuste' ? -1e7 : 0.001, max: 1e7 });
    delta = type === 'perda' ? -Math.abs(q) : q;
  }
  delta = Math.round(delta * 1000) / 1000;
  if (delta === 0) throw bad('Nada a alterar: a quantidade é igual ao estoque atual');
  if (type === 'perda' && ing.stock_qty + delta < 0) throw bad(`A perda é maior que o estoque atual (${ing.stock_qty} ${ing.unit})`);
  const totalCost = type === 'compra' ? cents(b.total_cost_cents, 'Valor da compra') : null;
  const createExpense = type === 'compra' && bool(b.create_expense) && totalCost > 0;
  const updateCost = type === 'compra' && bool(b.update_unit_cost) && totalCost > 0;
  tx(() => {
    db.prepare('INSERT INTO stock_movements (ingredient_id, delta, reason, note, cost_cents) VALUES (?, ?, ?, ?, ?)')
      .run(iid, delta, type, note || null, totalCost || null);
    db.prepare('UPDATE ingredients SET stock_qty = ROUND(stock_qty + ?, 3) WHERE id = ?').run(delta, iid);
    if (updateCost) db.prepare('UPDATE ingredients SET cost_cents_per_unit = ? WHERE id = ?').run(Math.round(totalCost / delta), iid);
    if (createExpense) {
      db.prepare("INSERT INTO transactions (type, category, description, amount_cents, date) VALUES ('despesa', 'insumos', ?, ?, ?)")
        .run(`Compra: ${delta} ${ing.unit} de ${ing.name}${note ? ' (' + note + ')' : ''}`.slice(0, 200), totalCost, localDate(0));
    }
  });
  res.status(201).json({ ok: true, ingredient: ingredientRow(db.prepare('SELECT * FROM ingredients WHERE id = ?').get(iid)) });
}));

router.get('/stock/movements', wrap((req, res) => {
  const where = [];
  const args = [];
  if (req.query.ingredient_id) { where.push('m.ingredient_id = ?'); args.push(id(req.query.ingredient_id, 'Ingrediente')); }
  if (req.query.reason) {
    if (!['pedido', 'compra', 'ajuste', 'perda', 'estorno'].includes(req.query.reason)) throw bad('Motivo inválido');
    where.push('m.reason = ?'); args.push(req.query.reason);
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const rows = db.prepare(`SELECT m.*, datetime(m.created_at, '${TZ}') AS created_local, i.name AS ingredient_name, i.unit, o.code AS order_code
                           FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id
                           LEFT JOIN orders o ON o.id = m.order_id
                           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                           ORDER BY m.id DESC LIMIT ?`).all(...args, limit);
  res.json(rows);
}));

// =====================================================================
// FINANCEIRO
// =====================================================================
const NOT_CANCELLED = "o.status <> 'cancelado'";
const LOCAL_DAY = `date(o.created_at, '${TZ}')`;

function revenueBetween(from, to) {
  const r = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue FROM orders o
                        WHERE ${NOT_CANCELLED} AND ${LOCAL_DAY} BETWEEN ? AND ?`).get(from, to);
  return { orders: r.orders, revenue_cents: r.revenue, avg_ticket_cents: r.orders ? Math.round(r.revenue / r.orders) : 0 };
}

router.get('/finance/summary', wrap((req, res) => {
  const { from, to, days } = period(req.query);
  const base = revenueBetween(from, to);
  const cost = db.prepare(`SELECT COALESCE(SUM(oi.qty * COALESCE(p.cost_cents, 0)), 0) AS c
                           FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.id = oi.product_id
                           WHERE ${NOT_CANCELLED} AND ${LOCAL_DAY} BETWEEN ? AND ?`).get(from, to).c;
  // Receitas lançadas automaticamente por pedido (order_id preenchido) já estão no faturamento: não somar de novo.
  const tr = db.prepare(`SELECT type, COALESCE(SUM(amount_cents), 0) AS s FROM transactions
                         WHERE date BETWEEN ? AND ? AND (type = 'despesa' OR order_id IS NULL) GROUP BY type`).all(from, to);
  const expenses = tr.find(t => t.type === 'despesa')?.s || 0;
  const otherIncome = tr.find(t => t.type === 'receita')?.s || 0;
  const cancelled = db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE o.status = 'cancelado' AND ${LOCAL_DAY} BETWEEN ? AND ?`).get(from, to).n;

  // Faturamento por dia (preenchendo dias sem venda)
  const dailyRows = db.prepare(`SELECT ${LOCAL_DAY} AS day, COUNT(*) AS orders, SUM(total_cents) AS revenue FROM orders o
                                WHERE ${NOT_CANCELLED} AND ${LOCAL_DAY} BETWEEN ? AND ? GROUP BY day`).all(from, to);
  const dmap = Object.fromEntries(dailyRows.map(r => [r.day, r]));
  const daily = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(from + 'T00:00:00Z') + i * 86400e3).toISOString().slice(0, 10);
    daily.push({ day: d, orders: dmap[d]?.orders || 0, revenue_cents: dmap[d]?.revenue || 0 });
  }

  const byCategory = db.prepare(`SELECT COALESCE(c.name, 'Sem categoria') AS name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.unit_price_cents) AS revenue_cents
                                 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                 LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.category_id
                                 WHERE ${NOT_CANCELLED} AND ${LOCAL_DAY} BETWEEN ? AND ?
                                 GROUP BY 1 ORDER BY revenue_cents DESC`).all(from, to);
  const topProducts = db.prepare(`SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.unit_price_cents) AS revenue_cents
                                  FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                  WHERE ${NOT_CANCELLED} AND ${LOCAL_DAY} BETWEEN ? AND ?
                                  GROUP BY oi.name ORDER BY qty DESC, revenue_cents DESC LIMIT 10`).all(from, to);
  const hourRows = db.prepare(`SELECT CAST(strftime('%H', o.created_at, '${TZ}') AS INTEGER) AS h, COUNT(*) AS n FROM orders o
                               WHERE ${NOT_CANCELLED} AND ${LOCAL_DAY} BETWEEN ? AND ? GROUP BY h`).all(from, to);
  const byHour = Array.from({ length: 24 }, (_, h) => hourRows.find(r => r.h === h)?.n || 0);
  const payments = db.prepare(`SELECT payment_method AS method, COUNT(*) AS orders, SUM(total_cents) AS revenue_cents FROM orders o
                               WHERE ${NOT_CANCELLED} AND ${LOCAL_DAY} BETWEEN ? AND ? GROUP BY payment_method ORDER BY orders DESC`).all(from, to);
  const expensesByCategory = db.prepare(`SELECT COALESCE(NULLIF(category, ''), 'outros') AS category, SUM(amount_cents) AS amount_cents
                                         FROM transactions WHERE type = 'despesa' AND date BETWEEN ? AND ? GROUP BY 1 ORDER BY 2 DESC`).all(from, to);

  const today = localDate(0);
  res.json({
    period: { from, to, days },
    quick: {
      today: revenueBetween(today, today),
      week: revenueBetween(localDate(-6), today),
      month: revenueBetween(today.slice(0, 8) + '01', today),
    },
    totals: {
      ...base,
      cancelled_orders: cancelled,
      product_cost_cents: cost,
      expenses_cents: expenses,
      other_income_cents: otherIncome,
      profit_cents: base.revenue_cents + otherIncome - cost - expenses,
    },
    daily, by_category: byCategory, top_products: topProducts, by_hour: byHour, payments, expenses_by_category: expensesByCategory,
  });
}));

// ----- Lançamentos manuais -----
const TX_CATEGORIES = ['aluguel', 'embalagens', 'motoboy', 'insumos', 'funcionários', 'energia', 'água', 'internet', 'gás', 'marketing', 'impostos', 'taxas', 'manutenção', 'vendas balcão', 'outros'];

function txFields(b, cur = {}) {
  const type = has(b, 'type') ? b.type : cur.type;
  if (!['receita', 'despesa'].includes(type)) throw bad('Tipo inválido (receita ou despesa)');
  return {
    type,
    category: has(b, 'category') ? str(b.category, 'Categoria', { max: 40 }).toLowerCase() || 'outros' : (cur.category || 'outros'),
    description: has(b, 'description') ? str(b.description, 'Descrição', { max: 200 }) : (cur.description || ''),
    amount: has(b, 'amount_cents') ? cents(b.amount_cents, 'Valor', { required: true, min: 1 }) : cur.amount_cents,
    date: has(b, 'date') ? date(b.date, 'Data') : (cur.date || localDate(0)),
  };
}
router.get('/transactions', wrap((req, res) => {
  const { from, to } = period(req.query);
  const args = [from, to];
  let extra = '';
  if (req.query.type) {
    if (!['receita', 'despesa'].includes(req.query.type)) throw bad('Tipo inválido');
    extra = ' AND t.type = ?'; args.push(req.query.type);
  }
  const rows = db.prepare(`SELECT t.*, o.code AS order_code FROM transactions t LEFT JOIN orders o ON o.id = t.order_id
                           WHERE t.date BETWEEN ? AND ?${extra} ORDER BY t.date DESC, t.id DESC LIMIT 1000`).all(...args);
  res.json({ transactions: rows, categories: TX_CATEGORIES });
}));
router.post('/transactions', wrap((req, res) => {
  const f = txFields(req.body || {});
  const r = db.prepare('INSERT INTO transactions (type, category, description, amount_cents, date) VALUES (?, ?, ?, ?, ?)')
    .run(f.type, f.category, f.description, f.amount, f.date);
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(lastId(r)));
}));
router.put('/transactions/:id', wrap((req, res) => {
  const tid = id(req.params.id);
  const cur = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tid);
  if (!cur) throw notFound('Lançamento não encontrado');
  if (cur.order_id) throw bad('Lançamentos automáticos de pedidos não podem ser editados');
  const f = txFields(req.body || {}, cur);
  db.prepare('UPDATE transactions SET type = ?, category = ?, description = ?, amount_cents = ?, date = ? WHERE id = ?')
    .run(f.type, f.category, f.description, f.amount, f.date, tid);
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(tid));
}));
router.delete('/transactions/:id', wrap((req, res) => {
  const tid = id(req.params.id);
  const cur = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tid);
  if (!cur) throw notFound('Lançamento não encontrado');
  if (cur.order_id) throw bad('Lançamentos automáticos de pedidos não podem ser excluídos (cancele o pedido)');
  db.prepare('DELETE FROM transactions WHERE id = ?').run(tid);
  res.json({ ok: true });
}));

// ----- Exportação CSV (separador ';' e vírgula decimal, abre direto no Excel em pt-BR) -----
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita injeção de fórmula
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const brl = (c) => ((c || 0) / 100).toFixed(2).replace('.', ',');
function sendCsv(res, filename, header, rows) {
  const body = '﻿' + [header, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}
router.get('/export/orders.csv', wrap((req, res) => {
  const { from, to } = period(req.query);
  const orders = db.prepare(`SELECT o.*, datetime(o.created_at, '${TZ}') AS created_local FROM orders o
                             WHERE ${LOCAL_DAY} BETWEEN ? AND ? ORDER BY o.id`).all(from, to);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const inv = db.prepare('SELECT status, number FROM invoices WHERE order_id = ? ORDER BY id DESC LIMIT 1');
  sendCsv(res, `pedidos_${from}_${to}.csv`,
    ['Código', 'Data/hora', 'Status', 'Cliente', 'Telefone', 'Tipo', 'Endereço', 'Pagamento', 'Itens', 'Subtotal (R$)', 'Entrega (R$)', 'Total (R$)', 'Nota fiscal'],
    orders.map(o => {
      const its = items.all(o.id).map(i => `${i.qty}x ${i.name}`).join(' | ');
      const n = inv.get(o.id);
      return [o.code, o.created_local, o.status, o.customer_name, o.customer_phone, o.delivery_type, o.address || '', o.payment_method, its,
        brl(o.subtotal_cents), brl(o.delivery_fee_cents), brl(o.total_cents), n ? `${n.status}${n.number ? ' nº ' + n.number : ''}` : ''];
    }));
}));
router.get('/export/transactions.csv', wrap((req, res) => {
  const { from, to } = period(req.query);
  const rows = db.prepare('SELECT * FROM transactions WHERE date BETWEEN ? AND ? ORDER BY date, id').all(from, to);
  sendCsv(res, `lancamentos_${from}_${to}.csv`, ['Data', 'Tipo', 'Categoria', 'Descrição', 'Valor (R$)', 'Pedido'],
    rows.map(t => [t.date, t.type, t.category || '', t.description || '', brl(t.amount_cents), t.order_id || '']));
}));

// =====================================================================
// PEDIDOS
// =====================================================================
const STATUSES = ['recebido', 'preparo', 'saiu', 'entregue', 'cancelado'];

function orderFull(o, { fullCpf = false } = {}) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(o.id).map(i => ({
    ...i, removed: parseJson(i.removed, []), addons: parseJson(i.addons, []),
  }));
  const invoice = db.prepare('SELECT * FROM invoices WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(o.id) || null;
  let timeline = [];
  try { timeline = db.prepare(`SELECT status, datetime(at, '${TZ}') AS at_local FROM order_status_log WHERE order_id = ? ORDER BY id`).all(o.id); } catch { /* tabela criada pelo módulo de pedidos */ }
  return {
    timeline,
    ...o,
    customer_cpf: fullCpf ? o.customer_cpf : maskCpf(o.customer_cpf),
    created_local: o.created_local,
    items, invoice,
    map_url: (o.lat != null && o.lng != null) ? `https://www.google.com/maps?q=${o.lat},${o.lng}` : (o.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}` : null),
  };
}

router.get('/orders', wrap((req, res) => {
  const where = [];
  const args = [];
  if (req.query.status) {
    if (req.query.status === 'abertos') where.push("o.status IN ('recebido', 'preparo', 'saiu')");
    else { if (!STATUSES.includes(req.query.status)) throw bad('Status inválido'); where.push('o.status = ?'); args.push(req.query.status); }
  }
  if (req.query.q) {
    const q = str(req.query.q, 'Busca', { max: 60 });
    where.push('(o.code LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q.replace(/\D/g, '') || q}%`);
  }
  if (req.query.date) { where.push(`${LOCAL_DAY} = ?`); args.push(date(req.query.date, 'Data')); }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const rows = db.prepare(`SELECT o.*, datetime(o.created_at, '${TZ}') AS created_local FROM orders o
                           ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`).all(...args, limit);
  const counts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM orders o WHERE ${LOCAL_DAY} = ? GROUP BY status`).all(localDate(0)).map(r => [r.status, r.n]));
  const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM orders').get().m;
  res.json({ orders: rows.map(o => orderFull(o)), today_counts: counts, latest_id: latest, statuses: STATUSES });
}));

router.get('/orders/:id', wrap((req, res) => {
  const o = db.prepare(`SELECT o.*, datetime(o.created_at, '${TZ}') AS created_local FROM orders o WHERE o.id = ?`).get(id(req.params.id));
  if (!o) throw notFound('Pedido não encontrado');
  res.json(orderFull(o, { fullCpf: true }));
}));

router.put('/orders/:id/status', wrap((req, res) => {
  const oid = id(req.params.id);
  const status = (req.body || {}).status;
  if (!STATUSES.includes(status)) throw bad('Status inválido');
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(oid);
  if (!o) throw notFound('Pedido não encontrado');
  if (o.status === 'cancelado' && status !== 'cancelado') throw bad('Pedido cancelado não pode ser reaberto');
  tx(() => {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, oid);
    // Cancelamento devolve ao estoque o que o pedido baixou (uma única vez)
    if (status === 'cancelado' && o.status !== 'cancelado') {
      const already = db.prepare("SELECT 1 FROM stock_movements WHERE order_id = ? AND reason = 'estorno' LIMIT 1").get(oid);
      if (!already) {
        const moves = db.prepare("SELECT ingredient_id, SUM(delta) AS d FROM stock_movements WHERE order_id = ? AND reason = 'pedido' GROUP BY ingredient_id").all(oid);
        for (const m of moves) {
          if (!m.d) continue;
          db.prepare("INSERT INTO stock_movements (ingredient_id, delta, reason, order_id, note) VALUES (?, ?, 'estorno', ?, 'Pedido cancelado')").run(m.ingredient_id, -m.d, oid);
          db.prepare('UPDATE ingredients SET stock_qty = ROUND(stock_qty - ?, 3) WHERE id = ?').run(m.d, m.ingredient_id);
        }
      }
    }
  });
  res.json({ ok: true, status });
}));

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================
router.get('/settings', (req, res) => {
  res.json({
    store: getSetting('store', {}),
    delivery: getSetting('delivery', { fee_cents: 0, min_order_cents: 0, eta_min: 30, eta_max: 50 }),
    dev: process.env.NODE_ENV !== 'production',
    admin: req.admin,
  });
});

router.put('/settings/store', wrap((req, res) => {
  const b = req.body || {};
  const cur = getSetting('store', {}) || {};
  const phone = (v, l) => { const d = str(v, l, { max: 20 }).replace(/\D/g, ''); if (d && (d.length < 10 || d.length > 13)) throw bad(`${l} inválido`); return d; };
  const next = {
    ...cur,
    name: str(b.name, 'Nome da loja', { required: true, max: 60 }),
    tagline: str(b.tagline, 'Slogan', { max: 120 }),
    logo: urlOrEmpty(b.logo, 'Logo'),
    banner: urlOrEmpty(b.banner, 'Banner'),
    address: str(b.address, 'Endereço', { max: 200 }),
    phone: phone(b.phone, 'Telefone'),
    whatsapp: phone(b.whatsapp, 'WhatsApp'),
    hours: str(b.hours, 'Horário', { max: 200 }),
    instagram: str(b.instagram, 'Instagram', { max: 60 }).replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, ''),
    open: has(b, 'open') ? !!bool(b.open) : (cur.open ?? true),
  };
  if (next.instagram && !/^[\w.]{1,30}$/.test(next.instagram)) throw bad('Instagram inválido (use só o @usuário)');
  setSetting('store', next);
  res.json(next);
}));

// Atalho para abrir/fechar a loja sem mexer no resto
router.put('/settings/store/open', wrap((req, res) => {
  const cur = getSetting('store', {}) || {};
  cur.open = !!bool((req.body || {}).open);
  setSetting('store', cur);
  res.json({ open: cur.open });
}));

function minutes(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 600) throw bad(`${label}: informe minutos (0 a 600)`);
  return n;
}
router.put('/settings/delivery', wrap((req, res) => {
  const b = req.body || {};
  const cur = getSetting('delivery', {}) || {};
  const next = {
    ...cur,
    fee_cents: cents(b.fee_cents, 'Taxa de entrega', { max: 100000 }),
    min_order_cents: cents(b.min_order_cents, 'Pedido mínimo', { max: 1000000 }),
    eta_min: minutes(b.eta_min, 'Tempo mínimo'),
    eta_max: minutes(b.eta_max, 'Tempo máximo'),
  };
  if (next.eta_max < next.eta_min) throw bad('O tempo máximo deve ser maior ou igual ao mínimo');
  setSetting('delivery', next);
  res.json(next);
}));

// ----- Nota fiscal (settings 'nfe'; lida pelo módulo de pagamento) -----
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const NFE_DEFAULT = { uf: 'SP', mode: 'mock', provider: 'focusnfe', token: '', cnpj: '', inscricao_estadual: '', regime_tributario: 1, csc_id: '', csc_token: '', auto_emit: true };
function validCnpj(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1+$/.test(c)) return false;
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = w.reduce((acc, wi, i) => acc + wi * Number(c[i]), 0);
    const r = s % 11; return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}
function publicNfe(n) {
  const { token, csc_token, ...rest } = { ...NFE_DEFAULT, ...n };
  return { ...rest, token_set: !!token, csc_token_set: !!csc_token, token_from_env: !!process.env.FOCUS_NFE_TOKEN, mode_from_env: process.env.NFE_MODE || null };
}
router.get('/nfe-settings', (req, res) => res.json(publicNfe(getSetting('nfe', {}) || {})));
router.put('/nfe-settings', wrap((req, res) => {
  const b = req.body || {};
  const cur = { ...NFE_DEFAULT, ...(getSetting('nfe', {}) || {}) };
  const mode = has(b, 'mode') ? b.mode : cur.mode;
  if (!['mock', 'homologacao', 'producao'].includes(mode)) throw bad('Ambiente inválido');
  const provider = has(b, 'provider') ? b.provider : cur.provider;
  if (provider !== 'focusnfe') throw bad('Provedor inválido');
  const cnpj = has(b, 'cnpj') ? str(b.cnpj, 'CNPJ', { max: 20 }).replace(/\D/g, '') : cur.cnpj;
  if (cnpj && !validCnpj(cnpj)) throw bad('CNPJ inválido');
  const regime = has(b, 'regime_tributario') ? Number(b.regime_tributario) : Number(cur.regime_tributario);
  if (![1, 2, 3].includes(regime)) throw bad('Regime tributário inválido');
  const next = {
    ...cur, mode, provider, cnpj,
    inscricao_estadual: has(b, 'inscricao_estadual') ? str(b.inscricao_estadual, 'Inscrição estadual', { max: 20 }).replace(/[^\dA-Za-z]/g, '').toUpperCase() : cur.inscricao_estadual,
    regime_tributario: regime,
    csc_id: has(b, 'csc_id') ? str(b.csc_id, 'ID do CSC', { max: 10 }).replace(/\D/g, '') : cur.csc_id,
    auto_emit: has(b, 'auto_emit') ? !!bool(b.auto_emit) : !!cur.auto_emit,
    uf: has(b, 'uf') ? String(b.uf || '').toUpperCase() : (cur.uf || 'SP'),
    razao_social: has(b, 'razao_social') ? str(b.razao_social, 'Razão social', { max: 120 }) : (cur.razao_social || ''),
  };
  if (!UFS.includes(next.uf)) throw bad('UF inválida');
  // Campos secretos: só gravados quando enviados; nunca devolvidos
  if (typeof b.token === 'string' && b.token.trim()) next.token = str(b.token, 'Token', { max: 200 });
  if (b.clear_token === true) next.token = '';
  if (typeof b.csc_token === 'string' && b.csc_token.trim()) next.csc_token = str(b.csc_token, 'Token CSC', { max: 100 });
  if (b.clear_csc_token === true) next.csc_token = '';
  // Sem token/CNPJ a emissão real falha (o pedido não é perdido; a nota fica com erro). Bloqueamos só a produção,
  // a menos que o token venha do ambiente (FOCUS_NFE_TOKEN tem prioridade sobre o painel).
  const warnings = [];
  if (mode !== 'mock') {
    if (!next.token && !process.env.FOCUS_NFE_TOKEN) warnings.push('token da Focus NFe');
    if (!next.cnpj) warnings.push('CNPJ');
    if (!next.inscricao_estadual) warnings.push('inscrição estadual');
    if (mode === 'producao' && warnings.length) throw bad(`Para emitir notas reais, preencha: ${warnings.join(', ')}`);
  }
  setSetting('nfe', next);
  res.json({ ...publicNfe(next), warnings: warnings.length ? `Falta: ${warnings.join(', ')}. Sem isso as notas ficarão com erro.` : null });
}));

// ----- Pix (settings 'pix' = { key, merchant_name, city }; lido pelo checkout) -----
function normalizePixKey(k) {
  k = String(k || '').trim();
  if (!k) return '';
  if (k.includes('@')) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k) || k.length > 77) throw bad('Chave Pix (e-mail) inválida'); return k.toLowerCase(); }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return k.toLowerCase();
  const d = k.replace(/\D/g, '');
  if (k.startsWith('+') || (d.length === 13 && d.startsWith('55'))) { if (d.length < 12 || d.length > 13) throw bad('Chave Pix (telefone) inválida: use +55 DDD número'); return '+' + d; }
  if (d.length === 11 || d.length === 14) return d;
  throw bad('Chave Pix inválida. Use CPF, CNPJ, e-mail, telefone com +55 ou chave aleatória');
}
router.get('/pix-settings', (req, res) => res.json({ key: '', merchant_name: '', city: '', ...(getSetting('pix', {}) || {}) }));
router.put('/pix-settings', wrap((req, res) => {
  const b = req.body || {};
  const next = {
    ...(getSetting('pix', {}) || {}),
    key: normalizePixKey(b.key),
    merchant_name: str(b.merchant_name, 'Nome do recebedor', { max: 25 }),
    city: str(b.city, 'Cidade', { max: 15 }),
  };
  if (next.key && (!next.merchant_name || !next.city)) throw bad('Informe também o nome do recebedor e a cidade');
  setSetting('pix', next);
  res.json(next);
}));

// =====================================================================
// DESENVOLVIMENTO: pedidos de exemplo para ver os gráficos
// =====================================================================
router.post('/dev/sample-orders', wrap((req, res) => {
  if (process.env.NODE_ENV === 'production') throw new HttpError(403, 'Indisponível em produção');
  const count = Math.min(Math.max(parseInt((req.body || {}).count, 10) || 60, 1), 300);
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  if (!products.length) throw bad('Cadastre produtos antes de gerar pedidos de exemplo');
  const addons = db.prepare('SELECT * FROM addons WHERE active = 1').all();
  const recipe = db.prepare('SELECT pi.ingredient_id, i.name FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id WHERE pi.product_id = ? AND i.removable = 1');
  const fee = (getSetting('delivery', {}) || {}).fee_cents || 0;
  const names = ['Ana Souza', 'Bruno Lima', 'Carla Mendes', 'Diego Rocha', 'Eduarda Alves', 'Felipe Costa', 'Gabriela Dias', 'Henrique Nunes',
    'Isabela Martins', 'João Pereira', 'Larissa Gomes', 'Marcos Ribeiro', 'Natália Barbosa', 'Otávio Freitas', 'Paula Cardoso', 'Rafael Teixeira'];
  const streets = ['Rua das Flores', 'Av. Brasil', 'Rua XV de Novembro', 'Rua São João', 'Av. Paulista', 'Rua do Comércio', 'Rua Santa Catarina'];
  const rnd = (n) => Math.floor(Math.random() * n);
  const pickW = (pairs) => { let t = Math.random() * pairs.reduce((s, p) => s + p[1], 0); for (const [v, w] of pairs) { if ((t -= w) <= 0) return v; } return pairs[0][0]; };
  const cpf = () => {
    const d = Array.from({ length: 9 }, () => rnd(10));
    for (const len of [9, 10]) { let s = 0; for (let i = 0; i < len; i++) s += d[i] * (len + 1 - i); const r = (s * 10) % 11; d.push(r === 10 ? 0 : r); }
    return d.join('');
  };
  // mesmo formato do módulo de pedidos (GB- + 5 caracteres, sem 0/O/1/I/L)
  const code = () => { const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; let c; do { c = 'GB-' + Array.from({ length: 5 }, () => A[rnd(A.length)]).join(''); } while (db.prepare('SELECT 1 FROM orders WHERE code = ?').get(c)); return c; };

  const insO = db.prepare(`INSERT INTO orders (code, customer_name, customer_cpf, customer_phone, address, address_ref, lat, lng, delivery_type, payment_method,
                           change_for_cents, notes, subtotal_cents, delivery_fee_cents, total_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insI = db.prepare('INSERT INTO order_items (order_id, product_id, name, qty, unit_price_cents, removed, addons, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insN = db.prepare(`INSERT INTO invoices (order_id, provider, ref, status, number, series, access_key, message, danfe_url, created_at) VALUES (?, 'mock', ?, ?, ?, '1', ?, ?, ?, ?)`);
  let created = 0;
  let sampleRevenue = 0;
  // horários gerados antes e ordenados, para os ids seguirem a ordem cronológica
  const when = Array.from({ length: count }, (_, k) => {
      const daysAgo = k < 3 ? 0 : rnd(30);
      const hour = pickW([[11, 3], [12, 5], [13, 4], [14, 1], [17, 1], [18, 4], [19, 8], [20, 10], [21, 8], [22, 5], [23, 2]]);
      const local = new Date(Date.now() - 3 * 3600e3 - daysAgo * 86400e3);
      local.setUTCHours(hour, rnd(60), rnd(60));
      let utc = new Date(local.getTime() + 3 * 3600e3);
      if (utc > new Date()) utc = new Date(Date.now() - rnd(90) * 60e3);
      return { daysAgo, utc };
  }).sort((a, b) => a.utc - b.utc);
  tx(() => {
    for (const { daysAgo, utc } of when) {
      const createdAt = utc.toISOString().slice(0, 19).replace('T', ' ');
      const delivery = Math.random() < 0.75;
      const items = [];
      const nItems = 1 + rnd(3);
      for (let j = 0; j < nItems; j++) {
        const p = products[rnd(products.length)];
        const ad = addons.filter(a => (a.product_id === p.id || a.product_id == null) && Math.random() < 0.25).slice(0, 2);
        const rem = recipe.all(p.id).filter(() => Math.random() < 0.12).map(r => r.name);
        const unit = p.price_cents + ad.reduce((s, a) => s + a.price_cents, 0);
        items.push({ p, qty: 1 + (Math.random() < 0.25 ? 1 : 0), unit, ad, rem });
      }
      const subtotal = items.reduce((s, i) => s + i.qty * i.unit, 0);
      const dfee = delivery ? fee : 0;
      const recent = daysAgo === 0 && (Date.now() - utc.getTime()) < 3 * 3600e3;
      const status = recent ? pickW([['recebido', 2], ['preparo', 2], ['saiu', 1]]) : pickW([['entregue', 92], ['cancelado', 8]]);
      const pay = pickW([['pix', 55], ['cartao', 35], ['dinheiro', 10]]);
      const total = subtotal + dfee;
      if (status !== 'cancelado') sampleRevenue += total;
      const lat = delivery ? -23.55 + (Math.random() - 0.5) * 0.06 : null;
      const lng = delivery ? -46.63 + (Math.random() - 0.5) * 0.06 : null;
      const oc = code();
      const r = insO.run(oc, names[rnd(names.length)], cpf(), `119${String(10000000 + rnd(89999999))}`,
        delivery ? `${streets[rnd(streets.length)]}, ${10 + rnd(990)} - Centro` : null, delivery && Math.random() < 0.3 ? 'Portão azul' : null,
        lat, lng, delivery ? 'delivery' : 'retirada', pay,
        pay === 'dinheiro' ? Math.ceil(total / 5000) * 5000 : null, '[exemplo]', subtotal, dfee, total, status, createdAt);
      const oid = lastId(r);
      for (const it of items) insI.run(oid, it.p.id, it.p.name, it.qty, it.unit, JSON.stringify(it.rem), JSON.stringify(it.ad.map(a => ({ id: a.id, name: a.name, price_cents: a.price_cents }))), null);
      const invStatus = status === 'cancelado' ? 'cancelada' : (recent && Math.random() < 0.3 ? 'processando' : 'autorizada');
      insN.run(oid, `EX-${oid}`, invStatus, invStatus === 'processando' ? null : String(1000 + oid),
        invStatus === 'processando' ? null : Array.from({ length: 44 }, () => rnd(10)).join(''), 'Nota de exemplo (simulada)',
        invStatus === 'autorizada' ? `/api/orders/${oc}/danfe` : null, createdAt);
      created++;
    }
    // algumas despesas típicas no período
    // despesas proporcionais ao faturamento de exemplo, para o lucro fazer sentido
    const exp = [['aluguel', 'Aluguel do ponto', 0.12, 25], ['embalagens', 'Caixas e sacos kraft', 0.04, 18], ['motoboy', 'Diárias motoboy (semana)', 0.05, 14],
      ['motoboy', 'Diárias motoboy (semana)', 0.05, 7], ['energia', 'Conta de luz', 0.03, 10], ['insumos', 'Carne e pães (atacado)', 0.06, 3]];
    const insT = db.prepare("INSERT INTO transactions (type, category, description, amount_cents, date) VALUES ('despesa', ?, ?, ?, ?)");
    for (const [c, d, f, ago] of exp) insT.run(c, `${d} [exemplo]`, Math.max(100, Math.round(sampleRevenue * f / 100) * 100), localDate(-ago));
  });
  res.status(201).json({ ok: true, created });
}));

router.delete('/dev/sample-orders', wrap((req, res) => {
  if (process.env.NODE_ENV === 'production') throw new HttpError(403, 'Indisponível em produção');
  const r = tx(() => {
    const o = db.prepare("DELETE FROM orders WHERE notes = '[exemplo]'").run();
    db.prepare("DELETE FROM transactions WHERE description LIKE '%[exemplo]'").run();
    return o.changes;
  });
  res.json({ ok: true, removed: r });
}));

// ---------- Erros do painel em JSON e em português ----------
router.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Arquivo grande demais (máximo 3 MB)' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  console.error('[admin]', err);
  res.status(500).json({ error: 'Erro interno' });
});

module.exports = router;
