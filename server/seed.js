// Popula o banco na primeira execução a partir de server/menu-source.json
// (cardápio copiado do InstaDelivery da Garage Burger).
// Insere em lote (poucos comandos) dentro de uma transação com trava, para ser rápido no Supabase
// e não duplicar o cardápio se duas instâncias da Vercel subirem ao mesmo tempo.
const fs = require('node:fs');
const path = require('node:path');
const { db, setSetting, tx } = require('./db');

const SOURCE = path.join(__dirname, 'menu-source.json');
const SEED_LOCK = 797979; // id da trava (pg_advisory_xact_lock)

function toCents(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v * 100);
  const n = parseFloat(String(v).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// INSERT de várias linhas: rows = [[a, b, c], ...] -> "($1,$2,$3),($4,$5,$6)" + params
function values(rows) {
  const params = [];
  const sql = rows.map(r => '(' + r.map(v => { params.push(v); return '$' + params.length; }).join(', ') + ')').join(', ');
  return { sql, params };
}

async function insertMany(t, head, rows, tail = '') {
  if (!rows.length) return [];
  const out = [];
  for (let i = 0; i < rows.length; i += 500) { // limite de parâmetros do Postgres
    const v = values(rows.slice(i, i + 500));
    out.push(...await t.all(`${head} VALUES ${v.sql} ${tail}`, v.params));
  }
  return out;
}

async function seedIfEmpty() {
  const { n } = await db.get('SELECT COUNT(*)::int AS n FROM products');
  if (n > 0) return false;
  if (!fs.existsSync(SOURCE)) return false;
  const src = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));

  const done = await tx(async (t) => {
    await t.get('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK]);
    if ((await t.get('SELECT COUNT(*)::int AS n FROM products')).n > 0) return false; // outra instância já importou

    if (!(await t.get("SELECT 1 FROM settings WHERE key = 'store'"))) await setSetting('store', src.store || {}, t);
    if (!(await t.get("SELECT 1 FROM settings WHERE key = 'delivery'"))) {
      await setSetting('delivery', src.delivery || { fee_cents: 500, min_order_cents: 0, eta_min: 30, eta_max: 50 }, t);
    }

    const cats = src.categories || [];
    const catRows = await insertMany(t, 'INSERT INTO categories (name, position)', cats.map((c, ci) => [c.name, ci]), 'RETURNING id, position');
    const catId = Object.fromEntries(catRows.map(r => [r.position, r.id]));

    // Ingredientes (nome único; "fixo" = não removível se algum produto o marcar como fixo)
    const ingInfo = new Map();
    for (const c of cats) for (const it of c.items || []) for (const raw of it.ingredients || []) {
      const name = raw.trim();
      if (!name || ingInfo.has(name)) continue;
      ingInfo.set(name, (it.fixed || []).includes(name) ? 0 : 1);
    }
    const ingRows = await insertMany(t, 'INSERT INTO ingredients (name, unit, stock_qty, min_qty, cost_cents_per_unit, removable)',
      [...ingInfo].map(([name, removable]) => [name, 'un', 100, 15, 150, removable]),
      'ON CONFLICT (name) DO NOTHING RETURNING id, name');
    const ingId = Object.fromEntries(ingRows.map(r => [r.name, r.id]));
    for (const r of await t.all('SELECT id, name FROM ingredients')) ingId[r.name] ??= r.id;

    // Produtos: guardamos a chave (categoria, posição) para ligar receitas e adicionais
    const prodRows = [];
    const prodKeys = [];
    cats.forEach((c, ci) => (c.items || []).forEach((it, pi) => {
      const price = toCents(it.price) ?? 0;
      const orig = toCents(it.original_price);
      prodRows.push([catId[ci], it.name, it.description || '', price, orig && orig > price ? orig : null,
        Math.round(price * 0.38), it.image || null, pi, it.featured ? 1 : 0]);
      prodKeys.push({ key: `${catId[ci]}:${pi}`, it });
    }));
    const insertedProds = await insertMany(t,
      'INSERT INTO products (category_id, name, description, price_cents, original_price_cents, cost_cents, image, position, featured)',
      prodRows, 'RETURNING id, category_id, position');
    const prodId = Object.fromEntries(insertedProds.map(r => [`${r.category_id}:${r.position}`, r.id]));

    const links = [];
    const addons = [];
    for (const { key, it } of prodKeys) {
      const pid = prodId[key];
      const seen = new Set();
      for (const raw of it.ingredients || []) {
        const iid = ingId[raw.trim()];
        if (!iid || seen.has(iid)) continue;
        seen.add(iid);
        links.push([pid, iid, 1, links.length]);
      }
      for (const a of it.addons || []) addons.push([pid, a.name, toCents(a.price) ?? 0]);
    }
    for (const a of src.global_addons || []) addons.push([null, a.name, toCents(a.price) ?? 0]);
    await insertMany(t, 'INSERT INTO product_ingredients (product_id, ingredient_id, qty, position)', links, 'ON CONFLICT DO NOTHING');
    await insertMany(t, 'INSERT INTO addons (product_id, name, price_cents)', addons);
    return true;
  });
  if (done) console.log('[seed] Cardápio importado de menu-source.json');
  return done;
}

module.exports = { seedIfEmpty, toCents };
