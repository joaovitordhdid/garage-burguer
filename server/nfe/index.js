// Emissão de NFC-e: escolhe o provedor (mock | focusnfe), grava em `invoices` e acompanha o status.
// Interface do provedor: emit(doc, {timeoutMs}) / status(ref, {timeoutMs}) / cancel(ref, reason) -> { status, number, series,
//   access_key, danfe_url, xml_url, qrcode_url, message }, com status em: processando | autorizada | erro | cancelada.
//
// Sem servidor contínuo (Vercel): nada roda em segundo plano. A nota é emitida durante o pedido (esperando até
// waitMs); se ficar "processando", ela é consultada de novo quando alguém lê o pedido (refreshIfStale, no máximo
// a cada 20 s por nota) ou quando a automação chama refreshPending().
'use strict';
const { db, getSetting } = require('../db');
const { createMockProvider } = require('./mock');
const { createFocusProvider } = require('./focusnfe');

const UF_CODES = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 };

const REFRESH_EVERY_S = 20;      // intervalo mínimo entre consultas da mesma nota
const READ_TIMEOUT_MS = 6000;    // consulta feita durante uma leitura de página
const RETRY_MAX_ATTEMPTS = 3;    // tentativas automáticas por pedido (notas com erro)
const RETRY_AFTER_S = 60;        // espera mínima antes de reenviar uma nota com erro

function buildConfig(s) {
  const cfg = {
    mode: 'mock', provider: 'focusnfe', token: '', cnpj: '', inscricao_estadual: '', regime_tributario: '1',
    csc_id: '', csc_token: '', auto_emit: true, auto_retry: true, uf: 'SP', ...(s || {}),
  };
  if (process.env.NFE_MODE) cfg.mode = process.env.NFE_MODE;
  if (process.env.FOCUS_NFE_TOKEN) cfg.token = process.env.FOCUS_NFE_TOKEN;
  if (!['mock', 'homologacao', 'producao'].includes(cfg.mode)) cfg.mode = 'mock';
  const on = v => v !== false && v !== 'false' && v !== 0;
  cfg.auto_emit = on(cfg.auto_emit);
  cfg.auto_retry = on(cfg.auto_retry);
  cfg.uf_code = UF_CODES[String(cfg.uf || 'SP').toUpperCase()] || 35;
  return cfg;
}

async function getConfig() {
  return buildConfig(await getSetting('nfe', {}));
}

function getProvider(cfg) {
  if (!cfg || typeof cfg.then === 'function') throw new Error('getProvider(cfg): passe a configuração (await getConfig())');
  if (cfg.mode === 'mock') return createMockProvider(cfg);
  if (cfg.provider === 'focusnfe') {
    if (!cfg.token || !cfg.cnpj) {
      return { name: 'focusnfe', configured: false, async emit() { return { status: 'erro', message: 'NFC-e não configurada: informe token da Focus NFe e CNPJ no painel' }; },
        async status() { return null; }, async cancel() { return { status: null, message: 'NFC-e não configurada' }; } };
    }
    return createFocusProvider(cfg);
  }
  return { name: cfg.provider, configured: false, async emit() { return { status: 'erro', message: `Provedor "${cfg.provider}" não suportado` }; },
    async status() { return null; }, async cancel() { return { status: null, message: 'Provedor não suportado' }; } };
}

async function loadDoc(orderId) {
  const [order, items] = await Promise.all([
    db.get('SELECT * FROM orders WHERE id = $1', [orderId]),
    db.all(`SELECT oi.*, p.ncm, p.cfop FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
            WHERE oi.order_id = $1 ORDER BY oi.id`, [orderId]),
  ]);
  return { order, items };
}

async function latestInvoice(orderId) {
  return (await db.get('SELECT * FROM invoices WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [orderId])) || null;
}

const getInvoice = async invoiceId => (await db.get('SELECT * FROM invoices WHERE id = $1', [invoiceId])) || null;

async function saveResult(invoiceId, r) {
  return (await db.get(`UPDATE invoices SET status = $1, number = COALESCE($2, number), series = COALESCE($3, series),
              access_key = COALESCE($4, access_key), danfe_url = COALESCE($5, danfe_url), xml_url = COALESCE($6, xml_url),
              qrcode_url = COALESCE($7, qrcode_url), message = $8, updated_at = now() WHERE id = $9 RETURNING *`,
    [r.status || 'erro', r.number ?? null, r.series ?? null, r.access_key ?? null, r.danfe_url ?? null,
      r.xml_url ?? null, r.qrcode_url ?? null, r.message ? String(r.message).slice(0, 1000) : null, invoiceId])) || null;
}

const isTimeout = e => e && (e.name === 'TimeoutError' || e.name === 'AbortError');

// Consulta uma nota "processando" no emissor. Respeita o intervalo mínimo (20 s) usando updated_at como trava:
// só quem conseguir "reservar" a nota faz a consulta, então leituras simultâneas não duplicam chamadas.
// Devolve a nota (atualizada ou não). Nunca lança erro.
async function refreshIfStale(inv, { timeoutMs = READ_TIMEOUT_MS, force = false } = {}) {
  if (!inv || inv.status !== 'processando' || inv.provider === 'mock') return inv;
  try {
    const claimed = await db.get(`UPDATE invoices SET updated_at = now()
                                  WHERE id = $1 AND status = 'processando'
                                    AND ($2::boolean OR COALESCE(updated_at, created_at) < now() - make_interval(secs => $3))
                                  RETURNING *`, [inv.id, !!force, REFRESH_EVERY_S]);
    if (!claimed) return (await getInvoice(inv.id)) || inv;
    const r = await getProvider(await getConfig()).status(claimed.ref, { timeoutMs });
    if (r && r.status) return (await saveResult(claimed.id, r)) || claimed;
    return claimed;
  } catch (e) {
    console.error('[nfe] erro ao consultar', inv.ref, e.message);
    return inv;
  }
}

// Emite a nota de um pedido. Nunca lança erro: falhas viram status 'erro' com mensagem.
// waitMs: tempo máximo esperando o emissor. Sem resposta nesse prazo, a nota fica 'processando'
// e é consultada depois (refreshIfStale / refreshPending) — a Focus pode ter recebido.
async function emitForOrder(orderId, { waitMs = 8000 } = {}) {
  const cfg = await getConfig();
  const provider = getProvider(cfg);
  const doc = await loadDoc(orderId);
  if (!doc.order) return null;
  const { n: attempts } = await db.get('SELECT COUNT(*)::int AS n FROM invoices WHERE order_id = $1', [orderId]);
  const ref = `${doc.order.code}-${attempts + 1}`.replace(/[^A-Za-z0-9-]/g, '');
  doc.ref = ref;
  const { id: invoiceId } = await db.get("INSERT INTO invoices (order_id, provider, ref, status) VALUES ($1, $2, $3, 'processando') RETURNING id",
    [orderId, provider.name, ref]);

  try {
    const r = await provider.emit(doc, { timeoutMs: waitMs });
    return await saveResult(invoiceId, r);
  } catch (e) {
    console.error('[nfe] falha ao emitir', ref, e.message);
    if (provider.name === 'focusnfe' && isTimeout(e)) {
      return saveResult(invoiceId, { status: 'processando', message: 'Sem resposta da Focus NFe; consultando…' });
    }
    return saveResult(invoiceId, { status: 'erro', message: 'Falha de comunicação com o emissor: ' + e.message });
  }
}

// Reenvio pelo painel: se já autorizada, devolve; se processando, consulta; senão emite de novo com nova ref.
async function retryForOrder(orderId) {
  const inv = await latestInvoice(orderId);
  if (inv && (inv.status === 'autorizada' || inv.status === 'cancelada')) return inv;
  if (inv && inv.status === 'processando') {
    if (inv.provider === 'mock') return emitForOrder(orderId);
    try {
      const r = await getProvider(await getConfig()).status(inv.ref, { timeoutMs: 10000 });
      if (r && r.status) await saveResult(inv.id, r);
      const now = await getInvoice(inv.id);
      if (now.status !== 'erro') return now;
    } catch (e) { return inv; }
  }
  return emitForOrder(orderId);
}

// Para a automação (cron/painel): consulta as notas "processando" e reenvia as com erro.
// Reenvio só quando auto_retry está ligado (config 'nfe', padrão ligado), o emissor está configurado,
// o pedido não foi cancelado, faz mais de 60 s da última tentativa e o pedido tem menos de 3 tentativas.
// Devolve { checked, retried, updated, items: [{ order_id, code, from, to, invoice_id }] }.
async function refreshPending({ limit = 20, retryErrors, timeoutMs = 8000 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const cfg = await getConfig();
  const provider = getProvider(cfg);
  const doRetry = retryErrors ?? cfg.auto_retry;
  const out = { checked: 0, retried: 0, updated: 0, items: [] };

  // Última nota de cada pedido (pedidos dos últimos 7 dias)
  const latest = await db.all(`
    SELECT i.*, o.code, o.status AS order_status,
           (SELECT COUNT(*)::int FROM invoices x WHERE x.order_id = i.order_id) AS attempts
    FROM invoices i JOIN orders o ON o.id = i.order_id
    WHERE i.id = (SELECT MAX(id) FROM invoices y WHERE y.order_id = i.order_id)
      AND i.status IN ('processando', 'erro')
      AND o.created_at > now() - interval '7 days'
    ORDER BY i.id DESC LIMIT $1`, [lim]);

  for (const inv of latest) {
    if (inv.status === 'processando') {
      if (inv.provider === 'mock') continue;
      out.checked++;
      const now = await refreshIfStale(inv, { timeoutMs });
      if (now && now.status !== inv.status) { out.updated++; out.items.push({ order_id: inv.order_id, code: inv.code, from: inv.status, to: now.status, invoice_id: now.id }); }
      continue;
    }
    // status 'erro'
    if (!doRetry || provider.configured === false || inv.order_status === 'cancelado') continue;
    if (inv.attempts >= RETRY_MAX_ATTEMPTS) continue;
    const age = await db.get(`SELECT COALESCE(updated_at, created_at) < now() - make_interval(secs => $2) AS old FROM invoices WHERE id = $1`, [inv.id, RETRY_AFTER_S]);
    if (!age || !age.old) continue;
    out.retried++;
    const now = await emitForOrder(inv.order_id, { waitMs: timeoutMs });
    if (now) out.items.push({ order_id: inv.order_id, code: inv.code, from: 'erro', to: now.status, invoice_id: now.id });
  }
  return out;
}

async function cancelForOrder(orderId, reason) {
  const inv = await latestInvoice(orderId);
  if (!inv || inv.status !== 'autorizada') return { error: 'Não há nota autorizada para cancelar' };
  const r = await getProvider(await getConfig()).cancel(inv.ref, reason);
  if (r && r.status === 'cancelada') await saveResult(inv.id, r);
  else return { error: (r && r.message) || 'Falha ao cancelar', invoice: inv };
  return { invoice: await getInvoice(inv.id) };
}

// Versão pública da nota (sem dados internos). Assíncrona: lê o modo atual da configuração.
// cfg é opcional (passe para evitar uma leitura do banco por nota numa lista).
async function publicInvoice(inv, cfg) {
  if (!inv) return null;
  const mode = inv.provider === 'mock' ? 'mock' : (cfg || await getConfig()).mode;
  return {
    provider: inv.provider, mode,
    status: inv.status, number: inv.number, series: inv.series, access_key: inv.access_key,
    danfe_url: inv.danfe_url, xml_url: inv.provider === 'mock' ? null : inv.xml_url, qrcode_url: inv.qrcode_url,
    message: inv.message, created_at: inv.created_at,
  };
}

module.exports = {
  getConfig, getProvider, emitForOrder, retryForOrder, refreshPending, refreshIfStale, cancelForOrder,
  latestInvoice, publicInvoice, loadDoc,
};
