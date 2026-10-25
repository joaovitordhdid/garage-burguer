// Emissão de NFC-e: escolhe o provedor (mock | focusnfe), grava em `invoices` e acompanha o status.
// Interface do provedor: emit(doc) / status(ref) / cancel(ref, reason) -> { status, number, series, access_key,
//   danfe_url, xml_url, qrcode_url, message }, com status em: processando | autorizada | erro | cancelada.
'use strict';
const { db, getSetting } = require('../db');
const { createMockProvider } = require('./mock');
const { createFocusProvider } = require('./focusnfe');

const UF_CODES = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 };

function getConfig() {
  const s = getSetting('nfe', {}) || {};
  const cfg = {
    mode: 'mock', provider: 'focusnfe', token: '', cnpj: '', inscricao_estadual: '', regime_tributario: '1',
    csc_id: '', csc_token: '', auto_emit: true, uf: 'SP', ...s,
  };
  if (process.env.NFE_MODE) cfg.mode = process.env.NFE_MODE;
  if (process.env.FOCUS_NFE_TOKEN) cfg.token = process.env.FOCUS_NFE_TOKEN;
  if (!['mock', 'homologacao', 'producao'].includes(cfg.mode)) cfg.mode = 'mock';
  cfg.auto_emit = cfg.auto_emit !== false && cfg.auto_emit !== 'false' && cfg.auto_emit !== 0;
  cfg.uf_code = UF_CODES[String(cfg.uf || 'SP').toUpperCase()] || 35;
  return cfg;
}

function getProvider(cfg = getConfig()) {
  if (cfg.mode === 'mock') return createMockProvider(cfg);
  if (cfg.provider === 'focusnfe') {
    if (!cfg.token || !cfg.cnpj) {
      return { name: 'focusnfe', async emit() { return { status: 'erro', message: 'NFC-e não configurada: informe token da Focus NFe e CNPJ no painel' }; },
        async status() { return null; }, async cancel() { return { status: null, message: 'NFC-e não configurada' }; } };
    }
    return createFocusProvider(cfg);
  }
  return { name: cfg.provider, async emit() { return { status: 'erro', message: `Provedor "${cfg.provider}" não suportado` }; },
    async status() { return null; }, async cancel() { return { status: null, message: 'Provedor não suportado' }; } };
}

function loadDoc(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const items = db.prepare(`SELECT oi.*, p.ncm, p.cfop FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
                            WHERE oi.order_id = ? ORDER BY oi.id`).all(orderId);
  return { order, items };
}

function latestInvoice(orderId) {
  return db.prepare('SELECT * FROM invoices WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId) || null;
}

function saveResult(invoiceId, r) {
  db.prepare(`UPDATE invoices SET status = ?, number = COALESCE(?, number), series = COALESCE(?, series),
              access_key = COALESCE(?, access_key), danfe_url = COALESCE(?, danfe_url), xml_url = COALESCE(?, xml_url),
              qrcode_url = COALESCE(?, qrcode_url), message = ? WHERE id = ?`)
    .run(r.status || 'erro', r.number ?? null, r.series ?? null, r.access_key ?? null, r.danfe_url ?? null,
      r.xml_url ?? null, r.qrcode_url ?? null, r.message ? String(r.message).slice(0, 1000) : null, invoiceId);
}

// Consulta periódica enquanto a SEFAZ processa (3s, 6s, 12s, 24s, 48s)
const polling = new Set();
function schedulePoll(invoiceId, attempt = 0) {
  if (attempt >= 5 || (attempt === 0 && polling.has(invoiceId))) { if (attempt >= 5) polling.delete(invoiceId); return; }
  polling.add(invoiceId);
  const t = setTimeout(async () => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!inv || inv.status !== 'processando') { polling.delete(invoiceId); return; }
    try {
      const r = await getProvider().status(inv.ref);
      if (r && r.status) saveResult(invoiceId, r);
      if (!r || r.status === 'processando') return schedulePoll(invoiceId, attempt + 1);
    } catch (e) {
      console.error('[nfe] erro ao consultar', inv.ref, e.message);
      return schedulePoll(invoiceId, attempt + 1);
    }
    polling.delete(invoiceId);
  }, 3000 * 2 ** attempt);
  t.unref?.();
}

// Emite a nota de um pedido. Nunca lança erro: falhas viram status 'erro' com mensagem.
// waitMs: quanto esperar pela resposta antes de devolver 'processando' (a emissão continua em segundo plano).
async function emitForOrder(orderId, { waitMs = 8000 } = {}) {
  const cfg = getConfig();
  const provider = getProvider(cfg);
  const doc = loadDoc(orderId);
  if (!doc.order) return null;
  const attempts = db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE order_id = ?').get(orderId).n;
  const ref = `${doc.order.code}-${attempts + 1}`.replace(/[^A-Za-z0-9-]/g, '');
  doc.ref = ref;
  const invoiceId = db.prepare("INSERT INTO invoices (order_id, provider, ref, status) VALUES (?, ?, ?, 'processando')")
    .run(orderId, provider.name, ref).lastInsertRowid;

  const job = (async () => {
    try {
      const r = await provider.emit(doc);
      saveResult(invoiceId, r);
      if (r.status === 'processando') schedulePoll(invoiceId);
    } catch (e) {
      // Timeout/rede: a nota pode ter sido recebida. Marcamos processando e consultamos depois.
      console.error('[nfe] falha ao emitir', ref, e.message);
      if (provider.name === 'focusnfe' && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        saveResult(invoiceId, { status: 'processando', message: 'Sem resposta da Focus NFe; consultando…' });
        schedulePoll(invoiceId);
      } else {
        saveResult(invoiceId, { status: 'erro', message: 'Falha de comunicação com o emissor: ' + e.message });
      }
    }
  })();
  await Promise.race([job, new Promise(r => setTimeout(r, waitMs).unref?.())]);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
}

// Reenvio pelo painel: se já autorizada, devolve; se processando, consulta; senão emite de novo com nova ref.
async function retryForOrder(orderId) {
  const inv = latestInvoice(orderId);
  if (inv && (inv.status === 'autorizada' || inv.status === 'cancelada')) return inv;
  if (inv && inv.status === 'processando') {
    try {
      const r = await getProvider().status(inv.ref);
      if (r && r.status) saveResult(inv.id, r);
      const now = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
      if (now.status !== 'erro') return now;
    } catch (e) { return inv; }
  }
  return emitForOrder(orderId);
}

async function cancelForOrder(orderId, reason) {
  const inv = latestInvoice(orderId);
  if (!inv || inv.status !== 'autorizada') return { error: 'Não há nota autorizada para cancelar' };
  const r = await getProvider().cancel(inv.ref, reason);
  if (r && r.status === 'cancelada') saveResult(inv.id, r);
  else return { error: (r && r.message) || 'Falha ao cancelar', invoice: inv };
  return { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id) };
}

function publicInvoice(inv) {
  if (!inv) return null;
  return {
    provider: inv.provider, mode: inv.provider === 'mock' ? 'mock' : getConfig().mode,
    status: inv.status, number: inv.number, series: inv.series, access_key: inv.access_key,
    danfe_url: inv.danfe_url, xml_url: inv.provider === 'mock' ? null : inv.xml_url, qrcode_url: inv.qrcode_url,
    message: inv.message, created_at: inv.created_at,
  };
}

module.exports = { getConfig, getProvider, emitForOrder, retryForOrder, cancelForOrder, latestInvoice, publicInvoice, loadDoc };
