// Autenticação do painel: senha com bcrypt, sessão em cookie httpOnly guardada no banco.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const COOKIE = 'gb_admin';
const SESSION_DAYS = 7;

function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count > 0) return;
  const email = (process.env.ADMIN_EMAIL || 'dono@garageburger.com').toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(6).toString('base64url');
    console.log(`\n[painel] Conta do dono criada: ${email} / senha: ${password}`);
    console.log('[painel] Defina ADMIN_EMAIL e ADMIN_PASSWORD no ambiente para escolher os seus.\n');
  }
  db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, bcrypt.hashSync(password, 12));
}

function login(email, password) {
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(String(email || '').toLowerCase().trim());
  // compara mesmo sem usuário para não vazar existência por tempo de resposta
  const ok = bcrypt.compareSync(String(password || ''), admin ? admin.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!admin || !ok) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400e3;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, admin_id, expires_at) VALUES (?, ?, ?)').run(token, admin.id, expires);
  return { token, expires, admin: { id: admin.id, email: admin.email } };
}

function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function changePassword(adminId, current, next) {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
  if (!admin || !bcrypt.compareSync(String(current || ''), admin.password_hash)) return false;
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(next), 12), adminId);
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId);
  return true;
}

// Middleware: exige sessão válida em toda rota /api/admin/*
function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const row = db.prepare(`SELECT s.admin_id, s.expires_at, a.email FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?`).get(token);
  if (!row || row.expires_at < Date.now()) return res.status(401).json({ error: 'Sessão expirada' });
  req.admin = { id: row.admin_id, email: row.email };
  next();
}

function cookieOptions(expires) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(expires),
    path: '/',
  };
}

module.exports = { COOKIE, ensureAdmin, login, logout, changePassword, requireAdmin, cookieOptions };
