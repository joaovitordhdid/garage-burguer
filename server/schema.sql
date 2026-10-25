-- Garage Burger: esquema Postgres (Supabase). Idempotente: pode rodar várias vezes.
-- Valores em centavos (*_cents). Datas em timestamptz (UTC); a API devolve 'YYYY-MM-DD HH:MM:SS' em UTC.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price_cents INTEGER NOT NULL,
  original_price_cents INTEGER,
  cost_cents INTEGER DEFAULT 0,
  image TEXT,
  active INTEGER DEFAULT 1,
  featured INTEGER DEFAULT 0,
  position INTEGER DEFAULT 0,
  ncm TEXT DEFAULT '21069090',
  cfop TEXT DEFAULT '5102'
);

CREATE TABLE IF NOT EXISTS ingredients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  unit TEXT DEFAULT 'un',
  stock_qty DOUBLE PRECISION DEFAULT 0,
  min_qty DOUBLE PRECISION DEFAULT 0,
  cost_cents_per_unit INTEGER DEFAULT 0,
  removable INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_ingredients (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty DOUBLE PRECISION DEFAULT 1,
  PRIMARY KEY (product_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS addons (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  customer_cpf TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  address TEXT,
  address_ref TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  delivery_type TEXT DEFAULT 'delivery',
  payment_method TEXT NOT NULL,
  change_for_cents INTEGER,
  notes TEXT,
  subtotal_cents INTEGER NOT NULL,
  delivery_fee_cents INTEGER DEFAULT 0,
  total_cents INTEGER NOT NULL,
  status TEXT DEFAULT 'recebido',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  removed TEXT,
  addons TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT,
  ref TEXT,
  status TEXT,
  number TEXT,
  series TEXT,
  access_key TEXT,
  danfe_url TEXT,
  xml_url TEXT,
  qrcode_url TEXT,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  category TEXT,
  description TEXT,
  amount_cents INTEGER NOT NULL,
  date DATE DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date),
  order_id INTEGER
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  delta DOUBLE PRECISION NOT NULL,
  reason TEXT,
  order_id INTEGER,
  note TEXT,
  cost_cents INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Histórico de status: um gatilho registra cada mudança, venha de onde vier.
CREATE TABLE IF NOT EXISTS order_status_log (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_status_log_order ON order_status_log(order_id);

CREATE OR REPLACE FUNCTION gb_log_order_status() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_status_log (order_id, status) VALUES (NEW.id, NEW.status);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_status_log ON orders;
CREATE TRIGGER trg_order_status_log AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION gb_log_order_status();

-- O site acessa o banco só pelo servidor (conexão direta). Bloqueia a API pública do Supabase.
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_log ENABLE ROW LEVEL SECURITY;
