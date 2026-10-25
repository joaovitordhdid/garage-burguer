// Painel: Cardápio (categorias, produtos, preços rápidos, receita e adicionais).
(function () {
  'use strict';
  const A = window.GBA;
  const { h } = A;

  let data = null;          // resposta de /api/admin/menu
  let ingredients = [];     // /api/admin/ingredients
  let root = null;
  let filter = '';

  async function load() {
    const [menu, ing] = await Promise.all([A.api('/api/admin/menu'), A.api('/api/admin/ingredients')]);
    data = menu; ingredients = ing.ingredients;
    draw();
  }
  const allProducts = () => [...data.categories.flatMap(c => c.products), ...data.uncategorized];
  const findProduct = (id) => allProducts().find(p => p.id === id);

  function draw() {
    if (!root) return;
    A.clear(root);
    const search = h('input.gb-input.search', { type: 'search', placeholder: 'Buscar produto', value: filter, 'aria-label': 'Buscar produto' });
    search.addEventListener('input', A.debounce(() => { filter = search.value.trim().toLowerCase(); drawList(); }, 150));
    root.append(
      h('div.toolbar',
        h('button.gb-btn.btn-sm', { type: 'button', on: { click: () => productModal(null) } }, A.icon('plus'), 'Produto'),
        h('button.gb-btn.gb-btn--ghost.btn-sm', { type: 'button', on: { click: () => categoryModal(null) } }, A.icon('plus'), 'Categoria'),
        search,
        h('span.muted.small', 'Dica: edite o preço direto na tabela e tecle Enter.')),
      h('div#menu-list'),
      globalAddons());
    drawList();
  }

  function drawList() {
    const list = A.clear(root.querySelector('#menu-list'));
    const cats = data.categories;
    if (!cats.length && !data.uncategorized.length) {
      list.appendChild(A.empty('Seu cardápio está vazio.', 'Crie uma categoria e depois adicione produtos.'));
      return;
    }
    cats.forEach((c, i) => list.appendChild(categoryBlock(c, i, cats.length)));
    if (data.uncategorized.length) list.appendChild(categoryBlock({ id: null, name: 'Sem categoria', active: true, products: data.uncategorized }, -1, 0));
  }

  function categoryBlock(c, idx, total) {
    const prods = c.products.filter(p => !filter || p.name.toLowerCase().includes(filter));
    if (filter && !prods.length) return h('div');
    const head = h('header.cat__head',
      h('div.cat__title',
        h('h3', c.name),
        h('span.muted.small', `${c.products.length} ${c.products.length === 1 ? 'item' : 'itens'}`),
        c.id && !c.active ? h('span.tag.tag--off', 'oculta') : null),
      c.id ? h('div.cat__actions',
        A.toggle('active', c.active, 'Visível', { on: { change: (e) => saveCategory(c, { active: e.target.checked }) } }),
        h('button.icon-btn', { type: 'button', title: 'Subir', 'aria-label': 'Subir categoria', disabled: idx === 0, on: { click: () => moveCategory(idx, -1) } }, A.icon('up')),
        h('button.icon-btn', { type: 'button', title: 'Descer', 'aria-label': 'Descer categoria', disabled: idx === total - 1, on: { click: () => moveCategory(idx, 1) } }, A.icon('down')),
        h('button.icon-btn', { type: 'button', title: 'Renomear', 'aria-label': 'Renomear categoria', on: { click: () => categoryModal(c) } }, A.icon('edit')),
        h('button.icon-btn.danger', { type: 'button', title: 'Excluir', 'aria-label': 'Excluir categoria', on: { click: () => deleteCategory(c) } }, A.icon('trash')),
        h('button.gb-btn.gb-btn--ghost.btn-sm', { type: 'button', on: { click: () => productModal(null, c.id) } }, A.icon('plus'), 'Produto')) : null);

    const table = h('div.ptable', { role: 'table', 'aria-label': `Produtos de ${c.name}` },
      h('div.ptable__row.ptable__head', { role: 'row' },
        h('span', ''), h('span', 'Produto'), h('span', 'Preço'), h('span', 'Preço "de"'), h('span', 'Custo / margem'), h('span', 'Ativo'), h('span', 'Destaque'), h('span', '')),
      prods.length ? prods.map((p, i) => productRow(p, c, i, prods.length)) : h('div.ptable__empty.muted', 'Nenhum produto nesta categoria.'));
    return h('section.cat', { class: c.id && !c.active ? 'cat--off' : '' }, head, table);
  }

  function priceCell(p, field, label) {
    const inp = A.moneyInput(field, p[field], { placeholder: field === 'original_price_cents' ? '—' : '0,00', 'aria-label': `${label} de ${p.name}`, class: 'inline-money' + (field === 'original_price_cents' ? ' inline-money--muted' : '') });
    const wrap = h('label.inline-edit', h('span.prefix', 'R$'), inp);
    let saved = A.centsToInput(p[field]);
    const commit = async () => {
      if (inp.value === saved) return;
      const v = A.parseMoney(inp.value);
      if (Number.isNaN(v) || (field === 'price_cents' && v == null)) { A.toast('Valor inválido. Ex.: 29,90', 'error'); inp.value = saved; return; }
      wrap.classList.add('saving');
      try {
        const r = await A.api(`/api/admin/products/${p.id}`, { method: 'PUT', body: { [field]: v } });
        Object.assign(p, r, { active: !!r.active, featured: !!r.featured });
        saved = A.centsToInput(r[field]);
        inp.value = saved;
        wrap.classList.remove('saving'); wrap.classList.add('saved');
        setTimeout(() => wrap.classList.remove('saved'), 1400);
        const row = wrap.closest('.ptable__row');
        if (row) row.querySelector('.margin').replaceWith(marginEl(p));
      } catch (e) { wrap.classList.remove('saving'); inp.value = saved; A.fail(e); }
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.value = saved; inp.blur(); }
    });
    inp.addEventListener('blur', commit);
    inp.addEventListener('focus', () => inp.select());
    return wrap;
  }

  function marginEl(p) {
    const cost = p.cost_cents || 0;
    const m = p.price_cents > 0 ? Math.round(((p.price_cents - cost) / p.price_cents) * 100) : 0;
    return h('span.margin', { class: m < 30 ? 'margin--low' : '' }, h('span', A.money(cost)), h('small', `${m}% margem`));
  }

  function productRow(p, c, i, n) {
    const thumb = p.image ? h('img.thumb', { src: p.image, alt: '', loading: 'lazy' }) : h('span.thumb.thumb--empty', A.icon('menu'));
    return h('div.ptable__row', { role: 'row', class: p.active ? '' : 'is-off', dataset: { id: p.id } },
      h('span.ptable__thumb', thumb),
      h('button.ptable__name', { type: 'button', on: { click: () => productModal(p) }, title: 'Editar produto' },
        h('strong', p.name),
        h('small.muted', [p.ingredients.length ? `${p.ingredients.length} ingred.` : 'sem receita', p.addons.length ? ` · ${p.addons.length} adicionais` : ''].join('')),
        !p.active ? h('span.tag.tag--off', 'pausado') : null,
        p.ingredients.some(x => x.out_of_stock) ? h('span.tag.tag--warn', 'falta ingrediente') : null),
      h('span', { 'data-label': 'Preço' }, priceCell(p, 'price_cents', 'Preço')),
      h('span', { 'data-label': 'Preço "de"' }, priceCell(p, 'original_price_cents', 'Preço "de"')),
      h('span', { 'data-label': 'Custo' }, marginEl(p)),
      h('span', { 'data-label': 'Ativo' }, A.toggle('active', p.active, '', { 'aria-label': `Ativo: ${p.name}`, on: { change: (e) => quickToggle(p, 'active', e.target) } })),
      h('span', { 'data-label': 'Destaque' }, A.toggle('featured', p.featured, '', { 'aria-label': `Destaque: ${p.name}`, on: { change: (e) => quickToggle(p, 'featured', e.target) } })),
      h('span.ptable__actions',
        c.id ? h('button.icon-btn', { type: 'button', 'aria-label': 'Subir produto', disabled: i === 0 || !!filter, on: { click: () => moveProduct(c, i, -1) } }, A.icon('up')) : null,
        c.id ? h('button.icon-btn', { type: 'button', 'aria-label': 'Descer produto', disabled: i === n - 1 || !!filter, on: { click: () => moveProduct(c, i, 1) } }, A.icon('down')) : null,
        h('button.icon-btn', { type: 'button', 'aria-label': 'Editar produto', on: { click: () => productModal(p) } }, A.icon('edit'))));
  }

  async function quickToggle(p, field, input) {
    const v = input.checked;
    try {
      await A.api(`/api/admin/products/${p.id}`, { method: 'PUT', body: { [field]: v } });
      p[field] = v;
      A.toast(field === 'active' ? (v ? `${p.name} voltou ao cardápio` : `${p.name} pausado`) : (v ? `${p.name} em destaque` : `${p.name} sem destaque`));
      const row = input.closest('.ptable__row');
      if (field === 'active' && row) row.classList.toggle('is-off', !v);
    } catch (e) { input.checked = !v; A.fail(e); }
  }

  // ---------- Categorias ----------
  async function saveCategory(c, body) {
    try { await A.api(`/api/admin/categories/${c.id}`, { method: 'PUT', body }); Object.assign(c, body); drawList(); }
    catch (e) { A.fail(e); drawList(); }
  }
  function categoryModal(c) {
    const name = A.input('name', c ? c.name : '', { required: true, maxlength: 60, placeholder: 'Ex.: Hambúrgueres' });
    const form = h('form.form', {
      on: {
        submit: async (e) => {
          e.preventDefault();
          try {
            if (c) await A.api(`/api/admin/categories/${c.id}`, { method: 'PUT', body: { name: name.value } });
            else await A.api('/api/admin/categories', { method: 'POST', body: { name: name.value } });
            A.closeModal(); A.toast('Categoria salva'); load();
          } catch (err) { A.fail(err); }
        },
      },
    }, A.field('Nome da categoria', name),
    h('div.form-actions', h('button.gb-btn', { type: 'submit' }, 'Salvar')));
    A.openModal(c ? 'Renomear categoria' : 'Nova categoria', form);
  }
  async function deleteCategory(c) {
    if (c.products.length) { A.toast('Mova ou exclua os produtos desta categoria antes.', 'error'); return; }
    if (!(await A.confirm('Excluir categoria?', `"${c.name}" será removida.`, 'Excluir'))) return;
    try { await A.api(`/api/admin/categories/${c.id}`, { method: 'DELETE' }); A.toast('Categoria excluída'); load(); } catch (e) { A.fail(e); }
  }
  async function moveCategory(idx, dir) {
    const ids = data.categories.map(c => c.id);
    [ids[idx], ids[idx + dir]] = [ids[idx + dir], ids[idx]];
    try { await A.api('/api/admin/categories/reorder', { method: 'POST', body: { ids } }); load(); } catch (e) { A.fail(e); }
  }
  async function moveProduct(c, idx, dir) {
    const ids = c.products.map(p => p.id);
    [ids[idx], ids[idx + dir]] = [ids[idx + dir], ids[idx]];
    try { await A.api('/api/admin/products/reorder', { method: 'POST', body: { ids } }); load(); } catch (e) { A.fail(e); }
  }

  // ---------- Produto (modal com abas) ----------
  function productModal(p, categoryId) {
    const tabs = [['dados', 'Dados'], ['receita', 'Ingredientes'], ['adicionais', 'Adicionais']];
    const body = h('div');
    const nav = h('div.tabs', { role: 'tablist' }, tabs.map(([k, l]) => h('button.tab', {
      type: 'button', role: 'tab', dataset: { tab: k }, disabled: !p && k !== 'dados',
      title: !p && k !== 'dados' ? 'Salve o produto primeiro' : null,
      on: { click: () => show(k) },
    }, l)));
    const show = (k) => {
      nav.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === k));
      A.clear(body).appendChild(k === 'dados' ? productForm(p, categoryId) : k === 'receita' ? recipeEditor(p) : addonsEditor(p));
    };
    A.openModal(p ? p.name : 'Novo produto', [nav, body], { wide: true });
    show('dados');
  }

  function productForm(p, categoryId) {
    p = p || { name: '', description: '', price_cents: null, original_price_cents: null, cost_cents: 0, image: '', active: true, featured: false, category_id: categoryId ?? (data.categories[0] && data.categories[0].id) };
    const f = {
      name: A.input('name', p.name, { required: true, maxlength: 80 }),
      description: h('textarea.gb-input', { name: 'description', rows: 3, maxlength: 600 }, p.description || ''),
      category: A.select('category_id', [['', 'Sem categoria'], ...data.categories.map(c => [c.id, c.name])], p.category_id ?? ''),
      price: A.moneyInput('price', p.price_cents, { required: true }),
      orig: A.moneyInput('orig', p.original_price_cents, { placeholder: 'opcional' }),
      cost: A.moneyInput('cost', p.cost_cents),
      image: A.input('image', p.image || '', { placeholder: 'https://… ou envie um arquivo', maxlength: 500 }),
      file: h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'visually-hidden', id: 'img-file' }),
      active: A.toggle('active', p.active, 'Ativo (aparece no cardápio)'),
      featured: A.toggle('featured', p.featured, 'Destaque'),
    };
    const preview = h('div.img-preview');
    const setPreview = () => {
      A.clear(preview);
      const v = f.image.value.trim();
      if (v) preview.appendChild(h('img', { src: v, alt: 'Prévia da imagem' }));
      else preview.appendChild(h('span.muted.small', 'Sem imagem'));
    };
    f.image.addEventListener('change', setPreview);
    setPreview();
    const uploadBtn = h('label.gb-btn.gb-btn--ghost.btn-sm', { for: 'img-file' }, 'Enviar foto');
    f.file.addEventListener('change', async () => {
      const file = f.file.files[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { A.toast('Use JPG, PNG ou WEBP', 'error'); return; }
      if (file.size > 3 * 1024 * 1024) { A.toast('Arquivo grande demais (máximo 3 MB)', 'error'); return; }
      uploadBtn.classList.add('saving'); uploadBtn.textContent = 'Enviando…';
      try {
        const r = await A.api('/api/admin/upload', { method: 'POST', raw: file, headers: { 'Content-Type': file.type } });
        f.image.value = r.url; setPreview(); A.toast('Foto enviada');
      } catch (e) { A.fail(e); }
      finally { uploadBtn.classList.remove('saving'); uploadBtn.textContent = 'Enviar foto'; f.file.value = ''; }
    });
    const recipeCost = p.recipe_cost_cents || 0;
    const useRecipe = p.id && recipeCost ? h('button.btn-text.small', { type: 'button', on: { click: () => { f.cost.value = A.centsToInput(recipeCost); } } }, `Usar custo da receita (${A.money(recipeCost)})`) : null;

    const save = h('button.gb-btn', { type: 'submit' }, p.id ? 'Salvar alterações' : 'Criar produto');
    const form = h('form.form', {
      novalidate: true,
      on: {
        submit: async (e) => {
          e.preventDefault();
          const price = A.parseMoney(f.price.value);
          const orig = A.parseMoney(f.orig.value);
          const cost = A.parseMoney(f.cost.value);
          if (!f.name.value.trim()) return A.toast('Informe o nome', 'error');
          if (price == null || Number.isNaN(price)) return A.toast('Preço inválido. Ex.: 29,90', 'error');
          if (Number.isNaN(orig) || Number.isNaN(cost)) return A.toast('Valor inválido', 'error');
          const body = {
            name: f.name.value, description: f.description.value, category_id: f.category.value || null,
            price_cents: price, original_price_cents: orig, cost_cents: cost || 0, image: f.image.value.trim() || null,
            active: f.active.querySelector('input').checked, featured: f.featured.querySelector('input').checked,
          };
          await A.busy(save, async () => {
            try {
              if (p.id) await A.api(`/api/admin/products/${p.id}`, { method: 'PUT', body });
              else {
                const r = await A.api('/api/admin/products', { method: 'POST', body });
                A.toast('Produto criado. Agora você pode montar a receita.');
                await load();
                return productModal(findProduct(r.id));
              }
              A.closeModal(); A.toast('Produto salvo'); load();
            } catch (err) { A.fail(err); }
          });
        },
      },
    },
    h('div.grid-2',
      h('div',
        A.field('Nome', f.name),
        A.field('Descrição', f.description),
        A.field('Categoria', f.category),
        h('div.grid-3',
          A.field('Preço (R$)', f.price),
          A.field('Preço "de" (R$)', f.orig, 'Riscado, para promoção'),
          A.field('Custo (R$)', f.cost, useRecipe))),
      h('div',
        h('div.field', h('span', 'Imagem'), preview, h('div.row', f.image), h('div.row', uploadBtn, f.file, h('small.hint', 'JPG, PNG ou WEBP até 3 MB'))),
        h('div.stack', f.active, f.featured))),
    h('div.form-actions',
      p.id ? h('button.btn-text.danger', { type: 'button', on: { click: () => deleteProduct(p) } }, A.icon('trash'), 'Excluir produto') : null,
      h('span.spacer'),
      save));
    return form;
  }

  async function deleteProduct(p) {
    if (!(await A.confirm('Excluir produto?', `"${p.name}" será removido do cardápio. Para só esconder, use "pausar" (desligar Ativo).`, 'Excluir'))) return;
    try { await A.api(`/api/admin/products/${p.id}`, { method: 'DELETE' }); A.toast('Produto excluído'); load(); } catch (e) { A.fail(e); }
  }

  // ---------- Receita ----------
  function recipeEditor(p) {
    let rows = p.ingredients.map(i => ({ ingredient_id: i.ingredient_id, qty: i.qty }));
    const list = h('div.recipe');
    const costEl = h('strong');
    const byId = (id) => ingredients.find(i => i.id === Number(id));
    const drawRows = () => {
      A.clear(list);
      if (!rows.length) list.appendChild(h('p.muted.small', 'Nenhum ingrediente. A receita é usada para baixar o estoque e para o cliente pedir "sem X".'));
      rows.forEach((r, idx) => {
        const ing = byId(r.ingredient_id);
        const sel = A.select('ing', ingredients.map(i => [i.id, i.name]), r.ingredient_id, { 'aria-label': 'Ingrediente' });
        sel.addEventListener('change', () => { r.ingredient_id = Number(sel.value); drawRows(); });
        const qty = A.input('qty', String(r.qty).replace('.', ','), { inputmode: 'decimal', 'aria-label': 'Quantidade usada', class: 'qty-input' });
        qty.addEventListener('input', () => { r.qty = A.parseNum(qty.value); updateCost(); });
        const removable = A.toggle('removable', ing && ing.removable, 'Cliente pode tirar', {
          on: {
            change: async (e) => {
              try {
                await A.api(`/api/admin/ingredients/${ing.id}`, { method: 'PUT', body: { removable: e.target.checked } });
                ing.removable = e.target.checked; A.toast(`${ing.name}: ${ing.removable ? 'removível' : 'não removível'} (vale para todos os produtos)`);
              } catch (err) { e.target.checked = !e.target.checked; A.fail(err); }
            },
          },
        });
        list.appendChild(h('div.recipe__row',
          sel, h('div.qty-wrap', qty, h('span.muted.small', ing ? ing.unit : '')),
          removable,
          ing && ing.out ? h('span.tag.tag--warn', 'sem estoque') : ing && ing.low ? h('span.tag.tag--warn', 'baixo') : h('span'),
          h('button.icon-btn.danger', { type: 'button', 'aria-label': 'Remover da receita', on: { click: () => { rows.splice(idx, 1); drawRows(); } } }, A.icon('trash'))));
      });
      updateCost();
    };
    const updateCost = () => {
      const c = rows.reduce((s, r) => { const i = byId(r.ingredient_id); return s + (i && r.qty ? r.qty * i.cost_cents_per_unit : 0); }, 0);
      costEl.textContent = A.money(Math.round(c));
    };
    const free = () => ingredients.find(i => !rows.some(r => r.ingredient_id === i.id));
    const addBtn = h('button.gb-btn.gb-btn--ghost.btn-sm', {
      type: 'button', on: {
        click: () => {
          const i = free();
          if (!i) return A.toast('Cadastre o ingrediente na aba Estoque primeiro', 'error');
          rows.push({ ingredient_id: i.id, qty: 1 }); drawRows();
        },
      },
    }, A.icon('plus'), 'Adicionar ingrediente');
    const save = h('button.gb-btn', {
      type: 'button', on: {
        click: () => A.busy(save, async () => {
          if (rows.some(r => !r.qty || r.qty <= 0 || Number.isNaN(r.qty))) return A.toast('Quantidade inválida em algum ingrediente', 'error');
          try {
            await A.api(`/api/admin/products/${p.id}/ingredients`, { method: 'PUT', body: { items: rows } });
            A.toast('Receita salva'); await load();
            const np = findProduct(p.id); if (np) { p.ingredients = np.ingredients; p.recipe_cost_cents = np.recipe_cost_cents; }
          } catch (e) { A.fail(e); }
        }),
      },
    }, 'Salvar receita');
    drawRows();
    return h('div',
      h('p.muted.small', 'Quanto de cada ingrediente o produto consome (baixa o estoque a cada pedido). "Cliente pode tirar" define se aparece como "sem X" no cardápio.'),
      list,
      h('div.row', addBtn, h('span.spacer'), h('span.muted.small', 'Custo da receita: '), costEl),
      h('div.form-actions', save));
  }

  // ---------- Adicionais ----------
  function addonRow(a, onChange) {
    const name = A.input('name', a.name, { maxlength: 60, 'aria-label': 'Nome do adicional', placeholder: a.id ? '' : 'Novo adicional (ex.: Bacon extra)' });
    const price = A.moneyInput('price', a.price_cents, { 'aria-label': 'Preço do adicional' });
    const active = A.toggle('active', a.active, 'Ativo');
    const save = async () => {
      const pc = A.parseMoney(price.value);
      if (!name.value.trim() || pc == null || Number.isNaN(pc)) return A.toast('Preencha nome e preço do adicional', 'error');
      try {
        const body = { name: name.value, price_cents: pc, active: active.querySelector('input').checked };
        if (a.id) await A.api(`/api/admin/addons/${a.id}`, { method: 'PUT', body });
        else await A.api('/api/admin/addons', { method: 'POST', body: { ...body, product_id: a.product_id ?? null } });
        A.toast('Adicional salvo'); onChange();
      } catch (e) { A.fail(e); }
    };
    const del = async () => {
      if (!a.id) return onChange();
      if (!(await A.confirm('Excluir adicional?', `"${a.name}" será removido.`, 'Excluir'))) return;
      try { await A.api(`/api/admin/addons/${a.id}`, { method: 'DELETE' }); A.toast('Adicional excluído'); onChange(); } catch (e) { A.fail(e); }
    };
    [name, price].forEach(i => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }));
    return h('div.addon-row', name, h('label.inline-edit', h('span.prefix', 'R$'), price), active,
      h('button.gb-btn.btn-sm', { type: 'button', on: { click: save } }, a.id ? 'Salvar' : 'Adicionar'),
      h('button.icon-btn.danger', { type: 'button', 'aria-label': 'Excluir adicional', on: { click: del } }, A.icon('trash')));
  }

  function addonsEditor(p) {
    const wrap = h('div');
    const redraw = async () => {
      await load();
      const np = findProduct(p.id); if (np) Object.assign(p, np);
      A.clear(wrap).appendChild(content());
    };
    const content = () => h('div',
      h('p.muted.small', 'Adicionais pagos só deste produto. Os adicionais gerais (valem para todos) ficam no fim da página Cardápio.'),
      h('div.addons', p.addons.map(a => addonRow(a, redraw))),
      h('div.addons', addonRow({ name: '', price_cents: null, active: true, product_id: p.id }, redraw)),
      data.global_addons.length ? h('p.muted.small', `Também aparecem: ${data.global_addons.filter(a => a.active).map(a => a.name).join(', ')}`) : null);
    wrap.appendChild(content());
    return wrap;
  }

  function globalAddons() {
    const sec = h('section.cat');
    sec.append(
      h('header.cat__head', h('div.cat__title', h('h3', 'Adicionais gerais'), h('span.muted.small', 'valem para todos os produtos'))),
      h('div.addons.pad', data.global_addons.map(a => addonRow(a, load)), addonRow({ name: '', price_cents: null, active: true, product_id: null }, load)));
    return sec;
  }

  A.views.cardapio = {
    async render(view) {
      root = view;
      view.appendChild(h('div.skeleton'));
      await load();
    },
    destroy() { root = null; },
  };
})();
