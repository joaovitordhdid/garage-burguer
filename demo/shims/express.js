// Express mínimo para rodar as rotas do servidor dentro do navegador (demonstração).
function compile(path, prefix) {
  if (path === '/' && prefix) return { re: /^(?=\/|$)/, keys: [] };
  const keys = [];
  const src = path.replace(/\/$/, '').replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp('^' + src + (prefix ? '(?=/|$)' : '/?$')), keys };
}

function createRouter() {
  const stack = [];
  function router(req, res, done) { return router.handle(req, res, done); }
  router._isRouter = true;

  router.use = (...args) => {
    const path = typeof args[0] === 'string' ? args.shift() : '/';
    for (const fn of args.flat()) stack.push({ ...compile(path, true), method: null, fn, prefix: true });
    return router;
  };
  for (const m of ['get', 'post', 'put', 'delete', 'patch']) {
    router[m] = (path, ...fns) => {
      for (const fn of fns.flat()) stack.push({ ...compile(path, false), method: m.toUpperCase(), fn, prefix: false });
      return router;
    };
  }
  router.handle = (req, res, done) => {
    let i = 0;
    const basePath = req.path;
    const baseUrl = req.baseUrl || '';
    const next = err => {
      if (res.finished) return;
      req.path = basePath; req.baseUrl = baseUrl;
      const layer = stack[i++];
      if (!layer) return done(err);
      if (layer.method && layer.method !== req.method && !(layer.method === 'GET' && req.method === 'HEAD')) return next(err);
      const m = layer.re.exec(basePath);
      if (!m) return next(err);
      const params = {};
      layer.keys.forEach((k, j) => { params[k] = decodeURIComponent(m[j + 1]); });
      req.params = { ...(req.params || {}), ...params };
      if (layer.prefix) {
        req.baseUrl = baseUrl + m[0];
        req.path = basePath.slice(m[0].length) || '/';
      }
      const isErrHandler = layer.fn.length === 4;
      try {
        let r;
        if (err) { if (!isErrHandler) return next(err); r = layer.fn(err, req, res, next); }
        else { if (isErrHandler) return next(); r = layer.fn(req, res, next); }
        if (r && typeof r.then === 'function') r.catch(next);
      } catch (e) { next(e); }
    };
    next();
  };
  return router;
}

function express() {
  const app = createRouter();
  app.set = () => app;
  app.locals = {};
  app.listen = () => {};
  return app;
}
express.Router = createRouter;
express.json = () => (req, res, next) => next();
express.urlencoded = express.json;
express.static = () => (req, res, next) => next();
express.raw = () => (req, res, next) => { if (req.rawBody) req.body = Buffer.from(req.rawBody); next(); };

module.exports = express;
module.exports.default = express;
module.exports.Router = createRouter;
