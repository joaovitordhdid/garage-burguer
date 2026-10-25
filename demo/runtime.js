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
  Object.assign(process.env, { ADMIN_EMAIL: 'dono@garageburger.com', ADMIN_PASSWORD: 'garage123', NODE_ENV: 'production' });
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
