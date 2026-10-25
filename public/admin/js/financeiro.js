// Painel: Financeiro (KPIs, gráficos, lançamentos, exportação).
(function () {
  'use strict';
  const A = window.GBA;
  const { h } = A;

  const PAY = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
  // Paleta categórica validada para fundo escuro (ordem fixa) + âmbar da marca para séries únicas
  const CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const AMBER = '#ffb000';
  const PRESETS = [['hoje', 'Hoje'], ['7', '7 dias'], ['30', '30 dias'], ['mes', 'Este mês'], ['custom', 'Personalizado']];

  let root = null;
  let charts = [];
  let per = { preset: '30', from: null, to: null };
  let txCats = [];

  function range() {
    const t = A.today();
    if (per.preset === 'hoje') return { from: t, to: t };
    if (per.preset === '7') return { from: A.addDays(t, -6), to: t };
    if (per.preset === 'mes') return { from: t.slice(0, 8) + '01', to: t };
    if (per.preset === 'custom' && per.from && per.to) return { from: per.from, to: per.to };
    return { from: A.addDays(t, -29), to: t };
  }

  function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }

  async function load() {
    if (!root) return;
    const { from, to } = range();
    const qs = new URLSearchParams({ from, to });
    const body = root.querySelector('#fin-body');
    try {
      const [s, t] = await Promise.all([A.api('/api/admin/finance/summary?' + qs), A.api('/api/admin/transactions?' + qs)]);
      txCats = t.categories;
      destroyCharts();
      A.clear(body);
      drawSummary(body, s);
      drawTransactions(body, t.transactions, s.period);
    } catch (e) { A.fail(e); }
  }

  const kpi = (label, value, sub, cls = '') => h('div.kpi', { class: cls }, h('small', label), h('strong', value), sub ? h('span.kpi__sub', sub) : null);

  function drawSummary(body, s) {
    const q = s.quick; const t = s.totals;
    body.append(
      h('div.kpis.kpis--3',
        kpi('Faturamento hoje', A.money(q.today.revenue_cents), `${q.today.orders} pedidos`),
        kpi('Últimos 7 dias', A.money(q.week.revenue_cents), `${q.week.orders} pedidos`),
        kpi('Este mês', A.money(q.month.revenue_cents), `${q.month.orders} pedidos`)),
      h('h3.section-title', `Período: ${A.fmtDate(s.period.from)} a ${A.fmtDate(s.period.to)}`),
      h('div.kpis.kpis--6',
        kpi('Faturamento', A.money(t.revenue_cents), t.other_income_cents ? `+ ${A.money(t.other_income_cents)} outras receitas` : 'pedidos não cancelados'),
        kpi('Pedidos', String(t.orders), t.cancelled_orders ? `${t.cancelled_orders} cancelados` : 'nenhum cancelado'),
        kpi('Ticket médio', A.money(t.avg_ticket_cents)),
        kpi('Custo dos produtos', A.money(t.product_cost_cents), t.revenue_cents ? `${Math.round(t.product_cost_cents / t.revenue_cents * 100)}% do faturamento` : ''),
        kpi('Despesas', A.money(t.expenses_cents), 'lançamentos manuais'),
        kpi('Lucro estimado', A.money(t.profit_cents), 'receita − custo − despesas', t.profit_cents < 0 ? 'kpi--neg' : 'kpi--pos')));

    const empty = t.orders === 0;
    const grid = h('div.charts');
    body.appendChild(grid);
    if (empty) {
      grid.appendChild(h('div.card.chart-card.chart-card--wide', A.empty('Sem vendas neste período.', A.state.settings && A.state.settings.dev ? 'Para testar, use "Gerar pedidos de exemplo" no fim da página.' : '')));
      return;
    }
    if (!window.Chart) { grid.appendChild(A.empty('Não foi possível carregar os gráficos (sem internet?).')); return; }

    setupChartDefaults();
    const card = (title, sub, wide, height = 260) => {
      const cv = h('canvas', { role: 'img', 'aria-label': title });
      const c = h('section.card.chart-card', { class: wide ? 'chart-card--wide' : '' },
        h('header.card__head', h('h3', title), sub ? h('small.muted', sub) : null),
        h('div.chart-box', { style: `height:${height}px` }, cv));
      grid.appendChild(c);
      return { cv, c };
    };

    // 1. Faturamento por dia
    const d = card('Faturamento por dia', `${s.daily.length} dias`, true);
    charts.push(new Chart(d.cv, {
      type: 'bar',
      data: {
        labels: s.daily.map(x => x.day.slice(8, 10) + '/' + x.day.slice(5, 7)),
        datasets: [{ label: 'Faturamento', data: s.daily.map(x => x.revenue_cents / 100), backgroundColor: AMBER, hoverBackgroundColor: '#ffc94a', borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28 }],
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${A.money(Math.round(c.raw * 100))} · ${s.daily[c.dataIndex].orders} pedidos`, title: (c) => A.fmtDate(s.daily[c[0].dataIndex].day) } } },
        scales: { y: { ticks: { callback: (v) => 'R$ ' + v.toLocaleString('pt-BR') } }, x: { grid: { display: false } } },
      },
    }));

    // 2. Vendas por categoria (barras horizontais: comparar magnitude)
    const c = card('Vendas por categoria', 'faturamento dos itens', false, Math.max(160, s.by_category.length * 44 + 40));
    charts.push(new Chart(c.cv, {
      type: 'bar',
      data: { labels: s.by_category.map(x => x.name), datasets: [{ label: 'Faturamento', data: s.by_category.map(x => x.revenue_cents / 100), backgroundColor: AMBER, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 26 }] },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${A.money(s.by_category[ctx.dataIndex].revenue_cents)} · ${s.by_category[ctx.dataIndex].qty} itens` } } },
        scales: { x: { ticks: { callback: (v) => 'R$ ' + v.toLocaleString('pt-BR') } }, y: { grid: { display: false } } },
      },
    }));

    // 3. Formas de pagamento
    const p = card('Formas de pagamento', 'nº de pedidos', false);
    charts.push(new Chart(p.cv, {
      type: 'doughnut',
      data: {
        labels: s.payments.map(x => PAY[x.method] || x.method),
        datasets: [{ data: s.payments.map(x => x.orders), backgroundColor: s.payments.map((x) => CAT[['pix', 'cartao', 'dinheiro'].indexOf(x.method) >= 0 ? ['pix', 'cartao', 'dinheiro'].indexOf(x.method) : 3]), borderColor: '#1a1a1e', borderWidth: 2 }],
      },
      options: {
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { generateLabels: (chart) => chart.data.labels.map((l, i) => ({ text: `${l}: ${s.payments[i].orders} (${A.money(s.payments[i].revenue_cents)})`, fillStyle: chart.data.datasets[0].backgroundColor[i], strokeStyle: 'transparent', fontColor: '#b9b4aa', index: i })) } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.raw} pedidos · ${A.money(s.payments[ctx.dataIndex].revenue_cents)}` } },
        },
      },
    }));

    // 4. Top 10 produtos
    const tp = card('Top 10 produtos', 'unidades vendidas', false, Math.max(180, s.top_products.length * 34 + 40));
    charts.push(new Chart(tp.cv, {
      type: 'bar',
      data: { labels: s.top_products.map(x => x.name.length > 26 ? x.name.slice(0, 25) + '…' : x.name), datasets: [{ label: 'Unidades', data: s.top_products.map(x => x.qty), backgroundColor: CAT[0], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22 }] },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (ctx) => s.top_products[ctx[0].dataIndex].name, label: (ctx) => ` ${ctx.raw} un. · ${A.money(s.top_products[ctx.dataIndex].revenue_cents)}` } } },
        scales: { x: { ticks: { precision: 0 } }, y: { grid: { display: false } } },
      },
    }));

    // 5. Pedidos por hora
    const hr = card('Pedidos por horário', 'hora do dia (Brasília)', false);
    charts.push(new Chart(hr.cv, {
      type: 'bar',
      data: { labels: s.by_hour.map((_, i) => String(i).padStart(2, '0') + 'h'), datasets: [{ label: 'Pedidos', data: s.by_hour, backgroundColor: CAT[2], borderRadius: 4, borderSkipped: 'start' }] },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.raw} pedidos` } } },
        scales: { y: { ticks: { precision: 0 } }, x: { grid: { display: false } } },
      },
    }));

    // Despesas por categoria (tabela simples)
    if (s.expenses_by_category.length) {
      grid.appendChild(h('section.card.chart-card',
        h('header.card__head', h('h3', 'Despesas por categoria')),
        h('table.table.table--compact', h('tbody', s.expenses_by_category.map(e => h('tr', h('td', cap(e.category)), h('td.num', A.money(e.amount_cents))))))));
    }
  }

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

  function setupChartDefaults() {
    const C = window.Chart;
    C.defaults.color = '#b9b4aa';
    C.defaults.borderColor = 'rgba(255,255,255,.07)';
    C.defaults.font.family = "'Inter', system-ui, sans-serif";
    C.defaults.maintainAspectRatio = false;
    C.defaults.plugins.tooltip.backgroundColor = '#2d2d33';
    C.defaults.plugins.tooltip.titleColor = '#f4f1ea';
    C.defaults.plugins.tooltip.bodyColor = '#f4f1ea';
    C.defaults.plugins.tooltip.borderColor = '#45454e';
    C.defaults.plugins.tooltip.borderWidth = 1;
    C.defaults.plugins.tooltip.padding = 10;
    C.defaults.interaction = { mode: 'index', intersect: false };
  }

  // ---------- Lançamentos ----------
  function drawTransactions(body, rows, period) {
    const sec = h('section.card');
    const list = h('div');
    const draw = () => {
      A.clear(list);
      if (!rows.length) { list.appendChild(A.empty('Nenhum lançamento no período.', 'Registre aluguel, embalagens, motoboy, etc.')); return; }
      list.appendChild(h('div.table-wrap', h('table.table.table--compact',
        h('thead', h('tr', h('th', 'Data'), h('th', 'Tipo'), h('th', 'Categoria'), h('th', 'Descrição'), h('th.num', 'Valor'), h('th', ''))),
        h('tbody', rows.map(t => h('tr',
          h('td', A.fmtDate(t.date)),
          h('td', h('span.pill', { class: t.type === 'despesa' ? 'pill--cancelado' : 'pill--entregue' }, t.type === 'despesa' ? 'Despesa' : 'Receita')),
          h('td', cap(t.category || '')),
          h('td', t.description || '', t.order_code ? h('small.muted', ` · pedido ${t.order_code}`) : null),
          h('td.num', { class: t.type === 'despesa' ? 'neg' : 'pos' }, (t.type === 'despesa' ? '− ' : '+ ') + A.money(t.amount_cents)),
          h('td.actions', t.order_id ? h('small.muted', 'automático') : [
            h('button.icon-btn', { type: 'button', 'aria-label': 'Editar lançamento', on: { click: () => txModal(t) } }, A.icon('edit')),
            h('button.icon-btn.danger', { type: 'button', 'aria-label': 'Excluir lançamento', on: { click: () => delTx(t) } }, A.icon('trash'))])))))));
    };
    draw();
    const qs = new URLSearchParams({ from: period.from, to: period.to });
    sec.append(
      h('header.card__head', h('h3', 'Lançamentos (receitas e despesas)'),
        h('div.row',
          h('button.gb-btn.btn-sm', { type: 'button', on: { click: () => txModal(null, 'despesa') } }, A.icon('plus'), 'Despesa'),
          h('button.gb-btn.gb-btn--ghost.btn-sm', { type: 'button', on: { click: () => txModal(null, 'receita') } }, A.icon('plus'), 'Receita'))),
      list,
      h('div.row.export',
        h('span.muted.small', 'Exportar período (CSV para Excel):'),
        h('a.gb-btn.gb-btn--ghost.btn-sm', { href: '/api/admin/export/orders.csv?' + qs, download: '' }, A.icon('download'), 'Pedidos'),
        h('a.gb-btn.gb-btn--ghost.btn-sm', { href: '/api/admin/export/transactions.csv?' + qs, download: '' }, A.icon('download'), 'Lançamentos')));
    body.appendChild(sec);

    if (A.state.settings && A.state.settings.dev) {
      const gen = h('button.gb-btn.gb-btn--ghost.btn-sm', { type: 'button', id: 'gen-samples' }, 'Gerar pedidos de exemplo');
      gen.addEventListener('click', () => A.busy(gen, async () => {
        try { const r = await A.api('/api/admin/dev/sample-orders', { method: 'POST', body: { count: 60 } }); A.toast(`${r.created} pedidos de exemplo criados`); load(); A.pollNow(); }
        catch (e) { A.fail(e); }
      }));
      const rm = h('button.btn-text.danger.small', { type: 'button' }, 'Apagar exemplos');
      rm.addEventListener('click', async () => {
        if (!(await A.confirm('Apagar dados de exemplo?', 'Remove só os pedidos e despesas marcados como [exemplo].', 'Apagar'))) return;
        try { const r = await A.api('/api/admin/dev/sample-orders', { method: 'DELETE' }); A.toast(`${r.removed} pedidos de exemplo removidos`); load(); } catch (e) { A.fail(e); }
      });
      body.appendChild(h('section.card.devtools', h('small.muted', 'Modo de desenvolvimento: '), gen, rm));
    }
  }

  function txModal(t, type) {
    t = t || { type, category: type === 'despesa' ? 'outros' : 'vendas balcão', description: '', amount_cents: null, date: A.today() };
    const typeSel = A.select('type', [['despesa', 'Despesa'], ['receita', 'Receita']], t.type);
    const catInput = A.input('category', t.category || '', { list: 'tx-cats', maxlength: 40, placeholder: 'Ex.: aluguel' });
    const dl = h('datalist#tx-cats', txCats.map(c => h('option', { value: c })));
    const desc = A.input('description', t.description || '', { maxlength: 200 });
    const amount = A.moneyInput('amount', t.amount_cents, { required: true });
    const dateI = A.input('date', t.date, { type: 'date', required: true });
    const form = h('form.form', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          const v = A.parseMoney(amount.value);
          if (!v || Number.isNaN(v)) return A.toast('Informe o valor', 'error');
          const body = { type: typeSel.value, category: catInput.value, description: desc.value, amount_cents: v, date: dateI.value };
          try {
            if (t.id) await A.api(`/api/admin/transactions/${t.id}`, { method: 'PUT', body });
            else await A.api('/api/admin/transactions', { method: 'POST', body });
            A.closeModal(); A.toast('Lançamento salvo'); load();
          } catch (err) { A.fail(err); }
        },
      },
    },
    h('div.grid-2', A.field('Tipo', typeSel), A.field('Data', dateI)),
    h('div.grid-2', A.field('Categoria', h('div', catInput, dl)), A.field('Valor (R$)', amount)),
    A.field('Descrição', desc),
    h('div.form-actions', h('button.gb-btn', { type: 'submit' }, 'Salvar')));
    A.openModal(t.id ? 'Editar lançamento' : (t.type === 'despesa' ? 'Nova despesa' : 'Nova receita'), form);
  }

  async function delTx(t) {
    if (!(await A.confirm('Excluir lançamento?', `${t.description || t.category} · ${A.money(t.amount_cents)}`, 'Excluir'))) return;
    try { await A.api(`/api/admin/transactions/${t.id}`, { method: 'DELETE' }); A.toast('Lançamento excluído'); load(); } catch (e) { A.fail(e); }
  }

  A.views.financeiro = {
    render(view) {
      root = view;
      const custom = h('div.custom-range', { hidden: per.preset !== 'custom' },
        A.input('from', per.from || A.addDays(A.today(), -29), { type: 'date', 'aria-label': 'Data inicial' }),
        h('span.muted', 'até'),
        A.input('to', per.to || A.today(), { type: 'date', 'aria-label': 'Data final' }),
        h('button.gb-btn.btn-sm', { type: 'button', on: { click: () => { per.from = custom.querySelector('[name=from]').value; per.to = custom.querySelector('[name=to]').value; load(); } } }, 'Aplicar'));
      const chips = h('div.chips', PRESETS.map(([k, l]) => h('button.chip', {
        type: 'button', class: per.preset === k ? 'active' : '', on: {
          click: (e) => {
            per.preset = k;
            chips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            e.currentTarget.classList.add('active');
            custom.hidden = k !== 'custom';
            if (k !== 'custom') load();
          },
        },
      }, l)));
      view.append(h('div.toolbar', chips, custom), h('div#fin-body', h('div.skeleton')));
      return load();
    },
    destroy() { destroyCharts(); root = null; },
  };
})();
