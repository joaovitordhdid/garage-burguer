// Carrinho compartilhado entre o cardápio (index.html) e o checkout (checkout.html).
// Guardado em localStorage na chave 'gb_cart'. Formato de cada linha:
// { key, product_id, name, image, unit_price_cents, qty, removed: [nomes], addons: [{id, name, price_cents}], notes }
// unit_price_cents já inclui os adicionais.
(function () {
  const KEY = 'gb_cart';
  const listeners = new Set();

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
  }
  function write(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {}
    listeners.forEach(fn => fn(items));
  }
  function lineKey(l) {
    return [l.product_id, (l.removed || []).slice().sort().join('|'), (l.addons || []).map(a => a.id).sort().join('|'), l.notes || ''].join('#');
  }

  const Cart = {
    items: read,
    add(line) {
      const items = read();
      line.key = lineKey(line);
      const existing = items.find(i => i.key === line.key);
      if (existing) existing.qty += line.qty || 1; else items.push({ qty: 1, ...line });
      write(items);
    },
    setQty(key, qty) {
      let items = read();
      if (qty <= 0) items = items.filter(i => i.key !== key);
      else items.forEach(i => { if (i.key === key) i.qty = qty; });
      write(items);
    },
    remove(key) { write(read().filter(i => i.key !== key)); },
    clear() { write([]); },
    count() { return read().reduce((s, i) => s + i.qty, 0); },
    subtotalCents() { return read().reduce((s, i) => s + i.unit_price_cents * i.qty, 0); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };

  window.addEventListener('storage', e => { if (e.key === KEY) listeners.forEach(fn => fn(read())); });

  window.GB = window.GB || {};
  window.GB.Cart = Cart;
  window.GB.money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
})();
