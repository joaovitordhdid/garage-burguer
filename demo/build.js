// Gera a versão de demonstração estática (sem servidor) em dist-demo/.
// Uso: node demo/build.js
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-demo');
const S = p => path.join(__dirname, 'shims', p);

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
fs.rmSync(path.join(OUT, 'images', 'uploads'), { recursive: true, force: true });

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'runtime.js')],
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2020',
  outfile: path.join(OUT, 'demo-runtime.js'),
  alias: {
    'node:sqlite': S('sqlite.js'), 'node:fs': S('fs.js'), fs: S('fs.js'), 'node:path': S('path.js'), path: S('path.js'),
    'node:crypto': S('crypto.js'), crypto: S('crypto.js'), express: S('express.js'),
    helmet: S('noop.js'), 'cookie-parser': S('noop.js'), 'express-rate-limit': S('noop.js'),
  },
  inject: [path.join(__dirname, 'buffer-inject.js')],
  define: { __dirname: '"/srv"', 'require.main': 'undefined', 'process.env.NODE_ENV': '"demo"' },
  logLevel: 'warning',
});

// admin/index.html vira admin.html na raiz; caminhos absolutos viram relativos
fs.renameSync(path.join(OUT, 'admin', 'index.html'), path.join(OUT, 'admin.html'));
const rewrite = s => s
  .replace(/(href|src)="\/(css|js|vendor|images|admin\/js|admin\/admin\.css)/g, '$1="$2')
  .replace(/href="\/admin\/"/g, 'href="admin.html"')
  .replace(/href="\/checkout"/g, 'href="checkout.html"')
  .replace(/href="\/"/g, 'href="./"')
  .replace(/'\/pedido\?c='/g, "'pedido.html?c='");

for (const f of ['index.html', 'checkout.html', 'pedido.html', 'admin.html', 'js/checkout.js', 'js/pedido.js', 'js/menu.js', 'admin/js/main.js', 'admin/js/core.js']) {
  const p = path.join(OUT, f);
  if (!fs.existsSync(p)) continue;
  let s = rewrite(fs.readFileSync(p, 'utf8'));
  if (f.endsWith('.html')) s = s.replace(/<head>/, '<head>\n  <script src="demo-runtime.js"></script>');
  fs.writeFileSync(p, s);
}
console.log('dist-demo pronto:', fs.readdirSync(OUT).join(', '));
