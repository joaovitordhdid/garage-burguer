// Banco SQLite (node:sqlite, sem dependências nativas).
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'garage.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price_cents INTEGER NOT NULL,
  original_price_cents INTEGER,          -- preço "de" (promoção), opcional
  cost_cents INTEGER DEFAULT 0,          -- custo estimado, usado no financeiro
  image TEXT,                            -- caminho em /images/... ou URL
  active INTEGER DEFAULT 1,
  featured INTEGER DEFAULT 0,
  position INTEGER DEFAULT 0,
  ncm TEXT DEFAULT '21069090',           -- dados fiscais para NFC-e
  cfop TEXT DEFAULT '5102'
);

-- Ingredientes = itens de estoque
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  unit TEXT DEFAULT 'un',                -- un, g, kg, ml, L
  stock_qty REAL DEFAULT 0,
  min_qty REAL DEFAULT 0,                -- alerta de estoque baixo
  cost_cents_per_unit INTEGER DEFAULT 0,
  removable INTEGER DEFAULT 1            -- cliente pode pedir "sem"
);

-- Receita: quanto de cada ingrediente um produto consome
CREATE TABLE IF NOT EXISTS product_ingredients (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty REAL DEFAULT 1,
  PRIMARY KEY (product_id, ingredient_id)
);

-- Adicionais pagos (bacon extra, cheddar...)
CREATE TABLE IF NOT EXISTS addons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,  -- NULL = vale para todos
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,             -- código curto público, ex: GB-7F3K
  customer_name TEXT NOT NULL,
  customer_cpf TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  address TEXT,
  address_ref TEXT,
  lat REAL,
  lng REAL,
  delivery_type TEXT DEFAULT 'delivery', -- delivery | retirada
  payment_method TEXT NOT NULL,          -- pix | cartao | dinheiro
  change_for_cents INTEGER,
  notes TEXT,
  subtotal_cents INTEGER NOT NULL,
  delivery_fee_cents INTEGER DEFAULT 0,
  total_cents INTEGER NOT NULL,
  status TEXT DEFAULT 'recebido',        -- recebido | preparo | saiu | entregue | cancelado
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  removed TEXT,                          -- JSON: nomes de ingredientes removidos
  addons TEXT,                           -- JSON: [{name, price_cents}]
  notes TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT,                         -- mock | focusnfe
  ref TEXT,
  status TEXT,                           -- processando | autorizada | erro | cancelada
  number TEXT,
  series TEXT,
  access_key TEXT,
  danfe_url TEXT,
  xml_url TEXT,
  qrcode_url TEXT,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Lançamentos financeiros manuais (despesas, outras receitas)
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                    -- receita | despesa
  category TEXT,
  description TEXT,
  amount_cents INTEGER NOT NULL,
  date TEXT DEFAULT (date('now')),
  order_id INTEGER
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  delta REAL NOT NULL,
  reason TEXT,                           -- pedido | compra | ajuste | perda
  order_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// Transação simples
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, getSetting, setSetting, tx, DATA_DIR };
