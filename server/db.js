// Banco Postgres. Em produção (Vercel) usa o Supabase via DATABASE_URL;
// sem DATABASE_URL roda um Postgres embutido (PGlite) em ./data para desenvolvimento.
//
// API (toda assíncrona):
//   await db.get(sql, [params])  -> 1ª linha ou undefined
//   await db.all(sql, [params])  -> array de linhas
//   await db.run(sql, [params])  -> { rowCount, rows }   (use RETURNING id para pegar o id)
//   await db.exec(sql)           -> vários comandos sem parâmetros
//   await tx(async (t) => { await t.get(...); ... })  -> transação; t tem get/all/run
// Placeholders: $1, $2... (Postgres).
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// Datas no mesmo formato de antes: 'YYYY-MM-DD HH:MM:SS' (UTC)
const pad = n => String(n).padStart(2, '0');
function fmtTs(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
const parseTs = v => (v == null ? v : fmtTs(new Date(v)));
const parseNum = v => (v == null ? v : Number(v));
const parseDate = v => v; // DATE continua 'YYYY-MM-DD'

let driver; // { query(sql, params) -> {rows, rowCount}, exec(sql), transaction(fn), close() }

async function makeDriver() {
  if (process.env.DATABASE_URL) {
    const pg = require('pg');
    pg.types.setTypeParser(1184, parseTs);   // timestamptz
    pg.types.setTypeParser(1114, parseTs);   // timestamp
    pg.types.setTypeParser(20, parseNum);    // bigint (count, sum)
    pg.types.setTypeParser(1700, parseNum);  // numeric
    pg.types.setTypeParser(1082, parseDate); // date
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_MAX || 3),
      idleTimeoutMillis: 10_000,
    });
    pool.on('connect', c => c.query("SET TIME ZONE 'UTC'"));
    return {
      query: (sql, params) => pool.query(sql, params),
      exec: sql => pool.query(sql),
      async transaction(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(c);
          await c.query('COMMIT');
          return r;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { c.release(); }
      },
      close: () => pool.end(),
    };
  }

  const { PGlite, types } = await import('@electric-sql/pglite');
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const pgl = await PGlite.create(path.join(dir, 'pglite'), {
    parsers: {
      [types.TIMESTAMPTZ]: parseTs, [types.TIMESTAMP]: parseTs,
      [types.INT8]: parseNum, [types.NUMERIC]: parseNum, [types.DATE]: parseDate,
    },
  });
  await pgl.exec("SET TIME ZONE 'UTC'");
  const wrap = q => ({
    query: async (sql, params) => { const r = await q.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; },
  });
  // PGlite é uma conexão só: as transações entram em fila
  let queue = Promise.resolve();
  return {
    query: (sql, params) => wrap(pgl).query(sql, params),
    exec: sql => pgl.exec(sql),
    transaction(fn) {
      const run = queue.then(() => pgl.transaction(t => fn(wrap(t))));
      queue = run.catch(() => {});
      return run;
    },
    close: () => pgl.close(),
  };
}

let initPromise;
function init() {
  if (!initPromise) {
    initPromise = (async () => {
      driver = await makeDriver();
      if (process.env.DB_SKIP_SCHEMA !== '1') await driver.exec(SCHEMA);
      return driver;
    })();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

function api(getQ) {
  return {
    async get(sql, params = []) { const r = await (await getQ()).query(sql, params); return r.rows[0]; },
    async all(sql, params = []) { const r = await (await getQ()).query(sql, params); return r.rows; },
    async run(sql, params = []) { const r = await (await getQ()).query(sql, params); return { rowCount: r.rowCount, rows: r.rows }; },
  };
}

const db = {
  ...api(() => init()),
  async exec(sql) { await init(); return driver.exec(sql); },
  init,
  close: () => driver && driver.close(),
};

async function tx(fn) {
  await init();
  return driver.transaction(client => fn(api(() => client)));
}

async function getSetting(key, fallback = null, q = db) {
  const row = await q.get('SELECT value FROM settings WHERE key = $1', [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

async function setSetting(key, value, q = db) {
  await q.run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)]);
}

module.exports = { db, tx, getSetting, setSetting };
