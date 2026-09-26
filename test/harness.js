'use strict';
// In-memory stand-ins for lib/db and lib/pgstore so the REAL server.js runs end-to-end
// (HTTP + SSE + auth + presence + broadcast coalescing) with no external Postgres.
// Injected into require.cache before server.js is required.
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---- in-memory stores ----
const rooms = new Map();                 // code -> {code,name,host_key,secret,created_at}
const claims = new Map();                // `${code}:${tid}` -> {room_code,team_id,nonce}
const teamAuth = new Map();              // `${code}:${tid}` -> {room_code,team_id,pin}
const events = new Map();                // code -> [event,...]

let queries = 0;
function q(text, params = []) {
  queries++;
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const P = params;
  // connectivity / schema
  if (t.startsWith('select version')) return { rows: [{ v: 'PostgreSQL 15 (memory-stub)' }] };
  if (t === 'select 1') return { rows: [{ '?column?': 1 }] };
  if (t.startsWith('create table')) return { rows: [] };
  // rooms
  if (t.startsWith('insert into rooms')) { rooms.set(P[0], { code: P[0], name: P[1], host_key: P[2], secret: P[3], created_at: Date.now() }); return { rows: [] }; }
  if (t.startsWith('select code, name, host_key, secret from rooms')) return { rows: [...rooms.values()].map(r => ({ code: r.code, name: r.name, host_key: r.host_key, secret: r.secret })) };
  // claims
  if (t.startsWith('select team_id, nonce from claims')) return { rows: [...claims.values()].filter(c => c.room_code === P[0]).map(c => ({ team_id: c.team_id, nonce: c.nonce })) };
  if (t.startsWith('insert into claims')) { claims.set(P[0] + ':' + P[1], { room_code: P[0], team_id: P[1], nonce: P[2] }); return { rows: [] }; }
  if (t.startsWith('delete from claims')) { claims.delete(P[0] + ':' + P[1]); return { rows: [] }; }
  // team_auth
  if (t.startsWith('select team_id, pin from team_auth')) return { rows: [...teamAuth.values()].filter(a => a.room_code === P[0]).map(a => ({ team_id: a.team_id, pin: a.pin })) };
  if (t.startsWith('select pin from team_auth')) { const a = teamAuth.get(P[0] + ':' + P[1]); return { rows: a ? [{ pin: a.pin }] : [] }; }
  if (t.startsWith('insert into team_auth')) {
    const key = P[0] + ':' + P[1];
    if (t.includes('do nothing')) { if (!teamAuth.has(key)) teamAuth.set(key, { room_code: P[0], team_id: P[1], pin: P[2] }); }
    else { teamAuth.set(key, { room_code: P[0], team_id: P[1], pin: P[2] }); } // do update
    return { rows: [] };
  }
  // events (pgstore is stubbed separately, but keep a fallback)
  return { rows: [] };
}

const dbStub = {
  pool: { query: (t, p) => Promise.resolve(q(t, p)), end: () => Promise.resolve(), on: () => {} },
  query: (t, p) => Promise.resolve(q(t, p)),
  ping: async () => ({ ok: true, version: 'PostgreSQL 15 (memory-stub) x64' }),
  isConfigured: () => true,
  ensureSchema: async () => {},
  _stats: () => ({ queries, rooms: rooms.size, claims: claims.size, teamAuth: teamAuth.size }),
};

const pgstoreStub = {
  loadEvents: async (code) => (events.get(code) || []).slice(),
  appendEvents: async (code, evs) => { const list = Array.isArray(evs) ? evs : [evs]; const cur = events.get(code) || []; cur.push(...list); events.set(code, cur); },
  appendChat: async () => {},
};

function inject() {
  const dbPath = require.resolve(path.join(ROOT, 'lib', 'db.js'));
  const pgPath = require.resolve(path.join(ROOT, 'lib', 'pgstore.js'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: pgstoreStub };
}

module.exports = { inject, dbStub, pgstoreStub, _stores: { rooms, claims, teamAuth, events } };
