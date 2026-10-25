// Cupons para impressora térmica (58 mm ou 80 mm): via da cozinha e via de entrega.
// HTML puro, só preto, monoespaçado, sem scripts (o painel imprime pelo iframe).
'use strict';
const { toSvg } = require('../nfe/qr');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = c => 'R$ ' + ((Number(c) || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PAY = { pix: 'PIX', cartao: 'CARTÃO (maquininha)', dinheiro: 'DINHEIRO' };

function parseTs(ts) {
  if (!ts) return new Date();
  if (ts instanceof Date) return ts;
  return new Date(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z'));
}
const localTime = (ts, opts = { hour: '2-digit', minute: '2-digit' }) =>
  parseTs(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', ...opts });
const localDateTime = ts => localTime(ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');

function json(v, fb) {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v || 'null') ?? fb; } catch { return fb; }
}

function formatPhone(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

function mapUrl(o) {
  if (o.lat != null && o.lng != null) return `https://www.google.com/maps?q=${Number(o.lat)},${Number(o.lng)}`;
  if (o.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}`;
  return null;
}

function css(width) {
  const w58 = String(width) === '58';
  const paper = w58 ? 58 : 80;
  const content = w58 ? 48 : 72;
  const base = w58 ? 11 : 13;
  return `
  @page { size: ${paper}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { font: 700 ${base}px/1.3 'Courier New', Courier, ui-monospace, monospace; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .via { width: ${content}mm; margin: 0 auto; padding: 2mm 0 6mm; page-break-after: always; break-after: page; }
  .via:last-child { page-break-after: auto; break-after: auto; }
  .c { text-align: center; } .r { text-align: right; }
  .tag { display: block; text-align: center; border: 2px solid #000; padding: 1mm 0; font-size: ${base + 1}px; letter-spacing: 2px; }
  .code { font-size: ${w58 ? 26 : 34}px; line-height: 1.1; text-align: center; margin: 1.5mm 0; letter-spacing: 1px; }
  .big { font-size: ${base + 5}px; }
  .huge { font-size: ${base + 9}px; line-height: 1.15; }
  .inv { background: #000; color: #fff; padding: 0 1mm; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
  hr.solid { border-top: 2px solid #000; }
  .row { display: flex; justify-content: space-between; gap: 2mm; }
  .row > :last-child { text-align: right; white-space: nowrap; }
  .item { margin: 1.5mm 0; }
  .item .name { font-size: ${base + 4}px; }
  .mod { font-size: ${base + 3}px; margin-left: 3mm; }
  .minus { text-decoration: underline; }
  .note { font-size: ${base + 3}px; border: 2px solid #000; padding: 1mm 1.5mm; margin: 1.5mm 0; }
  .muted { font-weight: 400; }
  .qr { width: ${w58 ? 30 : 38}mm; margin: 2mm auto 0; }
  .qr svg { width: 100%; height: auto; display: block; }
  .small { font-size: ${base - 2}px; font-weight: 400; }
  @media screen { body { background: #eee; } .via { background: #fff; margin: 4mm auto; padding: 3mm; box-shadow: 0 1px 4px rgba(0,0,0,.3); width: ${content + 6}mm; } }
  `;
}

function page(title, width, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${css(width)}</style></head><body>${body}</body></html>`;
}

function itemsBlock(items, { prices }) {
  return items.map(it => {
    const removed = json(it.removed, []);
    const addons = json(it.addons, []);
    return `<div class="item">
      <div class="row"><span class="name">${it.qty}x ${esc(String(it.name).toUpperCase())}</span>${prices ? `<span>${brl(it.qty * it.unit_price_cents)}</span>` : ''}</div>
      ${removed.map(r => `<div class="mod minus">SEM ${esc(String(r).toUpperCase())}</div>`).join('')}
      ${addons.map(a => `<div class="mod">+ ${esc(String(a.name).toUpperCase())}${prices && a.price_cents ? ` <span class="muted">(${brl(a.price_cents)})</span>` : ''}</div>`).join('')}
      ${it.notes ? `<div class="mod">OBS: ${esc(it.notes)}</div>` : ''}
    </div>`;
  }).join('<hr>');
}

function deliveryLabel(o) { return o.delivery_type === 'retirada' ? 'RETIRADA NO BALCÃO' : 'ENTREGA'; }

function kitchenVia({ order: o, items, settings, copy, copies }) {
  const eta = parseTs(o.accepted_at || o.created_at).getTime() + (Number(settings.prep_minutes) || 0) * 60e3;
  return `<section class="via">
    <span class="tag">VIA DA COZINHA${copies > 1 ? ` ${copy}/${copies}` : ''}</span>
    <div class="code">${esc(o.code)}</div>
    <div class="c big">${deliveryLabel(o)}</div>
    <div class="row"><span>${localDateTime(o.created_at)}</span>${settings.prep_minutes ? `<span>Pronto até ${localTime(new Date(eta))}</span>` : ''}</div>
    <div>${esc(String(o.customer_name).split(' ')[0])}</div>
    <hr class="solid">
    ${itemsBlock(items, { prices: false })}
    ${o.notes && o.notes !== '[exemplo]' ? `<hr class="solid"><div class="note">OBS DO PEDIDO: ${esc(o.notes)}</div>` : ''}
    <hr class="solid">
    <div class="c">${items.reduce((s, i) => s + i.qty, 0)} item(ns)</div>
  </section>`;
}

function deliveryVia({ order: o, items, store, invoice, copy, copies }) {
  const map = o.delivery_type === 'delivery' ? mapUrl(o) : null;
  const change = o.payment_method === 'dinheiro' && o.change_for_cents > o.total_cents ? o.change_for_cents - o.total_cents : 0;
  return `<section class="via">
    <div class="c big">${esc(store.name || 'Garage Burger')}</div>
    ${store.phone || store.whatsapp ? `<div class="c small">${esc(formatPhone(store.whatsapp || store.phone))}</div>` : ''}
    <span class="tag">${o.delivery_type === 'retirada' ? 'VIA DO BALCÃO' : 'VIA DE ENTREGA'}${copies > 1 ? ` ${copy}/${copies}` : ''}</span>
    <div class="code">${esc(o.code)}</div>
    <div class="c">${localDateTime(o.created_at)} · ${deliveryLabel(o)}</div>
    <hr class="solid">
    <div class="big">${esc(o.customer_name)}</div>
    <div>Tel: ${esc(formatPhone(o.customer_phone))}</div>
    ${o.delivery_type === 'delivery' ? `
      <div class="big">${esc(o.address || 'Endereço não informado')}</div>
      ${o.address_ref ? `<div>Ref.: ${esc(o.address_ref)}</div>` : ''}` : ''}
    <hr>
    ${itemsBlock(items, { prices: true })}
    <hr class="solid">
    <div class="row"><span>Subtotal</span><span>${brl(o.subtotal_cents)}</span></div>
    ${o.delivery_fee_cents ? `<div class="row"><span>Taxa de entrega</span><span>${brl(o.delivery_fee_cents)}</span></div>` : ''}
    <div class="row huge"><span>TOTAL</span><span>${brl(o.total_cents)}</span></div>
    <hr>
    <div class="big">Pagamento: ${esc(PAY[o.payment_method] || o.payment_method)}</div>
    ${o.payment_method === 'dinheiro' ? (change
      ? `<div class="big inv">LEVAR TROCO: ${brl(change)}</div><div>(cliente paga com ${brl(o.change_for_cents)})</div>`
      : '<div>Sem troco</div>') : ''}
    ${o.payment_method === 'pix' ? '<div class="small">Conferir se o Pix foi pago</div>' : ''}
    ${o.notes && o.notes !== '[exemplo]' ? `<div class="note">OBS: ${esc(o.notes)}</div>` : ''}
    ${invoice && invoice.status === 'autorizada' && invoice.number ? `<div class="small">NFC-e nº ${esc(invoice.number)}${invoice.series ? ` série ${esc(invoice.series)}` : ''}</div>` : ''}
    ${map ? `<hr><div class="c">Localização do cliente</div><div class="qr">${toSvg(map, { border: 1 })}</div>` : ''}
  </section>`;
}

// vias: ['cozinha', 'entrega']; copies: 1 a 3
function renderReceipt({ order, items, store = {}, settings = {}, invoice = null, vias = ['cozinha', 'entrega'], copies = 1, width = '80' }) {
  const parts = [];
  const n = Math.min(Math.max(parseInt(copies, 10) || 1, 1), 3);
  for (let copy = 1; copy <= n; copy++) {
    if (vias.includes('cozinha')) parts.push(kitchenVia({ order, items, settings, copy, copies: n }));
    if (vias.includes('entrega')) parts.push(deliveryVia({ order, items, store, invoice, copy, copies: n }));
  }
  if (!parts.length) parts.push('<section class="via"><div class="c">Nada para imprimir</div></section>');
  return page(`Pedido ${order.code}`, width, parts.join(''));
}

function renderTest({ store = {}, width = '80' }) {
  const now = new Date();
  return page('Teste de impressão', width, `<section class="via">
    <span class="tag">TESTE DE IMPRESSÃO</span>
    <div class="code">GB-TESTE</div>
    <div class="c big">${esc(store.name || 'Garage Burger')}</div>
    <div class="c">${localDateTime(now)}</div>
    <hr class="solid">
    <div>Papel configurado: ${String(width) === '58' ? '58' : '80'} mm</div>
    <div class="huge">TEXTO GRANDE</div>
    <div class="mod minus">SEM CEBOLA</div>
    <div class="mod">+ BACON EXTRA</div>
    <div class="row"><span>Linha com valor</span><span>${brl(4290)}</span></div>
    <div class="small">Se esta via saiu inteira, sem cortes nas laterais, a impressora está pronta.</div>
    <hr>
    <div class="c">QR Code de teste</div>
    <div class="qr">${toSvg('https://www.google.com/maps', { border: 1 })}</div>
  </section>`);
}

module.exports = { renderReceipt, renderTest, mapUrl, formatPhone, localTime, parseTs };
