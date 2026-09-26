'use strict';
// Postgres connection pool (Supabase). Reads credentials from .env via Node's
// built-in env-file loader (Node >= 20.6). No dotenv dependency needed.
try { process.loadEnvFile(); } catch (e) { /* .env optional in some environments */ }

const { Pool } = require('pg');

const ssl = String(process.env.PGSSL || '').toLowerCase();
const useSsl = ssl && ssl !== 'false' && ssl !== 'disable';

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  // Supabase presents a valid cert chain, but we keep this lenient so it also
  // works behind poolers / self-signed proxies. Flip to strict if you prefer.
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PGPOOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => { console.error('[db] idle client error:', err.message); });

/** Run a parameterized query. Returns the pg result. */
function query(text, params) { return pool.query(text, params); }

/** True if credentials are configured (password present). */
function isConfigured() { return !!process.env.PGPASSWORD; }

/** Quick connectivity check. Resolves { ok, version } or { ok:false, error }. */
async function ping() {
  try {
    const r = await pool.query('select version() as v');
    return { ok: true, version: r.rows[0].v };
  } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * Idempotently ensure schema that shipped after the first db-init.
 * Lets existing deployments pick up new tables on boot without a manual migration.
 */
async function ensureSchema() {
  await pool.query(`
    create table if not exists team_auth (
      room_code   text    not null references rooms(code) on delete cascade,
      team_id     integer not null,
      pin         text    not null,
      updated_at  timestamptz not null default now(),
      primary key (room_code, team_id)
    );
  `);
}

module.exports = { pool, query, ping, isConfigured, ensureSchema };
