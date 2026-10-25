// Checkout, acompanhamento do pedido, Pix e nota fiscal (NFC-e). Montado em /api/orders (público).
'use strict';
const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, getSetting, tx } = require('../db');
const { requireAdmin } = require('../auth');
const nfe = require('../nfe');
const { renderDanfe, maskCpf } = require('../nfe/danfe');
const { buildPayload } = require('../nfe/pix');
const { toSvg } = require('../nfe/qr');

const router = express.Router();

// ---------- Esquema extra (idempotente) ----------
// Histórico de status: um gatilho registra cada mudança, venha ela do painel ou de onde for.
db.exec(`
CREATE TABLE IF NOT EXISTS order_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_log_order ON order_status_log(order_id);
CREATE TRIGGER IF NOT EXISTS trg_order_status_log AFTER UPDATE OF status ON orders
WHEN NEW.status IS NOT OLD.status
BEGIN
  INSERT INTO order_status_log (order_id, status) VALUES (NEW.id, NEW.status);
END;
`);

// ---------- Validações ----------
function onlyDigits(s) { return String(s ?? '').replace(/\D/g, ''); }

function isValidCpf(value) {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = len => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function normalizePhone(value) {
  let d = onlyDigits(value);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return null;
  if (Number(d.slice(0, 2)) < 11) return null;            // DDD inválido
  if (d.length === 11 && d[2] !== '9') return null;        // celular começa com 9
  return d;
}

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

class HttpError extends Error {
  constructor(status, message, field) { super(message); this.status = status; this.field = field; this.expose = true; }
}
const bad = (msg, field) => { throw new HttpError(400, msg, field); };

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // sem 0/O/1/I/L
const CODE_RE = /^GB-[2-9A-HJKMNP-Z]{5}$/;
function newCode() {
  for (;;) {
    let c = 'GB-';
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM orders WHERE code = ?').get(c)) return c;
  }
}

function deliveryConfig() {
  const d = getSetting('delivery', {}) || {};
  return {
    fee_cents: Math.max(0, parseInt(d.fee_cents, 10) || 0),
    min_order_cents: Math.max(0, parseInt(d.min_order_cents, 10) || 0),
    eta_min: parseInt(d.eta_min, 10) || 30,
    eta_max: parseInt(d.eta_max, 10) || 50,
  };
}
function storeInfo() {
  const s = getSetting('store', {}) || {};
  return { name: s.name || 'Garage Burger', open: s.open !== false && s.open !== 'false', whatsapp: s.whatsapp || '', phone: s.phone || '', address: s.address || '' };
}
function pixConfig() {
  const p = getSetting('pix', null);
  return p && p.key ? p : null;
}

// ---------- Rate limits ----------
const createLimiter = rateLimit({
  windowMs: 10 * 60e3, limit: Number(process.env.ORDER_RATE_LIMIT) || 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitos pedidos em pouco tempo. Aguarde alguns minutos e tente de novo.' },
});
const readLimiter = rateLimit({
  windowMs: 60e3, limit: 90, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas consultas. Aguarde um minuto.' },
});

// ---------- GET /config (público, sem segredos) ----------
router.get('/config', (req, res) => {
  res.json({
    delivery: deliveryConfig(),
    store: storeInfo(),
    payment: { pix: !!pixConfig(), cartao: true, dinheiro: true },
  });
});

// ---------- POST / : criar pedido ----------
router.post('/', createLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const store = storeInfo();
    if (!store.open) bad('A loja está fechada agora. Volte no horário de funcionamento!');

    // Cliente
    const c = b.customer || {};
    const name = str(c.name, 80);
    if (name.length < 5 || name.split(' ').filter(w => w.length >= 2).length < 2) bad('Informe seu nome completo (nome e sobrenome).', 'name');
    const cpf = onlyDigits(c.cpf);
    if (!isValidCpf(cpf)) bad('CPF inválido. Confira os números.', 'cpf');
    const phone = normalizePhone(c.phone);
    if (!phone) bad('Telefone/WhatsApp inválido. Use DDD + número.', 'phone');

    // Entrega
    const deliveryType = b.delivery_type === 'retirada' ? 'retirada' : b.delivery_type === 'delivery' ? 'delivery' : null;
    if (!deliveryType) bad('Escolha entrega ou retirada no balcão.', 'delivery_type');
    let address = null, addressRef = null, lat = null, lng = null;
    if (deliveryType === 'delivery') {
      lat = Number(b.lat); lng = Number(b.lng);
      if (b.lat == null || b.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
        bad('Precisamos da sua localização atual para a entrega. Toque em "Usar minha localização atual".', 'location');
      }
      address = str(b.address, 200);
      if (address.length < 5) bad('Informe o endereço de entrega (rua e número).', 'address');
      addressRef = str(b.address_ref, 120) || null;
    }

    // Pagamento
    const payment = b.payment_method;
    if (!['pix', 'cartao', 'dinheiro'].includes(payment)) bad('Escolha a forma de pagamento.', 'payment_method');
    const notes = str(b.notes, 300) || null;

    // Itens: tudo recalculado a partir do banco
    if (!Array.isArray(b.items) || b.items.length === 0) bad('Seu carrinho está vazio.', 'items');
    if (b.items.length > 30) bad('Pedido com itens demais. Fale com a loja pelo WhatsApp.', 'items');
    const getProduct = db.prepare(`SELECT p.* FROM products p LEFT JOIN categories c ON c.id = p.category_id
                                   WHERE p.id = ? AND p.active = 1 AND (c.id IS NULL OR c.active = 1)`);
    const getRecipe = db.prepare(`SELECT pi.ingredient_id, pi.qty, i.name, i.removable, i.stock_qty
                                  FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id WHERE pi.product_id = ?`);
    const getAddon = db.prepare('SELECT * FROM addons WHERE id = ? AND active = 1 AND (product_id IS NULL OR product_id = ?)');

    const lines = [];
    const stockUse = new Map(); // ingredient_id -> quantidade consumida
    for (const raw of b.items) {
      const pid = Number(raw && raw.product_id);
      const p = Number.isInteger(pid) ? getProduct.get(pid) : null;
      if (!p) bad('Um dos itens do carrinho não está mais disponível. Atualize o carrinho.', 'items');
      const qty = Number(raw.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) bad(`Quantidade inválida para ${p.name} (1 a 50).`, 'items');

      const recipe = getRecipe.all(p.id);
      const removable = new Map(recipe.filter(r => r.removable).map(r => [r.name.toLowerCase(), r.name]));
      const removed = [];
      for (const r of Array.isArray(raw.removed) ? raw.removed : []) {
        const canonical = removable.get(String(r).trim().toLowerCase());
        if (!canonical) bad(`Não dá para tirar "${str(r, 40)}" de ${p.name}.`, 'items');
        if (!removed.includes(canonical)) removed.push(canonical);
      }
      const addons = [];
      for (const aid of Array.isArray(raw.addon_ids) ? raw.addon_ids : []) {
        const a = Number.isInteger(Number(aid)) ? getAddon.get(Number(aid), p.id) : null;
        if (!a) bad(`Adicional inválido para ${p.name}.`, 'items');
        if (!addons.some(x => x.id === a.id)) addons.push({ id: a.id, name: a.name, price_cents: a.price_cents });
      }
      for (const r of recipe) {
        if (removed.includes(r.name)) continue;
        if (r.stock_qty <= 0) bad(`${p.name} está sem ${r.name} no momento. ${r.removable ? 'Você pode pedir sem esse ingrediente.' : ''}`.trim(), 'items');
        stockUse.set(r.ingredient_id, (stockUse.get(r.ingredient_id) || 0) + r.qty * qty);
      }
      const unit = p.price_cents + addons.reduce((s, a) => s + a.price_cents, 0);
      lines.push({ product_id: p.id, name: p.name, qty, unit_price_cents: unit, removed, addons, notes: str(raw.notes, 140) || null });
    }

    const dcfg = deliveryConfig();
    const subtotal = lines.reduce((s, l) => s + l.unit_price_cents * l.qty, 0);
    const fee = deliveryType === 'delivery' ? dcfg.fee_cents : 0;
    const total = subtotal + fee;
    if (deliveryType === 'delivery' && subtotal < dcfg.min_order_cents) {
      bad(`O pedido mínimo para entrega é ${(dcfg.min_order_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`, 'items');
    }
    let changeFor = null;
    if (payment === 'dinheiro' && b.change_for_cents != null && b.change_for_cents !== '' && Number(b.change_for_cents) > 0) {
      changeFor = Math.round(Number(b.change_for_cents));
      if (!Number.isFinite(changeFor) || changeFor < total) bad('O valor para troco precisa ser maior que o total do pedido.', 'change_for');
      if (changeFor > total + 100000) bad('Valor para troco muito alto.', 'change_for');
    }

    // Grava tudo numa transação
    const code = newCode();
    const orderId = tx(() => {
      const id = Number(db.prepare(`INSERT INTO orders (code, customer_name, customer_cpf, customer_phone, address, address_ref, lat, lng,
          delivery_type, payment_method, change_for_cents, notes, subtotal_cents, delivery_fee_cents, total_cents, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recebido')`)
        .run(code, name, cpf, phone, address, addressRef, lat, lng, deliveryType, payment, changeFor, notes, subtotal, fee, total).lastInsertRowid);
      const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, name, qty, unit_price_cents, removed, addons, notes)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const l of lines) {
        insItem.run(id, l.product_id, l.name, l.qty, l.unit_price_cents, JSON.stringify(l.removed),
          JSON.stringify(l.addons.map(a => ({ id: a.id, name: a.name, price_cents: a.price_cents }))), l.notes);
      }
      const dec = db.prepare('UPDATE ingredients SET stock_qty = stock_qty - ? WHERE id = ?');
      const mov = db.prepare("INSERT INTO stock_movements (ingredient_id, delta, reason, order_id) VALUES (?, ?, 'pedido', ?)");
      for (const [ingId, used] of stockUse) { dec.run(used, ingId); mov.run(ingId, -used, id); }
      db.prepare("INSERT INTO transactions (type, category, description, amount_cents, order_id, date) VALUES ('receita', 'Vendas', ?, ?, ?, date('now', '-3 hours'))")
        .run(`Pedido ${code}`, total, id);
      db.prepare("INSERT INTO order_status_log (order_id, status) VALUES (?, 'recebido')").run(id);
      return id;
    });

    // Nota fiscal (falha nunca derruba o pedido)
    let invoice = null;
    try {
      if (nfe.getConfig().auto_emit) invoice = await nfe.emitForOrder(orderId);
    } catch (e) { console.error('[nfe]', e); }

    res.status(201).json({
      code, status: 'recebido', subtotal_cents: subtotal, delivery_fee_cents: fee, total_cents: total,
      invoice: nfe.publicInvoice(invoice),
      pix: payment === 'pix' ? pixFor({ code, total_cents: total }) : null,
    });
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, field: e.field });
    next(e);
  }
});

function pixFor(order) {
  const cfg = pixConfig();
  if (!cfg) return { enabled: false, message: 'Pagamento via Pix na entrega/retirada (QR na maquininha ou chave da loja).' };
  const payload = buildPayload({ key: cfg.key, merchant_name: cfg.merchant_name, city: cfg.city, amount_cents: order.total_cents, txid: order.code });
  if (!payload) return { enabled: false };
  return { enabled: true, copia_e_cola: payload, qr_url: `/api/orders/${order.code}/pix.svg`, merchant_name: cfg.merchant_name || '' };
}

// ---------- Leitura pública por código ----------
const STATUS_LABEL = { recebido: 'Recebido', preparo: 'Em preparo', saiu: 'Saiu para entrega', entregue: 'Entregue', cancelado: 'Cancelado' };

function findOrder(code) {
  const c = String(code || '').toUpperCase();
  if (!CODE_RE.test(c)) return null;
  return db.prepare('SELECT * FROM orders WHERE code = ?').get(c) || null;
}

router.get('/:code', readLimiter, (req, res) => {
  const o = findOrder(req.params.code);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado. Confira o código.' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(o.id).map(i => ({
    name: i.name, qty: i.qty, unit_price_cents: i.unit_price_cents,
    removed: safeJson(i.removed, []), addons: safeJson(i.addons, []).map(a => ({ name: a.name, price_cents: a.price_cents })), notes: i.notes,
  }));
  const timeline = db.prepare('SELECT status, at FROM order_status_log WHERE order_id = ? ORDER BY id').all(o.id);
  const store = storeInfo();
  const phone = String(o.customer_phone || '');
  res.set('Cache-Control', 'no-store');
  res.json({
    code: o.code, status: o.status, status_label: STATUS_LABEL[o.status] || o.status,
    delivery_type: o.delivery_type, payment_method: o.payment_method, change_for_cents: o.change_for_cents,
    subtotal_cents: o.subtotal_cents, delivery_fee_cents: o.delivery_fee_cents, total_cents: o.total_cents,
    created_at: o.created_at, timeline,
    customer: { first_name: String(o.customer_name).split(' ')[0], cpf_masked: maskCpf(o.customer_cpf), phone_masked: phone.length >= 4 ? `(${phone.slice(0, 2)}) •••••-${phone.slice(-4)}` : '' },
    address: o.delivery_type === 'delivery' ? o.address : null,
    notes: o.notes, items,
    eta: deliveryConfig(),
    invoice: nfe.publicInvoice(nfe.latestInvoice(o.id)),
    pix: o.payment_method === 'pix' && o.status !== 'cancelado' ? pixFor(o) : null,
    store: { name: store.name, whatsapp: store.whatsapp, phone: store.phone },
  });
});

router.get('/:code/pix.svg', readLimiter, (req, res) => {
  const o = findOrder(req.params.code);
  const pix = o && o.payment_method === 'pix' ? pixFor(o) : null;
  if (!pix || !pix.enabled) return res.status(404).type('text/plain').send('Pix indisponível');
  res.type('image/svg+xml').set('Cache-Control', 'private, max-age=300').send(toSvg(pix.copia_e_cola));
});

router.get('/:code/danfe', readLimiter, (req, res) => {
  const o = findOrder(req.params.code);
  if (!o) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Nota não encontrada</title><p>Pedido não encontrado.</p>');
  const inv = nfe.latestInvoice(o.id);
  if (!inv || !['autorizada', 'cancelada'].includes(inv.status)) {
    return res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nota fiscal</title>
      <body style="font-family:system-ui;background:#0d0d0f;color:#f4f1ea;padding:24px"><p>A nota fiscal deste pedido ainda não foi autorizada${inv && inv.status === 'processando' ? ' (processando na SEFAZ)' : ''}.</p>
      <p><a style="color:#ffb000" href="/pedido?c=${o.code}">Voltar ao pedido</a></p></body>`);
  }
  if (inv.provider !== 'mock' && inv.danfe_url && /^https:\/\//.test(inv.danfe_url)) return res.redirect(302, inv.danfe_url);
  const { items } = nfe.loadDoc(o.id);
  res.type('html').set('Cache-Control', 'no-store')
    .send(renderDanfe({ order: o, items, invoice: inv, store: getSetting('store', {}) || {}, cfg: nfe.getConfig() }));
});

// ---------- Somente painel ----------
router.post('/:code/invoice/retry', requireAdmin, async (req, res, next) => {
  try {
    const o = findOrder(req.params.code);
    if (!o) return res.status(404).json({ error: 'Pedido não encontrado' });
    const inv = await nfe.retryForOrder(o.id);
    res.json({ invoice: nfe.publicInvoice(inv) });
  } catch (e) { next(e); }
});

router.post('/:code/invoice/cancel', requireAdmin, async (req, res, next) => {
  try {
    const o = findOrder(req.params.code);
    if (!o) return res.status(404).json({ error: 'Pedido não encontrado' });
    const reason = str(req.body && req.body.reason, 255);
    if (reason.length < 15) return res.status(400).json({ error: 'A justificativa precisa ter pelo menos 15 caracteres.' });
    const r = await nfe.cancelForOrder(o.id, reason);
    if (r.error) return res.status(422).json({ error: r.error });
    res.json({ invoice: nfe.publicInvoice(r.invoice) });
  } catch (e) { next(e); }
});

function safeJson(s, fb) { try { return JSON.parse(s) ?? fb; } catch { return fb; } }

router.isValidCpf = isValidCpf; // exportado para testes
module.exports = router;
