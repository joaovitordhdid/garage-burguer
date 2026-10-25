// Painel Garage Burger: utilitários compartilhados (API, DOM, dinheiro, toasts, modal).
(function () {
  'use strict';
  const A = (window.GBA = window.GBA || {});

  // ---------- API ----------
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  A.ApiError = ApiError;
  A.api = async function (url, { method = 'GET', body, raw, headers } = {}) {
    const opts = { method, credentials: 'same-origin', headers: { ...(headers || {}) } };
    if (raw !== undefined) opts.body = raw;
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, opts); }
    catch { throw new ApiError(0, 'Sem conexão com o servidor'); }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json().catch(() => null);
    if (res.status === 401 && !url.startsWith('/api/auth/login')) {
      A.onUnauthorized && A.onUnauthorized();
      throw new ApiError(401, (data && data.error) || 'Sessão expirada');
    }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Erro ${res.status}`);
    return data;
  };

  // ---------- Dinheiro ----------
  const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  A.money = (c) => fmt.format((Number(c) || 0) / 100);
  // "29,90" → 2990 · "1.234,5" → 123450 · "" → null
  A.parseMoney = (s) => {
    let t = String(s == null ? '' : s).replace(/R\$|\s/g, '');
    if (!t) return null;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
  };
  A.centsToInput = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
  A.num = (n, d = 3) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
  A.parseNum = (s) => { const t = String(s ?? '').trim().replace(/\./g, '').replace(',', '.'); return t === '' ? null : Number(t); };

  // ---------- Datas ----------
  A.today = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  A.addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  A.fmtDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
  A.fmtDateTime = (s) => (s ? `${A.fmtDate(s)} ${s.slice(11, 16)}` : '');
  A.fmtTime = (s) => (s ? s.slice(11, 16) : '');
  A.minutesAgo = (localStr) => {
    if (!localStr) return 0;
    const t = Date.parse(localStr.replace(' ', 'T') + '-03:00');
    return Math.max(0, Math.round((Date.now() - t) / 60000));
  };

  // ---------- DOM ----------
  // h('div.cls#id', {attrs, on:{click}}, ...children)  (texto sempre via textContent: sem XSS)
  A.h = function h(sel, attrs, ...kids) {
    const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
    }
    if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'required' || k === 'multiple') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  };
  A.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  // Ícones (SVG estático e confiável)
  const ICONS = {
    orders: '<path d="M6 3h12l1 4H5l1-4Z"/><path d="M5 7h14v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7Z"/><path d="M9 11h6M9 15h4"/>',
    menu: '<path d="M4 11h16a8 8 0 0 0-16 0Z"/><path d="M3 14h18"/><path d="M4 17h16a2 2 0 0 1-2 3H6a2 2 0 0 1-2-3Z"/>',
    box: '<path d="M3 7l9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13 7l4 4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    up: '<path d="M6 15l6-6 6 6"/>', down: '<path d="M6 9l6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', map: '<path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
    doc: '<path d="M6 3h9l4 4v14H6V3Z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>', check: '<path d="M5 12l5 5L20 7"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Z"/><path d="M10 21h4"/>', download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
    truck: '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8Z"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>',
  };
  A.icon = (name, cls = '') => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'ico ' + cls);
    s.innerHTML = ICONS[name] || '';
    return s;
  };

  // ---------- Toasts ----------
  A.toast = (msg, type = 'ok', ms = 3500) => {
    const box = document.getElementById('toasts');
    const t = A.h('div.toast', { class: 'toast--' + type, role: type === 'error' ? 'alert' : 'status' }, msg);
    box.appendChild(t);
    setTimeout(() => { t.classList.add('toast--out'); setTimeout(() => t.remove(), 300); }, ms);
  };
  A.fail = (e) => { if (e && e.status === 401) return; A.toast((e && e.message) || 'Algo deu errado', 'error', 5000); };

  // ---------- Modal ----------
  const dlg = () => document.getElementById('modal');
  A.openModal = (title, content, { wide = false } = {}) => {
    const d = dlg();
    const body = A.clear(document.getElementById('modal-body'));
    d.classList.toggle('modal--wide', wide);
    body.appendChild(A.h('header.modal__head', A.h('h3', title),
      A.h('button.icon-btn', { type: 'button', 'aria-label': 'Fechar', on: { click: A.closeModal } }, '×')));
    body.appendChild(A.h('div.modal__content', content));
    if (!d.open) d.showModal();
    const first = body.querySelector('input:not([type=hidden]), select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
    return body;
  };
  A.closeModal = () => { const d = dlg(); if (d.open) d.close(); };
  A.confirm = (title, msg, okLabel = 'Confirmar', danger = true) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; A.closeModal(); resolve(v); };
    A.openModal(title, [
      A.h('p.muted', msg),
      A.h('div.form-actions',
        A.h('button.gb-btn.gb-btn--ghost', { type: 'button', on: { click: () => finish(false) } }, 'Voltar'),
        A.h('button.gb-btn', { type: 'button', class: danger ? 'gb-btn--red' : '', on: { click: () => finish(true) } }, okLabel)),
    ]);
    dlg().addEventListener('close', () => finish(false), { once: true });
  });

  // ---------- Formulários ----------
  A.field = (label, input, hint) => A.h('label.field', A.h('span', label), input, hint ? A.h('small.hint', hint) : null);
  A.input = (name, value, attrs = {}) => A.h('input.gb-input', { name, value: value ?? '', ...attrs });
  A.moneyInput = (name, cents, attrs = {}) => A.h('input.gb-input.money', { name, inputmode: 'decimal', placeholder: '0,00', value: A.centsToInput(cents), autocomplete: 'off', ...attrs });
  A.toggle = (name, checked, label, attrs = {}) => A.h('label.toggle', A.h('input', { type: 'checkbox', name, checked, ...attrs }), A.h('span.switch', { 'aria-hidden': 'true' }), A.h('span', label));
  A.select = (name, options, value, attrs = {}) => A.h('select.gb-input', { name, ...attrs },
    options.map(([v, l]) => A.h('option', { value: v, selected: String(v) === String(value ?? '') }, l)));
  A.busy = async (btn, fn) => {
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; }
    try { return await fn(); } finally { if (btn) { btn.disabled = false; } }
  };
  A.empty = (msg, sub) => A.h('div.empty', A.h('p', msg), sub ? A.h('small', sub) : null);
  A.debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  A.views = {};
  A.state = { settings: null };
})();
