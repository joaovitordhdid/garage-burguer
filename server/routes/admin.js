// Painel do dono (todas as rotas já passam por requireAdmin em server.js).
// Cardápio, receitas/adicionais, estoque, financeiro, pedidos, configurações e nota fiscal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, getSetting, setSetting, tx } = require('../db');
const nfe = require('../nfe');

const router = express.Router();

// Colunas extras do painel (stock_movements.note/cost_cents) já estão em server/schema.sql.

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'images', 'uploads');

// Datas locais do Brasil. A conversão é feita no Postgres com o fuso America/Sao_Paulo.
const TZ = "'America/Sao_Paulo'";
const localTs = (col) => `to_char(${col} AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI:SS')`; // mesmo formato de antes
const INT_MAX = 2147483647;
// Produção: NODE_ENV=production ou o deploy de produção da Vercel (previews continuam com dados de exemplo)
const IS_PROD = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';

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
  if (!Number.isInteger(n) || n <= 0 || n > INT_MAX) throw bad(`${label} inválido`);
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
function groupBy(rows, key) { const m = {}; for (const r of rows) (m[r[key]] ||= []).push(r); return m; }

// =====================================================================
// CARDÁPIO
// =====================================================================

router.get('/menu', wrap(async (req, res) => {
  const [categories, products, recipe, addons] = await Promise.all([
    db.all('SELECT * FROM categories ORDER BY position, id'),
    db.all('SELECT * FROM products ORDER BY position, id'),
    db.all(`SELECT pi.product_id, pi.ingredient_id, pi.qty, i.name, i.unit, i.removable, i.stock_qty, i.cost_cents_per_unit
            FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id ORDER BY i.name, i.id`),
    db.all('SELECT * FROM addons ORDER BY id'),
  ]);
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
}));

// ----- Categorias -----
router.post('/categories', wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 'Nome', { required: true, max: 60 });
  const row = await db.get(`INSERT INTO categories (name, position, active)
                            VALUES ($1, (SELECT COALESCE(MAX(position), -1) + 1 FROM categories), $2) RETURNING *`,
    [name, has(b, 'active') ? bool(b.active) : 1]);
  res.status(201).json(row);
}));

router.put('/categories/:id', wrap(async (req, res) => {
  const cid = id(req.params.id);
  const cur = await db.get('SELECT * FROM categories WHERE id = $1', [cid]);
  if (!cur) throw notFound('Categoria não encontrada');
  const b = req.body || {};
  const name = has(b, 'name') ? str(b.name, 'Nome', { required: true, max: 60 }) : cur.name;
  const active = has(b, 'active') ? bool(b.active) : cur.active;
  res.json(await db.get('UPDATE categories SET name = $1, active = $2 WHERE id = $3 RETURNING *', [name, active, cid]));
}));

router.delete('/categories/:id', wrap(async (req, res) => {
  const cid = id(req.params.id);
  const { n } = await db.get('SELECT COUNT(*)::int AS n FROM products WHERE category_id = $1', [cid]);
  if (n > 0 && req.query.force !== '1') throw bad(`A categoria tem ${n} produto(s). Mova-os ou exclua-os antes.`);
  const r = await db.run('DELETE FROM categories WHERE id = $1', [cid]);
  if (!r.rowCount) throw notFound('Categoria não encontrada');
  res.json({ ok: true });
}));

function reorder(table) {
  return wrap(async (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids) || ids.length > 1000) throw bad('Lista de ids inválida');
    const clean = ids.map(v => id(v));
    if (new Set(clean).size !== clean.length) throw bad('Lista de ids repetidos');
    // Um comando só: posição = índice na lista (nome de tabela fixo, não vem do cliente)
    if (clean.length) {
      await db.run(`UPDATE ${table} SET position = array_position($1::int[], id) - 1 WHERE id = ANY($1::int[])`, [clean]);
    }
    res.json({ ok: true });
  });
}
router.post('/categories/reorder', reorder('categories'));
router.post('/products/reorder', reorder('products'));

// ----- Produtos -----
async function productFields(b, cur = {}) {
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
  pick('category_id', v => (v === null || v === '') ? null : id(v, 'Categoria'));
  if (has(b, 'category_id') && out.category_id != null && !(await db.get('SELECT 1 FROM categories WHERE id = $1', [out.category_id]))) {
    throw bad('Categoria não existe');
  }
  if (out.name === undefined) throw bad('Nome é obrigatório');
  if (out.price_cents === undefined) throw bad('Preço é obrigatório');
  if (out.original_price_cents != null && out.original_price_cents <= out.price_cents) {
    throw bad('O preço "de" precisa ser maior que o preço atual (ou deixe vazio)');
  }
  return out;
}

router.post('/products', wrap(async (req, res) => {
  const f = await productFields(req.body || {});
  const row = await db.get(`INSERT INTO products (category_id, name, description, price_cents, original_price_cents, cost_cents, image, active, featured, position)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                              (SELECT COALESCE(MAX(position), -1) + 1 FROM products WHERE category_id IS NOT DISTINCT FROM $1::int))
                            RETURNING *`,
    [f.category_id ?? null, f.name, f.description ?? '', f.price_cents, f.original_price_cents ?? null, f.cost_cents ?? 0,
      f.image ?? null, f.active ?? 1, f.featured ?? 0]);
  res.status(201).json(row);
}));

// PUT aceita atualização parcial (ex.: só {price_cents} na edição rápida de preço)
router.put('/products/:id', wrap(async (req, res) => {
  const pid = id(req.params.id);
  const cur = await db.get('SELECT * FROM products WHERE id = $1', [pid]);
  if (!cur) throw notFound('Produto não encontrado');
  const f = await productFields(req.body || {}, cur);
  res.json(await db.get(`UPDATE products SET category_id = $1, name = $2, description = $3, price_cents = $4, original_price_cents = $5, cost_cents = $6,
              image = $7, active = $8, featured = $9 WHERE id = $10 RETURNING *`,
    [f.category_id ?? null, f.name, f.description ?? '', f.price_cents, f.original_price_cents ?? null, f.cost_cents ?? 0,
      f.image ?? null, f.active, f.featured, pid]));
}));

router.delete('/products/:id', wrap(async (req, res) => {
  const r = await db.run('DELETE FROM products WHERE id = $1', [id(req.params.id)]);
  if (!r.rowCount) throw notFound('Produto não encontrado');
  res.json({ ok: true });
}));

// Receita do produto (substitui a lista inteira)
router.put('/products/:id/ingredients', wrap(async (req, res) => {
  const pid = id(req.params.id);
  if (!(await db.get('SELECT 1 FROM products WHERE id = $1', [pid]))) throw notFound('Produto não encontrado');
  const items = (req.body || {}).items;
  if (!Array.isArray(items) || items.length > 100) throw bad('Lista de ingredientes inválida');
  const seen = new Set();
  const clean = items.map(it => {
    const iid = id(it && it.ingredient_id, 'Ingrediente');
    if (seen.has(iid)) throw bad('Ingrediente repetido na receita');
    seen.add(iid);
    return { iid, qty: num(it.qty, 'Quantidade', { min: 0.001, max: 100000, def: 1 }) };
  });
  if (clean.length) {
    const { n } = await db.get('SELECT COUNT(*)::int AS n FROM ingredients WHERE id = ANY($1::int[])', [clean.map(c => c.iid)]);
    if (n !== clean.length) throw bad('Ingrediente não existe');
  }
  await tx(async (t) => {
    await t.run('DELETE FROM product_ingredients WHERE product_id = $1', [pid]);
    for (const [i, c] of clean.entries()) {
      await t.run('INSERT INTO product_ingredients (product_id, ingredient_id, qty, position) VALUES ($1, $2, $3, $4)', [pid, c.iid, c.qty, i]);
    }
  });
  res.json({ ok: true });
}));

// ----- Adicionais -----
async function addonFields(b, cur = {}) {
  const name = has(b, 'name') ? str(b.name, 'Nome', { required: true, max: 60 }) : cur.name;
  const price = has(b, 'price_cents') ? cents(b.price_cents, 'Preço', { required: true }) : cur.price_cents;
  const active = has(b, 'active') ? bool(b.active) : (cur.active ?? 1);
  let product_id = has(cur, 'product_id') ? cur.product_id : null;
  if (has(b, 'product_id')) {
    product_id = (b.product_id === null || b.product_id === '') ? null : id(b.product_id, 'Produto');
    if (product_id && !(await db.get('SELECT 1 FROM products WHERE id = $1', [product_id]))) throw bad('Produto não existe');
  }
  if (!name) throw bad('Nome é obrigatório');
  if (price === undefined) throw bad('Preço é obrigatório');
  return { name, price, active, product_id };
}
router.get('/addons', wrap(async (req, res) => res.json(await db.all('SELECT * FROM addons ORDER BY product_id IS NOT NULL, product_id, id'))));
router.post('/addons', wrap(async (req, res) => {
  const f = await addonFields(req.body || {});
  res.status(201).json(await db.get('INSERT INTO addons (product_id, name, price_cents, active) VALUES ($1, $2, $3, $4) RETURNING *',
    [f.product_id, f.name, f.price, f.active]));
}));
router.put('/addons/:id', wrap(async (req, res) => {
  const aid = id(req.params.id);
  const cur = await db.get('SELECT * FROM addons WHERE id = $1', [aid]);
  if (!cur) throw notFound('Adicional não encontrado');
  const f = await addonFields(req.body || {}, cur);
  res.json(await db.get('UPDATE addons SET product_id = $1, name = $2, price_cents = $3, active = $4 WHERE id = $5 RETURNING *',
    [f.product_id, f.name, f.price, f.active, aid]));
}));
router.delete('/addons/:id', wrap(async (req, res) => {
  const r = await db.run('DELETE FROM addons WHERE id = $1', [id(req.params.id)]);
  if (!r.rowCount) throw notFound('Adicional não encontrado');
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
// Na Vercel o disco é somente leitura: com SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY a imagem vai para o
// Supabase Storage (bucket público "uploads", criado no primeiro envio). Sem isso, grava em public/images/uploads (local).
const BUCKET = 'uploads';
function storageConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return url && key ? { url, key } : null;
}
let bucketReady = false;
async function ensureBucket(st) {
  if (bucketReady) return;
  const headers = { Authorization: `Bearer ${st.key}`, apikey: st.key, 'Content-Type': 'application/json' };
  const r = await fetch(`${st.url}/storage/v1/bucket/${BUCKET}`, { headers, signal: AbortSignal.timeout(8000) });
  if (r.status !== 200) {
    const c = await fetch(`${st.url}/storage/v1/bucket`, {
      method: 'POST', headers, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 3 * 1024 * 1024, allowed_mime_types: Object.keys(IMAGE_TYPES) }),
    });
    const body = await c.text();
    // 409/400 "already exists" = outra instância criou ao mesmo tempo
    if (!c.ok && !/already exists|Duplicate/i.test(body)) throw new Error(`Supabase Storage: não foi possível criar o bucket (${c.status}) ${body.slice(0, 200)}`);
  }
  bucketReady = true;
}
async function uploadToSupabase(st, name, type, buf) {
  await ensureBucket(st);
  const r = await fetch(`${st.url}/storage/v1/object/${BUCKET}/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${st.key}`, apikey: st.key, 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000' },
    body: buf, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Supabase Storage: falha no envio (${r.status}) ${body.slice(0, 200)}`);
  }
  return `${st.url}/storage/v1/object/public/${BUCKET}/${name}`;
}

router.post('/upload',
  express.raw({ type: () => true, limit: 3 * 1024 * 1024 }),
  wrap(async (req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) throw bad('Formato não suportado. Use JPG, PNG ou WEBP.');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw bad('Arquivo vazio');
    const real = sniff(buf);
    if (!real) throw bad('O arquivo não é uma imagem JPG, PNG ou WEBP válida');
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${IMAGE_TYPES[real]}`;
    const st = storageConfig();
    if (st) {
      let url;
      try { url = await uploadToSupabase(st, name, real, buf); }
      catch (e) { console.error('[upload]', e.message); throw new HttpError(502, 'Não foi possível salvar a imagem no Supabase Storage. Tente de novo.'); }
      return res.status(201).json({ url, bytes: buf.length });
    }
    if (process.env.VERCEL) throw new HttpError(503, 'Envio de imagens indisponível: configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY na Vercel (ou use um link https://).');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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
router.get('/ingredients', wrap(async (req, res) => {
  const rows = (await db.all(`SELECT i.*, (SELECT COUNT(*)::int FROM product_ingredients pi WHERE pi.ingredient_id = i.id) AS used_in
                              FROM ingredients i ORDER BY lower(i.name), i.id`)).map(ingredientRow);
  res.json({ ingredients: rows, low_count: rows.filter(r => r.low).length, units: UNITS });
}));

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
router.post('/ingredients', wrap(async (req, res) => {
  const b = req.body || {};
  const f = ingFields(b);
  const stock = num(b.stock_qty, 'Estoque inicial', { min: 0 });
  if (await db.get('SELECT 1 FROM ingredients WHERE lower(name) = lower($1)', [f.name])) throw bad('Já existe um ingrediente com esse nome');
  const row = await tx(async (t) => {
    const r = await t.get('INSERT INTO ingredients (name, unit, stock_qty, min_qty, cost_cents_per_unit, removable) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [f.name, f.unit, stock, f.min_qty, f.cost, f.removable]);
    if (stock > 0) await t.run("INSERT INTO stock_movements (ingredient_id, delta, reason, note) VALUES ($1, $2, 'ajuste', 'Estoque inicial')", [r.id, stock]);
    return r;
  });
  res.status(201).json(ingredientRow(row));
}));
router.put('/ingredients/:id', wrap(async (req, res) => {
  const iid = id(req.params.id);
  const cur = await db.get('SELECT * FROM ingredients WHERE id = $1', [iid]);
  if (!cur) throw notFound('Ingrediente não encontrado');
  const f = ingFields(req.body || {}, cur);
  if (await db.get('SELECT 1 FROM ingredients WHERE lower(name) = lower($1) AND id <> $2', [f.name, iid])) throw bad('Já existe um ingrediente com esse nome');
  res.json(ingredientRow(await db.get('UPDATE ingredients SET name = $1, unit = $2, min_qty = $3, cost_cents_per_unit = $4, removable = $5 WHERE id = $6 RETURNING *',
    [f.name, f.unit, f.min_qty, f.cost, f.removable, iid])));
}));
router.delete('/ingredients/:id', wrap(async (req, res) => {
  const r = await db.run('DELETE FROM ingredients WHERE id = $1', [id(req.params.id)]);
  if (!r.rowCount) throw notFound('Ingrediente não encontrado');
  res.json({ ok: true });
}));

// Movimentação manual: compra (entrada), ajuste (+/-, ou contagem absoluta) e perda (saída)
router.post('/stock/movements', wrap(async (req, res) => {
  const b = req.body || {};
  const iid = id(b.ingredient_id, 'Ingrediente');
  const ing = await db.get('SELECT * FROM ingredients WHERE id = $1', [iid]);
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
  const row = await tx(async (t) => {
    await t.run('INSERT INTO stock_movements (ingredient_id, delta, reason, note, cost_cents) VALUES ($1, $2, $3, $4, $5)',
      [iid, delta, type, note || null, totalCost || null]);
    let r = await t.get('UPDATE ingredients SET stock_qty = round((stock_qty + $1)::numeric, 3) WHERE id = $2 RETURNING *', [delta, iid]);
    if (updateCost) r = await t.get('UPDATE ingredients SET cost_cents_per_unit = $1 WHERE id = $2 RETURNING *', [Math.round(totalCost / delta), iid]);
    if (createExpense) {
      await t.run("INSERT INTO transactions (type, category, description, amount_cents, date) VALUES ('despesa', 'insumos', $1, $2, $3)",
        [`Compra: ${delta} ${ing.unit} de ${ing.name}${note ? ' (' + note + ')' : ''}`.slice(0, 200), totalCost, localDate(0)]);
    }
    return r;
  });
  res.status(201).json({ ok: true, ingredient: ingredientRow(row) });
}));

router.get('/stock/movements', wrap(async (req, res) => {
  const where = [];
  const args = [];
  if (req.query.ingredient_id) { args.push(id(req.query.ingredient_id, 'Ingrediente')); where.push(`m.ingredient_id = $${args.length}`); }
  if (req.query.reason) {
    if (!['pedido', 'compra', 'ajuste', 'perda', 'estorno'].includes(req.query.reason)) throw bad('Motivo inválido');
    args.push(req.query.reason); where.push(`m.reason = $${args.length}`);
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  args.push(limit);
  const rows = await db.all(`SELECT m.*, ${localTs('m.created_at')} AS created_local, i.name AS ingredient_name, i.unit, o.code AS order_code
                             FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id
                             LEFT JOIN orders o ON o.id = m.order_id
                             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                             ORDER BY m.id DESC LIMIT $${args.length}`, args);
  res.json(rows);
}));

// =====================================================================
// FINANCEIRO
// =====================================================================
const NOT_CANCELLED = "o.status <> 'cancelado'";
const LOCAL_DAY = `(o.created_at AT TIME ZONE ${TZ})::date`;
const IN_PERIOD = `${LOCAL_DAY} BETWEEN $1::date AND $2::date`;

async function revenueBetween(from, to) {
  const r = await db.get(`SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_cents), 0)::bigint AS revenue FROM orders o
                          WHERE ${NOT_CANCELLED} AND ${IN_PERIOD}`, [from, to]);
  return { orders: r.orders, revenue_cents: r.revenue, avg_ticket_cents: r.orders ? Math.round(r.revenue / r.orders) : 0 };
}

router.get('/finance/summary', wrap(async (req, res) => {
  const { from, to, days } = period(req.query);
  const P = [from, to];
  const today = localDate(0);
  const [base, costRow, tr, cancelledRow, dailyRows, byCategory, topProducts, hourRows, payments, expensesByCategory, qToday, qWeek, qMonth] = await Promise.all([
    revenueBetween(from, to),
    db.get(`SELECT COALESCE(SUM(oi.qty::bigint * COALESCE(p.cost_cents, 0)), 0)::bigint AS c
            FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.id = oi.product_id
            WHERE ${NOT_CANCELLED} AND ${IN_PERIOD}`, P),
    // Receitas lançadas automaticamente por pedido (order_id preenchido) já estão no faturamento: não somar de novo.
    db.all(`SELECT type, COALESCE(SUM(amount_cents), 0)::bigint AS s FROM transactions
            WHERE date BETWEEN $1::date AND $2::date AND (type = 'despesa' OR order_id IS NULL) GROUP BY type`, P),
    db.get(`SELECT COUNT(*)::int AS n FROM orders o WHERE o.status = 'cancelado' AND ${IN_PERIOD}`, P),
    db.all(`SELECT to_char(${LOCAL_DAY}, 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders, SUM(total_cents)::bigint AS revenue FROM orders o
            WHERE ${NOT_CANCELLED} AND ${IN_PERIOD} GROUP BY 1`, P),
    db.all(`SELECT COALESCE(c.name, 'Sem categoria') AS name, SUM(oi.qty)::bigint AS qty, SUM(oi.qty::bigint * oi.unit_price_cents)::bigint AS revenue_cents
            FROM order_items oi JOIN orders o ON o.id = oi.order_id
            LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.category_id
            WHERE ${NOT_CANCELLED} AND ${IN_PERIOD}
            GROUP BY 1 ORDER BY revenue_cents DESC, 1`, P),
    db.all(`SELECT oi.name, SUM(oi.qty)::bigint AS qty, SUM(oi.qty::bigint * oi.unit_price_cents)::bigint AS revenue_cents
            FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE ${NOT_CANCELLED} AND ${IN_PERIOD}
            GROUP BY oi.name ORDER BY qty DESC, revenue_cents DESC, oi.name LIMIT 10`, P),
    db.all(`SELECT extract(hour FROM o.created_at AT TIME ZONE ${TZ})::int AS h, COUNT(*)::int AS n FROM orders o
            WHERE ${NOT_CANCELLED} AND ${IN_PERIOD} GROUP BY 1`, P),
    db.all(`SELECT payment_method AS method, COUNT(*)::int AS orders, SUM(total_cents)::bigint AS revenue_cents FROM orders o
            WHERE ${NOT_CANCELLED} AND ${IN_PERIOD} GROUP BY payment_method ORDER BY orders DESC, method`, P),
    db.all(`SELECT COALESCE(NULLIF(category, ''), 'outros') AS category, SUM(amount_cents)::bigint AS amount_cents
            FROM transactions WHERE type = 'despesa' AND date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 2 DESC, 1`, P),
    revenueBetween(today, today),
    revenueBetween(localDate(-6), today),
    revenueBetween(today.slice(0, 8) + '01', today),
  ]);
  const cost = costRow.c;
  const expenses = tr.find(t => t.type === 'despesa')?.s || 0;
  const otherIncome = tr.find(t => t.type === 'receita')?.s || 0;
  const cancelled = cancelledRow.n;

  // Faturamento por dia (preenchendo dias sem venda)
  const dmap = Object.fromEntries(dailyRows.map(r => [r.day, r]));
  const daily = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(from + 'T00:00:00Z') + i * 86400e3).toISOString().slice(0, 10);
    daily.push({ day: d, orders: dmap[d]?.orders || 0, revenue_cents: dmap[d]?.revenue || 0 });
  }
  const byHour = Array.from({ length: 24 }, (_, h) => hourRows.find(r => r.h === h)?.n || 0);

  res.json({
    period: { from, to, days },
    quick: { today: qToday, week: qWeek, month: qMonth },
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
router.get('/transactions', wrap(async (req, res) => {
  const { from, to } = period(req.query);
  const args = [from, to];
  let extra = '';
  if (req.query.type) {
    if (!['receita', 'despesa'].includes(req.query.type)) throw bad('Tipo inválido');
    extra = ' AND t.type = $3'; args.push(req.query.type);
  }
  const rows = await db.all(`SELECT t.*, o.code AS order_code FROM transactions t LEFT JOIN orders o ON o.id = t.order_id
                             WHERE t.date BETWEEN $1::date AND $2::date${extra} ORDER BY t.date DESC, t.id DESC LIMIT 1000`, args);
  res.json({ transactions: rows, categories: TX_CATEGORIES });
}));
router.post('/transactions', wrap(async (req, res) => {
  const f = txFields(req.body || {});
  res.status(201).json(await db.get('INSERT INTO transactions (type, category, description, amount_cents, date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [f.type, f.category, f.description, f.amount, f.date]));
}));
router.put('/transactions/:id', wrap(async (req, res) => {
  const tid = id(req.params.id);
  const cur = await db.get('SELECT * FROM transactions WHERE id = $1', [tid]);
  if (!cur) throw notFound('Lançamento não encontrado');
  if (cur.order_id) throw bad('Lançamentos automáticos de pedidos não podem ser editados');
  const f = txFields(req.body || {}, cur);
  res.json(await db.get('UPDATE transactions SET type = $1, category = $2, description = $3, amount_cents = $4, date = $5 WHERE id = $6 RETURNING *',
    [f.type, f.category, f.description, f.amount, f.date, tid]));
}));
router.delete('/transactions/:id', wrap(async (req, res) => {
  const tid = id(req.params.id);
  const cur = await db.get('SELECT * FROM transactions WHERE id = $1', [tid]);
  if (!cur) throw notFound('Lançamento não encontrado');
  if (cur.order_id) throw bad('Lançamentos automáticos de pedidos não podem ser excluídos (cancele o pedido)');
  await db.run('DELETE FROM transactions WHERE id = $1', [tid]);
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
router.get('/export/orders.csv', wrap(async (req, res) => {
  const { from, to } = period(req.query);
  const orders = await db.all(`SELECT o.*, ${localTs('o.created_at')} AS created_local FROM orders o
                               WHERE ${IN_PERIOD} ORDER BY o.id`, [from, to]);
  const ids = orders.map(o => o.id);
  const [itemRows, invRows] = ids.length ? await Promise.all([
    db.all('SELECT order_id, qty, name FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id', [ids]),
    db.all(`SELECT DISTINCT ON (order_id) order_id, status, number FROM invoices WHERE order_id = ANY($1::int[]) ORDER BY order_id, id DESC`, [ids]),
  ]) : [[], []];
  const itemsBy = groupBy(itemRows, 'order_id');
  const invBy = Object.fromEntries(invRows.map(r => [r.order_id, r]));
  sendCsv(res, `pedidos_${from}_${to}.csv`,
    ['Código', 'Data/hora', 'Status', 'Cliente', 'Telefone', 'Tipo', 'Endereço', 'Pagamento', 'Itens', 'Subtotal (R$)', 'Entrega (R$)', 'Total (R$)', 'Nota fiscal'],
    orders.map(o => {
      const its = (itemsBy[o.id] || []).map(i => `${i.qty}x ${i.name}`).join(' | ');
      const n = invBy[o.id];
      return [o.code, o.created_local, o.status, o.customer_name, o.customer_phone, o.delivery_type, o.address || '', o.payment_method, its,
        brl(o.subtotal_cents), brl(o.delivery_fee_cents), brl(o.total_cents), n ? `${n.status}${n.number ? ' nº ' + n.number : ''}` : ''];
    }));
}));
router.get('/export/transactions.csv', wrap(async (req, res) => {
  const { from, to } = period(req.query);
  const rows = await db.all('SELECT * FROM transactions WHERE date BETWEEN $1::date AND $2::date ORDER BY date, id', [from, to]);
  sendCsv(res, `lancamentos_${from}_${to}.csv`, ['Data', 'Tipo', 'Categoria', 'Descrição', 'Valor (R$)', 'Pedido'],
    rows.map(t => [t.date, t.type, t.category || '', t.description || '', brl(t.amount_cents), t.order_id || '']));
}));

// =====================================================================
// PEDIDOS
// =====================================================================
const STATUSES = ['recebido', 'preparo', 'saiu', 'entregue', 'cancelado'];

// Carrega itens, última nota e histórico de vários pedidos de uma vez (3 consultas, não 3 por pedido).
// Notas "processando" (emissor real) são consultadas no emissor no máximo a cada 20 s (refresh na leitura).
async function ordersFull(orders, { fullCpf = false } = {}) {
  if (!orders.length) return [];
  const ids = orders.map(o => o.id);
  const [itemRows, invRows, logRows] = await Promise.all([
    db.all('SELECT * FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id', [ids]),
    db.all('SELECT DISTINCT ON (order_id) * FROM invoices WHERE order_id = ANY($1::int[]) ORDER BY order_id, id DESC', [ids]),
    db.all(`SELECT order_id, status, ${localTs('at')} AS at_local FROM order_status_log WHERE order_id = ANY($1::int[]) ORDER BY id`, [ids]),
  ]);
  const itemsBy = groupBy(itemRows, 'order_id');
  const logBy = groupBy(logRows, 'order_id');
  const invBy = Object.fromEntries(invRows.map(r => [r.order_id, r]));
  const pending = invRows.filter(i => i.status === 'processando' && i.provider !== 'mock').slice(0, 5);
  if (pending.length) {
    const fresh = await Promise.all(pending.map(i => nfe.refreshIfStale(i)));
    for (const f of fresh) if (f) invBy[f.order_id] = f;
  }
  return orders.map(o => ({
    timeline: (logBy[o.id] || []).map(l => ({ status: l.status, at_local: l.at_local })),
    ...o,
    customer_cpf: fullCpf ? o.customer_cpf : maskCpf(o.customer_cpf),
    created_local: o.created_local,
    items: (itemsBy[o.id] || []).map(i => ({ ...i, removed: parseJson(i.removed, []), addons: parseJson(i.addons, []) })),
    invoice: invBy[o.id] || null,
    map_url: (o.lat != null && o.lng != null) ? `https://www.google.com/maps?q=${o.lat},${o.lng}` : (o.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}` : null),
  }));
}

router.get('/orders', wrap(async (req, res) => {
  const where = [];
  const args = [];
  const arg = (v) => { args.push(v); return `$${args.length}`; };
  if (req.query.status) {
    if (req.query.status === 'abertos') where.push("o.status IN ('recebido', 'preparo', 'saiu')");
    else { if (!STATUSES.includes(req.query.status)) throw bad('Status inválido'); where.push(`o.status = ${arg(req.query.status)}`); }
  }
  if (req.query.q) {
    const q = str(req.query.q, 'Busca', { max: 60 }).replace(/[\\%_]/g, c => '\\' + c);
    where.push(`(o.code ILIKE ${arg(`%${q}%`)} OR o.customer_name ILIKE ${arg(`%${q}%`)} OR o.customer_phone ILIKE ${arg(`%${q.replace(/\D/g, '') || q}%`)})`);
  }
  if (req.query.date) where.push(`${LOCAL_DAY} = ${arg(date(req.query.date, 'Data'))}::date`);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const lim = arg(limit);
  const [rows, countRows, latestRow] = await Promise.all([
    db.all(`SELECT o.*, ${localTs('o.created_at')} AS created_local FROM orders o
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC, o.id DESC LIMIT ${lim}`, args),
    db.all(`SELECT status, COUNT(*)::int AS n FROM orders o WHERE ${LOCAL_DAY} = $1::date GROUP BY status`, [localDate(0)]),
    db.get('SELECT COALESCE(MAX(id), 0) AS m FROM orders'),
  ]);
  const counts = Object.fromEntries(countRows.map(r => [r.status, r.n]));
  res.json({ orders: await ordersFull(rows), today_counts: counts, latest_id: latestRow.m, statuses: STATUSES });
}));

router.get('/orders/:id', wrap(async (req, res) => {
  const o = await db.get(`SELECT o.*, ${localTs('o.created_at')} AS created_local FROM orders o WHERE o.id = $1`, [id(req.params.id)]);
  if (!o) throw notFound('Pedido não encontrado');
  res.json((await ordersFull([o], { fullCpf: true }))[0]);
}));

router.put('/orders/:id/status', wrap(async (req, res) => {
  const oid = id(req.params.id);
  const status = (req.body || {}).status;
  if (!STATUSES.includes(status)) throw bad('Status inválido');
  await tx(async (t) => {
    // FOR UPDATE: duas mudanças ao mesmo tempo não estornam o estoque duas vezes
    const o = await t.get('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [oid]);
    if (!o) throw notFound('Pedido não encontrado');
    if (o.status === 'cancelado' && status !== 'cancelado') throw bad('Pedido cancelado não pode ser reaberto');
    await t.run('UPDATE orders SET status = $1 WHERE id = $2', [status, oid]);
    // Cancelamento devolve ao estoque o que o pedido baixou (uma única vez)
    if (status === 'cancelado' && o.status !== 'cancelado') {
      const already = await t.get("SELECT 1 FROM stock_movements WHERE order_id = $1 AND reason = 'estorno' LIMIT 1", [oid]);
      if (!already) {
        const moves = await t.all("SELECT ingredient_id, SUM(delta) AS d FROM stock_movements WHERE order_id = $1 AND reason = 'pedido' GROUP BY ingredient_id ORDER BY ingredient_id", [oid]);
        for (const m of moves) {
          if (!m.d) continue;
          await t.run("INSERT INTO stock_movements (ingredient_id, delta, reason, order_id, note) VALUES ($1, $2, 'estorno', $3, 'Pedido cancelado')", [m.ingredient_id, -m.d, oid]);
          await t.run('UPDATE ingredients SET stock_qty = round((stock_qty - $1)::numeric, 3) WHERE id = $2', [m.d, m.ingredient_id]);
        }
      }
    }
  });
  res.json({ ok: true, status });
}));

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================
router.get('/settings', wrap(async (req, res) => {
  const [store, delivery] = await Promise.all([
    getSetting('store', {}),
    getSetting('delivery', { fee_cents: 0, min_order_cents: 0, eta_min: 30, eta_max: 50 }),
  ]);
  res.json({
    store,
    delivery,
    dev: !IS_PROD,
    admin: req.admin,
  });
}));

router.put('/settings/store', wrap(async (req, res) => {
  const b = req.body || {};
  const cur = (await getSetting('store', {})) || {};
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
  await setSetting('store', next);
  res.json(next);
}));

// Atalho para abrir/fechar a loja sem mexer no resto
router.put('/settings/store/open', wrap(async (req, res) => {
  const cur = (await getSetting('store', {})) || {};
  cur.open = !!bool((req.body || {}).open);
  await setSetting('store', cur);
  res.json({ open: cur.open });
}));

function minutes(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 600) throw bad(`${label}: informe minutos (0 a 600)`);
  return n;
}
router.put('/settings/delivery', wrap(async (req, res) => {
  const b = req.body || {};
  const cur = (await getSetting('delivery', {})) || {};
  const next = {
    ...cur,
    fee_cents: cents(b.fee_cents, 'Taxa de entrega', { max: 100000 }),
    min_order_cents: cents(b.min_order_cents, 'Pedido mínimo', { max: 1000000 }),
    eta_min: minutes(b.eta_min, 'Tempo mínimo'),
    eta_max: minutes(b.eta_max, 'Tempo máximo'),
  };
  if (next.eta_max < next.eta_min) throw bad('O tempo máximo deve ser maior ou igual ao mínimo');
  await setSetting('delivery', next);
  res.json(next);
}));

// ----- Nota fiscal (settings 'nfe'; lida pelo módulo de pagamento) -----
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const NFE_DEFAULT = { uf: 'SP', mode: 'mock', provider: 'focusnfe', token: '', cnpj: '', inscricao_estadual: '', regime_tributario: 1, csc_id: '', csc_token: '', auto_emit: true, auto_retry: true };
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
router.get('/nfe-settings', wrap(async (req, res) => res.json(publicNfe((await getSetting('nfe', {})) || {}))));
router.put('/nfe-settings', wrap(async (req, res) => {
  const b = req.body || {};
  const cur = { ...NFE_DEFAULT, ...((await getSetting('nfe', {})) || {}) };
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
    // reenvio automático de notas com erro (usado pela automação: nfe.refreshPending)
    auto_retry: has(b, 'auto_retry') ? !!bool(b.auto_retry) : cur.auto_retry !== false,
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
  await setSetting('nfe', next);
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
router.get('/pix-settings', wrap(async (req, res) => res.json({ key: '', merchant_name: '', city: '', ...((await getSetting('pix', {})) || {}) })));
router.put('/pix-settings', wrap(async (req, res) => {
  const b = req.body || {};
  const next = {
    ...((await getSetting('pix', {})) || {}),
    key: normalizePixKey(b.key),
    merchant_name: str(b.merchant_name, 'Nome do recebedor', { max: 25 }),
    city: str(b.city, 'Cidade', { max: 15 }),
  };
  if (next.key && (!next.merchant_name || !next.city)) throw bad('Informe também o nome do recebedor e a cidade');
  await setSetting('pix', next);
  res.json(next);
}));

// =====================================================================
// DESENVOLVIMENTO: pedidos de exemplo para ver os gráficos
// =====================================================================
router.post('/dev/sample-orders', wrap(async (req, res) => {
  if (IS_PROD) throw new HttpError(403, 'Indisponível em produção');
  const count = Math.min(Math.max(parseInt((req.body || {}).count, 10) || 60, 1), 300);
  const products = await db.all('SELECT * FROM products WHERE active = 1 ORDER BY id');
  if (!products.length) throw bad('Cadastre produtos antes de gerar pedidos de exemplo');
  const addons = await db.all('SELECT * FROM addons WHERE active = 1 ORDER BY id');
  const recipeBy = groupBy(await db.all(`SELECT pi.product_id, pi.ingredient_id, i.name FROM product_ingredients pi
                                          JOIN ingredients i ON i.id = pi.ingredient_id WHERE i.removable = 1`), 'product_id');
  const fee = ((await getSetting('delivery', {})) || {}).fee_cents || 0;
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
  const usedCodes = new Set((await db.all('SELECT code FROM orders')).map(r => r.code));
  const code = () => { const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; let c; do { c = 'GB-' + Array.from({ length: 5 }, () => A[rnd(A.length)]).join(''); } while (usedCodes.has(c)); usedCodes.add(c); return c; };
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
  await tx(async (t) => {
    for (const { daysAgo, utc } of when) {
      const createdAt = utc.toISOString(); // com "Z": o Postgres grava em UTC, qualquer que seja o fuso da sessão
      const delivery = Math.random() < 0.75;
      const items = [];
      const nItems = 1 + rnd(3);
      for (let j = 0; j < nItems; j++) {
        const p = products[rnd(products.length)];
        const ad = addons.filter(a => (a.product_id === p.id || a.product_id == null) && Math.random() < 0.25).slice(0, 2);
        const rem = (recipeBy[p.id] || []).filter(() => Math.random() < 0.12).map(r => r.name);
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
      const { id: oid } = await t.get(`INSERT INTO orders (code, customer_name, customer_cpf, customer_phone, address, address_ref, lat, lng, delivery_type, payment_method,
                           change_for_cents, notes, subtotal_cents, delivery_fee_cents, total_cents, status, created_at)
                           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
        [oc, names[rnd(names.length)], cpf(), `119${String(10000000 + rnd(89999999))}`,
          delivery ? `${streets[rnd(streets.length)]}, ${10 + rnd(990)} - Centro` : null, delivery && Math.random() < 0.3 ? 'Portão azul' : null,
          lat, lng, delivery ? 'delivery' : 'retirada', pay,
          pay === 'dinheiro' ? Math.ceil(total / 5000) * 5000 : null, '[exemplo]', subtotal, dfee, total, status, createdAt]);
      const iv = [];
      const ip = [];
      for (const it of items) {
        const row = [oid, it.p.id, it.p.name, it.qty, it.unit, JSON.stringify(it.rem), JSON.stringify(it.ad.map(a => ({ id: a.id, name: a.name, price_cents: a.price_cents }))), null];
        iv.push('(' + row.map(v => { ip.push(v); return '$' + ip.length; }).join(', ') + ')');
      }
      await t.run(`INSERT INTO order_items (order_id, product_id, name, qty, unit_price_cents, removed, addons, notes) VALUES ${iv.join(', ')}`, ip);
      const invStatus = status === 'cancelado' ? 'cancelada' : (recent && Math.random() < 0.3 ? 'processando' : 'autorizada');
      await t.run(`INSERT INTO invoices (order_id, provider, ref, status, number, series, access_key, message, danfe_url, created_at, updated_at)
                   VALUES ($1, 'mock', $2, $3, $4, '1', $5, $6, $7, $8, $8)`,
        [oid, `EX-${oid}`, invStatus, invStatus === 'processando' ? null : String(1000 + oid),
          invStatus === 'processando' ? null : Array.from({ length: 44 }, () => rnd(10)).join(''), 'Nota de exemplo (simulada)',
          invStatus === 'autorizada' ? `/api/orders/${oc}/danfe` : null, createdAt]);
      created++;
    }
    // algumas despesas típicas no período
    // despesas proporcionais ao faturamento de exemplo, para o lucro fazer sentido
    const exp = [['aluguel', 'Aluguel do ponto', 0.12, 25], ['embalagens', 'Caixas e sacos kraft', 0.04, 18], ['motoboy', 'Diárias motoboy (semana)', 0.05, 14],
      ['motoboy', 'Diárias motoboy (semana)', 0.05, 7], ['energia', 'Conta de luz', 0.03, 10], ['insumos', 'Carne e pães (atacado)', 0.06, 3]];
    for (const [c, d, f, ago] of exp) {
      await t.run("INSERT INTO transactions (type, category, description, amount_cents, date) VALUES ('despesa', $1, $2, $3, $4)",
        [c, `${d} [exemplo]`, Math.max(100, Math.round(sampleRevenue * f / 100) * 100), localDate(-ago)]);
    }
  });
  res.status(201).json({ ok: true, created });
}));

router.delete('/dev/sample-orders', wrap(async (req, res) => {
  if (IS_PROD) throw new HttpError(403, 'Indisponível em produção');
  const r = await tx(async (t) => {
    const o = await t.run("DELETE FROM orders WHERE notes = '[exemplo]'");
    await t.run("DELETE FROM transactions WHERE description LIKE '%[exemplo]'");
    return o.rowCount;
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
