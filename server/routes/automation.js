// Automação do painel: aceite automático, impressão dos cupons, reenvio de nota e rotas de entrega.
// Exporta { adminRouter, publicRouter }:
//   adminRouter  -> /api/admin/automation  (atrás do requireAdmin)
//   publicRouter -> /api/entregador         (público; o token da rota é a credencial)
// Na Vercel não existe processo rodando o tempo todo: quem dá o "pulso" é o painel aberto,
// que chama POST /tick a cada ~10 s.
'use strict';
const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, tx, getSetting, setSetting } = require('../db');
const { renderReceipt, renderTest, mapUrl } = require('../print/receipt');

// ---------- Módulo de nota fiscal (carregado sob demanda) ----------
function nfe() {
  try { return require('../nfe'); } catch (e) { console.error('[automacao] módulo de nota indisponível:', e.message); return null; }
}
const fn = (m, name) => (m && typeof m[name] === 'function' ? m[name] : null);

// ---------- Esquema extra (idempotente, roda uma vez por processo) ----------
const NEW_COLUMNS = ['accepted_at', 'printed_at', 'print_claimed_at', 'danfe_printed_at', 'danfe_claimed_at', 'dispatched_at'];
const SCHEMA_SQL = `
${NEW_COLUMNS.map(c => `ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c} TIMESTAMPTZ;`).join('\n')}
CREATE TABLE IF NOT EXISTS delivery_routes (
  id SERIAL PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  driver_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS delivery_route_stops (
  route_id INTEGER NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  delivered_at TIMESTAMPTZ,
  PRIMARY KEY (route_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_route_stops_order ON delivery_route_stops(order_id);
CREATE INDEX IF NOT EXISTS idx_routes_finished ON delivery_routes(finished_at);
ALTER TABLE delivery_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_route_stops ENABLE ROW LEVEL SECURITY;
`;
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      // Evita ALTER TABLE (que trava a tabela) quando tudo já existe
      const cols = await db.all(`SELECT column_name FROM information_schema.columns
                                 WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = ANY($1::text[])`, [NEW_COLUMNS]);
      const t = await db.get(`SELECT to_regclass('delivery_routes') AS a, to_regclass('delivery_route_stops') AS b`);
      if (cols.length === NEW_COLUMNS.length && t && t.a && t.b) return;
      await db.exec(SCHEMA_SQL);
    })();
    schemaPromise.catch(e => { console.error('[automacao] esquema:', e.message); schemaPromise = null; });
  }
  return schemaPromise;
}
const schemaMw = async (req, res, next) => { await ensureSchema(); next(); };

// ---------- Utilidades ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; this.expose = true; } }
const bad = msg => new HttpError(400, msg);
const STATUS_LABEL = { recebido: 'Recebido', preparo: 'Em preparo', saiu: 'Saiu para entrega', entregue: 'Entregue', cancelado: 'Cancelado' };
const PAY = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
const RECENT = "o.created_at > now() - interval '12 hours'";
const LOCAL_TODAY = "(o.created_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date";

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
const json = (v, fb) => { try { return JSON.parse(v || 'null') ?? fb; } catch { return fb; } };
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
const phoneDigits = p => String(p || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
const intId = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw bad('Id inválido'); return n; };
const brl = c => ((Number(c) || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function haversineKm(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const hasLoc = p => p && p.lat != null && p.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

// Vizinho mais próximo a partir da loja; pedidos sem coordenada vão para o fim
function nearestNeighbor(start, orders) {
  const withLoc = orders.filter(hasLoc);
  const rest = orders.filter(o => !hasLoc(o));
  const out = [];
  let cur = hasLoc(start) ? start : null;
  const left = [...withLoc];
  while (left.length) {
    let bi = 0;
    if (cur) {
      let bd = Infinity;
      left.forEach((o, i) => { const d = haversineKm(cur, o); if (d < bd) { bd = d; bi = i; } });
    }
    cur = left.splice(bi, 1)[0];
    out.push(cur);
  }
  return out.concat(rest);
}

const placeParam = s => (hasLoc(s) ? `${Number(s.lat)},${Number(s.lng)}` : String(s.address || ''));
function directionsUrl(store, stops) {
  if (!stops.length) return null;
  const p = new URLSearchParams({ api: '1' });
  if (hasLoc(store)) p.set('origin', `${Number(store.lat)},${Number(store.lng)}`);
  p.set('destination', placeParam(stops[stops.length - 1]));
  const mid = stops.slice(0, -1).slice(0, 9).map(placeParam);
  if (mid.length) p.set('waypoints', mid.join('|'));
  p.set('travelmode', 'driving');
  return 'https://www.google.com/maps/dir/?' + p.toString().replace(/%2C/g, ',');
}
function wazeUrl(stop) {
  if (!stop) return null;
  if (hasLoc(stop)) return `https://waze.com/ul?ll=${Number(stop.lat)},${Number(stop.lng)}&navigate=yes`;
  return stop.address ? `https://waze.com/ul?q=${encodeURIComponent(stop.address)}&navigate=yes` : null;
}
function stopMapUrl(stop) {
  if (hasLoc(stop)) return `https://www.google.com/maps/dir/?api=1&destination=${Number(stop.lat)},${Number(stop.lng)}&travelmode=driving`;
  return stop.address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stop.address)}&travelmode=driving` : null;
}

function customerWhatsapp(o, storeName, base) {
  const d = phoneDigits(o.customer_phone);
  if (d.length < 10) return null;
  const change = o.payment_method === 'dinheiro' && o.change_for_cents > o.total_cents ? o.change_for_cents - o.total_cents : 0;
  const lines = [
    `Olá, ${firstName(o.customer_name)}! Seu pedido ${o.code} da ${storeName} saiu para entrega e já está a caminho.`,
    `Total: ${brl(o.total_cents)} (${PAY[o.payment_method] || o.payment_method}).`,
    change ? `Vamos levar ${brl(change)} de troco.` : null,
    `Acompanhe: ${base}/pedido?c=${o.code}`,
  ].filter(Boolean);
  return `https://wa.me/55${d}?text=${encodeURIComponent(lines.join('\n'))}`;
}

// ---------- Configuração ----------
const DEFAULTS = {
  enabled: false,              // chave geral "Automação ligada"
  auto_accept: true,           // recebido -> em preparo sozinho
  auto_print: 'on_accept',     // 'on_arrival' | 'on_accept' | 'off'
  print_copies: 1,             // 1 a 3
  print_kitchen: true,         // via da cozinha
  print_delivery: true,        // via de entrega
  print_nfe: true,             // DANFE NFC-e quando autorizada
  paper_width: '80',           // '58' | '80'
  auto_retry_nfe: true,        // reenvia notas com erro / consulta as pendentes
  prep_minutes: 25,            // previsão de preparo (aparece na via da cozinha)
  auto_dispatch_minutes: 0,    // 0 = desligado; senão em preparo -> saiu depois de N min
  notify_whatsapp: true,       // monta o link do WhatsApp "saiu para entrega"
  print_since: null,           // só imprime pedidos feitos depois disto (evita imprimir o histórico)
};

function normalize(s) {
  const v = { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
  const b = x => x === true || x === 'true' || x === 1 || x === '1' || x === 'on';
  return {
    enabled: b(v.enabled),
    auto_accept: b(v.auto_accept),
    auto_print: ['on_arrival', 'on_accept', 'off'].includes(v.auto_print) ? v.auto_print : DEFAULTS.auto_print,
    print_copies: Math.min(Math.max(parseInt(v.print_copies, 10) || 1, 1), 3),
    print_kitchen: b(v.print_kitchen),
    print_delivery: b(v.print_delivery),
    print_nfe: b(v.print_nfe),
    paper_width: String(v.paper_width) === '58' ? '58' : '80',
    auto_retry_nfe: b(v.auto_retry_nfe),
    prep_minutes: Math.min(Math.max(parseInt(v.prep_minutes, 10) || 0, 0), 240),
    auto_dispatch_minutes: Math.min(Math.max(parseInt(v.auto_dispatch_minutes, 10) || 0, 0), 240),
    notify_whatsapp: b(v.notify_whatsapp),
    print_since: typeof v.print_since === 'string' && !Number.isNaN(Date.parse(v.print_since)) ? v.print_since : null,
  };
}
async function loadSettings() { return normalize(await getSetting('automation', {})); }

async function storeInfo() {
  const s = (await getSetting('store', {})) || {};
  const lat = s.lat != null && s.lat !== '' ? Number(s.lat) : null;
  const lng = s.lng != null && s.lng !== '' ? Number(s.lng) : null;
  return { name: s.name || 'Garage Burger', address: s.address || '', phone: s.phone || '', whatsapp: s.whatsapp || '',
    lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, raw: s };
}

function vias(s) { return [s.print_kitchen && 'cozinha', s.print_delivery && 'entrega'].filter(Boolean); }
function printUrl(id, s, override = {}) {
  const p = new URLSearchParams({ vias: (override.vias || vias(s)).join(','), copies: String(override.copies || s.print_copies), width: override.width || s.paper_width });
  return `/api/admin/automation/orders/${id}/print?${p}`;
}

// Lease curto para que dois painéis abertos não reenviem a mesma nota ao mesmo tempo
async function takeLease(name, seconds) {
  const now = new Date();
  const until = new Date(now.getTime() + seconds * 1000).toISOString();
  const r = await db.run(`INSERT INTO settings (key, value) VALUES ($1, $2)
                          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE settings.value < $3
                          RETURNING key`, [`lease:${name}`, until, now.toISOString()]);
  return r.rows.length > 0;
}

async function latestInvoices(orderIds) {
  if (!orderIds.length) return new Map();
  const rows = await db.all(`SELECT DISTINCT ON (order_id) order_id, id, provider, status, number, series, danfe_url, message
                             FROM invoices WHERE order_id = ANY($1::int[]) ORDER BY order_id, id DESC`, [orderIds]);
  return new Map(rows.map(r => [r.order_id, r]));
}

async function todayCounts() {
  const rows = await db.all(`SELECT status, COUNT(*)::int AS n FROM orders o WHERE ${LOCAL_TODAY} GROUP BY status`);
  return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), ms).unref?.())]);

// =====================================================================
// Painel (protegido)
// =====================================================================
const adminRouter = express.Router();
adminRouter.use(schemaMw);

adminRouter.get('/settings', async (req, res) => {
  const [settings, store] = await Promise.all([loadSettings(), storeInfo()]);
  res.json({ settings, store: { name: store.name, address: store.address, lat: store.lat, lng: store.lng } });
});

adminRouter.put('/settings', async (req, res) => {
  const b = req.body || {};
  const cur = await loadSettings();
  const next = normalize({ ...cur, ...b, print_since: cur.print_since });
  // Ao ligar a automação (ou a impressão), só imprime o que chegar daqui para frente
  const printingNow = next.enabled && next.auto_print !== 'off';
  const printingBefore = cur.enabled && cur.auto_print !== 'off';
  if (printingNow && (!printingBefore || !next.print_since)) next.print_since = new Date().toISOString();
  await setSetting('automation', next);
  res.json({ settings: next });
});

adminRouter.put('/store-location', async (req, res) => {
  const b = req.body || {};
  let lat = null, lng = null;
  if (b.lat !== null && b.lat !== '' && b.lat !== undefined) {
    lat = Number(b.lat); lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) throw bad('Localização inválida');
    lat = Math.round(lat * 1e6) / 1e6; lng = Math.round(lng * 1e6) / 1e6;
  }
  const cur = (await getSetting('store', {})) || {};
  await setSetting('store', { ...cur, lat, lng });
  res.json({ lat, lng });
});

// ---------- O pulso da automação ----------
adminRouter.post('/tick', async (req, res) => {
  const s = await loadSettings();
  const out = { enabled: s.enabled, at: new Date().toISOString(), actions: [], to_print: [], danfe_to_print: [], errors: [], counts: {} };
  if (!s.enabled) { out.counts = await todayCounts(); return res.json(out); }
  const store = await storeInfo();
  const base = baseUrl(req);

  // (a) aceite automático
  if (s.auto_accept) {
    const r = await db.run(`UPDATE orders o SET status = 'preparo', accepted_at = now()
                            WHERE o.status = 'recebido' AND ${RECENT} RETURNING o.id, o.code, o.customer_name`);
    for (const o of r.rows) out.actions.push({ type: 'aceito', order_id: o.id, code: o.code, text: `${o.code} aceito (em preparo) · ${firstName(o.customer_name)}` });
  }

  // (b) nota fiscal: consulta as pendentes e reenvia as com erro
  if (s.auto_retry_nfe && await takeLease('nfe', 8)) {
    try { out.actions.push(...await retryInvoices()); }
    catch (e) { out.errors.push('Nota fiscal: ' + e.message); }
  }

  // (c) saída automática para entrega
  if (s.auto_dispatch_minutes > 0) {
    const r = await db.run(`UPDATE orders o SET status = 'saiu', dispatched_at = now()
      WHERE o.status = 'preparo' AND ${RECENT}
        AND COALESCE(o.accepted_at, (SELECT MAX(l.at) FROM order_status_log l WHERE l.order_id = o.id AND l.status = 'preparo'), o.created_at)
            < now() - make_interval(mins => $1::int)
      RETURNING o.id, o.code, o.customer_name, o.customer_phone, o.delivery_type, o.payment_method, o.total_cents, o.change_for_cents`,
    [s.auto_dispatch_minutes]);
    for (const o of r.rows) {
      out.actions.push({
        type: 'saiu', order_id: o.id, code: o.code,
        text: `${o.code} ${o.delivery_type === 'retirada' ? 'pronto para retirada' : 'saiu para entrega'} · ${firstName(o.customer_name)}`,
        whatsapp_url: s.notify_whatsapp && o.delivery_type === 'delivery' ? customerWhatsapp(o, store.name, base) : null,
      });
    }
  }

  // (d) o que falta imprimir (reserva por 90 s para não sair duplicado em dois painéis)
  if (s.auto_print !== 'off') {
    const statuses = s.auto_print === 'on_arrival' ? ['recebido', 'preparo'] : ['preparo'];
    if (!s.print_since) { s.print_since = new Date().toISOString(); await setSetting('automation', s); }
    const since = s.print_since;
    if (vias(s).length) {
      const r = await db.run(`UPDATE orders SET print_claimed_at = now() WHERE id IN (
          SELECT o.id FROM orders o WHERE o.printed_at IS NULL AND o.status = ANY($1::text[]) AND ${RECENT}
            AND o.created_at >= $2::timestamptz
            AND (o.print_claimed_at IS NULL OR o.print_claimed_at < now() - interval '90 seconds')
          ORDER BY o.id LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING id, code, customer_name, delivery_type, total_cents`, [statuses, since]);
      out.to_print = r.rows.sort((a, b) => a.id - b.id).map(o => ({
        id: o.id, code: o.code, customer_name: o.customer_name, delivery_type: o.delivery_type, url: printUrl(o.id, s),
      }));
    }
    if (s.print_nfe) {
      const danfeStatuses = s.auto_print === 'on_arrival' ? ['recebido', 'preparo', 'saiu', 'entregue'] : ['preparo', 'saiu', 'entregue'];
      const r = await db.run(`UPDATE orders SET danfe_claimed_at = now() WHERE id IN (
          SELECT o.id FROM orders o WHERE o.danfe_printed_at IS NULL AND o.status = ANY($1::text[]) AND ${RECENT}
            AND o.created_at >= $2::timestamptz AND ($3::boolean OR o.printed_at IS NOT NULL)
            AND (o.danfe_claimed_at IS NULL OR o.danfe_claimed_at < now() - interval '90 seconds')
            AND (SELECT i.status FROM invoices i WHERE i.order_id = o.id ORDER BY i.id DESC LIMIT 1) = 'autorizada'
          ORDER BY o.id LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING id, code`, [danfeStatuses, since, vias(s).length === 0]);
      const invs = await latestInvoices(r.rows.map(o => o.id));
      out.danfe_to_print = r.rows.sort((a, b) => a.id - b.id).map(o => danfeTarget(o, invs.get(o.id)));
    }
  }

  out.counts = await todayCounts();
  const latest = await db.get('SELECT COALESCE(MAX(id), 0) AS m FROM orders');
  out.latest_id = Number(latest.m);
  res.json(out);
});

function danfeTarget(o, inv) {
  const sameOrigin = !inv || inv.provider === 'mock' || !/^https:\/\//.test(inv.danfe_url || '');
  return { id: o.id, code: o.code, same_origin: sameOrigin, url: sameOrigin ? `/api/orders/${encodeURIComponent(o.code)}/danfe` : inv.danfe_url, number: inv && inv.number };
}

// Notas: usa nfe.refreshPending() quando existir; senão, reenvia com espera crescente (máx. 5 tentativas)
async function retryInvoices() {
  const m = nfe();
  if (!m) return [];
  const pendingSql = `SELECT o.id, o.code, li.status FROM orders o
    JOIN LATERAL (SELECT i.status, i.created_at, i.id FROM invoices i WHERE i.order_id = o.id ORDER BY i.id DESC LIMIT 1) li ON true
    WHERE o.status <> 'cancelado' AND o.created_at > now() - interval '24 hours' AND li.status IN ('processando', 'erro')`;
  const before = await db.all(pendingSql);
  if (!before.length) return [];
  const refresh = fn(m, 'refreshPending');
  const retry = fn(m, 'retryForOrder');
  if (refresh) {
    await withTimeout(Promise.resolve(refresh({ limit: 5, timeoutMs: 6000 })), 9000);
  } else if (retry) {
    const due = await db.all(`SELECT o.id FROM orders o
      JOIN LATERAL (SELECT i.status, i.created_at FROM invoices i WHERE i.order_id = o.id ORDER BY i.id DESC LIMIT 1) li ON true
      WHERE o.status <> 'cancelado' AND o.created_at > now() - interval '24 hours'
        AND ((li.status = 'erro' AND (SELECT COUNT(*) FROM invoices x WHERE x.order_id = o.id) < 5
              AND li.created_at < now() - make_interval(secs => 30 * (SELECT COUNT(*) FROM invoices x WHERE x.order_id = o.id)::int))
          OR (li.status = 'processando' AND li.created_at < now() - interval '20 seconds'))
      ORDER BY o.id LIMIT 3`);
    for (const o of due) await withTimeout(Promise.resolve(retry(o.id)), 9000).catch(e => console.error('[automacao] nota', o.id, e.message));
  } else return [];
  const after = await latestInvoices(before.map(o => o.id));
  const actions = [];
  for (const o of before) {
    const inv = after.get(o.id);
    if (!inv || inv.status === o.status) continue;
    if (inv.status === 'autorizada') actions.push({ type: 'nota', order_id: o.id, code: o.code, text: `${o.code}: nota ${o.status === 'erro' ? 'reemitida e ' : ''}autorizada${inv.number ? ` (nº ${inv.number})` : ''}` });
    else if (inv.status === 'processando') actions.push({ type: 'nota', order_id: o.id, code: o.code, text: `${o.code}: nota reenviada (processando)` });
    else if (inv.status === 'erro') actions.push({ type: 'nota_erro', order_id: o.id, code: o.code, text: `${o.code}: nota com erro${inv.message ? ` — ${String(inv.message).slice(0, 120)}` : ''}` });
  }
  return actions;
}

// O painel avisa que imprimiu (ok) ou que falhou (libera para tentar de novo)
adminRouter.post('/orders/:id/printed', async (req, res) => {
  const id = intId(req.params.id);
  const kind = (req.body || {}).kind === 'danfe' ? 'danfe' : 'receipt';
  const ok = (req.body || {}).ok !== false;
  const col = kind === 'danfe' ? 'danfe' : 'print';
  const done = kind === 'danfe' ? 'danfe_printed_at' : 'printed_at';
  const r = ok
    ? await db.run(`UPDATE orders SET ${done} = COALESCE(${done}, now()) WHERE id = $1 RETURNING id`, [id])
    : await db.run(`UPDATE orders SET ${col}_claimed_at = NULL WHERE id = $1 RETURNING id`, [id]);
  if (!r.rows.length) throw new HttpError(404, 'Pedido não encontrado');
  res.json({ ok: true });
});

async function orderForPrint(id) {
  const order = await db.get('SELECT * FROM orders WHERE id = $1', [id]);
  if (!order) return null;
  const items = await db.all('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [id]);
  const invoice = await db.get('SELECT * FROM invoices WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [id]);
  return { order, items, invoice: invoice || null };
}

// Cupom em HTML para o iframe de impressão
adminRouter.get('/orders/:id/print', async (req, res) => {
  const id = intId(req.params.id);
  const data = await orderForPrint(id);
  if (!data) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Pedido não encontrado</title><p>Pedido não encontrado.</p>');
  const s = await loadSettings();
  const store = await storeInfo();
  const want = String(req.query.vias || 'cozinha,entrega').split(',').filter(v => ['cozinha', 'entrega'].includes(v));
  res.type('html').set('Cache-Control', 'no-store').send(renderReceipt({
    ...data, store, settings: s, vias: want,
    copies: req.query.copies || 1, width: req.query.width || s.paper_width,
  }));
});

adminRouter.get('/print/test', async (req, res) => {
  const s = await loadSettings();
  const store = await storeInfo();
  res.type('html').set('Cache-Control', 'no-store').send(renderTest({ store, width: req.query.width || s.paper_width }));
});

// Dados de impressão de um pedido (botões manuais do painel)
adminRouter.get('/orders/:id/print-info', async (req, res) => {
  const id = intId(req.params.id);
  const o = await db.get('SELECT id, code FROM orders WHERE id = $1', [id]);
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  const s = await loadSettings();
  const inv = (await latestInvoices([id])).get(id);
  res.json({
    kitchen_url: printUrl(id, s, { vias: ['cozinha'] }),
    delivery_url: printUrl(id, s, { vias: ['entrega'] }),
    both_url: printUrl(id, s, { vias: ['cozinha', 'entrega'] }),
    danfe: inv && inv.status === 'autorizada' ? danfeTarget(o, inv) : null,
    invoice_status: inv ? inv.status : null,
  });
});

// ---------- Entregas ----------
const OPEN_ROUTE_STOP = `EXISTS (SELECT 1 FROM delivery_route_stops rs JOIN delivery_routes r ON r.id = rs.route_id
                                 WHERE rs.order_id = o.id AND r.finished_at IS NULL)`;

adminRouter.get('/deliveries', async (req, res) => {
  const store = await storeInfo();
  const s = await loadSettings();
  const rows = await db.all(`SELECT o.id, o.code, o.customer_name, o.customer_phone, o.address, o.address_ref, o.lat, o.lng, o.status,
        o.payment_method, o.change_for_cents, o.total_cents, o.created_at, o.printed_at,
        COALESCE(o.accepted_at, (SELECT MAX(l.at) FROM order_status_log l WHERE l.order_id = o.id AND l.status = 'preparo'), o.created_at) AS prep_started_at,
        (SELECT COALESCE(SUM(qty), 0) FROM order_items i WHERE i.order_id = o.id)::int AS items_count
      FROM orders o
      WHERE o.delivery_type = 'delivery' AND o.status IN ('preparo', 'saiu') AND o.created_at > now() - interval '24 hours'
        AND NOT ${OPEN_ROUTE_STOP}
      ORDER BY o.created_at`);
  const ready = rows.map(o => ({
    ...o, first_name: firstName(o.customer_name),
    distance_km: haversineKm(store, o) != null ? Math.round(haversineKm(store, o) * 10) / 10 : null,
    map_url: mapUrl(o),
  }));
  const routes = await db.all(`SELECT * FROM delivery_routes WHERE finished_at IS NULL OR finished_at > now() - interval '12 hours'
                               ORDER BY finished_at IS NOT NULL, id DESC LIMIT 30`);
  const views = [];
  for (const r of routes) views.push(await routeView(r, { store, base: baseUrl(req), settings: s }));
  res.json({ store: { name: store.name, lat: store.lat, lng: store.lng, address: store.address }, ready, routes: views, notify_whatsapp: s.notify_whatsapp });
});

async function routeStops(routeId, q = db) {
  return q.all(`SELECT rs.position, rs.delivered_at, o.id AS order_id, o.code, o.customer_name, o.customer_phone, o.address, o.address_ref,
                       o.lat, o.lng, o.status, o.payment_method, o.change_for_cents, o.total_cents, o.notes,
                       (SELECT COALESCE(SUM(qty), 0) FROM order_items i WHERE i.order_id = o.id)::int AS items_count
                FROM delivery_route_stops rs JOIN orders o ON o.id = rs.order_id
                WHERE rs.route_id = $1 ORDER BY rs.position`, [routeId]);
}
const stopDone = st => !!st.delivered_at || ['entregue', 'cancelado'].includes(st.status);

async function routeView(r, { store, base, settings }) {
  const stops = await routeStops(r.id);
  const pending = stops.filter(st => !stopDone(st));
  const driverUrl = `${base}/entregador?t=${r.token}`;
  const shareText = `Rota de entrega ${store.name}${r.driver_name ? ` (${r.driver_name})` : ''}: ${stops.length} ${stops.length === 1 ? 'entrega' : 'entregas'}.\nAbra no celular: ${driverUrl}`;
  return {
    id: r.id, driver_name: r.driver_name, created_at: r.created_at, finished_at: r.finished_at,
    driver_url: driverUrl,
    driver_whatsapp_url: `https://wa.me/?text=${encodeURIComponent(shareText)}`,
    maps_url: directionsUrl(store, pending.length ? pending : stops),
    waze_url: wazeUrl(pending[0] || stops[0]),
    progress: { done: stops.length - pending.length, total: stops.length },
    stops: stops.map(st => ({
      position: st.position, order_id: st.order_id, code: st.code, customer_name: st.customer_name, address: st.address,
      address_ref: st.address_ref, status: st.status, delivered_at: st.delivered_at, total_cents: st.total_cents,
      payment_method: st.payment_method, change_for_cents: st.change_for_cents,
      distance_km: haversineKm(store, st) != null ? Math.round(haversineKm(store, st) * 10) / 10 : null,
      whatsapp_url: settings.notify_whatsapp ? customerWhatsapp(st, store.name, base) : null,
    })),
  };
}

adminRouter.post('/routes', async (req, res) => {
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.order_ids) ? b.order_ids : []).map(Number))];
  if (!ids.length) throw bad('Escolha pelo menos um pedido para a rota.');
  if (ids.length > 10) throw bad('No máximo 10 pedidos por rota (limite do Google Maps).');
  if (ids.some(i => !Number.isInteger(i) || i < 1)) throw bad('Pedido inválido');
  const driver = String(b.driver_name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  const store = await storeInfo();
  const s = await loadSettings();

  const route = await tx(async t => {
    const orders = await t.all(`SELECT o.*, ${OPEN_ROUTE_STOP} AS in_route FROM orders o WHERE o.id = ANY($1::int[]) FOR UPDATE`, [ids]);
    if (orders.length !== ids.length) throw new HttpError(404, 'Algum pedido não foi encontrado. Atualize a lista.');
    for (const o of orders) {
      if (o.delivery_type !== 'delivery') throw new HttpError(409, `${o.code} é retirada no balcão, não entra em rota.`);
      if (!['preparo', 'saiu'].includes(o.status)) throw new HttpError(409, `${o.code} está "${STATUS_LABEL[o.status] || o.status}" e não pode sair para entrega.`);
      if (o.in_route) throw new HttpError(409, `${o.code} já está em outra rota em andamento.`);
    }
    const ordered = nearestNeighbor(store, orders);
    const token = crypto.randomBytes(24).toString('base64url');
    const r = (await t.run('INSERT INTO delivery_routes (token, driver_name) VALUES ($1, $2) RETURNING *', [token, driver])).rows[0];
    for (let i = 0; i < ordered.length; i++) {
      await t.run('INSERT INTO delivery_route_stops (route_id, order_id, position) VALUES ($1, $2, $3)', [r.id, ordered[i].id, i + 1]);
    }
    await t.run(`UPDATE orders SET status = 'saiu', dispatched_at = COALESCE(dispatched_at, now())
                 WHERE id = ANY($1::int[]) AND status = 'preparo'`, [ids]);
    return r;
  });
  res.status(201).json(await routeView(route, { store, base: baseUrl(req), settings: s }));
});

adminRouter.get('/routes/:id', async (req, res) => {
  const r = await db.get('SELECT * FROM delivery_routes WHERE id = $1', [intId(req.params.id)]);
  if (!r) throw new HttpError(404, 'Rota não encontrada');
  res.json(await routeView(r, { store: await storeInfo(), base: baseUrl(req), settings: await loadSettings() }));
});

// Encerrar: os pedidos que faltaram ficam como estão ("saiu") para o dono resolver
adminRouter.post('/routes/:id/finish', async (req, res) => {
  const r = await db.run('UPDATE delivery_routes SET finished_at = COALESCE(finished_at, now()) WHERE id = $1 RETURNING *', [intId(req.params.id)]);
  if (!r.rows.length) throw new HttpError(404, 'Rota não encontrada');
  res.json({ ok: true });
});

// Desfazer: tira da rota os pedidos não entregues e volta para "em preparo"
adminRouter.post('/routes/:id/cancel', async (req, res) => {
  const id = intId(req.params.id);
  const n = await tx(async t => {
    const r = await t.get('SELECT * FROM delivery_routes WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw new HttpError(404, 'Rota não encontrada');
    if (r.finished_at) throw new HttpError(409, 'Esta rota já foi encerrada.');
    const back = await t.run(`UPDATE orders SET status = 'preparo' WHERE status = 'saiu' AND id IN
                                (SELECT order_id FROM delivery_route_stops WHERE route_id = $1 AND delivered_at IS NULL) RETURNING id`, [id]);
    await t.run('DELETE FROM delivery_route_stops WHERE route_id = $1 AND delivered_at IS NULL', [id]);
    await t.run('UPDATE delivery_routes SET finished_at = now() WHERE id = $1', [id]);
    return back.rows.length;
  });
  res.json({ ok: true, returned: n });
});

// =====================================================================
// Entregador (público, pelo token)
// =====================================================================
const publicRouter = express.Router();
publicRouter.use(rateLimit({ windowMs: 60e3, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas consultas. Aguarde um minuto.' } }));
publicRouter.use(schemaMw);
publicRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex'); next(); });

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
async function findRoute(token, q = db, lock = false) {
  if (!TOKEN_RE.test(String(token || ''))) throw new HttpError(404, 'Rota não encontrada. Peça um link novo para a loja.');
  const r = await q.get(`SELECT *, (finished_at IS NOT NULL AND finished_at < now() - interval '12 hours') AS expired_finished,
                                (created_at < now() - interval '48 hours') AS expired_old
                         FROM delivery_routes WHERE token = $1 ${lock ? 'FOR UPDATE' : ''}`, [token]);
  if (!r) throw new HttpError(404, 'Rota não encontrada. Peça um link novo para a loja.');
  if (r.expired_finished || r.expired_old) throw new HttpError(410, 'Esta rota já foi encerrada.');
  return r;
}

async function driverView(r) {
  const store = await storeInfo();
  const stops = await routeStops(r.id);
  return {
    driver_name: r.driver_name, created_at: r.created_at, finished: !!r.finished_at,
    store: { name: store.name, phone: phoneDigits(store.whatsapp || store.phone), lat: store.lat, lng: store.lng },
    maps_url: directionsUrl(store, stops.filter(st => !stopDone(st))),
    stops: stops.map(st => {
      const change = st.payment_method === 'dinheiro' && st.change_for_cents > st.total_cents ? st.change_for_cents - st.total_cents : 0;
      return {
        position: st.position, code: st.code, first_name: firstName(st.customer_name),
        address: st.address, address_ref: st.address_ref, lat: st.lat, lng: st.lng,
        phone: phoneDigits(st.customer_phone), notes: st.notes && st.notes !== '[exemplo]' ? st.notes : null,
        payment_method: st.payment_method, payment_label: PAY[st.payment_method] || st.payment_method,
        total_cents: st.total_cents, change_for_cents: change ? st.change_for_cents : null, change_cents: change,
        items_count: st.items_count,
        status: st.delivered_at || st.status === 'entregue' ? 'entregue' : st.status === 'cancelado' ? 'cancelado' : 'pendente',
        delivered_at: st.delivered_at,
        maps_url: stopMapUrl(st), waze_url: wazeUrl(st),
      };
    }),
  };
}

publicRouter.get('/:token', async (req, res) => {
  const r = await findRoute(req.params.token);
  res.json(await driverView(r));
});

publicRouter.post('/:token/stops/:pos/delivered', async (req, res) => {
  const pos = intId(req.params.pos);
  const r = await tx(async t => {
    const route = await findRoute(req.params.token, t, true);
    if (route.finished_at) throw new HttpError(409, 'Esta rota já foi encerrada pela loja.');
    const st = await t.get(`SELECT rs.*, o.status, o.code FROM delivery_route_stops rs JOIN orders o ON o.id = rs.order_id
                            WHERE rs.route_id = $1 AND rs.position = $2 FOR UPDATE OF rs`, [route.id, pos]);
    if (!st) throw new HttpError(404, 'Entrega não encontrada nesta rota.');
    if (st.status === 'cancelado') throw new HttpError(409, `O pedido ${st.code} foi cancelado pela loja. Não entregue.`);
    await t.run('UPDATE delivery_route_stops SET delivered_at = COALESCE(delivered_at, now()) WHERE route_id = $1 AND order_id = $2', [route.id, st.order_id]);
    await t.run(`UPDATE orders SET status = 'entregue' WHERE id = $1 AND status IN ('preparo', 'saiu')`, [st.order_id]);
    const left = await t.get(`SELECT COUNT(*)::int AS n FROM delivery_route_stops rs JOIN orders o ON o.id = rs.order_id
                              WHERE rs.route_id = $1 AND rs.delivered_at IS NULL AND o.status NOT IN ('entregue', 'cancelado')`, [route.id]);
    if (Number(left.n) === 0) await t.run('UPDATE delivery_routes SET finished_at = now() WHERE id = $1', [route.id]);
    return route;
  });
  const fresh = await db.get('SELECT * FROM delivery_routes WHERE id = $1', [r.id]);
  res.json(await driverView(fresh));
});

// Erros com mensagem amigável (o handler geral do server.js esconde mensagens sem `expose`)
function errors(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  next(err);
}
adminRouter.use(errors);
publicRouter.use(errors);

module.exports = { adminRouter, publicRouter, ensureSchema, _internal: { nearestNeighbor, haversineKm, directionsUrl, normalize } };
