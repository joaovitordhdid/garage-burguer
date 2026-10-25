// Painel: Pedidos (lista, status, nota fiscal, mapa).
(function () {
  'use strict';
  const A = window.GBA;
  const { h } = A;

  const LABEL = { recebido: 'Recebido', preparo: 'Em preparo', saiu: 'Saiu p/ entrega', entregue: 'Entregue', cancelado: 'Cancelado' };
  const PAY = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
  const INV = { processando: 'Processando', autorizada: 'Autorizada', erro: 'Erro', cancelada: 'Cancelada' };
  const FILTERS = [['abertos', 'Em aberto'], ['', 'Todos'], ['recebido', 'Recebidos'], ['preparo', 'Em preparo'], ['saiu', 'Saíram'], ['entregue', 'Entregues'], ['cancelado', 'Cancelados']];

  function nextStep(o) {
    if (o.status === 'recebido') return ['preparo', 'Iniciar preparo'];
    if (o.status === 'preparo') return ['saiu', o.delivery_type === 'retirada' ? 'Pronto p/ retirada' : 'Saiu p/ entrega'];
    if (o.status === 'saiu') return ['entregue', o.delivery_type === 'retirada' ? 'Retirado' : 'Entregue'];
    return null;
  }
  const statusLabel = (o, s = o.status) => (s === 'saiu' && o.delivery_type === 'retirada' ? 'Pronto p/ retirada' : LABEL[s]);

  let state = { filter: 'abertos', q: '' };
  let listEl = null;
  let countsEl = null;
  let loading = false;

  async function load() {
    if (!listEl || loading) return;
    loading = true;
    try {
      const p = new URLSearchParams({ limit: '100' });
      if (state.filter) p.set('status', state.filter);
      if (state.q) p.set('q', state.q);
      const r = await A.api('/api/admin/orders?' + p);
      renderCounts(r.today_counts);
      renderList(r.orders);
    } catch (e) { A.fail(e); } finally { loading = false; }
  }

  function renderCounts(c) {
    if (!countsEl) return;
    A.clear(countsEl);
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    countsEl.append(
      h('div.mini-kpi', h('small', 'Hoje'), h('strong', total)),
      ...['recebido', 'preparo', 'saiu', 'entregue', 'cancelado'].map(s => h('div.mini-kpi', { class: 'st-' + s }, h('small', LABEL[s]), h('strong', c[s] || 0))));
  }

  function renderList(orders) {
    A.clear(listEl);
    if (!orders.length) { listEl.appendChild(A.empty('Nenhum pedido aqui.', state.filter === 'abertos' ? 'Os pedidos novos aparecem sozinhos (atualiza a cada 15 s).' : '')); return; }
    for (const o of orders) listEl.appendChild(card(o));
  }

  function card(o) {
    const isNew = A.newOrderIds && A.newOrderIds.has(o.id);
    const step = nextStep(o);
    const mins = A.minutesAgo(o.created_local);
    const late = ['recebido', 'preparo'].includes(o.status) && mins > 40;
    const inv = o.invoice;
    const phoneDigits = String(o.customer_phone || '').replace(/\D/g, '');
    const wa = phoneDigits ? `https://wa.me/55${phoneDigits.replace(/^55/, '')}` : null;

    const statusSel = A.select('status', A.state.statuses || Object.keys(LABEL).map(s => [s, statusLabel(o, s)]), o.status, { 'aria-label': 'Mudar status', class: 'status-select' });
    statusSel.addEventListener('change', () => setStatus(o, statusSel.value, statusSel));
    if (o.status === 'cancelado') statusSel.disabled = true;

    return h('article.order', { class: `st-${o.status}${isNew ? ' order--new' : ''}`, dataset: { id: o.id } },
      h('header.order__head',
        h('div',
          h('div.order__code', o.code, isNew ? h('span.tag.tag--new', 'NOVO') : null),
          h('small.muted', `${A.fmtDateTime(o.created_local)} · ${mins < 60 ? `há ${mins} min` : `há ${Math.floor(mins / 60)} h`}`, late ? h('span.tag.tag--warn', 'atrasado') : null)),
        h('span.pill', { class: 'pill--' + o.status }, statusLabel(o))),
      h('div.order__customer',
        h('strong', o.customer_name),
        h('div.order__meta',
          wa ? h('a', { href: wa, target: '_blank', rel: 'noopener' }, A.icon('phone'), formatPhone(phoneDigits)) : null,
          o.customer_cpf ? h('span.muted', { title: 'CPF (parcialmente oculto)' }, `CPF ${o.customer_cpf}`) : null)),
      o.delivery_type === 'delivery'
        ? h('div.order__addr', A.icon('map'),
          h('div', h('span', o.address || 'Endereço não informado'), o.address_ref ? h('small.muted', ` · ${o.address_ref}`) : null,
            o.map_url ? h('a.link', { href: o.map_url, target: '_blank', rel: 'noopener' }, o.lat != null ? ' Ver no mapa ↗' : ' Buscar no mapa ↗') : null))
        : h('div.order__addr', h('span.tag', 'Retirada no balcão')),
      h('ul.order__items', o.items.map(it => h('li',
        h('span.qty', `${it.qty}×`),
        h('div',
          h('span', it.name),
          it.removed && it.removed.length ? h('div.mods.mods--minus', it.removed.map(r => `sem ${r}`).join(' · ')) : null,
          it.addons && it.addons.length ? h('div.mods.mods--plus', it.addons.map(a => `+ ${a.name}`).join(' · ')) : null,
          it.notes ? h('div.mods', `“${it.notes}”`) : null),
        h('span.price', A.money(it.qty * it.unit_price_cents))))),
      o.notes && o.notes !== '[exemplo]' ? h('p.order__notes', `Obs.: ${o.notes}`) : null,
      h('div.order__totals',
        h('span', `${PAY[o.payment_method] || o.payment_method}${o.payment_method === 'dinheiro' && o.change_for_cents ? ` · troco p/ ${A.money(o.change_for_cents)} (${A.money(o.change_for_cents - o.total_cents)})` : ''}`),
        o.delivery_fee_cents ? h('small.muted', `entrega ${A.money(o.delivery_fee_cents)}`) : null,
        h('strong', A.money(o.total_cents))),
      h('div.order__invoice',
        A.icon('doc'),
        inv ? h('span', 'NFC-e ', h('span.inv', { class: 'inv--' + inv.status }, INV[inv.status] || inv.status || '—'), inv.number ? ` nº ${inv.number}` : '') : h('span.muted', 'Sem nota fiscal'),
        inv && inv.danfe_url ? h('a.link', { href: inv.danfe_url, target: '_blank', rel: 'noopener' }, 'DANFE ↗') : null,
        inv && inv.status === 'erro' && inv.message ? h('small.inv-msg', inv.message) : null,
        h('span.spacer'),
        (!inv || ['erro', 'processando'].includes(inv.status)) && o.status !== 'cancelado'
          ? h('button.btn-text.small', { type: 'button', on: { click: (e) => retryInvoice(o, e.currentTarget) } }, inv ? 'Reemitir nota' : 'Emitir nota') : null,
        inv && inv.status === 'autorizada'
          ? h('button.btn-text.small.danger', { type: 'button', on: { click: () => cancelInvoice(o) } }, 'Cancelar nota') : null),
      h('div.order__print',
        A.icon('print'),
        h('span.muted', 'Imprimir:'),
        h('button.btn-text.small', { type: 'button', on: { click: () => A.printer.order(o, 'cozinha') } }, 'Cozinha'),
        h('button.btn-text.small', { type: 'button', on: { click: () => A.printer.order(o, 'entrega') } }, o.delivery_type === 'retirada' ? 'Balcão' : 'Entrega'),
        inv && inv.status === 'autorizada' ? h('button.btn-text.small', { type: 'button', on: { click: () => A.printer.order(o, 'nota') } }, 'Nota') : null,
        h('span.spacer'),
        o.printed_at ? h('span.tag.tag--ok', { title: 'Cupom impresso' }, 'impresso') : null,
        o.status === 'saiu' && o.delivery_type === 'delivery' && notifyUrl(o) ? h('a.link.small', { href: notifyUrl(o), target: '_blank', rel: 'noopener' }, 'Avisar cliente ↗') : null),
      o.timeline && o.timeline.length > 1 ? h('div.timeline', o.timeline.map(t => h('span', h('b', statusLabel(o, t.status)), ' ', A.fmtTime(t.at_local)))) : null,
      h('footer.order__actions',
        step ? h('button.gb-btn.btn-sm', { type: 'button', on: { click: (e) => setStatus(o, step[0], e.currentTarget) } }, A.icon('check'), step[1]) : null,
        statusSel,
        o.status !== 'cancelado' && o.status !== 'entregue'
          ? h('button.btn-text.danger', { type: 'button', on: { click: async (e) => { if (await A.confirm('Cancelar pedido?', `O pedido ${o.code} será cancelado e o estoque devolvido.`, 'Cancelar pedido')) setStatus(o, 'cancelado', e.currentTarget); } } }, 'Cancelar')
          : null));
  }

  async function retryInvoice(o, btn) {
    btn.disabled = true; btn.textContent = 'Emitindo…';
    try {
      const r = await A.api(`/api/orders/${encodeURIComponent(o.code)}/invoice/retry`, { method: 'POST', body: {} });
      const st = r && r.invoice && r.invoice.status;
      A.toast(`${o.code}: nota ${INV[st] ? INV[st].toLowerCase() : 'enviada'}`, st === 'erro' ? 'error' : 'ok');
      load();
    } catch (e) { A.fail(e); btn.disabled = false; btn.textContent = 'Reemitir nota'; }
  }

  function cancelInvoice(o) {
    const reason = h('textarea.gb-input', { name: 'reason', rows: 3, maxlength: 255, placeholder: 'Ex.: pedido cancelado a pedido do cliente' });
    const count = h('small.hint', '0/15 caracteres no mínimo');
    reason.addEventListener('input', () => { count.textContent = `${reason.value.trim().length}/15 caracteres no mínimo`; });
    const btn = h('button.gb-btn.gb-btn--red', { type: 'submit' }, 'Cancelar nota');
    const form = h('form.form', {
      on: {
        submit: async (e) => {
          e.preventDefault();
          if (reason.value.trim().length < 15) return A.toast('A justificativa precisa ter pelo menos 15 caracteres', 'error');
          btn.disabled = true;
          try {
            await A.api(`/api/orders/${encodeURIComponent(o.code)}/invoice/cancel`, { method: 'POST', body: { reason: reason.value.trim() } });
            A.closeModal(); A.toast(`${o.code}: nota cancelada`); load();
          } catch (err) { A.fail(err); btn.disabled = false; }
        },
      },
    },
    h('p.muted.small', 'O cancelamento vai para a SEFAZ (pela Focus NFe). Em geral só é aceito até 30 minutos depois da emissão. Isto não cancela o pedido.'),
    A.field('Justificativa', reason, count),
    h('div.form-actions', btn));
    A.openModal(`Cancelar NFC-e do pedido ${o.code}`, form);
  }

  // Mensagem "saiu para entrega" (o dono só toca em enviar no WhatsApp)
  function notifyUrl(o) {
    const s = A.automation && A.automation.settings;
    if (s && s.notify_whatsapp === false) return null;
    const d = String(o.customer_phone || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    if (d.length < 10) return null;
    const store = (A.state.settings && A.state.settings.store && A.state.settings.store.name) || 'Garage Burger';
    const change = o.payment_method === 'dinheiro' && o.change_for_cents > o.total_cents ? o.change_for_cents - o.total_cents : 0;
    const text = [
      `Olá, ${String(o.customer_name).split(' ')[0]}! Seu pedido ${o.code} da ${store} saiu para entrega e já está a caminho.`,
      `Total: ${A.money(o.total_cents)} (${PAY[o.payment_method] || o.payment_method}).`,
      change ? `Vamos levar ${A.money(change)} de troco.` : null,
      `Acompanhe: ${location.origin}/pedido?c=${o.code}`,
    ].filter(Boolean).join('\n');
    return `https://wa.me/55${d}?text=${encodeURIComponent(text)}`;
  }
  A.notifyUrl = notifyUrl;

  function formatPhone(d) {
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d;
  }

  async function setStatus(o, status, el) {
    if (status === o.status) return;
    if (status === 'cancelado' && el && el.tagName === 'SELECT') {
      if (!(await A.confirm('Cancelar pedido?', `O pedido ${o.code} será cancelado e o estoque devolvido.`, 'Cancelar pedido'))) { el.value = o.status; return; }
    }
    try {
      if (el) el.disabled = true;
      await A.api(`/api/admin/orders/${o.id}/status`, { method: 'PUT', body: { status } });
      if (A.newOrderIds) A.newOrderIds.delete(o.id);
      A.toast(`${o.code}: ${statusLabel(o, status)}`);
      if (status === 'saiu' && o.delivery_type === 'delivery' && notifyUrl(o)) {
        const box = document.getElementById('toasts');
        const t = h('div.toast.toast--new', { role: 'status' }, h('div', `${o.code} saiu para entrega`),
          h('a.gb-btn.btn-sm.toast__btn', { href: notifyUrl(o), target: '_blank', rel: 'noopener', on: { click: () => setTimeout(() => t.remove(), 300) } }, 'Avisar cliente no WhatsApp'));
        box.appendChild(t);
        setTimeout(() => { t.classList.add('toast--out'); setTimeout(() => t.remove(), 300); }, 15000);
      }
      A.pollNow();
      load();
    } catch (e) { A.fail(e); if (el) { el.disabled = false; if (el.tagName === 'SELECT') el.value = o.status; } }
  }

  A.views.pedidos = {
    render(view) {
      const chips = h('div.chips', { role: 'tablist' }, FILTERS.map(([v, l]) => h('button.chip', {
        type: 'button', class: state.filter === v ? 'active' : '', on: {
          click: (e) => { state.filter = v; chips.querySelectorAll('.chip').forEach(c => c.classList.remove('active')); e.currentTarget.classList.add('active'); load(); },
        },
      }, l)));
      const search = h('input.gb-input.search', { type: 'search', placeholder: 'Código, nome ou telefone', value: state.q, 'aria-label': 'Buscar pedidos' });
      search.addEventListener('input', A.debounce(() => { state.q = search.value.trim(); load(); }, 300));
      countsEl = h('div.mini-kpis');
      listEl = h('div.orders', h('div.skeleton'));
      view.append(
        countsEl,
        h('div.toolbar', chips, search,
          h('span.muted.small.live', A.icon('bell'), 'Atualiza a cada 15 s')),
        listEl);
      return load();
    },
    refresh: load,
    destroy() { listEl = null; countsEl = null; },
  };
})();
