// Painel: Configurações (loja, entrega, nota fiscal, senha).
(function () {
  'use strict';
  const A = window.GBA;
  const { h } = A;
  let tab = 'loja';

  const TABS = [['loja', 'Loja'], ['entrega', 'Entrega'], ['pix', 'Pix'], ['nfe', 'Nota fiscal'], ['conta', 'Conta']];

  function storeForm(s) {
    const f = {
      name: A.input('name', s.name, { required: true, maxlength: 60 }),
      tagline: A.input('tagline', s.tagline, { maxlength: 120 }),
      logo: A.input('logo', s.logo, { maxlength: 300, placeholder: 'https://… ou /images/…' }),
      banner: A.input('banner', s.banner, { maxlength: 300, placeholder: 'https://… ou /images/…' }),
      address: A.input('address', s.address, { maxlength: 200 }),
      phone: A.input('phone', s.phone, { inputmode: 'tel', maxlength: 20, placeholder: '(11) 3333-4444' }),
      whatsapp: A.input('whatsapp', s.whatsapp, { inputmode: 'tel', maxlength: 20, placeholder: '(11) 99999-8888' }),
      hours: h('textarea.gb-input', { name: 'hours', rows: 2, maxlength: 200, placeholder: 'Ter a dom, 18h às 23h30' }, s.hours || ''),
      instagram: A.input('instagram', s.instagram, { maxlength: 60, placeholder: '@garageburger' }),
      open: A.toggle('open', s.open !== false, 'Loja aberta para pedidos'),
    };
    const upload = (input) => {
      const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'visually-hidden', id: 'up-' + input.name });
      const btn = h('label.gb-btn.gb-btn--ghost.btn-sm', { for: 'up-' + input.name }, 'Enviar');
      file.addEventListener('change', async () => {
        const fl = file.files[0];
        if (!fl) return;
        if (fl.size > 3 * 1024 * 1024) return A.toast('Arquivo grande demais (máximo 3 MB)', 'error');
        try { const r = await A.api('/api/admin/upload', { method: 'POST', raw: fl, headers: { 'Content-Type': fl.type || 'application/octet-stream' } }); input.value = r.url; A.toast('Imagem enviada. Clique em Salvar.'); }
        catch (e) { A.fail(e); } finally { file.value = ''; }
      });
      return h('div.row', input, btn, file);
    };
    return h('form.form.card', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          const body = Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'open').map(([k, el]) => [k, el.value]));
          body.open = f.open.querySelector('input').checked;
          try {
            const r = await A.api('/api/admin/settings/store', { method: 'PUT', body });
            A.state.settings.store = r; A.syncStoreToggle(); A.toast('Dados da loja salvos');
          } catch (err) { A.fail(err); }
        },
      },
    },
    h('div.grid-2', A.field('Nome da loja', f.name), A.field('Slogan', f.tagline)),
    h('div.grid-2', A.field('Logo', upload(f.logo)), A.field('Banner (capa)', upload(f.banner))),
    A.field('Endereço', f.address),
    h('div.grid-3', A.field('Telefone', f.phone), A.field('WhatsApp', f.whatsapp, 'Recebe os pedidos e dúvidas'), A.field('Instagram', f.instagram)),
    A.field('Horário de funcionamento', f.hours),
    f.open,
    h('div.form-actions', h('button.gb-btn', { type: 'submit' }, 'Salvar')));
  }

  function deliveryForm(d) {
    const fee = A.moneyInput('fee', d.fee_cents);
    const min = A.moneyInput('min', d.min_order_cents);
    const etaMin = A.input('eta_min', d.eta_min, { type: 'number', min: 0, max: 600, inputmode: 'numeric' });
    const etaMax = A.input('eta_max', d.eta_max, { type: 'number', min: 0, max: 600, inputmode: 'numeric' });
    return h('form.form.card', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          const body = { fee_cents: A.parseMoney(fee.value) ?? 0, min_order_cents: A.parseMoney(min.value) ?? 0, eta_min: Number(etaMin.value), eta_max: Number(etaMax.value) };
          if (Number.isNaN(body.fee_cents) || Number.isNaN(body.min_order_cents)) return A.toast('Valor inválido', 'error');
          try { A.state.settings.delivery = await A.api('/api/admin/settings/delivery', { method: 'PUT', body }); A.toast('Entrega salva'); }
          catch (err) { A.fail(err); }
        },
      },
    },
    h('div.grid-2', A.field('Taxa de entrega (R$)', fee, '0,00 = entrega grátis'), A.field('Pedido mínimo (R$)', min, '0,00 = sem mínimo')),
    h('div.grid-2', A.field('Tempo estimado: mínimo (min)', etaMin), A.field('Tempo estimado: máximo (min)', etaMax)),
    h('div.form-actions', h('button.gb-btn', { type: 'submit' }, 'Salvar')));
  }

  async function nfeForm() {
    const n = await A.api('/api/admin/nfe-settings');
    const mode = A.select('mode', [['mock', 'Simulação (não emite de verdade)'], ['homologacao', 'Homologação (testes na SEFAZ)'], ['producao', 'Produção (notas válidas)']], n.mode);
    const provider = A.select('provider', [['focusnfe', 'Focus NFe']], n.provider);
    const token = A.input('token', '', { type: 'password', autocomplete: 'new-password', maxlength: 200, placeholder: n.token_set ? '•••••••• (salvo; deixe vazio para manter)' : 'Cole o token da API' });
    const cnpj = A.input('cnpj', fmtCnpj(n.cnpj), { inputmode: 'numeric', maxlength: 18, placeholder: '00.000.000/0000-00' });
    const ie = A.input('ie', n.inscricao_estadual, { maxlength: 20 });
    const razao = A.input('razao_social', n.razao_social, { maxlength: 120, placeholder: 'Ex.: Garage Burger Lanches LTDA' });
    const uf = A.select('uf', ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'].map(u => [u, u]), n.uf || 'SP');
    const regime = A.select('regime', [[1, 'Simples Nacional'], [2, 'Simples Nacional: excesso de sublimite'], [3, 'Regime normal']], n.regime_tributario);
    const cscId = A.input('csc_id', n.csc_id, { inputmode: 'numeric', maxlength: 10, placeholder: 'Ex.: 1' });
    const cscToken = A.input('csc_token', '', { type: 'password', autocomplete: 'new-password', maxlength: 100, placeholder: n.csc_token_set ? '•••••••• (salvo; deixe vazio para manter)' : 'Código CSC da SEFAZ' });
    const auto = A.toggle('auto_emit', n.auto_emit, 'Emitir NFC-e automaticamente a cada pedido');
    const clearTok = n.token_set ? A.toggle('clear_token', false, 'Apagar token salvo') : null;
    const clearCsc = n.csc_token_set ? A.toggle('clear_csc', false, 'Apagar CSC salvo') : null;
    const status = (set) => h('span.tag', { class: set ? 'tag--ok' : 'tag--off' }, set ? 'configurado' : 'não configurado');
    return h('form.form.card', {
      novalidate: true, autocomplete: 'off',
      on: {
        submit: async (e) => {
          e.preventDefault();
          const body = {
            mode: mode.value, provider: provider.value, cnpj: cnpj.value, inscricao_estadual: ie.value,
            regime_tributario: Number(regime.value), uf: uf.value, razao_social: razao.value, csc_id: cscId.value, auto_emit: auto.querySelector('input').checked,
          };
          if (token.value.trim()) body.token = token.value.trim();
          if (cscToken.value.trim()) body.csc_token = cscToken.value.trim();
          if (clearTok && clearTok.querySelector('input').checked) body.clear_token = true;
          if (clearCsc && clearCsc.querySelector('input').checked) body.clear_csc_token = true;
          try {
            const r = await A.api('/api/admin/nfe-settings', { method: 'PUT', body });
            A.toast('Configuração fiscal salva');
            if (r.warnings) A.toast(r.warnings, 'error', 7000);
            render();
          }
          catch (err) { A.fail(err); }
        },
      },
    },
    h('p.muted.small', 'A NFC-e é emitida pela Focus NFe. Em "Simulação" o sistema gera notas de mentira para testes. Os tokens ficam só no servidor e nunca são exibidos de novo.'),
    h('div.grid-2', A.field('Ambiente', mode), A.field('Provedor', provider)),
    A.field(h('span', 'Token da API Focus NFe ', status(n.token_set)), token, clearTok),
    h('div.grid-3', A.field('CNPJ', cnpj), A.field('Inscrição estadual', ie), A.field('UF do emitente', uf)),
    h('div.grid-2', A.field('Razão social', razao, 'Aparece no DANFE'), A.field('Regime tributário', regime)),
    n.token_from_env || n.mode_from_env ? h('p.alert-bar', 'O servidor tem variáveis de ambiente (', [n.token_from_env ? 'FOCUS_NFE_TOKEN' : '', n.mode_from_env ? `NFE_MODE=${n.mode_from_env}` : ''].filter(Boolean).join(', '), ') que têm prioridade sobre o painel.') : null,
    h('div.grid-2', A.field('ID do CSC', cscId, 'O CSC fica cadastrado na Focus; aqui é referência'), A.field(h('span', 'Token CSC ', status(n.csc_token_set)), cscToken, clearCsc)),
    auto,
    h('div.form-actions', h('button.gb-btn', { type: 'submit' }, 'Salvar')));
  }
  async function pixForm() {
    const p = await A.api('/api/admin/pix-settings');
    const key = A.input('key', p.key, { maxlength: 80, placeholder: 'CPF, CNPJ, e-mail, +55 telefone ou chave aleatória', autocomplete: 'off' });
    const name = A.input('merchant_name', p.merchant_name, { maxlength: 25, placeholder: 'GARAGE BURGER' });
    const city = A.input('city', p.city, { maxlength: 15, placeholder: 'SAO PAULO' });
    return h('form.form.card', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          try {
            const r = await A.api('/api/admin/pix-settings', { method: 'PUT', body: { key: key.value, merchant_name: name.value, city: city.value } });
            key.value = r.key; A.toast(r.key ? 'Pix salvo: o checkout já mostra o "copia e cola"' : 'Pix desativado');
          } catch (err) { A.fail(err); }
        },
      },
    },
    h('p.muted.small', 'Com a chave preenchida, o cliente que escolher Pix recebe um QR Code / "copia e cola" com o valor exato do pedido. A confirmação do pagamento é feita por você (confira no app do banco).'),
    A.field('Chave Pix', key, 'Telefone precisa do +55 (ex.: +5511999998888)'),
    h('div.grid-2', A.field('Nome do recebedor', name, 'Até 25 caracteres, como aparece no banco'), A.field('Cidade', city, 'Até 15 caracteres')),
    h('div.form-actions', h('button.gb-btn', { type: 'submit' }, 'Salvar')));
  }

  function fmtCnpj(c) {
    const d = String(c || '').replace(/\D/g, '');
    return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d;
  }

  function accountForm() {
    const cur = A.input('current', '', { type: 'password', autocomplete: 'current-password', required: true });
    const next = A.input('next', '', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const conf = A.input('confirm', '', { type: 'password', autocomplete: 'new-password', required: true });
    return h('form.form.card', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          if (next.value.length < 8) return A.toast('A nova senha precisa ter pelo menos 8 caracteres', 'error');
          if (next.value !== conf.value) return A.toast('A confirmação não confere', 'error');
          try {
            await A.api('/api/auth/password', { method: 'POST', body: { current: cur.value, next: next.value } });
            A.toast('Senha alterada. Entre de novo com a nova senha.');
            setTimeout(() => A.onUnauthorized(), 800);
          } catch (err) { A.fail(err); }
        },
      },
    },
    h('p.muted', `Conectado como ${(A.state.settings && A.state.settings.admin && A.state.settings.admin.email) || ''}`),
    A.field('Senha atual', cur),
    h('div.grid-2', A.field('Nova senha', next, 'Mínimo 8 caracteres'), A.field('Confirmar nova senha', conf)),
    h('div.form-actions',
      h('button.btn-text.danger', { type: 'button', on: { click: () => document.getElementById('logout-btn').click() } }, 'Sair do painel'),
      h('span.spacer'),
      h('button.gb-btn', { type: 'submit' }, 'Alterar senha')));
  }

  let root = null;
  async function render() {
    if (!root) return;
    A.clear(root);
    const nav = h('div.chips', TABS.map(([k, l]) => h('button.chip', { type: 'button', class: tab === k ? 'active' : '', on: { click: () => { tab = k; render(); } } }, l)));
    const body = h('div.config-body', h('div.skeleton'));
    root.append(h('div.toolbar', nav), body);
    try {
      const s = await A.api('/api/admin/settings');
      A.state.settings = s;
      let content;
      if (tab === 'loja') content = storeForm(s.store || {});
      else if (tab === 'entrega') content = deliveryForm(s.delivery || {});
      else if (tab === 'nfe') content = await nfeForm();
      else if (tab === 'pix') content = await pixForm();
      else content = accountForm();
      A.clear(body).appendChild(content);
    } catch (e) { A.fail(e); }
  }

  A.views.config = {
    render(view) { root = view; return render(); },
    destroy() { root = null; },
  };
})();
