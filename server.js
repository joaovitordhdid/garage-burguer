// Garage Burger: servidor principal.
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { db, getSetting } = require('./server/db');
const auth = require('./server/auth');
const { seedIfEmpty } = require('./server/seed');

seedIfEmpty();
auth.ensureAdmin();

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://nominatim.openstreetmap.org'],
      frameSrc: ["'self'", 'https://www.openstreetmap.org'],
    },
  },
}));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ---------- API pública ----------

// Cardápio completo (só itens ativos)
app.get('/api/menu', (req, res) => {
  res.json(buildMenu({ includeInactive: false }));
});

function buildMenu({ includeInactive }) {
  const act = includeInactive ? '' : 'WHERE active = 1';
  const categories = db.prepare(`SELECT * FROM categories ${act} ORDER BY position, id`).all();
  const products = db.prepare(`SELECT * FROM products ${act} ORDER BY position, id`).all();
  const recipe = db.prepare(`SELECT pi.product_id, pi.qty, i.id, i.name, i.removable, i.stock_qty
                             FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id`).all();
  const addons = db.prepare(`SELECT * FROM addons WHERE active = 1 ORDER BY id`).all();
  const byProduct = {};
  for (const r of recipe) (byProduct[r.product_id] ||= []).push({ id: r.id, name: r.name, removable: !!r.removable, out_of_stock: r.stock_qty <= 0 });
  return {
    store: getSetting('store', {}),
    delivery: getSetting('delivery', { fee_cents: 0, min_order_cents: 0, eta_min: 30, eta_max: 50 }),
    categories: categories.map(c => ({
      ...c,
      products: products.filter(p => p.category_id === c.id).map(p => ({
        id: p.id, name: p.name, description: p.description,
        price_cents: p.price_cents, original_price_cents: p.original_price_cents,
        image: p.image, featured: !!p.featured, active: !!p.active,
        ingredients: byProduct[p.id] || [],
        addons: addons.filter(a => a.product_id === p.id || a.product_id === null)
                      .map(a => ({ id: a.id, name: a.name, price_cents: a.price_cents })),
      })),
    })),
  };
}
app.locals.buildMenu = buildMenu;

// ---------- Auth do painel ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente de novo em 15 minutos.' } });

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const s = auth.login(req.body.email, req.body.password);
  if (!s) return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  res.cookie(auth.COOKIE, s.token, auth.cookieOptions(s.expires));
  res.json({ ok: true, admin: s.admin });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.cookies[auth.COOKIE]) auth.logout(req.cookies[auth.COOKIE]);
  res.clearCookie(auth.COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', auth.requireAdmin, (req, res) => res.json({ admin: req.admin }));

app.post('/api/auth/password', auth.requireAdmin, (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 8) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 8 caracteres' });
  if (!auth.changePassword(req.admin.id, current, next)) return res.status(400).json({ error: 'Senha atual incorreta' });
  res.clearCookie(auth.COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ---------- Rotas dos módulos ----------
app.use('/api/orders', require('./server/routes/orders'));             // checkout + nota fiscal (público)
app.use('/api/admin', auth.requireAdmin, require('./server/routes/admin')); // painel do dono (protegido)

// ---------- Arquivos estáticos ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Erro interno' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Garage Burger rodando em http://localhost:${PORT}`));
}
module.exports = app;
