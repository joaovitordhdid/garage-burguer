// Checkout da Garage Burger: resumo do carrinho, dados, localização, pagamento e envio do pedido.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const Cart = window.GB && window.GB.Cart;
  const money = c => (window.GB && window.GB.money ? window.GB.money(c) : 'R$ ' + (c / 100).toFixed(2).replace('.', ','));
  const LS_CUSTOMER = 'gb_customer';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    config: { delivery: { fee_cents: 0, min_order_cents: 0, eta_min: 30, eta_max: 50 }, store: { name: 'Garage Burger', open: true }, payment: { pix: false } },
    loc: null,            // { lat, lng, accuracy }
    touched: new Set(),   // campos de endereço editados à mão (não sobrescrever)
    sending: false,
  };

  // ---------- utilidades ----------
  const digits = s => String(s || '').replace(/\D/g, '');
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function isValidCpf(v) {
    const d = digits(v);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const calc = len => { let s = 0; for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
  }
  function phoneOk(v) {
    let d = digits(v);
    if (d.length < 10 || d.length > 11) return false;
    if (Number(d.slice(0, 2)) < 11) return false;
    if (d.length === 11 && d[2] !== '9') return false;
    return true;
  }
  function maskCpf(v) {
    const d = digits(v).slice(0, 11);
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  function maskPhone(v) {
    const d = digits(v).slice(0, 11);
    if (d.length <= 2) return d.length ? '(' + d : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  function maskMoney(v) {
    const d = digits(v).replace(/^0+/, '').slice(0, 7);
    if (!d) return '';
    const c = d.padStart(3, '0');
    const int = c.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return int + ',' + c.slice(-2);
  }
  const moneyToCents = v => Number(digits(v) || 0);

  // Aplica máscara mantendo o cursor no fim (suficiente para campos curtos digitados no celular)
  function bindMask(input, fn) {
    input.addEventListener('input', () => { input.value = fn(input.value); });
  }

  function setError(field, msg) {
    const el = document.getElementById('err-' + field);
    const input = { name: '#name', phone: '#phone', cpf: '#cpf', street: '#street', number: '#number', change: '#changeFor' }[field];
    if (el) { el.textContent = msg || ''; el.classList.toggle('show', !!msg); }
    if (input) {
      const i = $(input);
      i.classList.toggle('is-invalid', !!msg);
      i.classList.toggle('is-valid', !msg && i.value.trim() !== '');
      i.setAttribute('aria-invalid', msg ? 'true' : 'false');
      if (el) i.setAttribute('aria-describedby', el.id);
    }
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 250); }, 5000);
  }

  // ---------- validação por seção ----------
  const deliveryType = () => (document.querySelector('input[name="delivery_type"]:checked') || {}).value;
  const payment = () => (document.querySelector('input[name="payment"]:checked') || {}).value;

  const validators = {
    name() {
      const v = $('#name').value.trim().replace(/\s+/g, ' ');
      if (!v) return 'Como podemos te chamar? Digite seu nome completo.';
      if (v.length < 5 || v.split(' ').filter(w => w.length >= 2).length < 2) return 'Digite nome e sobrenome.';
      return '';
    },
    phone() {
      const v = $('#phone').value;
      if (!digits(v)) return 'Precisamos do seu WhatsApp para avisar sobre o pedido.';
      return phoneOk(v) ? '' : 'Número incompleto. Use DDD + número, ex.: (11) 98765-4321.';
    },
    cpf() {
      const v = $('#cpf').value;
      if (!digits(v)) return 'O CPF é usado na nota fiscal.';
      if (digits(v).length < 11) return 'CPF incompleto (11 números).';
      return isValidCpf(v) ? '' : 'Esse CPF não parece válido. Confira os números.';
    },
    location() { return deliveryType() !== 'delivery' || state.loc ? '' : 'Toque em "Usar minha localização atual" para o entregador te encontrar.'; },
    street() { return deliveryType() !== 'delivery' || $('#street').value.trim().length >= 3 ? '' : 'Confirme o nome da rua.'; },
    number() { return deliveryType() !== 'delivery' || $('#number').value.trim() ? '' : 'Informe o número (ou "s/n").'; },
    payment() { return payment() ? '' : 'Escolha como vai pagar.'; },
    change() {
      if (payment() !== 'dinheiro' || $('#noChange').checked) return '';
      const c = moneyToCents($('#changeFor').value);
      if (!c) return 'Informe para quanto precisa de troco ou marque "Não preciso de troco".';
      return c < totals().total ? `O troco precisa ser maior que o total (${money(totals().total)}).` : '';
    },
  };
  const sections = {
    dados: ['name', 'phone', 'cpf'],
    entrega: ['location', 'street', 'number'],
    pagamento: ['payment', 'change'],
  };
  const sectionValid = s => sections[s].every(f => !validators[f]());

  function validateField(f) { const m = validators[f](); setError(f, m); return !m; }

  function updateSteps() {
    let done = 0;
    for (const s of Object.keys(sections)) {
      const ok = sectionValid(s);
      if (ok) done++;
      document.querySelector(`[data-section="${s}"]`).classList.toggle('is-complete', ok);
      document.querySelector(`.ck-steps li[data-step="${s}"]`).classList.toggle('is-done', ok);
    }
    const firstOpen = Object.keys(sections).find(s => !sectionValid(s));
    $$('.ck-steps li').forEach(li => li.classList.toggle('is-current', li.dataset.step === firstOpen));
    $('#stepsFill').style.transform = `scaleX(${done / 3})`;
    $('#submitBtn').classList.toggle('is-ready', done === 3);
  }

  // ---------- carrinho ----------
  function totals() {
    const items = Cart ? Cart.items() : [];
    const subtotal = items.reduce((s, i) => s + i.unit_price_cents * i.qty, 0);
    const fee = deliveryType() === 'delivery' ? state.config.delivery.fee_cents : 0;
    return { items, subtotal, fee, total: subtotal + fee, count: items.reduce((s, i) => s + i.qty, 0) };
  }

  function renderCart() {
    const t = totals();
    const empty = t.items.length === 0;
    $('#emptyState').hidden = !empty;
    $('#checkout').hidden = empty;
    $('#bar').hidden = empty;
    document.body.classList.toggle('is-empty', empty);
    if (empty) return;

    $('#items').innerHTML = t.items.map(i => {
      const mods = [];
      (i.removed || []).forEach(r => mods.push(`<span class="ck-mod ck-mod-sem">sem ${esc(r)}</span>`));
      (i.addons || []).forEach(a => mods.push(`<span class="ck-mod ck-mod-add">+ ${esc(a.name)}</span>`));
      return `<li class="ck-item" data-key="${esc(i.key)}">
        ${i.image ? `<img class="ck-item-img" src="${esc(i.image)}" alt="" loading="lazy">` : '<span class="ck-item-img ck-item-ph" aria-hidden="true"></span>'}
        <div class="ck-item-info">
          <b>${esc(i.name)}</b>
          ${mods.length ? `<div class="ck-mods">${mods.join('')}</div>` : ''}
          ${i.notes ? `<small class="ck-item-note">“${esc(i.notes)}”</small>` : ''}
          <span class="ck-item-price">${money(i.unit_price_cents * i.qty)}</span>
        </div>
        <div class="ck-qty" role="group" aria-label="Quantidade de ${esc(i.name)}">
          <button type="button" data-act="dec" aria-label="${i.qty === 1 ? 'Remover' : 'Diminuir'} ${esc(i.name)}">${i.qty === 1
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>' : '−'}</button>
          <output aria-live="polite">${i.qty}</output>
          <button type="button" data-act="inc" aria-label="Aumentar ${esc(i.name)}" ${i.qty >= 50 ? 'disabled' : ''}>+</button>
        </div>
      </li>`;
    }).join('');

    $('#tSubtotal').textContent = money(t.subtotal);
    $('#feeRow').hidden = deliveryType() !== 'delivery';
    $('#tFee').textContent = t.fee ? money(t.fee) : 'Grátis';
    $('#tTotal').textContent = money(t.total);
    $('#barTotal').textContent = money(t.total);
    $('#barCount').textContent = `${t.count} ${t.count === 1 ? 'item' : 'itens'} · Total`;

    const min = state.config.delivery.min_order_cents;
    const warn = deliveryType() === 'delivery' && min > 0 && t.subtotal < min;
    $('#minWarn').hidden = !warn;
    if (warn) $('#minWarn').textContent = `Pedido mínimo para entrega: ${money(min)}. Faltam ${money(min - t.subtotal)}.`;
    if (payment() === 'dinheiro' && $('#changeFor').value) validateField('change');
    updateSteps();
  }

  function onItemsClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const li = btn.closest('.ck-item');
    const item = Cart.items().find(i => i.key === li.dataset.key);
    if (!item) return;
    if (btn.dataset.act === 'inc') Cart.setQty(item.key, Math.min(50, item.qty + 1));
    else if (item.qty <= 1) {
      li.classList.add('is-leaving');
      setTimeout(() => Cart.remove(item.key), reduceMotion ? 0 : 200);
    } else Cart.setQty(item.key, item.qty - 1);
  }

  // ---------- entrega ----------
  function applyDeliveryType() {
    const isDel = deliveryType() === 'delivery';
    $('#deliveryBox').hidden = !isDel;
    $('#pickupBox').hidden = isDel;
    const d = state.config.delivery;
    $('#eta').innerHTML = isDel
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> Chega em <b>${d.eta_min}–${d.eta_max} min</b>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> Pronto em cerca de <b>${Math.max(10, d.eta_min - 10)}–${Math.max(20, d.eta_max - 15)} min</b>`;
    ['location', 'street', 'number'].forEach(f => setError(f, ''));
    renderCart();
  }

  function geoSetMsg(kind, html) {
    const m = $('#geoMsg');
    m.className = 'ck-geo-msg ck-geo-' + kind;
    m.innerHTML = html;
    m.hidden = !html;
  }

  function permissionHelp() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua)) {
      return 'No iPhone: abra <b>Ajustes › Privacidade › Serviços de Localização</b>, ative e escolha <b>Safari (ou seu navegador) › Durante o Uso</b>. Depois volte aqui e toque de novo.';
    }
    if (/Android/i.test(ua)) {
      return 'No Android: toque no <b>cadeado</b> ao lado do endereço do site › <b>Permissões › Local › Permitir</b>. Verifique também se o GPS do celular está ligado.';
    }
    return 'Clique no <b>cadeado</b> ao lado do endereço do site, permita a <b>Localização</b> e toque de novo no botão.';
  }

  function requestLocation() {
    const btn = $('#geoBtn');
    if (!('geolocation' in navigator)) {
      geoSetMsg('error', 'Seu navegador não permite pegar a localização. Tente outro navegador ou escolha <b>Retirar no balcão</b>.');
      return;
    }
    if (!window.isSecureContext) {
      geoSetMsg('error', 'A localização só funciona em conexão segura (https). Abra o site pelo endereço com https.');
      return;
    }
    btn.classList.add('is-loading'); btn.disabled = true;
    $('#geoLabel').textContent = 'Localizando você…';
    $('#geoSub').textContent = 'Aceite o pedido de localização do navegador';
    geoSetMsg('', '');
    navigator.geolocation.getCurrentPosition(onPosition, onGeoError, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  function onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    state.loc = { lat, lng, accuracy };
    const btn = $('#geoBtn');
    btn.classList.remove('is-loading'); btn.classList.add('is-ok'); btn.disabled = false;
    $('#geoLabel').textContent = 'Localização capturada';
    $('#geoSub').textContent = 'Toque para atualizar';
    setError('location', '');
    showMap(lat, lng, accuracy);
    if (accuracy > 150) {
      geoSetMsg('warn', `Precisão baixa (±${Math.round(accuracy)} m). Se puder, ligue o GPS e toque de novo. Confira o endereço abaixo.`);
    } else geoSetMsg('', '');
    reverseGeocode(lat, lng);
    updateSteps();
  }

  function onGeoError(err) {
    const btn = $('#geoBtn');
    btn.classList.remove('is-loading'); btn.disabled = false;
    $('#geoLabel').textContent = state.loc ? 'Localização capturada' : 'Tentar de novo';
    $('#geoSub').textContent = state.loc ? 'Toque para atualizar' : 'Obrigatório para o entregador te encontrar';
    if (err && err.code === 1) {
      geoSetMsg('error', `<b>Você bloqueou a localização.</b> Sem ela não conseguimos entregar. ${permissionHelp()}
        <br><button type="button" class="ck-linkbtn" data-pickup>Prefiro retirar no balcão</button>`);
    } else if (err && err.code === 3) {
      geoSetMsg('error', 'Demorou demais para achar sua localização. Vá para perto de uma janela ou ligue o GPS e toque de novo.');
    } else {
      geoSetMsg('error', 'Não conseguimos achar sua localização agora. Verifique se o GPS/Localização está ligado e tente de novo.');
    }
  }

  function showMap(lat, lng, acc) {
    const dLat = 0.0025, dLng = 0.004;
    const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map(n => n.toFixed(6)).join(',');
    $('#map').src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(6)},${lng.toFixed(6)}`;
    $('#mapAcc').textContent = acc ? `Precisão ±${Math.round(acc)} m` : '';
    $('#mapWrap').hidden = false;
  }

  async function reverseGeocode(lat, lng) {
    const fields = $('#addressFields');
    fields.classList.add('is-loading');
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=pt-BR&lat=${lat}&lon=${lng}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const a = j.address || {};
      const fill = (id, v) => { if (v && !state.touched.has(id)) { $('#' + id).value = v; } };
      fill('street', a.road || a.pedestrian || a.footway || a.residential || '');
      fill('number', a.house_number || '');
      fill('district', a.suburb || a.neighbourhood || a.quarter || a.city_district || '');
      state.city = a.city || a.town || a.village || a.municipality || '';
      if (!$('#number').value) {
        geoSetMsg('info', 'Endereço encontrado! <b>Confira a rua e informe o número</b>.');
        $('#number').focus({ preventScroll: true });
      } else geoSetMsg('info', 'Endereço encontrado! Confira se está certinho.');
    } catch (e) {
      geoSetMsg('warn', 'Pegamos sua localização, mas não conseguimos descobrir o endereço. Digite a rua e o número abaixo.');
    } finally {
      fields.classList.remove('is-loading');
      ['street', 'number'].forEach(f => { if ($('#' + f).value) validateField(f); });
      updateSteps();
    }
  }

  function fullAddress() {
    const parts = [$('#street').value.trim() + ', ' + $('#number').value.trim()];
    if ($('#complement').value.trim()) parts[0] += ' - ' + $('#complement').value.trim();
    if ($('#district').value.trim()) parts.push($('#district').value.trim());
    if (state.city) parts.push(state.city);
    return parts.join(' - ');
  }

  // ---------- pagamento ----------
  function applyPayment() {
    const isCash = payment() === 'dinheiro';
    $('#changeBox').hidden = !isCash;
    setError('payment', '');
    if (!isCash) setError('change', '');
    updateSteps();
  }

  // ---------- envio ----------
  async function submit(e) {
    e.preventDefault();
    if (state.sending) return;
    if (!state.config.store.open) { toast('A loja está fechada agora. Volte no horário de funcionamento!'); return; }
    const t = totals();
    if (!t.items.length) return;
    const min = state.config.delivery.min_order_cents;
    if (deliveryType() === 'delivery' && min > 0 && t.subtotal < min) {
      toast(`Pedido mínimo para entrega: ${money(min)}.`); $('.ck-summary').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); return;
    }

    let firstBad = null;
    for (const f of Object.keys(validators)) {
      if (!validateField(f) && !firstBad) firstBad = f;
    }
    updateSteps();
    if (firstBad) {
      const target = { location: '#geoBtn', payment: '.ck-pay', change: '#changeFor' }[firstBad] || '#' + firstBad;
      const el = $(target);
      el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      if (el.focus) setTimeout(() => el.focus({ preventScroll: true }), reduceMotion ? 0 : 350);
      el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
      return;
    }

    const isDel = deliveryType() === 'delivery';
    const body = {
      customer: { name: $('#name').value.trim().replace(/\s+/g, ' '), cpf: digits($('#cpf').value), phone: digits($('#phone').value) },
      delivery_type: isDel ? 'delivery' : 'retirada',
      address: isDel ? fullAddress() : null,
      address_ref: isDel ? $('#ref').value.trim() || null : null,
      lat: isDel ? state.loc.lat : null,
      lng: isDel ? state.loc.lng : null,
      payment_method: payment(),
      change_for_cents: payment() === 'dinheiro' && !$('#noChange').checked ? moneyToCents($('#changeFor').value) : null,
      notes: $('#notes').value.trim() || null,
      items: t.items.map(i => ({ product_id: i.product_id, qty: i.qty, removed: i.removed || [], addon_ids: (i.addons || []).map(a => a.id), notes: i.notes || null })),
    };

    state.sending = true;
    $('#submitBtn').disabled = true;
    $('#sending').hidden = false;
    try {
      const r = await fetch('/api/orders', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const map = { name: 'name', cpf: 'cpf', phone: 'phone', location: 'location', address: 'street', change_for: 'change', payment_method: 'payment' };
        if (j.field && map[j.field]) {
          setError(map[j.field], j.error);
          const el = document.getElementById('err-' + map[j.field]);
          if (el) el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        }
        toast(j.error || 'Não foi possível enviar o pedido. Tente de novo.');
        return;
      }
      saveCustomer();
      ls.set('gb_last_order', { code: j.code, at: Date.now() });
      Cart.clear();
      location.href = '/pedido?c=' + encodeURIComponent(j.code) + '&novo=1';
    } catch (err) {
      toast('Sem conexão com a internet. Verifique e tente de novo.');
    } finally {
      state.sending = false;
      $('#submitBtn').disabled = false;
      $('#sending').hidden = true;
    }
  }

  function saveCustomer() {
    const remember = $('#remember').checked;
    const data = { name: $('#name').value.trim(), phone: $('#phone').value, remember };
    if (remember) data.cpf = $('#cpf').value;
    ls.set(LS_CUSTOMER, data);
  }
  function loadCustomer() {
    const c = ls.get(LS_CUSTOMER);
    if (!c) return;
    if (c.name) $('#name').value = c.name;
    if (c.phone) $('#phone').value = maskPhone(c.phone);
    if (c.remember) { $('#remember').checked = true; if (c.cpf) $('#cpf').value = maskCpf(c.cpf); }
    ['name', 'phone', 'cpf'].forEach(f => { if ($('#' + f).value) validateField(f); });
  }

  async function loadConfig() {
    try {
      const r = await fetch('/api/orders/config', { credentials: 'same-origin' });
      if (r.ok) state.config = await r.json();
    } catch {}
    const d = state.config.delivery;
    $('#segFee').textContent = d.fee_cents ? money(d.fee_cents) : 'Grátis';
    $('#pixSub').textContent = state.config.payment && state.config.payment.pix ? 'QR Code na próxima tela' : 'Na entrega / retirada';
    if (state.config.store.address) $('#storeAddress').textContent = state.config.store.address;
    $('#closedBanner').hidden = state.config.store.open !== false;
    applyDeliveryType();
  }

  // ---------- inicialização ----------
  function init() {
    if (!Cart) { document.body.textContent = 'Erro ao carregar o carrinho.'; return; }
    bindMask($('#cpf'), maskCpf);
    bindMask($('#phone'), maskPhone);
    bindMask($('#changeFor'), maskMoney);

    // validação: no blur e, depois de errar uma vez, enquanto digita
    ['name', 'phone', 'cpf', 'street', 'number'].forEach(f => {
      const el = $('#' + f);
      el.addEventListener('blur', () => { if (el.value.trim()) validateField(f); updateSteps(); });
      el.addEventListener('input', () => {
        if (el.classList.contains('is-invalid')) validateField(f);
        if (f === 'cpf' && digits(el.value).length === 11) { validateField('cpf'); }
        if (f === 'phone' && digits(el.value).length === 11) { validateField('phone'); }
        updateSteps();
      });
    });
    ['street', 'number', 'district'].forEach(id => $('#' + id).addEventListener('input', () => state.touched.add(id)));
    $('#changeFor').addEventListener('input', () => { if ($('#changeFor').value) $('#noChange').checked = false; validateField('change'); updateSteps(); });
    $('#noChange').addEventListener('change', () => { if ($('#noChange').checked) $('#changeFor').value = ''; validateField('change'); updateSteps(); });

    $$('input[name="delivery_type"]').forEach(r => r.addEventListener('change', applyDeliveryType));
    $$('input[name="payment"]').forEach(r => r.addEventListener('change', applyPayment));
    $('#geoBtn').addEventListener('click', requestLocation);
    $('#geoMsg').addEventListener('click', e => {
      if (e.target.closest('[data-pickup]')) {
        const r = document.querySelector('input[name="delivery_type"][value="retirada"]');
        r.checked = true; applyDeliveryType(); r.focus();
      }
    });
    $('#items').addEventListener('click', onItemsClick);
    $('#form').addEventListener('submit', submit);
    $('#remember').addEventListener('change', () => { if (!$('#remember').checked) { const c = ls.get(LS_CUSTOMER); if (c) { delete c.cpf; c.remember = false; ls.set(LS_CUSTOMER, c); } } });

    Cart.onChange(renderCart);
    loadCustomer();
    renderCart();
    loadConfig();

    // Se a permissão já foi concedida antes, pega a localização sem precisar tocar
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(p => {
        if (p.state === 'granted' && deliveryType() === 'delivery' && !state.loc && Cart.items().length) requestLocation();
      }).catch(() => {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
