// Painel: impressão térmica por iframe escondido (cupom da cozinha, de entrega e DANFE).
// Com o Chrome aberto em --kiosk-printing a impressão sai direto na impressora padrão, sem janela.
(function () {
  'use strict';
  const A = window.GBA;
  let queue = Promise.resolve();

  function loadFrame(url, timeoutMs) {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.className = 'print-frame';
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      let done = false;
      const finish = (ok) => { if (done) return; done = true; clearTimeout(t); resolve({ ok, frame }); };
      const t = setTimeout(() => finish(false), timeoutMs);
      frame.addEventListener('load', () => finish(true), { once: true });
      frame.addEventListener('error', () => finish(false), { once: true });
      frame.src = url;
      document.body.appendChild(frame);
    });
  }

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // Imprime uma URL do mesmo site. Resolve true se mandou para a impressora.
  function printUrl(url, { timeoutMs = 15000, check = '.via, .cupom' } = {}) {
    const job = queue.then(async () => {
      const { ok, frame } = await loadFrame(url, timeoutMs);
      try {
        if (!ok) return false;
        const doc = frame.contentDocument;
        if (!doc || (check && !doc.querySelector(check))) return false; // erro, login expirado ou nota não autorizada
        if (doc.fonts && doc.fonts.ready) await Promise.race([doc.fonts.ready, wait(1500)]);
        await wait(120);
        frame.contentWindow.focus();
        frame.contentWindow.print();
        return true;
      } catch (e) {
        console.warn('impressão', e);
        return false;
      } finally {
        setTimeout(() => frame.remove(), 3000);
      }
    });
    queue = job.catch(() => false);
    return job;
  }

  // DANFE: no modo teste é uma página do próprio site; na Focus NFe é um endereço externo (abre em nova aba)
  async function danfe(target) {
    if (!target || !target.url) return { ok: false };
    if (target.same_origin) return { ok: await printUrl(target.url, { check: '.cupom' }) };
    const w = window.open(target.url, '_blank'); // com 'noopener' o retorno é sempre null
    if (w) { try { w.opener = null; } catch { /* ignora */ } }
    return { ok: true, opened: true, blocked: !w, url: target.url };
  }

  function receiptUrl(orderId, vias, opts = {}) {
    const s = (A.automation && A.automation.settings) || {};
    const p = new URLSearchParams({ vias: vias.join(','), copies: String(opts.copies || 1), width: String(opts.width || s.paper_width || '80') });
    return `/api/admin/automation/orders/${orderId}/print?${p}`;
  }

  // Botões manuais do cartão de pedido
  async function order(o, kind) {
    try {
      if (kind === 'nota') {
        const inv = o.invoice;
        if (!inv || inv.status !== 'autorizada') return A.toast('A nota deste pedido ainda não foi autorizada', 'error');
        const external = inv.provider !== 'mock' && /^https:\/\//.test(inv.danfe_url || '');
        const r = await danfe({ same_origin: !external, url: external ? inv.danfe_url : `/api/orders/${encodeURIComponent(o.code)}/danfe` });
        if (!r.ok) A.toast('Não foi possível imprimir a nota', 'error');
        else if (r.blocked) A.toast('O navegador bloqueou a nova aba da DANFE. Permita pop-ups para este site.', 'error', 7000);
        return;
      }
      const vias = kind === 'cozinha' ? ['cozinha'] : kind === 'entrega' ? ['entrega'] : ['cozinha', 'entrega'];
      const ok = await printUrl(receiptUrl(o.id, vias));
      if (!ok) return A.toast('Não foi possível imprimir', 'error');
      A.toast(`${o.code}: ${kind === 'cozinha' ? 'via da cozinha' : kind === 'entrega' ? 'via de entrega' : 'cupom'} enviado para a impressora`);
      if (vias.length === 2) {
        A.api(`/api/admin/automation/orders/${o.id}/printed`, { method: 'POST', body: { kind: 'receipt' } }).catch(() => {});
      }
    } catch (e) { A.fail(e); }
  }

  A.printer = { printUrl, danfe, order, receiptUrl };
})();
