// fs mínimo: lê o cardápio embutido e guarda uploads como data URL.
globalThis.__uploads = globalThis.__uploads || {};
const files = { 'menu-source.json': JSON.stringify(require('../../server/menu-source.json')) };
const base = p => String(p).split('/').pop();
module.exports = {
  existsSync: p => base(p) in files,
  readFileSync: p => files[base(p)],
  mkdirSync: () => {},
  writeFileSync: (p, buf) => {
    const b = Buffer.from(buf);
    const ext = base(p).split('.').pop();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/' + ext;
    globalThis.__uploads[base(p)] = `data:${mime};base64,${b.toString('base64')}`;
  },
};
