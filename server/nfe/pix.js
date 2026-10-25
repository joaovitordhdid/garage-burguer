// Pix "copia e cola" (BR Code estático, padrão EMV-QRCPS do Banco Central) com CRC16-CCITT.
// Config: settings 'pix' = { key, merchant_name, city }.
//
// GANCHO PARA CONFIRMAÇÃO AUTOMÁTICA: um BR Code estático não avisa o sistema quando é pago.
// Para baixa automática é preciso um PSP (Mercado Pago, Efí/Gerencianet, Asaas, banco com API Pix):
//   1. createCharge(order) -> o PSP devolve um "copia e cola" dinâmico (com txid) — substitua buildPayload por ele;
//   2. o PSP chama um webhook (ex.: POST /api/orders/pix/webhook) quando o pagamento cai;
//   3. o webhook valida a assinatura e chama markPaid(code). Veja `pspHook` abaixo.
'use strict';

function tlv(id, value) {
  const v = String(value);
  return id + String(v.length).padStart(2, '0') + v;
}

function crc16(str) {
  let crc = 0xffff;
  for (const byte of Buffer.from(str, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Remove acentos e caracteres fora do conjunto aceito pelos bancos
function clean(s, max) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,\-/]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
}

// Normaliza a chave: e-mail, telefone (+55...), CPF/CNPJ (só dígitos) ou chave aleatória (UUID)
function normalizeKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (k.includes('@')) return k.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return k.toLowerCase();
  if (k.startsWith('+')) return '+' + k.replace(/\D/g, '');
  const d = k.replace(/\D/g, '');
  if (d.length === 11 || d.length === 14) return d; // CPF ou CNPJ (telefone precisa vir com +55)
  if (d.length === 13 && d.startsWith('55')) return '+' + d;
  return k;
}

function buildPayload({ key, merchant_name, city, amount_cents, txid }) {
  const nk = normalizeKey(key);
  if (!nk) return null;
  const mai = tlv('00', 'br.gov.bcb.pix') + tlv('01', nk);
  let p = tlv('00', '01') +
    tlv('26', mai) +
    tlv('52', '0000') +
    tlv('53', '986') +
    (amount_cents > 0 ? tlv('54', (amount_cents / 100).toFixed(2)) : '') +
    tlv('58', 'BR') +
    tlv('59', clean(merchant_name, 25) || 'GARAGE BURGER') +
    tlv('60', clean(city, 15) || 'BRASIL') +
    tlv('62', tlv('05', String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***'));
  p += '6304';
  return p + crc16(p);
}

// Ponto de extensão para um PSP. Hoje não faz nada (Pix estático, conferência manual no painel).
const pspHook = {
  enabled: false,
  async createCharge(/* order */) { return null; },  // devolver { copia_e_cola, txid, expires_at }
  async verifyWebhook(/* req */) { return null; },   // devolver { code, paid: true } após validar assinatura
};

module.exports = { buildPayload, crc16, normalizeKey, pspHook };
