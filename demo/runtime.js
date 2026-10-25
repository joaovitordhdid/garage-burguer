// Demonstração estática: roda o servidor Garage Burger dentro do navegador.
// As rotas reais (server.js, server/routes/*, server/nfe/*) são empacotadas com esbuild;
// o banco é SQLite (sql.js) salvo no localStorage deste navegador.
globalThis.process = globalThis.process || { env: {} };
const initSqlJs = require('sql.js/dist/sql-asm.js');

const COOKIES = 'gb_demo_cookies';
const realFetch = window.fetch.bind(window);

function loadCookies() { try { return JSON.parse(localStorage.getItem(COOKIES)) || {}; } catch { return {}; } }
function saveCookies(c) { try { localStorage.setItem(COOKIES, JSON.stringify(c)); } catch {} }

const ready = initSqlJs().then(SQL => {
  globalThis.__SQL = SQL;
  Object.assign(process.env, { ADMIN_EMAIL: 'dono@garageburger.com', ADMIN_PASSWORD: 'garage123', NODE_ENV: 'demo' });
  const app = require('../server.js');
  globalThis.__gbDb.save();
  return app;
});

function apiPath(u) {
  const i = u.pathname.indexOf('/api/');
  return i < 0 ? null : u.pathname.slice(i);
}

async function dispatch(method, url, headers, body) {
  const app = await ready;
  const u = new URL(url, location.href);
  const path = apiPath(u);
  const cookies = loadCookies();
  return new Promise(resolve => {
    const resHeaders = { 'content-type': 'application/json; charset=utf-8' };
    const res = {
      statusCode: 200, finished: false, headersSent: false,
      status(c) { this.statusCode = c; return this; },
      set(k, v) { if (typeof k === 'object') Object.entries(k).forEach(([a, b]) => { resHeaders[a.toLowerCase()] = b; }); else resHeaders[k.toLowerCase()] = v; return this; },
      setHeader(k, v) { return this.set(k, v); },
      type(t) { resHeaders['content-type'] = t.includes('/') ? t : ({ html: 'text/html; charset=utf-8', svg: 'image/svg+xml', csv: 'text/csv; charset=utf-8', json: 'application/json' }[t] || t); return this; },
      cookie(name, val) { cookies[name] = val; saveCookies(cookies); return this; },
      clearCookie(name) { delete cookies[name]; saveCookies(cookies); return this; },
      json(o) { resHeaders['content-type'] = 'application/json; charset=utf-8'; return this.end(JSON.stringify(o)); },
      send(b) {
        if (b && typeof b === 'object' && !(b instanceof Uint8Array)) return this.json(b);
        if (typeof b === 'string' && !resHeaders['content-type'].startsWith('text/') && !resHeaders['content-type'].startsWith('image/')) resHeaders['content-type'] = 'text/html; charset=utf-8';
        return this.end(b);
      },
      redirect(a, b) { const to = typeof a === 'number' ? b : a; this.statusCode = 302; resHeaders.location = to; return this.end(''); },
      end(b = '') {
        if (this.finished) return this;
        this.finished = this.headersSent = true;
        if (method !== 'GET') globalThis.__gbDb.save();
        resolve({ status: this.statusCode, headers: resHeaders, body: b });
        return this;
      },
    };
    const req = {
      method, url: path + u.search, originalUrl: path + u.search, path, baseUrl: '',
      query: Object.fromEntries(u.searchParams), params: {}, headers, cookies, ip: '127.0.0.1',
      body: {}, rawBody: null, get: k => headers[k.toLowerCase()],
    };
    if (body instanceof Uint8Array) req.rawBody = body;
    else if (typeof body === 'string' && body) { try { req.body = JSON.parse(body); } catch { req.body = {}; } }
    app.handle(req, res, err => {
      if (err) { console.error(err); res.status(err.status || 500).json({ error: err.expose ? err.message : 'Erro interno' }); }
      else res.status(404).json({ error: 'Rota não encontrada' });
    });
  });
}

function toResponse(r) {
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
}

window.fetch = async function (input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const u = new URL(url, location.href);
  if (u.origin !== location.origin || !apiPath(u)) return realFetch(input, init);
  const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
  const headers = {};
  new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
  let body = init.body;
  if (body instanceof Blob) { headers['content-type'] = headers['content-type'] || body.type; body = new Uint8Array(await body.arrayBuffer()); }
  else if (body instanceof ArrayBuffer) body = new Uint8Array(body);
  const r = await dispatch(method, url, headers, body);
  // uploads ficam no próprio navegador como data URL
  if (apiPath(u) === '/api/admin/upload' && r.status < 300) {
    const j = JSON.parse(r.body);
    j.url = globalThis.__uploads[j.url.split('/').pop()] || j.url;
    r.body = JSON.stringify(j);
  }
  return toResponse(r);
};

// Links para /api/... (DANFE, CSV): abre o conteúdo gerado aqui mesmo.
document.addEventListener('click', async e => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const u = new URL(a.getAttribute('href'), location.href);
  if (u.origin !== location.origin || !apiPath(u)) return;
  e.preventDefault();
  const win = a.hasAttribute('download') ? null : window.open('', '_blank');
  const r = await dispatch('GET', u.href, {}, null);
  const blob = new Blob([r.body], { type: r.headers['content-type'] });
  const href = URL.createObjectURL(blob);
  if (a.hasAttribute('download')) {
    const d = document.createElement('a');
    d.href = href; d.download = u.pathname.split('/').pop(); document.body.appendChild(d); d.click(); d.remove();
  } else if (win) win.location.href = href;
  else location.href = href;
}, true);

// Imagens servidas pela API (ex.: QR do Pix)
new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (!n.querySelectorAll) continue;
    for (const img of [n, ...n.querySelectorAll('img')]) {
      if (img.tagName !== 'IMG') continue;
      const src = img.getAttribute('src');
      if (!src || !src.includes('/api/')) continue;
      img.removeAttribute('src');
      dispatch('GET', new URL(src, location.href).href, {}, null).then(r => {
        img.src = URL.createObjectURL(new Blob([r.body], { type: r.headers['content-type'] }));
      });
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// Faixa de demonstração (some sozinha) + dica de login no painel
function banner() {
  const form = document.getElementById('login-form');
  if (form && !document.getElementById('gb-demo-hint')) {
    const hint = document.createElement('p');
    hint.id = 'gb-demo-hint';
    hint.setAttribute('style', 'margin:0;padding:10px 12px;border-radius:10px;background:rgba(255,180,0,.12);border:1px dashed #ffb400;color:#ffcf5a;font:500 13px/1.4 system-ui,sans-serif');
    hint.innerHTML = 'Demonstração: entre com <b>dono@garageburger.com</b> e a senha <b>garage123</b>.';
    const err = document.getElementById('login-error');
    form.insertBefore(hint, err || form.lastElementChild);
    const em = form.querySelector('input[type=email]'); if (em && !em.value) em.value = 'dono@garageburger.com';
  }
  if (document.getElementById('gb-demo-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'gb-demo-bar';
  bar.setAttribute('style', 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483647;max-width:calc(100% - 16px);font:600 11px/1.3 system-ui,sans-serif;color:#111;background:#ffb400;border-radius:999px;padding:5px 6px 5px 12px;box-shadow:0 4px 14px rgba(0,0,0,.4);display:flex;gap:8px;align-items:center;transition:opacity .4s');
  bar.innerHTML = '<span>DEMONSTRAÇÃO · os dados ficam só neste navegador</span>';
  const btn = (label, fn, extra = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('style', 'font:inherit;border:0;border-radius:999px;padding:3px 9px;cursor:pointer;' + extra);
    b.addEventListener('click', fn);
    return b;
  };
  bar.append(
    btn('Zerar demo', () => {
      if (!confirm('Apagar pedidos e alterações desta demonstração?')) return;
      ['gb_demo_db', COOKIES, 'gb_cart', 'gb_last_order'].forEach(k => { try { localStorage.removeItem(k); } catch {} });
      location.reload();
    }, 'background:#111;color:#ffb400'),
    btn('×', () => bar.remove(), 'background:none;color:#111;font-size:14px;padding:0 6px'),
  );
  document.body.appendChild(bar);
  setTimeout(() => { bar.style.opacity = '0'; setTimeout(() => bar.remove(), 450); }, 7000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner); else banner();
