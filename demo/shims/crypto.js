function randomBytes(n) { const u = new Uint8Array(n); crypto.getRandomValues(u); return Buffer.from(u); }
function randomInt(min, max) {
  if (max === undefined) { max = min; min = 0; }
  const u = new Uint32Array(1); crypto.getRandomValues(u);
  return min + (u[0] % (max - min));
}
module.exports = { randomBytes, randomInt, default: { randomBytes, randomInt }, getRandomValues: a => crypto.getRandomValues(a), webcrypto: globalThis.crypto };
