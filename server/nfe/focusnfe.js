// Integração real com a Focus NFe (API v2) para NFC-e (modelo 65).
// Doc: https://doc.focusnfe.com.br/reference/emitir_nfce  (POST /v2/nfce?ref=REF, síncrono)
//      https://doc.focusnfe.com.br/reference/consultar_nfce (GET /v2/nfce/REF)
//      https://doc.focusnfe.com.br/reference/cancelar_nfce  (DELETE /v2/nfce/REF, justificativa 15–255 caracteres, até 30 min)
// Campos completos: https://campos.focusnfe.com.br/nfe/NotaFiscalXML.html
// Autenticação: HTTP Basic com o token como usuário e senha vazia.
'use strict';

const BASES = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br',
};

const PAY_CODES = { pix: '17', cartao: '03', dinheiro: '01' };

function money(cents) { return Number((cents / 100).toFixed(2)); }

function isoBR(date, offset = '-03:00') {
  // Brasil sem horário de verão desde 2019; offset configurável (AM/MT/RO/RR = -04:00, AC = -05:00)
  const [sign, hh, mm] = [offset[0] === '-' ? -1 : 1, Number(offset.slice(1, 3)), Number(offset.slice(4, 6))];
  const local = new Date(date.getTime() + sign * (hh * 60 + mm) * 60e3);
  return local.toISOString().slice(0, 19) + offset;
}

// Monta o JSON da NFC-e a partir do pedido (doc = { order, items, cfg })
function buildBody(doc, cfg) {
  const { order, items } = doc;
  const isDelivery = order.delivery_type === 'delivery';
  const fee = isDelivery ? order.delivery_fee_cents || 0 : 0;

  const body = {
    natureza_operacao: 'Venda ao consumidor',
    data_emissao: isoBR(new Date(), cfg.timezone_offset || '-03:00'),
    tipo_documento: 1,                       // 1 = saída
    finalidade_emissao: 1,                   // 1 = normal
    cnpj_emitente: String(cfg.cnpj || '').replace(/\D/g, ''),
    presenca_comprador: isDelivery ? '4' : '1', // 4 = entrega em domicílio, 1 = presencial
    local_destino: '1',
    consumidor_final: 1,
    // Frete na NFC-e: com entrega cobrada usamos 0 (por conta do emitente) e valor_frete no 1º item;
    // sem entrega, 9 (sem frete). CONFERIR com o contador: algumas SEFAZ rejeitam frete em NFC-e —
    // alternativa é lançar a taxa de entrega como item de serviço/produto à parte.
    modalidade_frete: fee > 0 ? '0' : '9',
    informacoes_adicionais_contribuinte: `Pedido ${order.code}`,
    items: items.map((it, i) => {
      const unit = it.unit_price_cents;
      const extras = [];
      try { const a = JSON.parse(it.addons || '[]'); if (a.length) extras.push('+ ' + a.map(x => x.name).join(', ')); } catch {}
      const item = {
        numero_item: i + 1,
        codigo_produto: String(it.product_id || i + 1),
        descricao: (it.name + (extras.length ? ' ' + extras.join(' ') : '')).slice(0, 120),
        codigo_ncm: String(it.ncm || '21069090').replace(/\D/g, ''),
        cfop: String(it.cfop || '5102'),
        unidade_comercial: 'UN',
        quantidade_comercial: it.qty,
        valor_unitario_comercial: money(unit),
        unidade_tributavel: 'UN',             // tributável = comercial neste caso
        quantidade_tributavel: it.qty,
        valor_unitario_tributavel: money(unit),
        valor_bruto: money(unit * it.qty),
        icms_origem: 0,                        // 0 = nacional
        // 102 = Simples Nacional sem permissão de crédito (CSOSN). Regime normal (3) usa CST, ex.: '00'/'40' — CONFERIR com o contador.
        icms_situacao_tributaria: String(cfg.regime_tributario || '1') === '3' ? (cfg.icms_cst || '00') : (cfg.icms_csosn || '102'),
        // PIS/COFINS: '07' (isenta) / '49' é o mais comum no Simples. INCERTO — confirmar com o contador.
        pis_situacao_tributaria: cfg.pis_cst || '07',
        cofins_situacao_tributaria: cfg.cofins_cst || '07',
        inclui_no_total: 1,
      };
      if (it.cest) item.cest = it.cest;
      return item;
    }),
  };
  if (fee > 0 && body.items.length) body.items[0].valor_frete = money(fee);

  const total = order.total_cents;
  const forma = order.payment_method === 'pix' ? (cfg.pix_forma || PAY_CODES.pix) : PAY_CODES[order.payment_method] || '99';
  // Obs.: desde a NT 2023.004 existe '20' = Pix estático (QR fixo); '17' = Pix dinâmico. Ajustável por cfg.pix_forma.
  const pag = { forma_pagamento: forma, valor_pagamento: money(total) };
  if (forma === '03' || forma === '04') pag.tipo_integracao = 2; // 2 = maquininha não integrada ao sistema (INCERTO: campo do grupo "card")
  if (order.payment_method === 'dinheiro' && order.change_for_cents > total) {
    pag.valor_pagamento = money(order.change_for_cents);
    body.valor_troco = money(order.change_for_cents - total);
  }
  body.formas_pagamento = [pag];

  const cpf = String(order.customer_cpf || '').replace(/\D/g, '');
  if (cpf.length === 11) body.cpf_destinatario = cpf;
  // Em homologação a SEFAZ exige o nome "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";
  // a Focus troca automaticamente, então mandamos o nome real.
  if (order.customer_name) body.nome_destinatario = String(order.customer_name).slice(0, 60);
  return body;
}

function mapResponse(json, base, httpStatus) {
  if (!json || typeof json !== 'object') return { status: 'erro', message: `Resposta inválida da Focus NFe (HTTP ${httpStatus})` };
  const abs = p => (p ? (/^https?:/i.test(p) ? p : base + p) : null);
  const s = json.status;
  const out = {
    number: json.numero != null ? String(json.numero) : null,
    series: json.serie != null ? String(json.serie) : null,
    access_key: json.chave_nfe ? String(json.chave_nfe).replace(/^NFe/i, '') : null,
    danfe_url: abs(json.caminho_danfe),
    xml_url: abs(json.caminho_xml_nota_fiscal),
    qrcode_url: json.qrcode_url || json.url_consulta_nf || null,
  };
  if (s === 'autorizado') return { ...out, status: 'autorizada', message: json.mensagem_sefaz || 'Autorizada' };
  if (s === 'processando_autorizacao') return { ...out, status: 'processando', message: 'Processando na SEFAZ' };
  if (s === 'cancelado') return { ...out, status: 'cancelada', message: json.mensagem_sefaz || 'Cancelada' };
  if (s === 'erro_autorizacao' || s === 'denegado') {
    return { ...out, status: 'erro', message: `${json.status_sefaz ? json.status_sefaz + ' - ' : ''}${json.mensagem_sefaz || s}` };
  }
  // Erros de validação (400/422): { codigo, mensagem, erros:[{mensagem, campo}] }
  const det = Array.isArray(json.erros) ? ' ' + json.erros.map(e => e.mensagem || e.campo).join('; ') : '';
  return { status: 'erro', message: `${json.mensagem || json.codigo || 'Erro na Focus NFe'} (HTTP ${httpStatus})${det}`.slice(0, 900) };
}

function createFocusProvider(cfg) {
  const base = BASES[cfg.mode === 'producao' ? 'producao' : 'homologacao'];
  const auth = 'Basic ' + Buffer.from(`${cfg.token}:`).toString('base64');

  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { httpStatus: res.status, json };
  }

  return {
    name: 'focusnfe',
    base,
    buildBody: doc => buildBody(doc, cfg),
    async emit(doc) {
      const { httpStatus, json } = await call('POST', `/v2/nfce?ref=${encodeURIComponent(doc.ref)}`, buildBody(doc, cfg));
      return mapResponse(json, base, httpStatus);
    },
    async status(ref) {
      const { httpStatus, json } = await call('GET', `/v2/nfce/${encodeURIComponent(ref)}`);
      return mapResponse(json, base, httpStatus);
    },
    async cancel(ref, reason) {
      const { httpStatus, json } = await call('DELETE', `/v2/nfce/${encodeURIComponent(ref)}`, { justificativa: reason });
      if (json && json.status === 'cancelado') return { status: 'cancelada', message: json.mensagem_sefaz || 'Cancelada' };
      return { status: null, message: (json && (json.mensagem || json.mensagem_sefaz)) || `Falha ao cancelar (HTTP ${httpStatus})` };
    },
  };
}

module.exports = { createFocusProvider, buildBody, mapResponse, BASES };
