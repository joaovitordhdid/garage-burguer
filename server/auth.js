// Autenticação do painel: senha com bcrypt, sessão em cookie httpOnly guardada no banco.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const COOKIE = 'gb_admin';
const SESSION_DAYS = 7;
// Hash usado quando o e-mail não existe, para o tempo de resposta não revelar quem tem conta (gerado sob demanda).
let dummyHash;
const getDummyHash = async () => (dummyHash ||= await bcrypt.hash('nao-existe', 12));

async function ensureAdmin() {
  const { n } = await db.get('SELECT COUNT(*)::int AS n FROM admins');
  if (n > 0) return;
  const email = (process.env.ADMIN_EMAIL || 'dono@garageburger.com').toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(6).toString('base64url');
    console.log(`\n[painel] Conta do dono criada: ${email} / senha: ${password}`);
    console.log('[painel] Defina ADMIN_EMAIL e ADMIN_PASSWORD no ambiente para escolher os seus.\n');
  }
  // ON CONFLICT: duas instâncias subindo ao mesmo tempo não quebram
  await db.run('INSERT INTO admins (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
    [email, await bcrypt.hash(password, 12)]);
}

async function login(email, password) {
  const admin = await db.get('SELECT * FROM admins WHERE email = $1', [String(email || '').toLowerCase().trim()]);
  // compara mesmo sem usuário para não vazar existência por tempo de resposta
  const ok = await bcrypt.compare(String(password || ''), admin ? admin.password_hash : await getDummyHash());
  if (!admin || !ok) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400e3;
  await db.run('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
  await db.run('INSERT INTO sessions (token, admin_id, expires_at) VALUES ($1, $2, $3)', [token, admin.id, expires]);
  return { token, expires, admin: { id: admin.id, email: admin.email } };
}

async function logout(token) {
  await db.run('DELETE FROM sessions WHERE token = $1', [token]);
}

async function changePassword(adminId, current, next) {
  const admin = await db.get('SELECT * FROM admins WHERE id = $1', [adminId]);
  if (!admin || !(await bcrypt.compare(String(current || ''), admin.password_hash))) return false;
  await db.run('UPDATE admins SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(String(next), 12), adminId]);
  await db.run('DELETE FROM sessions WHERE admin_id = $1', [adminId]);
  return true;
}

// Middleware: exige sessão válida em toda rota /api/admin/*
async function requireAdmin(req, res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const row = await db.get(`SELECT s.admin_id, s.expires_at, a.email FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = $1`, [String(token)]);
    if (!row || Number(row.expires_at) < Date.now()) return res.status(401).json({ error: 'Sessão expirada' });
    req.admin = { id: row.admin_id, email: row.email };
    next();
  } catch (e) { next(e); }
}

function cookieOptions(expires) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL, // Vercel é sempre HTTPS
    expires: new Date(expires),
    path: '/',
  };
}

module.exports = { COOKIE, ensureAdmin, login, logout, changePassword, requireAdmin, cookieOptions };
