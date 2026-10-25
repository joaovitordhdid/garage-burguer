// Garage Burger: cardápio público. Depende de /js/cart.js (GB.Cart, GB.money).
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const Cart = window.GB.Cart;
  const money = window.GB.money;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const catbar = $('#catbar');
  const state = { data: null, products: new Map(), delivery: {}, current: null, qty: 1 };

  // ---------- Utilidades ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const safeUrl = u => (typeof u === 'string' && /^(https:\/\/|\/(?!\/))/i.test(u.trim())) ? u.trim() : null;
  const pad = n => String(n).padStart(2, '0');
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

  function artFor(p, catName) {
    const t = norm(`${catName} ${p.name}`);
    if (/combo|box|kit/.test(t)) return 'art-combo';
    if (/bebida|refri|coca|guarana|suco|agua|cerveja|drink|lata|soda|cha /.test(t)) return 'art-drink';
    if (/sobremesa|doce|milk|shake|brownie|sorvete|acai|pudim|petit/.test(t)) return 'art-dessert';
    if (/porc|batata|frita|onion|nugget|aipim|mandioca|polenta/.test(t)) return 'art-fries';
    return 'art-burger';
  }
  function placeholder(p, cls = '') {
    return `<div class="ph ${cls}" aria-hidden="true"><svg><use href="#${p._art}"/></svg><span class="ph-initial">${esc((p.name || '?').trim().charAt(0))}</span></div>`;
  }
  function media(p, size) {
    const src = safeUrl(p.image);
    if (!src) return placeholder(p);
    return `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" width="${size}" height="${size}" data-fallback="${p.id}">`;
  }
  function discount(p) {
    return p.original_price_cents && p.original_price_cents > p.price_cents
      ? Math.round((1 - p.price_cents / p.original_price_cents) * 100) : 0;
  }
  function priceHtml(p) {
    const off = discount(p);
    return `<span class="price ${off ? 'price--promo' : ''}">
      ${off ? `<span class="price-old"><span class="sr-only">de </span>${money(p.original_price_cents)}</span>` : ''}
      <span class="price-now">${off ? '<span class="sr-only">por </span>' : ''}${money(p.price_cents)}</span></span>`;
  }
  function badgesHtml(p, withFeatured) {
    const off = discount(p), b = [];
    if (p._unavailable) b.push('<span class="badge badge--out">Esgotado</span>');
    if (off) b.push(`<span class="badge badge--promo">-${off}%</span>`);
    if (withFeatured && p.featured) b.push('<span class="badge badge--hot"><svg class="ico" aria-hidden="true"><use href="#i-flame"/></svg>Destaque</span>');
    return b.length ? `<span class="badges">${b.join('')}</span>` : '';
  }
  const needsSheet = p => p.addons.length > 0 || p.ingredients.some(i => i.removable);

  // Imagens quebradas viram ilustração
  document.addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
    const p = state.products.get(Number(img.dataset.fallback));
    if (!p) return;
    p.image = null;
    const tmp = document.createElement('div');
    tmp.innerHTML = placeholder(p);
    img.replaceWith(tmp.firstElementChild);
  }, true);

  // ---------- Horário de funcionamento ----------
  const DAYS = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
  const DAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  function parseHours(text) {
    if (!text || typeof text !== 'string') return null;
    const rules = [];
    for (const seg of text.split(/[;\n|]+/)) {
      const t = norm(seg);
      const tm = t.match(/(\d{1,2})(?:[:h](\d{2}))?\s*h?\s*(?:as|a|-|–|ate)\s*(\d{1,2})(?:[:h](\d{2}))?/);
      if (!tm) continue;
      const open = +tm[1] * 60 + (+tm[2] || 0);
      let close = +tm[3] * 60 + (+tm[4] || 0);
      if (close === 0) close = 24 * 60;
      const daysPart = t.slice(0, tm.index);
      let days = null;
      const range = daysPart.match(/(dom|seg|ter|qua|qui|sex|sab)\w*\.?\s*(?:a|-|–|ate)\s*(dom|seg|ter|qua|qui|sex|sab)/);
      if (range) {
        days = []; let d = DAYS[range[1]];
        for (let k = 0; k < 7; k++) { days.push(d); if (d === DAYS[range[2]]) break; d = (d + 1) % 7; }
      } else {
        const list = daysPart.match(/dom|seg|ter|qua|qui|sex|sab/g);
        if (list) days = list.map(x => DAYS[x]);
        else if (/todos|diariamente|todo dia/.test(daysPart) || !daysPart.trim()) days = [0, 1, 2, 3, 4, 5, 6];
      }
      if (!days) continue;
      rules.push({ days, open, close });
    }
    return rules.length ? rules : null;
  }
  const fmtTime = m => { m %= 1440; const h = Math.floor(m / 60), mm = m % 60; return mm ? `${h}h${pad(mm)}` : `${h}h`; };
  function openStatus(store) {
    if (typeof store.open === 'boolean') return { open: store.open };
    const rules = parseHours(store.hours);
    if (!rules) return null;
    const now = new Date(), day = now.getDay(), min = now.getHours() * 60 + now.getMinutes();
    for (const r of rules) {
      const crosses = r.close <= r.open;
      if (r.days.includes(day) && min >= r.open && (crosses || min < r.close)) return { open: true, until: fmtTime(r.close) };
      const prev = (day + 6) % 7;
      if (crosses && r.days.includes(prev) && min < r.close) return { open: true, until: fmtTime(r.close) };
    }
    // próxima abertura
    for (let k = 0; k < 8; k++) {
      const d = (day + k) % 7;
      const opts = rules.filter(r => r.days.includes(d) && (k > 0 || r.open > min)).sort((a, b) => a.open - b.open);
      if (opts.length) return { open: false, next: `${k === 0 ? 'hoje' : k === 1 ? 'amanhã' : DAY_NAMES[d]} às ${fmtTime(opts[0].open)}` };
    }
    return { open: false };
  }

  // ---------- Loja: hero e rodapé ----------
  function renderStore(store) {
    const name = (store.name || 'Garage Burger').trim();
    document.title = `${name} · Cardápio`;
    const words = name.split(/\s+/);
    const h1 = $('#store-name');
    h1.setAttribute('aria-label', name);
    h1.innerHTML = `<span class="neon-a" aria-hidden="true">${esc(words[0])}</span>${words.length > 1 ? `<span class="neon-b" aria-hidden="true">${esc(words.slice(1).join(' '))}</span>` : ''}`;
    if (words[0].length > 8) h1.classList.add('neon--long');
    $('#hero-kicker').textContent = store.tagline || 'Hambúrguer artesanal';
    const logo = safeUrl(store.logo);
    if (logo) { const el = $('#hero-logo'); el.src = logo; el.alt = `Logo ${name}`; el.hidden = false; }
    const banner = safeUrl(store.banner);
    if (banner) {
      const img = new Image();
      img.onload = () => { const bg = $('#hero-bg'); bg.style.backgroundImage = `url("${banner.replace(/"/g, '%22')}")`; bg.classList.add('has-img'); };
      img.src = banner;
    }

    const d = state.delivery, pills = [];
    const st = openStatus(store);
    if (st) {
      pills.push(st.open
        ? `<li class="pill pill--open"><span class="status-dot" aria-hidden="true"></span>Aberto agora${st.until ? ` · até ${esc(st.until)}` : ''}</li>`
        : `<li class="pill pill--closed"><span class="status-dot" aria-hidden="true"></span>Fechado${st.next ? ` · abre ${esc(st.next)}` : ''}</li>`);
    }
    if (d.eta_min || d.eta_max) {
      const eta = d.eta_min && d.eta_max ? `${d.eta_min}–${d.eta_max} min` : `${d.eta_min || d.eta_max} min`;
      pills.push(`<li class="pill"><svg class="ico" aria-hidden="true"><use href="#i-clock"/></svg>${eta}</li>`);
    }
    if (d.fee_cents != null) {
      pills.push(`<li class="pill"><svg class="ico" aria-hidden="true"><use href="#i-bike"/></svg>${d.fee_cents > 0 ? `Entrega ${money(d.fee_cents)}` : 'Entrega grátis'}</li>`);
    }
    if (!pills.length && store.hours) pills.push(`<li class="pill"><svg class="ico" aria-hidden="true"><use href="#i-clock"/></svg>${esc(store.hours)}</li>`);
    $('#hero-status').innerHTML = pills.join('');

    // Rodapé
    $('#foot-name').textContent = name;
    $('#foot-tag').textContent = store.tagline || '';
    $('#foot-copy').textContent = `© ${new Date().getFullYear()} ${name}`;
    const info = [];
    if (store.address) {
      info.push(`<li><svg class="ico" aria-hidden="true"><use href="#i-pin"/></svg><div><small>Endereço</small>
        <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(store.address)}" target="_blank" rel="noopener">${esc(store.address)}</a></div></li>`);
    }
    if (store.hours) info.push(`<li><svg class="ico" aria-hidden="true"><use href="#i-clock"/></svg><div><small>Horário</small>${esc(store.hours)}</div></li>`);
    const wa = String(store.whatsapp || '').replace(/\D/g, '');
    if (wa) {
      const full = wa.length <= 11 ? `55${wa}` : wa;
      info.push(`<li><svg class="ico" aria-hidden="true"><use href="#i-whats"/></svg><div><small>WhatsApp</small>
        <a href="https://wa.me/${full}" target="_blank" rel="noopener">${esc(fmtPhone(wa))}</a></div></li>`);
    }
    const ph = String(store.phone || '').replace(/\D/g, '');
    if (ph) info.push(`<li><svg class="ico" aria-hidden="true"><use href="#i-phone"/></svg><div><small>Telefone</small><a href="tel:${ph}">${esc(store.phone)}</a></div></li>`);
    if (store.instagram) {
      const raw = String(store.instagram).trim();
      const handle = raw.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
      if (handle) info.push(`<li><svg class="ico" aria-hidden="true"><use href="#i-insta"/></svg><div><small>Instagram</small>
        <a href="https://instagram.com/${encodeURIComponent(handle)}" target="_blank" rel="noopener">@${esc(handle)}</a></div></li>`);
    }
    $('#foot-info').innerHTML = info.join('');
  }
  function fmtPhone(d) {
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d;
  }

  // ---------- Cardápio ----------
  function prepare(data) {
    state.products.clear();
    const cats = (data.categories || []).filter(c => c.active !== false && c.active !== 0)
      .map(c => ({ ...c, products: (c.products || []).filter(p => p.active !== false && p.active !== 0) }))
      .filter(c => c.products.length);
    cats.forEach(c => c.products.forEach(p => {
      p.ingredients = p.ingredients || []; p.addons = p.addons || [];
      p._art = artFor(p, c.name);
      p._cat = c.name;
      // ingrediente obrigatório em falta = produto esgotado
      p._unavailable = p.ingredients.some(i => i.out_of_stock && !i.removable);
      p._search = norm(`${p.name} ${p.description} ${c.name} ${p.ingredients.map(i => i.name).join(' ')}`);
      state.products.set(p.id, p);
    }));
    return cats;
  }

  function cardHtml(p) {
    return `<article class="card ${p._unavailable ? 'is-out' : ''}" data-pid="${p.id}">
      <button class="card-hit" type="button" data-open="${p.id}" aria-label="${esc(p.name)}, ${esc(money(p.price_cents))}${p._unavailable ? ', esgotado' : ''}. Ver detalhes"></button>
      <div class="card-body">
        ${badgesHtml(p, false)}
        <h3 class="card-name">${esc(p.name)}</h3>
        ${p.description ? `<p class="card-desc">${esc(p.description)}</p>` : '<p class="card-desc"></p>'}
        ${priceHtml(p)}
      </div>
      <div class="card-media">
        ${media(p, 136)}
        ${p._unavailable ? '' : `<button class="add-fab" type="button" data-quick="${p.id}" aria-label="Adicionar ${esc(p.name)}"><svg class="ico" aria-hidden="true"><use href="#i-plus"/></svg></button>`}
      </div>
    </article>`;
  }

  function featHtml(p) {
    const src = safeUrl(p.image);
    return `<article class="feat" data-pid="${p.id}">
      <div class="media">${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" width="300" height="375" data-fallback="${p.id}">` : placeholder(p)}</div>
      ${badgesHtml(p, true)}
      <button class="feat-hit" type="button" data-open="${p.id}" aria-label="${esc(p.name)}, ${esc(money(p.price_cents))}. Ver detalhes"></button>
      <div class="feat-body">
        <span class="feat-name">${esc(p.name)}</span>
        ${p.description ? `<span class="feat-desc">${esc(p.description)}</span>` : ''}
        <div class="feat-foot">${priceHtml(p)}
          ${p._unavailable ? '' : `<button class="add-fab" type="button" data-quick="${p.id}" aria-label="Adicionar ${esc(p.name)}"><svg class="ico" aria-hidden="true"><use href="#i-plus"/></svg></button>`}
        </div>
      </div>
    </article>`;
  }

  function renderMenu(cats) {
    // destaques: marcados como destaque + promoções (máx 10)
    const all = cats.flatMap(c => c.products).filter(p => !p._unavailable);
    const feats = [...all.filter(p => p.featured), ...all.filter(p => !p.featured && discount(p))].slice(0, 10);
    $('#rail').innerHTML = feats.map(featHtml).join('');
    $('#destaques').hidden = feats.length === 0;
    updateRailNav();

    $('#categories').innerHTML = cats.map((c, i) => `
      <section class="cat" id="cat-${c.id}" data-cat="${c.id}" aria-labelledby="cat-title-${c.id}">
        <div class="sec-head">
          <span class="bay" aria-hidden="true">Box ${pad(i + 1)}</span>
          <h2 id="cat-title-${c.id}">${esc(c.name)}</h2>
          <span class="sec-count">${plural(c.products.length, 'item', 'itens')}</span>
        </div>
        <div class="grid">${c.products.map(cardHtml).join('')}</div>
      </section>`).join('');

    const chips = (feats.length ? [`<a class="chip" role="listitem" href="#destaques" data-target="destaques">Destaques</a>`] : [])
      .concat(cats.map(c => `<a class="chip" role="listitem" href="#cat-${c.id}" data-target="cat-${c.id}">${esc(c.name)} <small>${c.products.length}</small></a>`));
    $('#chips').innerHTML = chips.join('');
    setupScrollSpy();
  }

  // setas do carrossel (desktop)
  const rail = $('#rail');
  function updateRailNav() {
    const max = rail.scrollWidth - rail.clientWidth - 4;
    $('#rail-prev').disabled = rail.scrollLeft <= 4;
    $('#rail-next').disabled = rail.scrollLeft >= max;
    $('.rail-nav').hidden = max <= 0;
  }
  rail.addEventListener('scroll', () => requestAnimationFrame(updateRailNav), { passive: true });
  window.addEventListener('resize', () => requestAnimationFrame(updateRailNav));
  [['#rail-prev', -1], ['#rail-next', 1]].forEach(([sel, dir]) => $(sel).addEventListener('click', () => {
    rail.scrollBy({ left: dir * rail.clientWidth * 0.8, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }));

  // ---------- Scroll-spy das categorias ----------
  function setActiveChip(id) {
    const chips = $('#chips');
    $$('.chip', chips).forEach(ch => {
      const on = ch.dataset.target === id;
      if (on) ch.setAttribute('aria-current', 'true'); else ch.removeAttribute('aria-current');
      if (on) {
        const left = ch.offsetLeft - chips.clientWidth / 2 + ch.clientWidth / 2;
        chips.scrollTo({ left, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
      }
    });
  }
  let spySections = [], spyTicking = false, spyCurrent = null;
  function computeSpy() {
    spyTicking = false;
    const line = catbar.getBoundingClientRect().bottom + 60;
    let cur = null;
    for (const sec of spySections) {
      if (sec.hidden) continue;
      if (sec.getBoundingClientRect().top <= line) cur = sec.id; else break;
    }
    if (!cur) { const first = spySections.find(x => !x.hidden); cur = first && first.id; }
    if (cur && cur !== spyCurrent) { spyCurrent = cur; setActiveChip(cur); }
  }
  function setupScrollSpy() {
    spySections = $$('#destaques, .cat');
    spyCurrent = null;
    computeSpy();
  }
  window.addEventListener('scroll', () => { if (!spyTicking) { spyTicking = true; requestAnimationFrame(computeSpy); } }, { passive: true });
  $('#chips').addEventListener('click', e => {
    const a = e.target.closest('.chip');
    if (!a) return;
    e.preventDefault();
    const el = document.getElementById(a.dataset.target);
    if (!el) return;
    el.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
    setActiveChip(a.dataset.target);
    history.replaceState(null, '', `#${a.dataset.target}`);
  });

  // ---------- Busca ----------
  const search = $('#search');
  function openSearch() {
    catbar.classList.add('searching');
    $('#search-toggle').setAttribute('aria-expanded', 'true');
    search.focus();
    const top = catbar.getBoundingClientRect().top;
    if (top > 0) window.scrollTo({ top: window.scrollY + top, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }
  function closeSearch() {
    search.value = ''; applySearch();
    catbar.classList.remove('searching');
    $('#search-toggle').setAttribute('aria-expanded', 'false');
    $('#search-toggle').focus();
  }
  function applySearch() {
    const q = norm(search.value.trim());
    let shown = 0;
    $$('.cat').forEach(sec => {
      let n = 0;
      $$('.card', sec).forEach(card => {
        const p = state.products.get(Number(card.dataset.pid));
        const ok = !q || q.split(/\s+/).every(w => p._search.includes(w));
        card.hidden = !ok; if (ok) n++;
      });
      sec.hidden = n === 0; shown += n;
      const cnt = $('.sec-count', sec);
      if (cnt) cnt.textContent = q ? `${plural(n, 'resultado', 'resultados')}` : plural($$('.card', sec).length, 'item', 'itens');
    });
    $('#destaques').hidden = !!q || !$('#rail').children.length;
    $('#empty-search').hidden = shown > 0;
    $('#search-status').textContent = q ? (shown ? `${plural(shown, 'item encontrado', 'itens encontrados')}` : 'Nenhum item encontrado') : '';
  }
  $('#search-toggle').addEventListener('click', openSearch);
  $('#search-close').addEventListener('click', closeSearch);
  $('#clear-search').addEventListener('click', closeSearch);
  search.addEventListener('input', () => {
    applySearch();
    const y = $('#cardapio').getBoundingClientRect().top + window.scrollY - catbar.offsetHeight;
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo({ top: y, behavior: 'auto' });
  });
  search.addEventListener('keydown', e => { if (e.key === 'Escape') closeSearch(); if (e.key === 'Enter') search.blur(); });

  // ---------- Dialogs (abrir/fechar com animação) ----------
  function openDialog(dlg) {
    if (dlg.open) return;
    dlg.classList.remove('closing');
    dlg.showModal();
    document.documentElement.classList.add('lock');
  }
  function closeDialog(dlg) {
    if (!dlg.open || dlg.classList.contains('closing')) return Promise.resolve();
    return new Promise(res => {
      const done = () => { dlg.classList.remove('closing'); dlg.close(); resetDrag(dlg); if (!$$('dialog[open]').length) document.documentElement.classList.remove('lock'); res(); };
      if (reduceMotion.matches) return done();
      dlg.classList.add('closing');
      setTimeout(done, 240);
    });
  }
  $$('dialog').forEach(dlg => {
    dlg.addEventListener('cancel', e => { e.preventDefault(); closeDialog(dlg); });
    dlg.addEventListener('click', e => {
      if (e.target === dlg || e.target.closest('[data-close]')) closeDialog(dlg);
    });
    dlg.addEventListener('close', () => { if (!$$('dialog[open]').length) document.documentElement.classList.remove('lock'); });
    setupDrag(dlg);
  });
  // arrastar para baixo para fechar (mobile)
  function panelOf(dlg) { return dlg.querySelector('.sheet-panel, .drawer-panel'); }
  function resetDrag(dlg) { const p = panelOf(dlg); p.style.transform = ''; p.style.transition = ''; }
  function setupDrag(dlg) {
    const grip = dlg.querySelector('.sheet-grip'), panel = panelOf(dlg);
    const handles = [grip, dlg.querySelector('.sheet-media'), dlg.querySelector('.drawer-head')].filter(Boolean);
    let y0 = null, dy = 0;
    handles.forEach(h => {
      h.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' || window.innerWidth >= 720 || e.target.closest('button')) return;
        y0 = e.clientY; dy = 0; panel.style.transition = 'none';
        h.setPointerCapture(e.pointerId);
      });
      h.addEventListener('pointermove', e => {
        if (y0 == null) return;
        dy = Math.max(0, e.clientY - y0);
        panel.style.transform = `translateY(${dy}px)`;
      });
      const end = () => {
        if (y0 == null) return;
        y0 = null;
        panel.style.transition = 'transform .25s var(--gb-ease)';
        if (dy > 110) { panel.style.transform = 'translateY(100%)'; setTimeout(() => { dlg.close(); resetDrag(dlg); }, 230); }
        else panel.style.transform = '';
      };
      h.addEventListener('pointerup', end);
      h.addEventListener('pointercancel', end);
    });
  }

  // ---------- Produto ----------
  const sheet = $('#sheet');
  function openProduct(p) {
    state.current = p; state.qty = 1;
    const src = safeUrl(p.image);
    $('#sheet-media').innerHTML = (src ? `<img src="${esc(src)}" alt="${esc(p.name)}" decoding="async" data-fallback="${p.id}">` : placeholder(p)) + badgesHtml(p, true);
    $('#sheet-title').textContent = p.name;
    $('#sheet-desc').textContent = p.description || '';
    $('#sheet-desc').hidden = !p.description;
    $('#sheet-price').innerHTML = priceHtml(p);

    const ings = p.ingredients;
    $('#opt-ing').hidden = ings.length === 0;
    const anyRemovable = ings.some(i => i.removable && !i.out_of_stock);
    $('#opt-ing .opt-hint').textContent = anyRemovable ? 'Toque para tirar' : '';
    $('#ing-list').innerHTML = ings.map(i => {
      if (i.out_of_stock) {
        return `<span class="ing oos" data-oos="${esc(i.name)}"><span class="mark" aria-hidden="true"><svg class="ico"><use href="#i-close"/></svg></span><span class="lbl">${esc(i.name)}</span><span class="tag">acabou</span></span>`;
      }
      if (!i.removable) {
        return `<span class="ing fixed" title="Faz parte da receita"><span class="mark" aria-hidden="true"><svg class="ico"><use href="#i-lock"/></svg></span><span class="lbl">${esc(i.name)}</span></span>`;
      }
      return `<button type="button" class="ing" aria-pressed="false" data-ing="${esc(i.name)}" aria-label="${esc(i.name)}: incluso. Toque para tirar">
        <span class="mark" aria-hidden="true"><svg class="ico v"><use href="#i-check"/></svg><svg class="ico x"><use href="#i-close"/></svg></span><span class="lbl">${esc(i.name)}</span></button>`;
    }).join('');

    $('#opt-add').hidden = p.addons.length === 0;
    $('#add-list').innerHTML = p.addons.map(a => `
      <label class="addon"><input type="checkbox" value="${a.id}">
        <span class="box" aria-hidden="true"><svg class="ico"><use href="#i-check"/></svg></span>
        <span class="nm">${esc(a.name)}</span><span class="pr">+ ${money(a.price_cents)}</span></label>`).join('');

    $('#notes').value = ''; $('#notes-count').textContent = '0/140';
    const btn = $('#add-btn');
    btn.disabled = !!p._unavailable;
    btn.firstElementChild.textContent = p._unavailable ? 'Esgotado' : 'Adicionar';
    updateSheet(false);
    $('#sheet-scroll').scrollTop = 0;
    openDialog(sheet);
  }
  function sheetSelection() {
    const p = state.current;
    const removed = $$('.ing[aria-pressed="true"]', sheet).map(b => b.dataset.ing)
      .concat($$('.ing.oos', sheet).map(s => s.dataset.oos));
    const ids = $$('#add-list input:checked').map(i => Number(i.value));
    const addons = p.addons.filter(a => ids.includes(a.id)).map(a => ({ id: a.id, name: a.name, price_cents: a.price_cents }));
    const unit = p.price_cents + addons.reduce((s, a) => s + a.price_cents, 0);
    return { removed, addons, unit };
  }
  function updateSheet(tick = true) {
    const { removed, addons, unit } = sheetSelection();
    $('#qty').textContent = state.qty;
    $('#qty-minus').disabled = state.qty <= 1;
    const priceEl = $('#add-price');
    const txt = money(unit * state.qty);
    if (priceEl.textContent !== txt) {
      priceEl.textContent = txt;
      if (tick) { priceEl.classList.remove('tick'); void priceEl.offsetWidth; priceEl.classList.add('tick'); }
    }
    const parts = [];
    const manual = $$('.ing[aria-pressed="true"]', sheet).map(b => b.dataset.ing);
    if (manual.length) parts.push(`Sem ${listPt(manual.map(s => s.toLowerCase()))}`);
    if (addons.length) parts.push(`com ${listPt(addons.map(a => a.name.toLowerCase()))}`);
    $('#sheet-summary').textContent = parts.length ? parts.join(' · ').replace(/^com/, 'Com') : '';
    void removed;
  }
  function listPt(arr) { return arr.length < 2 ? arr.join('') : `${arr.slice(0, -1).join(', ')} e ${arr[arr.length - 1]}`; }

  $('#ing-list').addEventListener('click', e => {
    const b = e.target.closest('button.ing');
    if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `${b.dataset.ing}: ${on ? 'removido. Toque para colocar de volta' : 'incluso. Toque para tirar'}`);
    updateSheet();
  });
  $('#add-list').addEventListener('change', () => updateSheet());
  $('#qty-minus').addEventListener('click', () => { if (state.qty > 1) { state.qty--; updateSheet(); } });
  $('#qty-plus').addEventListener('click', () => { if (state.qty < 50) { state.qty++; updateSheet(); } });
  $('#notes').addEventListener('input', e => { $('#notes-count').textContent = `${e.target.value.length}/140`; });
  $('#sheet-form').addEventListener('submit', e => {
    e.preventDefault();
    const p = state.current;
    if (!p || p._unavailable) return;
    const { removed, addons, unit } = sheetSelection();
    const from = $('#sheet-media img, #sheet-media .ph');
    const rect = from ? from.getBoundingClientRect() : $('#add-btn').getBoundingClientRect();
    addToCart(p, { removed, addons, unit, qty: state.qty, notes: $('#notes').value.trim() });
    closeDialog(sheet);
    flyToCart(p, rect);
  });

  function addToCart(p, { removed = [], addons = [], unit = p.price_cents, qty = 1, notes = '' } = {}) {
    Cart.add({ product_id: p.id, name: p.name, image: safeUrl(p.image), unit_price_cents: unit, qty, removed, addons, notes });
    toast(`${qty > 1 ? qty + '× ' : ''}${p.name} na sacola`);
    if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
  }

  // Cliques nos cartões
  document.addEventListener('click', e => {
    const quick = e.target.closest('[data-quick]');
    if (quick) {
      const p = state.products.get(Number(quick.dataset.quick));
      if (!p) return;
      if (needsSheet(p)) return openProduct(p);
      const img = quick.closest('.card, .feat').querySelector('img, .ph');
      const rect = (img || quick).getBoundingClientRect();
      addToCart(p, { removed: p.ingredients.filter(i => i.out_of_stock).map(i => i.name) });
      flyToCart(p, rect);
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      const p = state.products.get(Number(open.dataset.open));
      if (p) openProduct(p);
    }
  });

  // ---------- Animação "voando para a sacola" ----------
  function flyToCart(p, rect) {
    const bar = $('#cartbar');
    const target = $('#cart-target');
    if (reduceMotion.matches || !target || !rect || !rect.width) return bump();
    requestAnimationFrame(() => {
      const t = target.getBoundingClientRect();
      const size = 64;
      const el = document.createElement('div');
      el.className = 'fly';
      const src = safeUrl(p.image);
      if (src) el.style.backgroundImage = `url("${src.replace(/"/g, '%22')}")`;
      else el.innerHTML = `<svg aria-hidden="true"><use href="#${p._art}"/></svg>`;
      const x0 = rect.left + rect.width / 2 - size / 2, y0 = rect.top + rect.height / 2 - size / 2;
      const x1 = t.left + t.width / 2 - size / 2, y1 = t.top + t.height / 2 - size / 2;
      el.style.left = `${x0}px`; el.style.top = `${y0}px`;
      document.body.appendChild(el);
      const dx = x1 - x0, dy = y1 - y0, lift = Math.min(160, Math.abs(dy) * 0.4 + 60);
      const anim = el.animate([
        { transform: 'translate(0,0) scale(1.4)', opacity: 0.2 },
        { transform: `translate(${dx * 0.4}px, ${dy * 0.25 - lift}px) scale(1.1)`, opacity: 1, offset: 0.4 },
        { transform: `translate(${dx}px, ${dy}px) scale(.35)`, opacity: 0.9 },
      ], { duration: 720, easing: 'cubic-bezier(.5,0,.3,1)' });
      anim.onfinish = () => { el.remove(); bump(); };
      void bar;
    });
  }
  function bump() {
    const bar = $('#cartbar');
    bar.classList.remove('bump'); void bar.offsetWidth; bar.classList.add('bump');
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- Sacola ----------
  const drawer = $('#drawer');
  function renderCartBar() {
    const n = Cart.count();
    $('#cartbar').hidden = n === 0;
    $('#cart-count').textContent = n;
    $('#cart-total').textContent = money(Cart.subtotalCents());
    $('#cartbar-btn').setAttribute('aria-label', `Ver sacola: ${plural(n, 'item', 'itens')}, ${money(Cart.subtotalCents())}`);
  }
  function lineThumb(l) {
    const p = state.products.get(l.product_id);
    const src = safeUrl(l.image);
    if (src) return `<img class="line-thumb" src="${esc(src)}" alt="" loading="lazy" width="56" height="56">`;
    return `<div class="line-thumb ph" aria-hidden="true"><svg><use href="#${p ? p._art : 'art-burger'}"/></svg></div>`;
  }
  function renderDrawer() {
    const items = Cart.items();
    $('#drawer-empty').hidden = items.length > 0;
    $('#drawer-foot').hidden = items.length === 0;
    $('#lines').innerHTML = items.map(l => {
      const meta = [];
      if (l.removed && l.removed.length) meta.push(`<span class="rm">Sem ${esc(listPt(l.removed.map(s => s.toLowerCase())))}</span>`);
      if (l.addons && l.addons.length) meta.push(`<span class="ad">+ ${esc(l.addons.map(a => a.name).join(', '))}</span>`);
      if (l.notes) meta.push(`<span>“${esc(l.notes)}”</span>`);
      return `<li class="line" data-key="${esc(l.key)}">
        ${lineThumb(l)}
        <div>
          <div class="line-name"><span>${esc(l.name)}</span><span>${money(l.unit_price_cents * l.qty)}</span></div>
          ${meta.length ? `<p class="line-meta">${meta.join(' · ')}</p>` : ''}
          <div class="line-ctl">
            <div class="stepper" role="group" aria-label="Quantidade de ${esc(l.name)}">
              <button type="button" class="step-btn" data-dec aria-label="${l.qty <= 1 ? 'Remover' : 'Diminuir'} ${esc(l.name)}"><svg class="ico" aria-hidden="true"><use href="#${l.qty <= 1 ? 'i-trash' : 'i-minus'}"/></svg></button>
              <output>${l.qty}</output>
              <button type="button" class="step-btn" data-inc aria-label="Aumentar ${esc(l.name)}"><svg class="ico" aria-hidden="true"><use href="#i-plus"/></svg></button>
            </div>
            ${l.qty > 1 ? `<span class="line-unit">${money(l.unit_price_cents)} cada</span>` : ''}
          </div>
        </div>
      </li>`;
    }).join('');
    const sub = Cart.subtotalCents();
    $('#drawer-subtotal').textContent = money(sub);
    const min = state.delivery.min_order_cents || 0;
    const mo = $('#min-order');
    mo.hidden = !min || sub >= min;
    if (min && sub < min) {
      $('#min-fill').style.width = `${Math.min(100, (sub / min) * 100)}%`;
      $('#min-text').textContent = `Faltam ${money(min - sub)} para o pedido mínimo de entrega (${money(min)}).`;
    }
    const fee = state.delivery.fee_cents;
    $('#fee-note').textContent = fee > 0 ? `+ taxa de entrega de ${money(fee)} (ou retire grátis no balcão).` : 'Taxa de entrega calculada no próximo passo.';
  }
  $('#lines').addEventListener('click', e => {
    const li = e.target.closest('.line');
    if (!li) return;
    const key = li.dataset.key;
    const line = Cart.items().find(i => i.key === key);
    if (!line) return;
    const removeLine = () => {
      if (reduceMotion.matches) return Cart.remove(key);
      li.classList.add('removing');
      setTimeout(() => Cart.remove(key), 260);
    };
    if (e.target.closest('[data-inc]')) Cart.setQty(key, line.qty + 1);
    else if (e.target.closest('[data-dec]')) { if (line.qty <= 1) removeLine(); else Cart.setQty(key, line.qty - 1); }
    else if (e.target.closest('[data-del]')) removeLine();
  });
  $('#clear-cart').addEventListener('click', () => {
    if (confirm('Esvaziar a sacola?')) Cart.clear();
  });
  $('#cartbar-btn').addEventListener('click', () => { renderDrawer(); openDialog(drawer); });

  Cart.onChange(() => {
    renderCartBar();
    if (drawer.open) {
      renderDrawer();
      if (!Cart.count()) setTimeout(() => closeDialog(drawer), 900);
    }
  });

  // ---------- Inicialização ----------
  try {
    if (sessionStorage.getItem('gb_intro')) document.documentElement.classList.add('skip-intro');
    sessionStorage.setItem('gb_intro', '1');
  } catch {}

  async function load() {
    $('#load-error').hidden = true;
    try {
      const r = await fetch('/api/menu', { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.data = data;
      state.delivery = data.delivery || (data.store && data.store.delivery) || {};
      renderStore(data.store || {});
      renderMenu(prepare(data));
      renderCartBar();
      // abre produto por link (#produto-12)
      const m = location.hash.match(/^#produto-(\d+)$/);
      if (m && state.products.get(+m[1])) openProduct(state.products.get(+m[1]));
    } catch (err) {
      console.warn('Falha ao carregar o cardápio', err);
      $('#categories').innerHTML = '';
      $('#load-error').hidden = false;
    }
  }
  $('#retry').addEventListener('click', load);
  renderCartBar();
  load();
})();
