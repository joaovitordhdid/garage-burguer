// node:sqlite (DatabaseSync) por cima do sql.js, para a demonstração no navegador.
const STORE = 'gb_demo_db';

function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
const clean = ps => ps.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

class StatementSync {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  _rows(params, one) {
    const st = this.db.prepare(this.sql);
    try {
      st.bind(clean(params));
      const out = [];
      while (st.step()) { out.push(st.getAsObject()); if (one) break; }
      return out;
    } finally { st.free(); }
  }
  get(...p) { return this._rows(p, true)[0]; }
  all(...p) { return this._rows(p, false); }
  run(...p) {
    this.db.run(this.sql, clean(p));
    const changes = this.db.getRowsModified();
    const r = this.db.exec('SELECT last_insert_rowid() AS id');
    return { changes, lastInsertRowid: r.length ? r[0].values[0][0] : 0 };
  }
}

class DatabaseSync {
  constructor() {
    const SQL = globalThis.__SQL;
    let saved = null;
    try { saved = localStorage.getItem(STORE); } catch {}
    this.db = saved ? new SQL.Database(fromB64(saved)) : new SQL.Database();
    globalThis.__gbDb = this;
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) { return new StatementSync(this.db, sql); }
  save() { try { localStorage.setItem(STORE, toB64(this.db.export())); } catch (e) { console.warn('demo: não salvou', e); } }
}

module.exports = { DatabaseSync };
