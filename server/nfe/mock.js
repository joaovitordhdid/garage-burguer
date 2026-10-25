// Emissor de TESTE: autoriza na hora, gera chave de acesso fictícia (44 dígitos, DV válido)
// e numeração sequencial própria. Nada é enviado à SEFAZ — o DANFE sai com "SEM VALOR FISCAL".
'use strict';
const crypto = require('node:crypto');
const { db } = require('../db');

function mod11(digits) {
  let sum = 0, w = 2;
  for (let i = digits.length - 1; i >= 0; i--) { sum += Number(digits[i]) * w; w = w === 9 ? 2 : w + 1; }
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

// cUF(2) AAMM(4) CNPJ(14) mod(2)=65 série(3) nNF(9) tpEmis(1) cNF(8) cDV(1)
function accessKey({ uf = '35', cnpj, series, number, date = new Date() }) {
  const aamm = String(date.getFullYear()).slice(2) + String(date.getMonth() + 1).padStart(2, '0');
  const cnf = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
  const base = String(uf).padStart(2, '0') + aamm + String(cnpj || '').replace(/\D/g, '').padStart(14, '0').slice(-14) +
    '65' + String(series).padStart(3, '0') + String(number).padStart(9, '0') + '1' + cnf;
  return base + mod11(base);
}

async function nextNumber() {
  const row = await db.get(`SELECT MAX(NULLIF(regexp_replace(number, '\\D', '', 'g'), '')::bigint) AS n
                            FROM invoices WHERE provider = 'mock'`);
  return (row && row.n ? row.n : 0) + 1;
}

function createMockProvider(cfg) {
  return {
    name: 'mock',
    async emit(doc) {
      const number = await nextNumber();
      const series = '1';
      const key = accessKey({ uf: cfg.uf_code, cnpj: cfg.cnpj || '00000000000191', series, number });
      return {
        status: 'autorizada',
        number: String(number),
        series,
        access_key: key,
        danfe_url: `/api/orders/${encodeURIComponent(doc.order.code)}/danfe`,
        xml_url: null,
        // URL de consulta fictícia (no real, a SEFAZ de cada estado define a URL + hash com o CSC)
        qrcode_url: `https://www.sefaz.exemplo.gov.br/nfce/qrcode?p=${key}|2|2|1|TESTE`,
        message: 'Autorizada em ambiente de teste (mock) — sem valor fiscal',
      };
    },
    async status(/* ref */) { return null; },  // nada a consultar
    async cancel(/* ref, reason */) { return { status: 'cancelada', message: 'Cancelada (teste)' }; },
  };
}

module.exports = { createMockProvider, accessKey, mod11 };
