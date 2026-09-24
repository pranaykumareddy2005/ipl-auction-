'use strict';
// Postgres-backed, room-scoped event log — the cloud replacement for the local
// events.log. loadEvents() replays a room; appendEvents() durably appends.
const { query } = require('./db');

/** Replay every event for a room, in order. Returns an array of event envelopes. */
async function loadEvents(roomCode) {
  const r = await query('select event from events where room_code=$1 order by seq', [roomCode]);
  return r.rows.map((row) => row.event);
}

/** Durably append one or more events. seq is assigned atomically per room. */
async function appendEvents(roomCode, events) {
  const list = Array.isArray(events) ? events : [events];
  if (!list.length) return;
  await query(
    `with base as (select coalesce(max(seq), 0) as m from events where room_code = $1)
     insert into events (room_code, seq, event)
     select $1, base.m + t.ord, t.elem
     from base, jsonb_array_elements($2::jsonb) with ordinality as t(elem, ord)`,
    [roomCode, JSON.stringify(list)]
  );
}

/** Append a chat message row (parked feature; table exists so it's a no-migration switch). */
async function appendChat(roomCode, msg) {
  await query('insert into chat (room_code, id, msg) values ($1,$2,$3) on conflict do nothing',
    [roomCode, msg.id, JSON.stringify(msg)]);
}

module.exports = { loadEvents, appendEvents, appendChat };
