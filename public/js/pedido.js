// Acompanhamento do pedido: status ao vivo (consulta a cada 10s), Pix, nota fiscal e WhatsApp da loja.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const money = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const params = new URLSearchParams(location.search);
  const code = String(params.get('c') || '').trim().toUpperCase();
  const isNew = params.get('novo') === '1';
  const POLL_MS = 10000;

  const ICONS = {
    recebido: '<svg viewBox="0 0 24 24"><path d="M9 4h6l1 2h3v15H5V6h3z"/><path d="M9 12l2 2 4-4"/></svg>',
    preparo: '<svg viewBox="0 0 24 24"><path d="M12 3c-1 2 1 3 0 5M8 4c-1 2 1 3 0 5M16 4c-1 2 1 3 0 5"/><path d="M3 13h18M5 13c0 4 3 7 7 7s7-3 7-7"/></svg>',
    saiu: '<svg viewBox="0 0 24 24"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-7h5l3 7M14 6h3l1 4"/></svg>',
    entregue: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9H3z"/><path d="M9 20v-6h6v6"/></svg>',
    retirada: '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 016 0v2"/></svg>',
  };

  function stepsFor(o) {
    const pickup = o.delivery_type === 'retirada';
    return [
      { id: 'recebido', label: 'Recebido', sub: 'A loja recebeu seu pedido' },
      { id: 'preparo', label: 'Em preparo', sub: 'Seu lanche está na chapa' },
      pickup ? { id: 'saiu', label: 'Pronto para retirar', sub: 'Pode vir buscar no balcão', icon: 'retirada' }
             : { id: 'saiu', label: 'Saiu para entrega', sub: 'O entregador está a caminho' },
      { id: 'entregue', label: pickup ? 'Retirado' : 'Entregue', sub: 'Bom apetite!' },
    ];
  }
  const ORDER = ['recebido', 'preparo', 'saiu', 'entregue'];

  let timer = null, last = null;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 250); }, 2500);
  }

  async function copy(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
    }
    if (ok && btn) {
      const old = btn.innerHTML; btn.classList.add('is-copied'); btn.textContent = 'Copiado!';
      setTimeout(() => { btn.classList.remove('is-copied'); btn.innerHTML = old; }, 2000);
    }
    toast(ok ? 'Copiado!' : 'Não deu para copiar. Selecione e copie manualmente.');
  }

  const parseDate = s => new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  const hhmm = d => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  function render(o) {
    $('#loading').hidden = true;
    ['hero', 'track', 'itemsCard', 'actions'].forEach(id => { $('#' + id).hidden = false; });
    document.title = `Pedido ${o.code} · ${o.store.name || 'Garage Burger'}`;
    $('#code').textContent = o.code;

    const cancelled = o.status === 'cancelado';
    const idx = ORDER.indexOf(o.status);
    const hero = $('#hero');
    hero.classList.toggle('is-cancel', cancelled);
    const first = o.customer.first_name ? `, ${o.customer.first_name}` : '';
    if (cancelled) { $('#heroTitle').textContent = 'Pedido cancelado'; $('#heroSub').textContent = 'Fale com a loja se precisar de ajuda.'; }
    else if (o.status === 'entregue') { $('#heroTitle').textContent = `Bom apetite${first}!`; $('#heroSub').textContent = 'Obrigado por pedir na Garage Burger.'; }
    else if (isNew && idx === 0) { $('#heroTitle').textContent = `Pedido confirmado${first}!`; $('#heroSub').textContent = 'Já recebemos e logo vai pra chapa.'; }
    else { $('#heroTitle').textContent = o.status_label; $('#heroSub').textContent = 'Acompanhe abaixo — atualiza sozinho.'; }

    // rastreador
    const times = {};
    (o.timeline || []).forEach(t => { times[t.status] = t.at; });
    $('#steps').innerHTML = stepsFor(o).map((s, i) => {
      const cls = cancelled ? '' : i < idx ? 'is-done' : i === idx ? (o.status === 'entregue' ? 'is-done' : 'is-current') : '';
      const at = times[s.id] ? ` · ${hhmm(parseDate(times[s.id]))}` : '';
      return `<li class="pd-step ${cls}" ${i === idx ? 'aria-current="step"' : ''}>
        <span class="pd-ic" aria-hidden="true">${ICONS[s.icon || s.id]}</span>
        <div><b>${esc(s.label)}</b><small>${esc(s.sub)}${esc(at)}</small></div></li>`;
    }).join('');
    $('#cancelled').hidden = !cancelled;
    $('#live').hidden = cancelled || o.status === 'entregue';

    const created = parseDate(o.created_at);
    const eta = o.eta || { eta_min: 30, eta_max: 50 };
    if (!cancelled && o.status !== 'entregue') {
      const a = new Date(created.getTime() + eta.eta_min * 60e3), b = new Date(created.getTime() + eta.eta_max * 60e3);
      $('#etaBox').innerHTML = `<span>${o.delivery_type === 'retirada' ? 'Previsão para retirar' : 'Previsão de chegada'}</span><b>${hhmm(a)} – ${hhmm(b)}</b>`;
    } else $('#etaBox').innerHTML = `<span>Pedido feito às</span><b>${hhmm(created)}</b>`;

    renderPix(o);
    renderInvoice(o);

    // itens
    $('#items').innerHTML = o.items.map(i => {
      const mods = (i.removed || []).map(r => `<span class="ck-mod ck-mod-sem">sem ${esc(r)}</span>`)
        .concat((i.addons || []).map(a => `<span class="ck-mod ck-mod-add">+ ${esc(a.name)}</span>`));
      return `<li><div><span><span class="q">${i.qty}×</span>${esc(i.name)}</span>${mods.length ? `<div class="ck-mods">${mods.join('')}</div>` : ''}
        ${i.notes ? `<small>“${esc(i.notes)}”</small>` : ''}</div><span class="p">${money(i.unit_price_cents * i.qty)}</span></li>`;
    }).join('');
    $('#totals').innerHTML = `<div><dt>Subtotal</dt><dd>${money(o.subtotal_cents)}</dd></div>
      ${o.delivery_type === 'delivery' ? `<div><dt>Entrega</dt><dd>${o.delivery_fee_cents ? money(o.delivery_fee_cents) : 'Grátis'}</dd></div>` : ''}
      <div class="ck-total"><dt>Total</dt><dd>${money(o.total_cents)}</dd></div>`;
    const pay = { pix: 'Pix', cartao: 'Cartão na entrega', dinheiro: 'Dinheiro' }[o.payment_method] || o.payment_method;
    $('#meta').innerHTML = `
      <span><b>Pagamento:</b> ${esc(pay)}${o.payment_method === 'dinheiro' && o.change_for_cents ? ` · troco para ${money(o.change_for_cents)}` : ''}</span>
      <span><b>${o.delivery_type === 'retirada' ? 'Retirada' : 'Entrega'}:</b> ${o.delivery_type === 'retirada' ? 'no balcão' : esc(o.address || '')}</span>
      ${o.notes ? `<span><b>Obs.:</b> ${esc(o.notes)}</span>` : ''}`;

    // WhatsApp
    const wa = String(o.store.whatsapp || o.store.phone || '').replace(/\D/g, '');
    const waBtn = $('#waBtn');
    if (wa.length >= 10) {
      const num = wa.length <= 11 ? '55' + wa : wa;
      const msg = `Olá! Sobre o meu pedido ${o.code} (${money(o.total_cents)}):`;
      waBtn.href = `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
      waBtn.hidden = false;
    } else waBtn.hidden = true;

    if (last && last.status !== o.status && 'vibrate' in navigator) { try { navigator.vibrate(80); } catch {} }
    last = o;
  }

  function renderPix(o) {
    const box = $('#pix');
    const p = o.pix;
    if (!p || o.status === 'cancelado' || o.status === 'entregue') { box.hidden = true; return; }
    box.hidden = false;
    $('#pixAmount').textContent = money(o.total_cents);
    if (!p.enabled) {
      $('#pixBody').innerHTML = `<p class="pd-note">${esc(p.message || 'Pague com Pix na entrega/retirada.')}</p>`;
      return;
    }
    if ($('#pixBody').dataset.payload === p.copia_e_cola) return; // não redesenha a cada consulta
    $('#pixBody').dataset.payload = p.copia_e_cola;
    $('#pixBody').innerHTML = `
      <div class="pd-qr"><img src="${esc(p.qr_url)}" alt="QR Code Pix de ${esc(money(o.total_cents))}" width="220" height="220"></div>
      <div class="pd-copy">
        <label class="sr-only" for="pixCode">Pix copia e cola</label>
        <textarea class="gb-input" id="pixCode" readonly>${esc(p.copia_e_cola)}</textarea>
        <button type="button" class="gb-btn" id="copyPix">Copiar código Pix</button>
      </div>
      <p class="pd-note">Abra o app do seu banco › Pix › <b>Pix copia e cola</b> (ou leia o QR). ${p.merchant_name ? `Recebedor: <b>${esc(p.merchant_name)}</b>.` : ''}
      Depois do pagamento, a loja confere e confirma.</p>`;
    $('#copyPix').addEventListener('click', e => copy(p.copia_e_cola, e.currentTarget));
  }

  function renderInvoice(o) {
    const box = $('#nf');
    const inv = o.invoice;
    box.hidden = false;
    const icon = '<span class="pd-nf-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14l-2-1-2 1-2-1-2 1-2-1-3 1z"/><path d="M9 9h6M9 13h6M9 17h3"/></svg></span>';
    if (!inv) {
      $('#nfBody').innerHTML = `<div class="pd-nf-row">${icon}<div class="pd-nf-info"><span class="pd-pill pd-pill-wait">Aguardando emissão</span>
        <span>A loja emite a NFC-e no seu CPF (${esc(o.customer.cpf_masked)}).</span></div></div>`;
      return;
    }
    const pill = {
      autorizada: '<span class="pd-pill pd-pill-ok">● Autorizada</span>',
      processando: '<span class="pd-pill pd-pill-wait">● Processando na SEFAZ</span>',
      erro: '<span class="pd-pill pd-pill-err">● Pendente</span>',
      cancelada: '<span class="pd-pill pd-pill-err">● Cancelada</span>',
    }[inv.status] || `<span class="pd-pill pd-pill-wait">${esc(inv.status)}</span>`;
    const test = inv.mode === 'mock' || inv.mode === 'homologacao' ? '<small>Ambiente de teste — sem valor fiscal</small>' : '';
    const num = inv.number ? `<span>NFC-e nº <b>${esc(inv.number)}</b> · Série ${esc(inv.series || '1')}</span>` : '';
    const sub = inv.status === 'erro' ? '<span>A loja vai reemitir a nota. Seu pedido segue normalmente.</span>'
      : inv.status === 'processando' ? '<span>Isso costuma levar alguns segundos.</span>' : '';
    const key = inv.access_key ? `<span class="pd-key">${esc(inv.access_key.replace(/(\d{4})(?=\d)/g, '$1 '))}</span>` : '';
    const btn = inv.status === 'autorizada' && inv.danfe_url
      ? `<a class="gb-btn gb-btn--ghost" id="danfeBtn" href="${esc(inv.provider === 'mock' ? inv.danfe_url : '/api/orders/' + encodeURIComponent(o.code) + '/danfe')}" target="_blank" rel="noopener">Ver nota fiscal (DANFE)</a>` : '';
    $('#nfBody').innerHTML = `<div class="pd-nf-row">${icon}<div class="pd-nf-info">${pill}${num}${sub}${test}</div></div>${key}${btn}`;
  }

  async function load() {
    try {
      const r = await fetch('/api/orders/' + encodeURIComponent(code), { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 404) { $('#loading').hidden = true; $('#notFound').hidden = false; return stop(); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const o = await r.json();
      render(o);
      if (o.status === 'entregue' || o.status === 'cancelado') {
        // segue consultando devagar só se a nota ainda estiver pendente
        if (!o.invoice || o.invoice.status === 'processando') schedule(30000); else stop();
      } else schedule(POLL_MS);
    } catch (e) {
      if (!last) $('#loading').innerHTML = '<p>Sem conexão. Tentando de novo…</p>';
      schedule(POLL_MS);
    }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(load, ms); }
  function stop() { clearTimeout(timer); timer = null; }

  function init() {
    if (!/^GB-[A-Z0-9]{4,6}$/.test(code)) { $('#loading').hidden = true; $('#notFound').hidden = false; return; }
    $('#codeBtn').addEventListener('click', () => copy(code));
    // volta a consultar na hora quando o cliente reabre a aba
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && timer) { schedule(0); } });
    if (isNew && history.replaceState) history.replaceState(null, '', '/pedido?c=' + encodeURIComponent(code));
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
