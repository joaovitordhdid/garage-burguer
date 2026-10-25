// Painel: Estoque (ingredientes, entradas, ajustes, perdas, histórico).
(function () {
  'use strict';
  const A = window.GBA;
  const { h } = A;

  const REASON = { pedido: 'Pedido', compra: 'Compra', ajuste: 'Ajuste', perda: 'Perda', estorno: 'Estorno' };
  let root = null;
  let list = [];
  let units = ['un'];
  let onlyLow = false;
  let q = '';
  let histReason = '';

  async function load() {
    const r = await A.api('/api/admin/ingredients');
    list = r.ingredients; units = r.units;
    const b = document.getElementById('badge-stock');
    b.hidden = !r.low_count; b.textContent = r.low_count;
    draw();
    loadHistory();
  }

  function draw() {
    if (!root) return;
    A.clear(root);
    const low = list.filter(i => i.low);
    const value = list.reduce((s, i) => s + Math.max(0, i.stock_qty) * i.cost_cents_per_unit, 0);
    const search = h('input.gb-input.search', { type: 'search', placeholder: 'Buscar ingrediente', value: q, 'aria-label': 'Buscar ingrediente' });
    search.addEventListener('input', A.debounce(() => { q = search.value.trim().toLowerCase(); drawTable(); }, 150));
    root.append(
      h('div.kpis.kpis--3',
        kpi('Itens no estoque', String(list.length)),
        kpi('Abaixo do mínimo', String(low.length), low.length ? 'kpi--alert' : ''),
        kpi('Valor em estoque', A.money(Math.round(value)))),
      low.length ? h('div.alert-bar', h('strong', `${low.length} ${low.length === 1 ? 'item precisa' : 'itens precisam'} de reposição: `), low.map(i => i.name).join(', ')) : null,
      h('div.toolbar',
        h('button.gb-btn.btn-sm', { type: 'button', on: { click: () => ingredientModal(null) } }, A.icon('plus'), 'Ingrediente'),
        search,
        A.toggle('onlylow', onlyLow, 'Só estoque baixo', { on: { change: (e) => { onlyLow = e.target.checked; drawTable(); } } })),
      h('div#stock-table'),
      h('section.card',
        h('header.card__head', h('h3', 'Histórico de movimentações'),
          (() => {
            const s = A.select('reason', [['', 'Todas'], ...Object.entries(REASON)], histReason, { 'aria-label': 'Filtrar por motivo', class: 'select-sm' });
            s.addEventListener('change', () => { histReason = s.value; loadHistory(); });
            return s;
          })()),
        h('div#stock-history', h('div.skeleton'))));
    drawTable();
  }

  const kpi = (label, value, cls = '') => h('div.kpi', { class: cls }, h('small', label), h('strong', value));

  function drawTable() {
    const box = A.clear(root.querySelector('#stock-table'));
    const rows = list.filter(i => (!onlyLow || i.low) && (!q || i.name.toLowerCase().includes(q)));
    if (!rows.length) { box.appendChild(A.empty(list.length ? 'Nenhum ingrediente com esse filtro.' : 'Nenhum ingrediente cadastrado.')); return; }
    box.appendChild(h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Ingrediente'), h('th.num', 'Estoque'), h('th.num', 'Mínimo'), h('th.num', 'Custo/un.'), h('th', 'Usado em'), h('th', ''))),
      h('tbody', rows.map(i => {
        const pct = i.min_qty > 0 ? Math.min(100, (i.stock_qty / (i.min_qty * 3)) * 100) : 100;
        return h('tr', { class: i.low ? 'is-low' : '' },
          h('td', h('strong', i.name),
            i.out ? h('span.tag.tag--danger', 'esgotado') : i.low ? h('span.tag.tag--warn', 'estoque baixo') : null,
            !i.removable ? h('small.muted.block', 'não removível pelo cliente') : null),
          h('td.num', h('div.stockbar', h('span', `${A.num(i.stock_qty)} ${i.unit}`), h('i', { class: i.low ? 'low' : '', style: `--p:${Math.max(0, pct)}%` }))),
          h('td.num', `${A.num(i.min_qty)} ${i.unit}`),
          h('td.num', A.money(i.cost_cents_per_unit)),
          h('td', `${i.used_in} produto${i.used_in === 1 ? '' : 's'}`),
          h('td.actions',
            h('button.btn-chip.in', { type: 'button', on: { click: () => moveModal(i, 'compra') } }, '+ Entrada'),
            h('button.btn-chip', { type: 'button', on: { click: () => moveModal(i, 'ajuste') } }, 'Ajuste'),
            h('button.btn-chip.out', { type: 'button', on: { click: () => moveModal(i, 'perda') } }, '− Perda'),
            h('button.icon-btn', { type: 'button', 'aria-label': `Editar ${i.name}`, on: { click: () => ingredientModal(i) } }, A.icon('edit')),
            h('button.icon-btn.danger', { type: 'button', 'aria-label': `Excluir ${i.name}`, on: { click: () => del(i) } }, A.icon('trash'))));
      })))));
  }

  async function loadHistory() {
    const box = root && root.querySelector('#stock-history');
    if (!box) return;
    try {
      const p = new URLSearchParams({ limit: '100' });
      if (histReason) p.set('reason', histReason);
      const rows = await A.api('/api/admin/stock/movements?' + p);
      A.clear(box);
      if (!rows.length) { box.appendChild(A.empty('Nenhuma movimentação ainda.')); return; }
      box.appendChild(h('div.table-wrap', h('table.table.table--compact',
        h('thead', h('tr', h('th', 'Quando'), h('th', 'Ingrediente'), h('th', 'Motivo'), h('th.num', 'Quantidade'), h('th', 'Detalhe'))),
        h('tbody', rows.map(m => h('tr',
          h('td', A.fmtDateTime(m.created_local)),
          h('td', m.ingredient_name),
          h('td', h('span.pill', { class: 'pill--m-' + m.reason }, REASON[m.reason] || m.reason)),
          h('td.num', { class: m.delta < 0 ? 'neg' : 'pos' }, `${m.delta > 0 ? '+' : ''}${A.num(m.delta)} ${m.unit}`),
          h('td.muted', [m.order_code ? `Pedido ${m.order_code}` : '', m.cost_cents ? `${A.money(m.cost_cents)}` : '', m.note || ''].filter(Boolean).join(' · '))))))));
    } catch (e) { A.fail(e); }
  }

  function ingredientModal(i) {
    const f = {
      name: A.input('name', i ? i.name : '', { required: true, maxlength: 60 }),
      unit: A.select('unit', units.map(u => [u, u]), i ? i.unit : 'un'),
      stock: A.input('stock', '', { inputmode: 'decimal', placeholder: '0' }),
      min: A.input('min', i ? String(i.min_qty).replace('.', ',') : '', { inputmode: 'decimal', placeholder: '0' }),
      cost: A.moneyInput('cost', i ? i.cost_cents_per_unit : null),
      removable: A.toggle('removable', i ? i.removable : true, 'Cliente pode pedir "sem" este ingrediente'),
    };
    const form = h('form.form', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          const body = {
            name: f.name.value, unit: f.unit.value, min_qty: A.parseNum(f.min.value) ?? 0,
            cost_cents_per_unit: A.parseMoney(f.cost.value) ?? 0, removable: f.removable.querySelector('input').checked,
          };
          if (Number.isNaN(body.min_qty) || Number.isNaN(body.cost_cents_per_unit)) return A.toast('Número inválido', 'error');
          if (!i) { body.stock_qty = A.parseNum(f.stock.value) ?? 0; if (Number.isNaN(body.stock_qty)) return A.toast('Estoque inválido', 'error'); }
          try {
            if (i) await A.api(`/api/admin/ingredients/${i.id}`, { method: 'PUT', body });
            else await A.api('/api/admin/ingredients', { method: 'POST', body });
            A.closeModal(); A.toast('Ingrediente salvo'); load();
          } catch (err) { A.fail(err); }
        },
      },
    },
    A.field('Nome', f.name),
    h('div.grid-3',
      A.field('Unidade', f.unit),
      i ? A.field('Estoque atual', A.input('cur', `${A.num(i.stock_qty)} ${i.unit}`, { disabled: true }), 'Use Entrada/Ajuste/Perda') : A.field('Estoque inicial', f.stock),
      A.field('Estoque mínimo', f.min, 'Alerta quando chegar aqui')),
    A.field('Custo por unidade (R$)', f.cost, 'Ex.: custo de 1 pão, ou de 1 g de carne'),
    f.removable,
    h('div.form-actions', h('button.gb-btn', { type: 'submit' }, 'Salvar')));
    A.openModal(i ? `Editar ${i.name}` : 'Novo ingrediente', form);
  }

  function moveModal(i, type) {
    const titles = { compra: `Entrada (compra) · ${i.name}`, ajuste: `Ajuste · ${i.name}`, perda: `Perda · ${i.name}` };
    const qty = A.input('qty', '', { inputmode: 'decimal', required: true, placeholder: type === 'ajuste' ? 'Ex.: -3 ou 5' : '0' });
    const counted = A.input('counted', '', { inputmode: 'decimal', placeholder: `atual: ${A.num(i.stock_qty)}` });
    const total = A.moneyInput('total', null, { placeholder: 'opcional' });
    const expense = A.toggle('expense', true, 'Lançar como despesa no financeiro');
    const updCost = A.toggle('updcost', true, 'Atualizar custo por unidade com esta compra');
    const note = A.input('note', '', { maxlength: 200, placeholder: type === 'perda' ? 'Ex.: venceu, caiu no chão' : 'Ex.: fornecedor, nota' });
    const fields = [];
    if (type === 'ajuste') {
      fields.push(h('div.grid-2', A.field('Somar/subtrair', qty, 'Negativo para tirar'), A.field('…ou quantidade contada', counted, 'Substitui o estoque')));
    } else {
      fields.push(A.field(`Quantidade (${i.unit})`, qty));
    }
    if (type === 'compra') fields.push(A.field('Valor total pago (R$)', total), h('div.stack', expense, updCost));
    fields.push(A.field('Observação', note));
    const form = h('form.form', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          const body = { ingredient_id: i.id, type, note: note.value };
          if (type === 'ajuste' && counted.value.trim()) body.set_qty = A.parseNum(counted.value);
          else body.qty = A.parseNum(qty.value);
          if ((body.qty == null && body.set_qty == null) || Number.isNaN(body.qty) || Number.isNaN(body.set_qty)) return A.toast('Informe a quantidade', 'error');
          if (type === 'compra') {
            const t = A.parseMoney(total.value);
            if (Number.isNaN(t)) return A.toast('Valor inválido', 'error');
            body.total_cost_cents = t;
            body.create_expense = expense.querySelector('input').checked;
            body.update_unit_cost = updCost.querySelector('input').checked;
          }
          try {
            const r = await A.api('/api/admin/stock/movements', { method: 'POST', body });
            A.closeModal(); A.toast(`${i.name}: agora ${A.num(r.ingredient.stock_qty)} ${i.unit}`); load();
          } catch (err) { A.fail(err); }
        },
      },
    }, fields, h('div.form-actions', h('button.gb-btn', { type: 'submit', class: type === 'perda' ? 'gb-btn--red' : '' }, 'Registrar')));
    A.openModal(titles[type], form);
  }

  async function del(i) {
    const msg = i.used_in ? `"${i.name}" está na receita de ${i.used_in} produto(s) e sairá delas. O histórico também será apagado.` : `"${i.name}" e seu histórico serão apagados.`;
    if (!(await A.confirm('Excluir ingrediente?', msg, 'Excluir'))) return;
    try { await A.api(`/api/admin/ingredients/${i.id}`, { method: 'DELETE' }); A.toast('Ingrediente excluído'); load(); } catch (e) { A.fail(e); }
  }

  A.views.estoque = {
    async render(view) { root = view; view.appendChild(h('div.skeleton')); await load(); },
    destroy() { root = null; },
  };
})();
