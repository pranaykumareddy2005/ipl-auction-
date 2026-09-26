'use strict';
// Multi-room manager: each room owns an in-memory authoritative engine whose
// events are persisted to Postgres, plus first-come-first-served team claims
// (the replacement for per-team PINs). Room/claim data lives in Postgres, never
// in the event log.
const crypto = require('crypto');
const { query } = require('./db');
const { loadEvents, appendEvents } = require('./pgstore');
const { AuctionEngine } = require('./engine');

// Room codes: 6 chars, no ambiguous glyphs (no I/L/O/0/1).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode(n = 6) {
  const b = crypto.randomBytes(n); let s = '';
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
function timingEq(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

// Passcodes: 4-digit numeric, easy to read out / type on a phone at a live event.
function genPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

class Room {
  constructor({ code, name, hostKey, secret, players, photosDir, events, claims, pins }) {
    this.code = code; this.name = name; this.hostKey = hostKey; this.secret = secret;
    this.claims = new Map();                       // teamId -> nonce (active session)
    for (const c of (claims || [])) this.claims.set(Number(c.team_id), c.nonce);
    this.pins = new Map();                         // teamId -> passcode
    for (const pr of (pins || [])) this.pins.set(Number(pr.team_id), pr.pin);
    this.engine = new AuctionEngine({
      players, photosDir, events,
      persist: (evs) => appendEvents(code, evs),   // async, serialized by the engine
    });
    this.engine.setClaimLookup((teamId) => this.claims.has(Number(teamId)));
  }

  hostOk(key) { return this.hostKey && timingEq(key, this.hostKey); }

  /** Make sure every team currently in the auction has a passcode (lazy provisioning). */
  async ensurePins() {
    const teams = this.engine.state.teams || [];
    for (const t of teams) {
      const id = Number(t.id);
      if (this.pins.has(id)) continue;
      const pin = genPin();
      await query(
        `insert into team_auth (room_code, team_id, pin) values ($1,$2,$3)
         on conflict (room_code, team_id) do nothing`,
        [this.code, id, pin]
      );
      // If another writer won the insert, read back the stored pin so memory matches DB.
      const r = await query('select pin from team_auth where room_code=$1 and team_id=$2', [this.code, id]);
      this.pins.set(id, (r.rows[0] && r.rows[0].pin) || pin);
    }
  }

  /** Operator-facing list: team + passcode + whether a session is currently claimed. */
  async pinList() {
    await this.ensurePins();
    return (this.engine.state.teams || []).map((t) => ({
      teamId: Number(t.id), name: t.name, short: t.short, color: t.color,
      pin: this.pins.get(Number(t.id)) || null,
      claimed: this.claims.has(Number(t.id)),
    }));
  }

  /** Operator rotates a team's passcode (and boots any active session for that team). */
  async regenPin(teamId) {
    teamId = Number(teamId);
    if (!this.engine.state.teams.find((t) => t.id === teamId)) return { ok: false, error: 'Unknown team' };
    const pin = genPin();
    await query(
      `insert into team_auth (room_code, team_id, pin) values ($1,$2,$3)
       on conflict (room_code, team_id) do update set pin=excluded.pin, updated_at=now()`,
      [this.code, teamId, pin]
    );
    this.pins.set(teamId, pin);
    // Invalidate the current session so the old passcode/token can't keep bidding.
    if (this.claims.has(teamId)) await this.release(teamId);
    return { ok: true, teamId, pin };
  }

  _pinOk(teamId, pin) {
    const want = this.pins.get(Number(teamId));
    return !!want && timingEq(pin, want);
  }

  // Token binds teamId + a per-claim nonce, so releasing a team invalidates its token.
  _sig(teamId) {
    const nonce = this.claims.get(Number(teamId));
    if (!nonce) return null;
    return crypto.createHmac('sha256', this.secret)
      .update('team:' + Number(teamId) + ':' + nonce).digest('hex').slice(0, 40);
  }

  /**
   * Join OR rejoin a team with its passcode. The passcode is the identity proof, so
   * a captain who lost their token (new phone, cleared cache) gets straight back in.
   * A fresh session nonce is issued each time, which invalidates any older device
   * still holding this team — exactly one live captain per franchise.
   * Returns { ok, token, teamId, name, rejoined } or { ok:false, error }.
   */
  async join(teamId, pin) {
    teamId = Number(teamId);
    const team = this.engine.state.teams.find((t) => t.id === teamId);
    if (!team) return { ok: false, error: 'Unknown team' };
    await this.ensurePins();
    if (!this._pinOk(teamId, pin)) return { ok: false, error: 'Wrong passcode for this team' };

    const rejoined = this.claims.has(teamId);
    const nonce = crypto.randomBytes(16).toString('hex');
    // Upsert: create the session if new, rotate the nonce if rejoining/taking over.
    await query(
      `insert into claims (room_code, team_id, nonce) values ($1,$2,$3)
       on conflict (room_code, team_id) do update set nonce=excluded.nonce, claimed_at=now()`,
      [this.code, teamId, nonce]
    );
    this.claims.set(teamId, nonce);
    this.engine._notify();                          // push updated claimed flags to all screens
    return { ok: true, token: teamId + '.' + this._sig(teamId), teamId, name: team.name, rejoined };
  }

  /** Auctioneer releases a team, instantly invalidating the old owner's token. */
  async release(teamId) {
    teamId = Number(teamId);
    await query('delete from claims where room_code=$1 and team_id=$2', [this.code, teamId]);
    this.claims.delete(teamId);
    this.engine._notify();
    return { ok: true };
  }

  /** Verify a team bearer token → returns the teamId it authorizes, or null. */
  verifyTeam(token) {
    if (!token || typeof token !== 'string') return null;
    const i = token.indexOf('.');
    if (i < 0) return null;
    const teamId = Number(token.slice(0, i));
    const want = this._sig(teamId);
    if (!want) return null;
    return timingEq(token.slice(i + 1), want) ? teamId : null;
  }

  meta() { return { code: this.code, name: this.name }; }
}

class RoomManager {
  constructor({ players, photosDir }) {
    this.players = players; this.photosDir = photosDir;
    this.rooms = new Map();
  }

  /** Rehydrate every persisted room + its claims from Postgres at boot. */
  async loadAll() {
    const r = await query('select code, name, host_key, secret from rooms order by created_at');
    for (const row of r.rows) await this._hydrate(row);
    return this.rooms.size;
  }

  async _hydrate(row) {
    const events = await loadEvents(row.code);
    const cl = await query('select team_id, nonce from claims where room_code=$1', [row.code]);
    const pn = await query('select team_id, pin from team_auth where room_code=$1', [row.code]);
    const room = new Room({
      code: row.code, name: row.name, hostKey: row.host_key, secret: row.secret,
      players: this.players, photosDir: this.photosDir, events, claims: cl.rows, pins: pn.rows,
    });
    this.rooms.set(row.code, room);
    return room;
  }

  /** Create a fresh room. Returns the Room (its hostKey is the creator's secret). */
  async create(name) {
    let code = genCode();
    for (let i = 0; i < 8 && this.rooms.has(code); i++) code = genCode();
    const hostKey = crypto.randomBytes(9).toString('base64url');
    const secret = crypto.randomBytes(24).toString('hex');
    const nm = String(name || '').trim().slice(0, 60) || ('Auction ' + code);
    await query('insert into rooms (code, name, host_key, secret) values ($1,$2,$3,$4)',
      [code, nm, hostKey, secret]);
    const room = new Room({
      code, name: nm, hostKey, secret,
      players: this.players, photosDir: this.photosDir, events: [], claims: [], pins: [],
    });
    this.rooms.set(code, room);
    return room;
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }

  list() {
    return [...this.rooms.values()].map((r) => ({
      code: r.code, name: r.name,
      phase: r.engine.state.phase, teams: r.engine.state.teams.length,
    }));
  }
}

module.exports = { RoomManager, Room, genCode };
