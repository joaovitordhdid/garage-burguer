// DANFE NFC-e em HTML, estilo cupom térmico 80mm. Usado pelo emissor de teste (mock).
'use strict';
const { toSvg } = require('./qr');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCnpj = c => { const d = String(c || '').replace(/\D/g, ''); return d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : (c || '—'); };
const maskCpf = c => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : '—'; };
const PAY = { pix: 'Pix', cartao: 'Cartão de crédito', dinheiro: 'Dinheiro' };

function renderDanfe({ order, items, invoice, store, cfg }) {
  const isMock = !invoice || invoice.provider === 'mock' || cfg.mode !== 'producao';
  const key = String(invoice?.access_key || '').replace(/(\d{4})(?=\d)/g, '$1 ');
  const dt = new Date((invoice?.created_at || order.created_at).replace(' ', 'T') + 'Z');
  const when = dt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const qr = invoice?.qrcode_url ? toSvg(invoice.qrcode_url, { border: 2 }) : '';
  const qtyTotal = items.reduce((s, i) => s + i.qty, 0);
  const rows = items.map((it, i) => {
    let extras = [];
    try { extras = JSON.parse(it.addons || '[]').map(a => '+ ' + a.name); } catch {}
    try { extras = extras.concat(JSON.parse(it.removed || '[]').map(r => 'sem ' + r)); } catch {}
    return `<tr><td colspan="4" class="d">${String(i + 1).padStart(3, '0')} ${esc(it.product_id || '')} ${esc(it.name)}${extras.length ? `<br><small>${esc(extras.join(', '))}</small>` : ''}
      <br><small>NCM ${esc(it.ncm || '21069090')} · CFOP ${esc(it.cfop || '5102')}</small></td></tr>
      <tr><td>${it.qty} UN</td><td class="r">x ${brl(it.unit_price_cents)}</td><td></td><td class="r">${brl(it.unit_price_cents * it.qty)}</td></tr>`;
  }).join('');
  const paid = order.payment_method === 'dinheiro' && order.change_for_cents > order.total_cents ? order.change_for_cents : order.total_cents;

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DANFE NFC-e ${esc(invoice?.number || '')} · ${esc(order.code)}</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#3a3a3f;font:12px/1.35 'Courier New',ui-monospace,monospace;color:#111;padding:16px}
  .cupom{position:relative;max-width:340px;margin:0 auto;background:#fffef8;padding:18px 14px 24px;box-shadow:0 10px 30px rgba(0,0,0,.4);overflow:hidden}
  .cupom:after{content:'';position:absolute;left:0;right:0;bottom:-8px;height:16px;background:radial-gradient(circle at 8px 0,transparent 7px,#fffef8 8px) repeat-x;background-size:16px 16px}
  h1{font-size:14px;margin:0 0 2px;text-align:center;text-transform:uppercase} .c{text-align:center} .r{text-align:right}
  hr{border:0;border-top:1px dashed #555;margin:8px 0} table{width:100%;border-collapse:collapse} td{padding:1px 0;vertical-align:top}
  td.d{padding-top:4px} small{font-size:10.5px;color:#333} .tot td{font-weight:bold;font-size:13px}
  .key{font-size:11px;word-break:break-all;text-align:center;letter-spacing:.5px} .qr{width:150px;margin:6px auto} .qr svg{width:100%;height:auto;display:block}
  .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
  .wm span{transform:rotate(-35deg);font:900 30px/1.1 Arial,sans-serif;color:rgba(220,0,0,.17);text-align:center;border:4px solid rgba(220,0,0,.17);padding:8px 12px;white-space:nowrap}
  .test{background:#111;color:#fff;text-align:center;font-weight:bold;padding:4px;margin:6px 0;font-size:11px}
  .bar{display:flex;gap:8px;justify-content:center;margin:14px auto 0;max-width:340px}
  .bar a{flex:1;text-align:center;background:#ffb000;color:#1a1200;font:700 13px Arial,sans-serif;padding:10px;border-radius:999px;text-decoration:none}
  @media print{body{background:#fff;padding:0}.cupom{box-shadow:none}.bar{display:none}}
</style></head><body>
<div class="cupom">
  ${isMock ? '<div class="wm" aria-hidden="true"><span>SEM VALOR FISCAL<br>AMBIENTE DE TESTE</span></div>' : ''}
  <h1>${esc(cfg.razao_social || store.name || 'Garage Burger')}</h1>
  <div class="c">CNPJ ${esc(fmtCnpj(cfg.cnpj))} · IE ${esc(cfg.inscricao_estadual || '—')}</div>
  <div class="c">${esc(store.address || '')}</div>
  <hr>
  <div class="c"><b>DANFE NFC-e</b><br>Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</div>
  ${isMock ? '<div class="test">EMITIDA EM AMBIENTE DE TESTE — SEM VALOR FISCAL</div>' : ''}
  <hr>
  <table><tr><td><b>#</b> CÓD DESCRIÇÃO</td></tr></table>
  <table><tr><td>QTD UN</td><td class="r">VL UNIT</td><td></td><td class="r">VL TOTAL</td></tr>${rows}</table>
  <hr>
  <table>
    <tr><td>Qtd. total de itens</td><td class="r">${qtyTotal}</td></tr>
    <tr><td>Valor dos produtos R$</td><td class="r">${brl(order.subtotal_cents)}</td></tr>
    ${order.delivery_fee_cents ? `<tr><td>Frete / entrega R$</td><td class="r">${brl(order.delivery_fee_cents)}</td></tr>` : ''}
    <tr class="tot"><td>VALOR A PAGAR R$</td><td class="r">${brl(order.total_cents)}</td></tr>
    <tr><td>FORMA DE PAGAMENTO</td><td class="r">VALOR PAGO R$</td></tr>
    <tr><td>${esc(PAY[order.payment_method] || order.payment_method)}</td><td class="r">${brl(paid)}</td></tr>
    ${paid > order.total_cents ? `<tr><td>Troco R$</td><td class="r">${brl(paid - order.total_cents)}</td></tr>` : ''}
  </table>
  <hr>
  <div class="c">Consulte pela chave de acesso em<br>www.nfce.fazenda.gov.br/consulta</div>
  <div class="key">${esc(key || '—')}</div>
  <hr>
  <div class="c"><b>CONSUMIDOR</b> — CPF ${esc(maskCpf(order.customer_cpf))}<br>${esc(order.customer_name)}</div>
  <hr>
  <div class="c"><b>NFC-e nº ${esc(String(invoice?.number || '').padStart(9, '0'))} Série ${esc(String(invoice?.series || '1').padStart(3, '0'))}</b><br>Emissão: ${esc(when)}<br>
  ${isMock ? 'Protocolo: TESTE-SEM-VALOR' : `Situação: ${esc(invoice?.status || '')}`}</div>
  ${qr ? `<div class="qr">${qr}</div>` : ''}
  <div class="c"><small>Pedido ${esc(order.code)} · Tributos conforme Lei 12.741/2012: consulte o estabelecimento</small></div>
</div>
<div class="bar"><a href="/pedido?c=${encodeURIComponent(order.code)}">Voltar ao pedido</a></div>
</body></html>`;
}

module.exports = { renderDanfe, maskCpf };
