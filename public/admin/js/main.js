// Painel Garage Burger: login, navegação, alerta de pedidos novos.
(function () {
  'use strict';
  const A = window.GBA;
  const { h } = A;
  const $ = (s) => document.querySelector(s);
  const TITLES = { pedidos: 'Pedidos', entregas: 'Entregas', automacao: 'Automação', cardapio: 'Cardápio', estoque: 'Estoque', financeiro: 'Financeiro', config: 'Configurações' };
  let current = null;
  let pollTimer = null;
  let lastOrderId = null;
  let baseTitle = document.title;
  let flashTimer = null;

  // ---------- Login ----------
  function showLogin() {
    stopPolling();
    if (A.automation) A.automation.stop();
    $('#app').hidden = true;
    $('#login').hidden = false;
    A.closeModal();
    setTimeout(() => $('#login-form [name=email]').focus(), 30);
  }
  A.onUnauthorized = showLogin;

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const err = $('#login-error');
    err.hidden = true;
    const email = f.email.value.trim();
    const password = f.password.value;
    if (!email || !password) { err.textContent = 'Informe e-mail e senha.'; err.hidden = false; return; }
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      await A.api('/api/auth/login', { method: 'POST', body: { email, password } });
      f.password.value = '';
      await startApp();
    } catch (e) {
      err.textContent = e.message || 'Não foi possível entrar';
      err.hidden = false;
      f.password.select();
    } finally { btn.disabled = false; btn.textContent = 'Entrar'; }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await A.api('/api/auth/logout', { method: 'POST' }); } catch { /* ignora */ }
    A.state.settings = null;
    showLogin();
  });

  // ---------- App ----------
  async function startApp() {
    const settings = await A.api('/api/admin/settings');
    A.state.settings = settings;
    $('#login').hidden = true;
    $('#app').hidden = false;
    syncStoreToggle();
    lastOrderId = null;
    route();
    startPolling();
    if (A.automation) A.automation.start();
    refreshStockBadge();
  }

  function syncStoreToggle() {
    const open = !A.state.settings || !A.state.settings.store || A.state.settings.store.open !== false;
    $('#store-open').checked = open;
    $('#store-open-label').textContent = open ? 'Loja aberta' : 'Loja fechada';
    $('.store-toggle').classList.toggle('is-closed', !open);
  }
  A.syncStoreToggle = syncStoreToggle;
  $('#store-open').addEventListener('change', async (ev) => {
    const open = ev.target.checked;
    try {
      const r = await A.api('/api/admin/settings/store/open', { method: 'PUT', body: { open } });
      A.state.settings.store.open = r.open;
      A.toast(r.open ? 'Loja aberta para pedidos' : 'Loja fechada: o cardápio mostra "fechado"');
    } catch (e) { ev.target.checked = !open; A.fail(e); }
    syncStoreToggle();
  });

  // ---------- Rotas por hash ----------
  function route() {
    if ($('#app').hidden) return;
    let name = (location.hash || '#pedidos').slice(1);
    if (!A.views[name]) name = 'pedidos';
    if (current && current.name !== name && A.views[current.name].destroy) A.views[current.name].destroy();
    current = { name };
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === name));
    $('#view-title').textContent = TITLES[name];
    document.title = `${TITLES[name]} · Painel Garage Burger`;
    baseTitle = document.title;
    const view = A.clear($('#view'));
    view.dataset.view = name;
    Promise.resolve(A.views[name].render(view)).catch(A.fail);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  A.currentView = () => current && current.name;

  // ---------- Pedidos novos (a cada 15 s) ----------
  function startPolling() { stopPolling(); poll(); pollTimer = setInterval(poll, 15000); }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
  async function poll() {
    try {
      const r = await A.api('/api/admin/orders?status=recebido&limit=100');
      const badge = $('#badge-orders');
      badge.hidden = r.orders.length === 0;
      badge.textContent = r.orders.length;
      if (lastOrderId !== null && r.latest_id > lastOrderId) {
        const fresh = r.orders.filter(o => o.id > lastOrderId);
        newOrderAlert(fresh.length || 1, fresh[0]);
        A.newOrderIds = new Set([...(A.newOrderIds || []), ...fresh.map(o => o.id)]);
      }
      lastOrderId = r.latest_id;
      if (A.currentView() === 'pedidos' && A.views.pedidos.refresh) A.views.pedidos.refresh();
    } catch (e) { if (e.status !== 401) console.warn('poll', e.message); }
  }
  A.pollNow = poll;

  function newOrderAlert(n, o) {
    beep();
    A.toast(n > 1 ? `${n} pedidos novos!` : `Pedido novo${o ? ` ${o.code} · ${o.customer_name} · ${A.money(o.total_cents)}` : ''}!`, 'new', 8000);
    clearInterval(flashTimer);
    let on = false, k = 0;
    flashTimer = setInterval(() => {
      document.title = (on = !on) ? `🔔 Pedido novo! · Garage Burger` : baseTitle;
      if (++k > 20 || document.hasFocus() && k > 6) { clearInterval(flashTimer); document.title = baseTitle; }
    }, 1000);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }

  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime;
      [0, 0.22, 0.44].forEach((d, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'square';
        o.frequency.value = i === 2 ? 1320 : 880;
        g.gain.setValueAtTime(0.0001, t0 + d);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.18);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0 + d); o.stop(t0 + d + 0.2);
      });
    } catch { /* sem áudio */ }
  }
  A.beep = beep;
  // desbloqueia o áudio no primeiro clique
  document.addEventListener('pointerdown', () => {
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch { /* ignora */ }
  }, { once: true });

  async function refreshStockBadge() {
    try {
      const r = await A.api('/api/admin/ingredients');
      const b = $('#badge-stock');
      b.hidden = !r.low_count; b.textContent = r.low_count;
    } catch { /* ignora */ }
  }
  A.refreshStockBadge = refreshStockBadge;

  // ---------- Ícones do menu ----------
  document.querySelectorAll('[data-icon]').forEach(el => el.appendChild(A.icon(el.dataset.icon)));

  // ---------- Início ----------
  (async function boot() {
    try {
      await A.api('/api/auth/me');
      await startApp();
    } catch (e) {
      if (e.status === 401) showLogin();
      else { showLogin(); const err = $('#login-error'); err.textContent = e.message; err.hidden = false; }
    }
  })();
  void h;
})();
