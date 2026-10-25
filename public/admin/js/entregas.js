// Painel: Entregas (montar rota com vários pedidos, link do entregador, acompanhamento).
(function () {
  'use strict';
  const A = window.GBA;
  const { h } = A;
  const PAY = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };

  let root = null;
  let timer = null;
  let selected = new Set();
  let driverName = '';
  let loading = false;

  function payText(o) {
    let t = PAY[o.payment_method] || o.payment_method;
    if (o.payment_method === 'dinheiro' && o.change_for_cents > o.total_cents) t += ` · troco ${A.money(o.change_for_cents - o.total_cents)}`;
    return t;
  }
  const minsSince = (utc) => (utc ? Math.max(0, Math.round((Date.now() - Date.parse(utc.replace(' ', 'T') + 'Z')) / 60000)) : 0);
  const localHHMM = (utc) => (utc ? new Date(utc.replace(' ', 'T') + 'Z').toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); A.toast('Link copiado'); }
    catch {
      const i = h('input.gb-input', { value: text, readonly: true });
      A.openModal('Copie o link', [h('p.muted.small', 'Selecione e copie (Ctrl+C):'), i]);
      setTimeout(() => i.select(), 50);
    }
  }

  async function load() {
    if (!root || loading) return;
    loading = true;
    try {
      const r = await A.api('/api/admin/automation/deliveries');
      if (root) draw(r);
    } catch (e) { A.fail(e); } finally { loading = false; }
  }

  function draw(r) {
    A.clear(root);
    const ids = new Set(r.ready.map(o => o.id));
    selected = new Set([...selected].filter(id => ids.has(id)));

    if (r.store.lat == null) {
      root.appendChild(h('p.alert-bar', h('strong', 'Local da loja não informado. '), 'Sem ele a rota não começa na loja e a distância não aparece. ',
        h('a.link', { href: '#automacao' }, 'Informar agora →')));
    }

    // ---- Prontos para sair ----
    const sendBtn = h('button.gb-btn', { type: 'button', disabled: selected.size === 0, on: { click: (e) => createRoute(e.currentTarget, r) } }, A.icon('truck'), `Enviar para rota${selected.size ? ` (${selected.size})` : ''}`);
    const updateBtn = () => { sendBtn.disabled = selected.size === 0; sendBtn.lastChild.textContent = `Enviar para rota${selected.size ? ` (${selected.size})` : ''}`; };
    const driver = A.input('driver', driverName, { placeholder: 'Nome do entregador (opcional)', maxlength: 60, 'aria-label': 'Nome do entregador' });
    driver.addEventListener('input', () => { driverName = driver.value; });

    const list = r.ready.length
      ? h('div.dlist', r.ready.map(o => {
        const cb = h('input', { type: 'checkbox', checked: selected.has(o.id), 'aria-label': `Incluir ${o.code} na rota` });
        cb.addEventListener('change', () => { if (cb.checked) selected.add(o.id); else selected.delete(o.id); row.classList.toggle('is-sel', cb.checked); updateBtn(); });
        const prep = minsSince(o.prep_started_at);
        const row = h('label.drow', { class: selected.has(o.id) ? 'is-sel' : '' },
          cb,
          h('div.drow__main',
            h('div.drow__top', h('strong.mono', o.code), h('span', o.first_name),
              o.status === 'saiu' ? h('span.pill.pill--saiu', 'Saiu (sem rota)') : h('span.pill.pill--preparo', `Em preparo · ${prep} min`)),
            h('div.drow__addr', o.address || 'Endereço não informado', o.address_ref ? h('small.muted', ` · ${o.address_ref}`) : null),
            h('div.drow__meta.muted.small', `${o.items_count} ${o.items_count === 1 ? 'item' : 'itens'} · ${payText(o)} · `, h('b', A.money(o.total_cents)))),
          h('div.drow__dist', o.distance_km != null ? h('strong', `${String(o.distance_km).replace('.', ',')} km`) : h('span.muted.small', o.lat == null ? 'sem GPS' : '—'),
            o.map_url ? h('a.link.small', { href: o.map_url, target: '_blank', rel: 'noopener', on: { click: (e) => e.stopPropagation() } }, 'mapa ↗') : null));
        return row;
      }))
      : A.empty('Nenhum pedido pronto para sair.', 'Aparecem aqui os pedidos de entrega "Em preparo" (ou que saíram sem rota).');

    const all = h('button.btn-text.small', {
      type: 'button', disabled: !r.ready.length,
      on: { click: () => { const every = r.ready.every(o => selected.has(o.id)); selected = every ? new Set() : new Set(r.ready.slice(0, 10).map(o => o.id)); draw(r); } },
    }, 'Marcar todos');

    root.appendChild(h('section.card',
      h('div.card__head', h('h3', `Prontos para sair (${r.ready.length})`), all),
      list,
      r.ready.length ? h('div.route-bar', driver, sendBtn) : null,
      r.ready.length ? h('p.muted.small', 'A ordem das paradas é calculada pela distância (sempre o cliente mais próximo do anterior), começando na loja. Até 10 pedidos por rota.') : null));

    // ---- Rotas ----
    const active = r.routes.filter(x => !x.finished_at);
    const done = r.routes.filter(x => x.finished_at);
    root.appendChild(h('h3.section-title', `Rotas em andamento (${active.length})`));
    root.appendChild(active.length ? h('div.routes', active.map(x => routeCard(x, r))) : A.empty('Nenhuma rota em andamento.'));
    if (done.length) {
      root.appendChild(h('h3.section-title', 'Concluídas nas últimas 12 h'));
      root.appendChild(h('div.routes', done.map(x => routeCard(x, r))));
    }
  }

  function routeCard(x, r) {
    const pct = x.progress.total ? Math.round((x.progress.done / x.progress.total) * 100) : 0;
    const finished = !!x.finished_at;
    return h('article.route', { class: finished ? 'is-done' : '' },
      h('header.route__head',
        h('div', h('strong', x.driver_name || 'Entregador'), h('small.muted', ` · saiu às ${localHHMM(x.created_at)}${finished ? ` · encerrada às ${localHHMM(x.finished_at)}` : ''}`)),
        h('span.route__count', `${x.progress.done}/${x.progress.total}`)),
      h('div.progress', h('i', { style: `width:${pct}%` })),
      h('ol.route__stops', x.stops.map(s => h('li', { class: s.delivered_at || s.status === 'entregue' ? 'is-ok' : s.status === 'cancelado' ? 'is-cancel' : '' },
        h('span.mono', s.code), ' ', h('span', s.customer_name.split(' ')[0]),
        h('small.muted', ` · ${s.address || ''}`),
        s.delivered_at ? h('small.ok', ` ✓ ${localHHMM(s.delivered_at)}`) : s.status === 'cancelado' ? h('small.neg', ' cancelado') : null,
        !finished && !s.delivered_at && s.whatsapp_url ? h('a.link.small', { href: s.whatsapp_url, target: '_blank', rel: 'noopener' }, ' avisar ↗') : null))),
      finished ? null : h('div.route__actions',
        x.maps_url ? h('a.gb-btn.btn-sm', { href: x.maps_url, target: '_blank', rel: 'noopener' }, A.icon('map'), 'Rota no Maps') : null,
        h('button.gb-btn.gb-btn--ghost.btn-sm', { type: 'button', on: { click: () => copy(x.driver_url) } }, 'Copiar link do entregador'),
        h('a.gb-btn.gb-btn--ghost.btn-sm', { href: x.driver_whatsapp_url, target: '_blank', rel: 'noopener' }, A.icon('phone'), 'Enviar ao entregador'),
        h('span.spacer'),
        h('button.btn-text.small', { type: 'button', on: { click: () => finishRoute(x) } }, 'Encerrar'),
        x.progress.done === 0 ? h('button.btn-text.small.danger', { type: 'button', on: { click: () => cancelRoute(x) } }, 'Desfazer rota') : null));
  }

  async function createRoute(btn, r) {
    const ids = [...selected];
    if (!ids.length) return;
    btn.disabled = true;
    try {
      const route = await A.api('/api/admin/automation/routes', { method: 'POST', body: { order_ids: ids, driver_name: driverName } });
      selected = new Set();
      showRoute(route, r.notify_whatsapp);
      A.toast(`Rota criada: ${route.stops.length} ${route.stops.length === 1 ? 'pedido saiu' : 'pedidos saíram'} para entrega`);
      if (A.automation && A.automation.addLog) A.automation.addLog('saiu', `Rota${route.driver_name ? ` (${route.driver_name})` : ''}: ${route.stops.map(s => s.code).join(', ')} saíram para entrega`);
      load();
      if (A.pollNow) A.pollNow();
    } catch (e) { A.fail(e); btn.disabled = false; load(); }
  }

  function showRoute(x, notify) {
    const linkInput = h('input.gb-input.mono', { value: x.driver_url, readonly: true, 'aria-label': 'Link do entregador' });
    linkInput.addEventListener('focus', () => linkInput.select());
    A.openModal('Rota pronta: pedidos saíram para entrega', [
      h('ol.route__stops.route__stops--big', x.stops.map(s => h('li',
        h('div', h('b.mono', s.code), ' ', s.customer_name, s.distance_km != null ? h('small.muted', ` · ${String(s.distance_km).replace('.', ',')} km da loja`) : null),
        h('small.muted.block', s.address || ''),
        notify && s.whatsapp_url ? h('a.gb-btn.gb-btn--ghost.btn-sm.mt-xs', { href: s.whatsapp_url, target: '_blank', rel: 'noopener' }, A.icon('phone'), `Avisar ${s.customer_name.split(' ')[0]} no WhatsApp`) : null))),
      h('div.route-links',
        x.maps_url ? h('a.gb-btn', { href: x.maps_url, target: '_blank', rel: 'noopener' }, A.icon('map'), 'Abrir rota no Google Maps') : null,
        x.waze_url ? h('a.gb-btn.gb-btn--ghost', { href: x.waze_url, target: '_blank', rel: 'noopener' }, '1ª parada no Waze') : null),
      A.field('Link do entregador (abre no celular, sem senha)', h('div.row', linkInput,
        h('button.gb-btn.gb-btn--ghost.btn-sm', { type: 'button', on: { click: () => copy(x.driver_url) } }, 'Copiar'),
        h('a.gb-btn.btn-sm', { href: x.driver_whatsapp_url, target: '_blank', rel: 'noopener' }, 'WhatsApp')),
      'O entregador vê só o necessário (primeiro nome, endereço, telefone e o que cobrar) e marca cada entrega. O link para de funcionar 12 h depois que a rota termina.'),
      h('div.form-actions', h('button.gb-btn', { type: 'button', on: { click: A.closeModal } }, 'Pronto')),
    ], { wide: true });
  }

  async function finishRoute(x) {
    if (!(await A.confirm('Encerrar rota?', 'O link do entregador para de aceitar entregas. Pedidos não marcados continuam como "Saiu para entrega".', 'Encerrar', false))) return;
    try { await A.api(`/api/admin/automation/routes/${x.id}/finish`, { method: 'POST', body: {} }); A.toast('Rota encerrada'); load(); }
    catch (e) { A.fail(e); }
  }
  async function cancelRoute(x) {
    if (!(await A.confirm('Desfazer rota?', 'Os pedidos voltam para "Em preparo" e o link do entregador deixa de funcionar.', 'Desfazer'))) return;
    try { const r = await A.api(`/api/admin/automation/routes/${x.id}/cancel`, { method: 'POST', body: {} }); A.toast(`${r.returned} pedido(s) voltaram para "Em preparo"`); load(); if (A.pollNow) A.pollNow(); }
    catch (e) { A.fail(e); }
  }

  A.views.entregas = {
    render(view) {
      root = h('div.entregas', h('div.skeleton'));
      view.append(root);
      clearInterval(timer);
      timer = setInterval(load, 15000);
      return load();
    },
    refresh: load,
    destroy() { root = null; clearInterval(timer); timer = null; },
  };
})();
