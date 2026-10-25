// Painel: Automação (aceite automático, impressão, nota fiscal, saída para entrega).
// Enquanto o painel fica aberto, chama POST /api/admin/automation/tick a cada 10 s.
(function () {
  'use strict';
  const A = window.GBA;
  const { h } = A;
  const TICK_MS = 10000;
  const LOG_KEY = 'gb.automation.log';
  const LOG_MAX = 60;

  const auto = (A.automation = {
    settings: null, store: null, timer: null, ticking: false,
    lastTick: null, lastError: null, latestId: null, log: loadLog(),
  });

  // ---------- Registro das ações ----------
  function loadLog() {
    try { const v = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); return Array.isArray(v) ? v.slice(0, LOG_MAX) : []; } catch { return []; }
  }
  function saveLog() { try { localStorage.setItem(LOG_KEY, JSON.stringify(auto.log.slice(0, LOG_MAX))); } catch { /* sem armazenamento */ } }
  function addLog(type, text, link) {
    auto.log.unshift({ at: new Date().toISOString(), type, text, link: link || null });
    auto.log.length = Math.min(auto.log.length, LOG_MAX);
    saveLog();
    renderLog();
  }
  const LOG_LABEL = { aceito: 'Aceito', impresso: 'Impresso', nota: 'Nota', nota_erro: 'Nota', saiu: 'Saiu', erro: 'Erro', info: 'Info' };
  const hhmmss = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let logEl = null;
  function renderLog() {
    if (!logEl) return;
    A.clear(logEl);
    if (!auto.log.length) { logEl.appendChild(A.empty('Nada por aqui ainda.', 'As ações automáticas aparecem nesta lista.')); return; }
    logEl.appendChild(h('ul.autolog', auto.log.map(e => h('li', { class: 'autolog--' + e.type },
      h('time', hhmmss(e.at)),
      h('span.autolog__tag', LOG_LABEL[e.type] || e.type),
      h('span.autolog__text', e.text),
      e.link ? h('a.link', { href: e.link.url, target: '_blank', rel: 'noopener' }, e.link.label) : null))));
  }

  // ---------- Indicador no topo ----------
  function indicator() {
    const el = document.getElementById('auto-ind');
    if (!el) return;
    const s = auto.settings;
    const on = !!(s && s.enabled);
    el.classList.toggle('is-on', on && !auto.lastError);
    el.classList.toggle('is-warn', on && !!auto.lastError);
    const label = el.querySelector('.auto-ind__label');
    const time = el.querySelector('.auto-ind__time');
    label.textContent = on ? (auto.lastError ? 'Automação: sem conexão' : 'Automação ligada') : 'Automação desligada';
    time.textContent = on && auto.lastTick ? hhmmss(auto.lastTick) : '';
    time.hidden = !time.textContent;
    el.title = on ? `Último ciclo: ${auto.lastTick ? hhmmss(auto.lastTick) : '—'}${auto.lastError ? ` · ${auto.lastError}` : ''}` : 'Clique para configurar a automação';
    const st = document.getElementById('auto-status');
    if (st) st.textContent = on ? (auto.lastTick ? `Último ciclo às ${hhmmss(auto.lastTick)}${auto.lastError ? ` · erro: ${auto.lastError}` : ''}` : 'Iniciando…') : 'Desligada: nada acontece sozinho.';
  }

  // ---------- Ciclo ----------
  async function start() {
    stop();
    try {
      const r = await A.api('/api/admin/automation/settings');
      auto.settings = r.settings; auto.store = r.store;
    } catch (e) { if (e.status !== 401) console.warn('automação', e.message); }
    indicator();
    if (auto.settings && auto.settings.enabled) {
      tick();
      auto.timer = setInterval(tick, TICK_MS);
    }
  }
  function stop() { if (auto.timer) clearInterval(auto.timer); auto.timer = null; }
  auto.start = start;
  auto.addLog = addLog;
  auto.stop = stop;

  async function tick() {
    if (auto.ticking) return;
    auto.ticking = true;
    try {
      const r = await A.api('/api/admin/automation/tick', { method: 'POST', body: {} });
      auto.lastTick = r.at || new Date().toISOString();
      auto.lastError = null;
      if (!r.enabled) { auto.settings.enabled = false; stop(); indicator(); return; }
      let changed = false;
      for (const a of r.actions || []) {
        changed = true;
        const link = a.whatsapp_url ? { url: a.whatsapp_url, label: 'Avisar cliente no WhatsApp ↗' } : null;
        addLog(a.type, a.text, link);
        if (a.type === 'saiu' && a.whatsapp_url) notifyToast(a);
      }
      for (const p of r.to_print || []) {
        const ok = await A.printer.printUrl(p.url);
        await A.api(`/api/admin/automation/orders/${p.id}/printed`, { method: 'POST', body: { kind: 'receipt', ok } }).catch(() => {});
        addLog(ok ? 'impresso' : 'erro', ok ? `${p.code} impresso (${viasLabel()})` : `${p.code}: falha ao imprimir, tentando de novo em 1 min`);
        changed = true;
      }
      for (const d of r.danfe_to_print || []) {
        const res = await A.printer.danfe(d);
        await A.api(`/api/admin/automation/orders/${d.id}/printed`, { method: 'POST', body: { kind: 'danfe', ok: res.ok } }).catch(() => {});
        if (res.blocked) addLog('erro', `${d.code}: o navegador bloqueou a DANFE (permita pop-ups)`, { url: d.url, label: 'Abrir DANFE ↗' });
        else addLog(res.ok ? 'impresso' : 'erro', res.ok ? `${d.code}: nota fiscal${d.number ? ` nº ${d.number}` : ''} ${res.opened ? 'aberta para imprimir' : 'impressa'}` : `${d.code}: falha ao imprimir a nota`);
        changed = true;
      }
      for (const e of r.errors || []) addLog('erro', e);
      // Pedido novo: o poll do painel toca o alerta e atualiza o contador
      const fresh = auto.latestId !== null && r.latest_id > auto.latestId;
      auto.latestId = r.latest_id ?? auto.latestId;
      if (fresh || (r.actions || []).some(a => a.type === 'aceito')) { if (A.pollNow) A.pollNow(); }
      else if (changed) {
        if (A.currentView() === 'pedidos' && A.views.pedidos.refresh) A.views.pedidos.refresh();
      }
      if (changed && A.currentView() === 'entregas' && A.views.entregas.refresh) A.views.entregas.refresh();
    } catch (e) {
      if (e.status === 401) { stop(); return; }
      auto.lastError = e.message || 'erro';
    } finally {
      auto.ticking = false;
      indicator();
    }
  }
  auto.tick = tick;

  function viasLabel() {
    const s = auto.settings || {};
    const v = [s.print_kitchen && 'cozinha', s.print_delivery && 'entrega'].filter(Boolean).join(' + ');
    return `${v}${s.print_copies > 1 ? `, ${s.print_copies} cópias` : ''}`;
  }

  function notifyToast(a) {
    const box = document.getElementById('toasts');
    const t = h('div.toast.toast--new', { role: 'status' },
      h('div', a.text),
      h('a.gb-btn.btn-sm.toast__btn', { href: a.whatsapp_url, target: '_blank', rel: 'noopener', on: { click: () => setTimeout(() => t.remove(), 300) } }, 'Avisar cliente no WhatsApp'));
    box.appendChild(t);
    setTimeout(() => { t.classList.add('toast--out'); setTimeout(() => t.remove(), 300); }, 20000);
  }

  // ---------- Tela "Automação" ----------
  async function saveSettings(patch, msg) {
    const r = await A.api('/api/admin/automation/settings', { method: 'PUT', body: { ...auto.settings, ...patch } });
    const wasOn = auto.settings && auto.settings.enabled;
    auto.settings = r.settings;
    if (msg) A.toast(msg);
    if (r.settings.enabled && !wasOn) { addLog('info', 'Automação ligada'); start(); }
    else if (!r.settings.enabled && wasOn) { addLog('info', 'Automação desligada'); stop(); }
    indicator();
    return r.settings;
  }

  function steps(list) { return h('ol.steps', list.map(x => h('li', x))); }

  function render(view) {
    const s = auto.settings || {};
    const st = auto.store || {};

    // Chave geral
    const master = A.toggle('enabled', !!s.enabled, 'Automação ligada');
    master.classList.add('toggle--big');
    master.querySelector('input').addEventListener('change', async (e) => {
      try { await saveSettings({ enabled: e.target.checked }, e.target.checked ? 'Automação ligada' : 'Automação desligada'); }
      catch (err) { e.target.checked = !e.target.checked; A.fail(err); }
    });
    const runNow = h('button.gb-btn.gb-btn--ghost.btn-sm', { type: 'button', on: { click: () => { if (!auto.settings.enabled) return A.toast('Ligue a automação primeiro', 'error'); tick(); } } }, 'Rodar agora');

    // Formulário
    const f = {
      auto_accept: A.toggle('auto_accept', s.auto_accept, 'Aceitar pedidos novos sozinho (vão direto para "Em preparo")'),
      prep_minutes: A.input('prep_minutes', s.prep_minutes, { type: 'number', min: 0, max: 240, inputmode: 'numeric' }),
      auto_dispatch_minutes: A.input('auto_dispatch_minutes', s.auto_dispatch_minutes, { type: 'number', min: 0, max: 240, inputmode: 'numeric' }),
      auto_print: A.select('auto_print', [['on_accept', 'Quando o pedido é aceito'], ['on_arrival', 'Assim que o pedido chega'], ['off', 'Não imprimir sozinho']], s.auto_print),
      print_copies: A.select('print_copies', [[1, '1 via de cada'], [2, '2 vias de cada'], [3, '3 vias de cada']], s.print_copies),
      paper_width: A.select('paper_width', [['80', 'Bobina 80 mm'], ['58', 'Bobina 58 mm']], s.paper_width),
      print_kitchen: A.toggle('print_kitchen', s.print_kitchen, 'Via da cozinha (itens, "SEM", adicionais e observações em letra grande)'),
      print_delivery: A.toggle('print_delivery', s.print_delivery, 'Via de entrega (cliente, telefone, endereço, pagamento/troco, total e QR do mapa)'),
      print_nfe: A.toggle('print_nfe', s.print_nfe, 'Nota fiscal (DANFE NFC-e) quando for autorizada'),
      auto_retry_nfe: A.toggle('auto_retry_nfe', s.auto_retry_nfe, 'Reenviar sozinho as notas com erro e consultar as que estão processando'),
      notify_whatsapp: A.toggle('notify_whatsapp', s.notify_whatsapp, 'Preparar mensagem de WhatsApp "saiu para entrega" para o cliente'),
    };
    const val = (k) => { const el = f[k]; const i = el.tagName === 'LABEL' ? el.querySelector('input') : el; return i.type === 'checkbox' ? i.checked : i.value; };
    const form = h('form.form', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          const body = {};
          for (const k of Object.keys(f)) body[k] = val(k);
          for (const k of ['prep_minutes', 'auto_dispatch_minutes']) {
            const n = Number(body[k]);
            if (!Number.isInteger(n) || n < 0 || n > 240) return A.toast('Informe minutos entre 0 e 240', 'error');
            body[k] = n;
          }
          body.print_copies = Number(body.print_copies);
          try { await saveSettings(body, 'Automação salva'); } catch (err) { A.fail(err); }
        },
      },
    },
    h('section.card',
      h('div.card__head', h('h3', 'Pedidos')),
      f.auto_accept,
      h('div.grid-2.mt',
        A.field('Tempo de preparo (min)', f.prep_minutes, 'Aparece na via da cozinha como "Pronto até"'),
        A.field('Saída automática para entrega (min)', f.auto_dispatch_minutes, '0 = desligado. Depois desse tempo em preparo, o pedido muda para "Saiu para entrega"'))),
    h('section.card',
      h('div.card__head', h('h3', 'Impressão'),
        h('button.gb-btn.gb-btn--ghost.btn-sm', { type: 'button', on: { click: testPrint } }, A.icon('print'), 'Imprimir teste')),
      h('div.grid-3', A.field('Imprimir sozinho', f.auto_print), A.field('Cópias', f.print_copies), A.field('Papel', f.paper_width)),
      h('div.stack', f.print_kitchen, f.print_delivery, f.print_nfe),
      h('details.howto',
        h('summary', 'Como imprimir sem a janela de impressão (impressão silenciosa)'),
        h('p.muted.small', 'Por segurança, o navegador sempre mostra a janela "Imprimir" antes de cada cupom. Para a automação imprimir direto, sem clicar em nada, abra o painel por um atalho do Google Chrome com a opção --kiosk-printing:'),
        steps([
          'Instale o driver da impressora térmica e, no Windows, vá em Configurações › Impressoras e defina ela como impressora padrão (desligue "Permitir que o Windows gerencie a impressora padrão").',
          'Nas preferências da impressora, escolha o papel da bobina (80 mm ou 58 mm, "Roll paper") e margens zero.',
          h('span', 'Clique com o botão direito na área de trabalho › Novo › Atalho e cole: ', h('code.code', `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing ${location.origin}/admin/`)),
          'Feche todas as janelas do Chrome e abra o painel sempre por esse atalho. Faça login e ligue a automação.',
          'Clique em "Imprimir teste". Se sair o cupom sem aparecer janela, está pronto. Deixe esta aba aberta e visível durante o expediente.',
        ]),
        h('p.muted.small', 'Sem o atalho, a impressão automática também funciona, mas o Chrome mostra a janela de impressão a cada cupom e alguém precisa confirmar. No Mac: open -a "Google Chrome" --args --kiosk-printing. Na primeira impressão, ative "Imprimir cabeçalhos e rodapés" desligado e "Margens: nenhuma".')),
    ),
    h('section.card',
      h('div.card__head', h('h3', 'Nota fiscal e entrega')),
      h('div.stack', f.auto_retry_nfe, f.notify_whatsapp),
      h('p.muted.small', 'O WhatsApp não deixa enviar mensagens sozinho por um site. O painel prepara a mensagem pronta e você só toca em "Avisar cliente" e depois em enviar.')),
    h('div.form-actions', h('button.gb-btn', { type: 'submit' }, 'Salvar automação')));

    // Localização da loja
    const lat = A.input('lat', st.lat ?? '', { inputmode: 'decimal', placeholder: '-10.947200' });
    const lng = A.input('lng', st.lng ?? '', { inputmode: 'decimal', placeholder: '-37.073100' });
    const geoBtn = h('button.gb-btn.gb-btn--ghost.btn-sm', {
      type: 'button',
      on: {
        click: () => {
          if (!navigator.geolocation) return A.toast('Este navegador não informa a localização', 'error');
          geoBtn.disabled = true; geoBtn.textContent = 'Localizando…';
          navigator.geolocation.getCurrentPosition((p) => {
            lat.value = p.coords.latitude.toFixed(6); lng.value = p.coords.longitude.toFixed(6);
            geoBtn.disabled = false; geoBtn.textContent = 'Usar minha localização';
            A.toast('Localização encontrada. Clique em Salvar local.');
          }, (err) => {
            geoBtn.disabled = false; geoBtn.textContent = 'Usar minha localização';
            A.toast(err.code === 1 ? 'Permita o acesso à localização no navegador' : 'Não foi possível pegar a localização', 'error');
          }, { enableHighAccuracy: true, timeout: 15000 });
        },
      },
    }, 'Usar minha localização');
    const locForm = h('form.form.card', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          const parse = (v) => Number(String(v).trim().replace(',', '.'));
          const empty = lat.value.trim() === '' && lng.value.trim() === '';
          const body = empty ? { lat: null, lng: null } : { lat: parse(lat.value), lng: parse(lng.value) };
          if (!empty && (!Number.isFinite(body.lat) || !Number.isFinite(body.lng) || lat.value.trim() === '' || lng.value.trim() === '')) return A.toast('Use números com ponto, ex.: -10.9472', 'error');
          try { const r = await A.api('/api/admin/automation/store-location', { method: 'PUT', body }); auto.store = { ...auto.store, ...r }; A.toast('Local da loja salvo');
            const old = locForm.querySelector('.card__head > :last-child');
            old.replaceWith(r.lat != null ? h('a.link', { href: `https://www.google.com/maps?q=${r.lat},${r.lng}`, target: '_blank', rel: 'noopener' }, 'Ver no mapa ↗') : h('span.tag.tag--warn', 'não informado')); }
          catch (err) { A.fail(err); }
        },
      },
    },
    h('div.card__head', h('h3', 'Local da loja'), st.lat != null ? h('a.link', { href: `https://www.google.com/maps?q=${st.lat},${st.lng}`, target: '_blank', rel: 'noopener' }, 'Ver no mapa ↗') : h('span.tag.tag--warn', 'não informado')),
    h('p.muted.small', 'Ponto de partida das rotas de entrega e da distância até cada cliente. Abra o painel na loja e toque em "Usar minha localização", ou cole as coordenadas do Google Maps.'),
    h('div.grid-2', A.field('Latitude', lat), A.field('Longitude', lng)),
    h('div.form-actions', geoBtn, h('button.gb-btn', { type: 'submit' }, 'Salvar local')));

    logEl = h('div.autolog-wrap');
    view.append(
      h('section.card.auto-hero', { class: s.enabled ? 'is-on' : '' },
        h('div.auto-hero__main',
          master,
          h('p.muted.small#auto-status', ''),
          h('p.small', 'Com a automação ligada e este painel aberto, a cada 10 segundos o sistema aceita os pedidos novos, imprime os cupons, reenvia notas fiscais com erro e marca a saída para entrega, conforme as opções abaixo.')),
        h('div.auto-hero__side', runNow)),
      form,
      locForm,
      h('section.card',
        h('div.card__head', h('h3', 'Últimas ações'),
          h('button.btn-text.small', { type: 'button', on: { click: () => { auto.log = []; saveLog(); renderLog(); } } }, 'Limpar')),
        logEl));
    master.querySelector('input').addEventListener('change', () => view.querySelector('.auto-hero').classList.toggle('is-on', master.querySelector('input').checked));
    renderLog();
    indicator();
  }

  async function testPrint() {
    const s = auto.settings || {};
    const ok = await A.printer.printUrl(`/api/admin/automation/print/test?width=${encodeURIComponent(s.paper_width || '80')}`);
    if (ok) { A.toast('Teste enviado para a impressora'); addLog('impresso', 'Impressão de teste'); }
    else A.toast('Não foi possível imprimir o teste', 'error');
  }

  A.views.automacao = {
    async render(view) {
      if (!auto.settings) {
        const r = await A.api('/api/admin/automation/settings');
        auto.settings = r.settings; auto.store = r.store;
      } else {
        A.api('/api/admin/automation/settings').then(r => { auto.store = r.store; }).catch(() => {});
      }
      render(view);
    },
    destroy() { logEl = null; },
  };

  // Indicador: clique leva para a tela
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('auto-ind');
    if (el) el.addEventListener('click', () => { location.hash = '#automacao'; });
  });
})();
