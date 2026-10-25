// Página do entregador: paradas da rota, ligar/WhatsApp/Maps e botão "Entregue".
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const token = new URLSearchParams(location.search).get('t') || '';
  const money = (c) => ((Number(c) || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const hhmm = (utc) => (utc ? new Date(utc.replace(' ', 'T') + 'Z').toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
  let data = null;
  let busy = false;
  let armed = null; // parada aguardando a confirmação
  let armTimer = null;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }

  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-bad', !!bad);
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function showError(title, text) {
    $('#loading').hidden = true;
    $('#route').hidden = true;
    $('#error').hidden = false;
    $('#error-title').textContent = title;
    $('#error-text').textContent = text;
  }

  async function api(url, opts) {
    const r = await fetch(url, { credentials: 'omit', cache: 'no-store', ...opts });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(body.error || `Erro ${r.status}`); e.status = r.status; throw e; }
    return body;
  }

  async function load() {
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return showError('Link inválido', 'Peça para a loja enviar o link da rota de novo.');
    try {
      data = await api(`/api/entregador/${encodeURIComponent(token)}`);
      render();
    } catch (e) {
      if (e.status === 404) showError('Rota não encontrada', e.message);
      else if (e.status === 410) showError('Rota encerrada', 'Esta rota já terminou. Se ainda tem entrega, peça um link novo para a loja.');
      else if (!data) showError('Sem conexão', 'Não foi possível carregar a rota. Confira a internet e tente de novo.');
      else toast('Sem conexão. Tentando de novo…', true);
    }
  }

  function payBox(s) {
    if (s.payment_method === 'dinheiro') {
      return el('div', { class: 'en-pay en-pay--cash' },
        el('span', { class: 'en-pay__label', text: 'Cobrar em dinheiro' }),
        el('strong', { class: 'en-pay__value', text: money(s.total_cents) }),
        s.change_cents ? el('span', { class: 'en-pay__change' }, 'Levar troco: ', el('b', { text: money(s.change_cents) }), ` (paga com ${money(s.change_for_cents)})`) : el('span', { class: 'en-pay__change', text: 'Sem troco' }));
    }
    if (s.payment_method === 'cartao') {
      return el('div', { class: 'en-pay' },
        el('span', { class: 'en-pay__label', text: 'Cartão: levar a maquininha' }),
        el('strong', { class: 'en-pay__value', text: money(s.total_cents) }));
    }
    return el('div', { class: 'en-pay en-pay--ok' },
      el('span', { class: 'en-pay__label', text: 'Pix: conferir se foi pago' }),
      el('strong', { class: 'en-pay__value', text: money(s.total_cents) }));
  }

  function render() {
    $('#loading').hidden = true;
    $('#error').hidden = true;
    $('#route').hidden = false;
    $('#driver').textContent = data.driver_name ? `Entregas de ${data.driver_name}` : 'Entregas';
    const total = data.stops.length;
    const done = data.stops.filter(s => s.status !== 'pendente').length;
    $('#progress-text').textContent = `${done} de ${total} ${total === 1 ? 'entrega' : 'entregas'} concluídas`;
    $('#progress-bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    const maps = $('#maps-all');
    maps.hidden = !data.maps_url || done === total;
    if (data.maps_url) maps.href = data.maps_url;
    $('#done').hidden = !(data.finished || done === total);

    const list = $('#stops');
    list.replaceChildren();
    const nextPos = (data.stops.find(s => s.status === 'pendente') || {}).position;
    for (const s of data.stops) {
      const pending = s.status === 'pendente';
      const isArmed = armed === s.position;
      const btn = el('button', {
        type: 'button', class: `en-deliver${isArmed ? ' is-armed' : ''}`, disabled: busy || data.finished,
        on: { click: () => onDeliver(s) },
      }, isArmed ? 'Toque de novo para confirmar' : 'Entregue');
      const tel = s.phone ? `tel:+55${s.phone}` : null;
      const wa = s.phone ? `https://wa.me/55${s.phone}?text=${encodeURIComponent(`Olá, ${s.first_name}! Aqui é o entregador da ${data.store.name}. Estou chegando com o seu pedido ${s.code}.`)}` : null;
      list.append(el('li', { class: `en-stop${pending ? '' : ' is-done'}${s.status === 'cancelado' ? ' is-cancel' : ''}${s.position === nextPos ? ' is-next' : ''}` },
        el('div', { class: 'en-stop__head' },
          el('span', { class: 'en-stop__num', text: String(s.position) }),
          el('div', { class: 'en-stop__who' },
            el('strong', { text: s.first_name }),
            el('span', { class: 'en-stop__code', text: s.code })),
          pending ? (s.position === nextPos ? el('span', { class: 'en-badge', text: 'Próxima' }) : null)
            : el('span', { class: `en-badge ${s.status === 'cancelado' ? 'en-badge--bad' : 'en-badge--ok'}`, text: s.status === 'cancelado' ? 'Cancelado' : `Entregue ${hhmm(s.delivered_at)}` })),
        s.status === 'cancelado' ? el('p', { class: 'en-cancel', text: 'Pedido cancelado pela loja. Não entregue; volte com ele.' }) : null,
        pending ? [
          el('p', { class: 'en-addr', text: s.address || 'Endereço não informado' }),
          s.address_ref ? el('p', { class: 'en-ref' }, 'Referência: ', s.address_ref) : null,
          s.notes ? el('p', { class: 'en-ref' }, 'Obs.: ', s.notes) : null,
          payBox(s),
          el('p', { class: 'en-items', text: `${s.items_count} ${s.items_count === 1 ? 'item' : 'itens'} no pedido` }),
          el('div', { class: 'en-actions' },
            s.maps_url ? el('a', { class: 'gb-btn gb-btn--ghost', href: s.maps_url, target: '_blank', rel: 'noopener' }, 'Abrir no Maps') : null,
            s.waze_url ? el('a', { class: 'gb-btn gb-btn--ghost', href: s.waze_url, target: '_blank', rel: 'noopener' }, 'Waze') : null,
            tel ? el('a', { class: 'gb-btn gb-btn--ghost', href: tel }, 'Ligar') : null,
            wa ? el('a', { class: 'gb-btn gb-btn--ghost', href: wa, target: '_blank', rel: 'noopener' }, 'WhatsApp') : null),
          btn,
        ] : el('p', { class: 'en-addr en-addr--small', text: s.address || '' })));
    }
  }

  async function onDeliver(s) {
    if (busy) return;
    if (armed !== s.position) {
      armed = s.position;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = null; render(); }, 4000);
      render();
      return;
    }
    clearTimeout(armTimer);
    armed = null;
    busy = true;
    render();
    try {
      data = await api(`/api/entregador/${encodeURIComponent(token)}/stops/${s.position}/delivered`, { method: 'POST' });
      toast(`${s.first_name}: entrega registrada`);
      if (navigator.vibrate) navigator.vibrate(80);
    } catch (e) {
      toast(e.message || 'Não foi possível marcar. Tente de novo.', true);
      if (e.status === 410) return showError('Rota encerrada', 'Esta rota já terminou.');
      await load();
    } finally {
      busy = false;
      if (data) render();
    }
  }

  $('#refresh').addEventListener('click', load);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden && !busy && armed === null) load(); }, 30000);
  load();
})();
