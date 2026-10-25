// Popula o banco na primeira execução a partir de server/menu-source.json
// (cardápio copiado do InstaDelivery da Garage Burger).
const fs = require('node:fs');
const path = require('node:path');
const { db, setSetting, tx } = require('./db');

const SOURCE = path.join(__dirname, 'menu-source.json');

function toCents(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v * 100);
  const n = parseFloat(String(v).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) return;
  if (!fs.existsSync(SOURCE)) return;
  const src = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));

  tx(() => {
    setSetting('store', src.store || {});
    setSetting('delivery', src.delivery || { fee_cents: 500, min_order_cents: 0, eta_min: 30, eta_max: 50 });

    const insCat = db.prepare('INSERT INTO categories (name, position) VALUES (?, ?)');
    const insProd = db.prepare(`INSERT INTO products (category_id, name, description, price_cents, original_price_cents, cost_cents, image, position, featured)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const getIng = db.prepare('SELECT id FROM ingredients WHERE name = ?');
    const insIng = db.prepare('INSERT INTO ingredients (name, unit, stock_qty, min_qty, cost_cents_per_unit, removable) VALUES (?, ?, ?, ?, ?, ?)');
    const link = db.prepare('INSERT OR IGNORE INTO product_ingredients (product_id, ingredient_id, qty) VALUES (?, ?, ?)');
    const insAddon = db.prepare('INSERT INTO addons (product_id, name, price_cents) VALUES (?, ?, ?)');

    (src.categories || []).forEach((c, ci) => {
      const catId = insCat.run(c.name, ci).lastInsertRowid;
      (c.items || []).forEach((it, pi) => {
        const price = toCents(it.price) ?? 0;
        const orig = toCents(it.original_price);
        const prodId = insProd.run(catId, it.name, it.description || '', price,
          orig && orig > price ? orig : null, Math.round(price * 0.38), it.image || null, pi, it.featured ? 1 : 0).lastInsertRowid;
        for (const ingName of it.ingredients || []) {
          const name = ingName.trim();
          if (!name) continue;
          let row = getIng.get(name);
          const removable = (it.fixed || []).includes(name) ? 0 : 1;
          if (!row) row = { id: insIng.run(name, 'un', 100, 15, 150, removable).lastInsertRowid };
          link.run(prodId, row.id, 1);
        }
        for (const a of it.addons || []) insAddon.run(prodId, a.name, toCents(a.price) ?? 0);
      });
    });
    for (const a of src.global_addons || []) insAddon.run(null, a.name, toCents(a.price) ?? 0);
  });
  console.log('[seed] Cardápio importado de menu-source.json');
}

module.exports = { seedIfEmpty, toCents };
