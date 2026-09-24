'use strict';
// Idempotently provisions the Postgres schema for the multi-room auction platform.
// Usage:  node scripts/db-init.js   (needs PGPASSWORD set in .env)
const { pool, ping, isConfigured } = require('../lib/db');

const SCHEMA = `
create table if not exists rooms (
  code        text primary key,
  name        text not null,
  host_key    text not null,
  secret      text not null,
  created_at  timestamptz not null default now()
);

-- Append-only event log, one ordered stream per room (mirrors the old events.log).
create table if not exists events (
  room_code   text   not null references rooms(code) on delete cascade,
  seq         bigint not null,
  event       jsonb  not null,
  ts          timestamptz not null default now(),
  primary key (room_code, seq)
);
create index if not exists events_room_seq on events(room_code, seq);

-- First-come-first-served team claims. A row = team is taken; nonce signs its token.
create table if not exists claims (
  room_code   text    not null references rooms(code) on delete cascade,
  team_id     integer not null,
  nonce       text    not null,
  claimed_at  timestamptz not null default now(),
  primary key (room_code, team_id)
);

-- Room chat (parked feature; table kept so it can be switched on without a migration).
create table if not exists chat (
  room_code   text not null references rooms(code) on delete cascade,
  id          text not null,
  msg         jsonb not null,
  ts          timestamptz not null default now(),
  primary key (room_code, id)
);
create index if not exists chat_room_ts on chat(room_code, ts);
`;

(async () => {
  if (!isConfigured()) {
    console.error('\n  ✗ PGPASSWORD is not set. Edit .env and add your Supabase database password, then re-run.\n');
    process.exit(1);
  }
  const p = await ping();
  if (!p.ok) { console.error('\n  ✗ Cannot connect to Postgres:', p.error, '\n'); process.exit(1); }
  console.log('  ✓ Connected:', p.version.split(',')[0]);
  await pool.query(SCHEMA);
  const { rows } = await pool.query(
    "select table_name from information_schema.tables where table_schema='public' and table_name in ('rooms','events','claims','chat') order by table_name"
  );
  console.log('  ✓ Tables ready:', rows.map((r) => r.table_name).join(', '));
  await pool.end();
  console.log('  ✓ Schema init complete.\n');
})().catch((e) => { console.error('  ✗ db-init failed:', e.message); process.exit(1); });
