'use strict';
const { reduce } = require('./reducer');
const { dispatch } = require('./commands');
const { allTeamStats, teamStats } = require('./selectors');
const { minNextBidL } = require('./commands');
const { stepFor } = require('./money');

// The single authoritative auction. All writes flow through command(); on
// success the events are durably appended and the state is re-derived from the
// full log, so persisted state and in-memory state can never diverge.

class AuctionEngine {
  // Two persistence modes:
  //   legacy single-room: pass `store` (sync file-backed EventStore).
  //   multi-room (Postgres): pass `events` (preloaded array) + `persist` (async
  //     fn(events) that durably appends). Writes are serialized via a promise
  //     chain; call flush() to await durability before acking a command.
  constructor({ store, players, photosDir, chatStore, events, persist }) {
    this.store = store || null;
    this.persist = persist || null;
    this._writes = Promise.resolve();
    this.players = players;
    this.photosDir = photosDir || null;
    // Chat is NOT auction state: kept out of the event log (like team claims), in a
    // separate durable store + an in-memory ring buffer, so it never bloats the
    // audit log or slows event replay, but still survives a restart.
    this.chatStore = chatStore || null;
    this.chat = chatStore ? chatStore.loadAll() : [];
    if (this.chat.length > 400) this.chat = this.chat.slice(-400);
    this.photos = new Map();     // sr -> photo filename on disk (jpg/png/webp)
    this.photoVer = Date.now();  // cache-busting token, bumped on upload
    this._scanPhotos();
    this.events = events || (store ? store.loadAll() : []);
    this.state = reduce(this.events);
    this.subs = new Set();
    // Optional (multi-room): sync lookup of whether a team is claimed (FCFS).
    this.claimLookup = null;
    // Transient (not event-sourced) presentation timer.
    this.timer = { running: false, endsAt: null, durationMs: 0 };
    // Deterministic change counter: equals the number of persisted events, so it
    // is identical before and after a restart (clients use it to detect changes).
    this.rev = this.events.length;
  }

  /** Inject a sync claimed-team lookup so snapshots can flag FCFS-claimed teams. */
  setClaimLookup(fn) { this.claimLookup = fn; }

  /** Durably append events. Returns a promise for THIS write (serialized). */
  _append(events) {
    if (this.store) { this.store.append(events); return Promise.resolve(); }
    if (!this.persist) return Promise.resolve();
    this._pending = (this._pending || 0) + 1;
    const run = this._writes.then(() => this.persist(events));
    // Keep the serialized chain alive after success OR failure, and track DB health so
    // the operator can be warned if writes start failing (e.g. internet/Supabase blip),
    // and told not to restart until it recovers (a restart would drop un-persisted bids).
    this._writes = run.then(
      () => { this._pending = Math.max(0, (this._pending || 1) - 1); this._lastPersistOk = Date.now(); },
      () => { this._pending = Math.max(0, (this._pending || 1) - 1); }
    );
    return run.catch((err) => { console.error('[engine] persist failed:', err && err.message); this._lastPersistError = Date.now(); throw err; });
  }

  /** DB-write health for the operator UI: ok=false means writes are currently failing. */
  _persistHealth() {
    if (!this.persist) return { ok: true, pending: 0, lastOkAt: null, lastErrorAt: null };
    const lastErr = this._lastPersistError || 0, lastOk = this._lastPersistOk || 0;
    return { ok: lastErr <= lastOk, pending: this._pending || 0, lastOkAt: lastOk || null, lastErrorAt: lastErr || null };
  }

  /** Await all pending async writes (Postgres mode). No-op in legacy mode. */
  flush() { return this._writes; }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  _scanPhotos() {
    if (!this.photosDir) return;
    try {
      const fs = require('fs');
      if (!fs.existsSync(this.photosDir)) return;
      for (const f of fs.readdirSync(this.photosDir)) {
        const m = f.match(/^(\d+)\.(jpe?g|png|webp)$/i);
        if (m) this.photos.set(Number(m[1]), f);
      }
    } catch (e) { /* noop */ }
  }

  /** Record that player `sr` now has a photo and push the update to all screens. */
  addPhoto(sr, filename) { this.photos.set(Number(sr), filename || `${sr}.jpg`); this.photoVer = Date.now(); this._notify(); }

  _notify() {
    const snap = this.snapshot();
    for (const fn of this.subs) { try { fn(snap); } catch (e) { /* noop */ } }
  }

  reduceWith(extraEvents) { return reduce(this.events.concat(extraEvents)); }

  /** Append a chat message and push it to every screen. Not event-sourced. */
  postChat({ from, teamId, color, short, text, actor }) {
    const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 280);
    if (!clean) return { ok: false, error: 'Empty message' };
    const msg = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      from: String(from || 'Anon').slice(0, 40),
      teamId: teamId != null ? teamId : null,
      color: color || null,
      short: short || null,
      actor: actor || 'team',
      text: clean,
    };
    this.chat.push(msg);
    if (this.chat.length > 400) this.chat = this.chat.slice(-400);
    this.chatStore && this.chatStore.append(msg);
    this._notify();
    return { ok: true };
  }

  /** Run a command. Returns { ok, error?, rev }. Appends + broadcasts on success. */
  command(name, payload, meta) {
    const ctx = {
      state: this.state,
      players: this.players,
      events: this.events,
      reduceWith: (ex) => this.reduceWith(ex),
    };
    const res = dispatch(name, ctx, payload);
    if (!res.ok) return { ok: false, error: res.error };

    if (meta && meta.actor) res.events.forEach((e) => { e.actor = meta.actor; });
    const write = this._append(res.events);
    this.events = this.events.concat(res.events);
    this.state = reduce(this.events);
    this.rev = this.events.length;

    // Timer side-effects: reset on a new player / new bid, stop on resolution.
    this._syncTimer(name, res.events);
    this._notify();
    return { ok: true, rev: this.rev, write };
  }

  _syncTimer(name, events) {
    const dur = (this.state.settings.timerSec || 20) * 1000;
    if (name === 'present' || name === 'placeBid' || name === 'correctBid') {
      this.timer = { running: true, endsAt: Date.now() + dur, durationMs: dur };
    } else if (['sold', 'unsold', 'skip', 'hold', 'pause', 'complete', 'reset'].includes(name)) {
      this.timer = { running: false, endsAt: null, durationMs: dur };
    }
  }

  startTimer() {
    const dur = (this.state.settings.timerSec || 20) * 1000;
    this.timer = { running: true, endsAt: Date.now() + dur, durationMs: dur };
    this._notify();
  }
  stopTimer() {
    this.timer = { running: false, endsAt: null, durationMs: this.timer.durationMs };
    this._notify();
  }

  playerView(sr) {
    if (sr == null) return null;
    const p = this.players.bySr[sr];
    if (!p) return { sr, name: `#${sr}` };
    const star = this.players.stars[p.name];
    return {
      sr: p.sr, code: p.code, name: p.name, country: p.country, role: p.role,
      cu: p.cu, base: p.base, cat: this.players.catFor(p),
      star: star ? star : null,
      stats: this.players.stats[p.sr] || null,
      photo: this.photos.has(p.sr) ? `/photos/${this.photos.get(p.sr)}?v=${this.photoVer}` : null,
    };
  }

  /** Full client-facing snapshot: everything a screen needs to render. */
  snapshot() {
    const s = this.state;
    const rawStats = allTeamStats(s, this.players);
    // Multi-room: annotate each team with whether it has been claimed (FCFS).
    const stats = this.claimLookup
      ? rawStats.map((t) => ({ ...t, claimed: !!this.claimLookup(t.teamId) }))
      : rawStats;
    const current = this.playerView(s.currentSr);
    const bidding = s.bidding ? {
      sr: s.bidding.sr,
      baseL: s.bidding.baseL,
      currentBidL: s.bidding.currentBidL,
      leadingTeamId: s.bidding.leadingTeamId,
      nextMinL: minNextBidL(s.bidding, s.bidding.baseL),
      step: s.bidding.currentBidL == null ? 0 : stepFor(s.bidding.currentBidL),
      bids: s.bidding.bids.slice(-12),
    } : null;
    let lastResult = null;
    if (s.lastEvent) {
      const le = s.lastEvent;
      const t = le.teamId != null ? s.teams.find((x) => x.id === le.teamId) : null;
      lastResult = {
        kind: le.kind,
        ...this.playerView(le.sr),
        teamId: le.teamId != null ? le.teamId : null,
        teamName: t ? t.name : null,
        teamColor: t ? t.color : null,
        teamShort: t ? t.short : null,
        priceL: le.priceL != null ? le.priceL : null,
        ts: le.ts,
      };
    }
    return {
      rev: this.rev,
      phase: s.phase,
      round: s.round,
      lastResult,
      settings: s.settings,
      teams: stats,
      current,
      bidding,
      poolCount: s.pool.length,
      queuePreview: s.pool.slice(0, 12).map((sr) => this.playerView(sr)),
      held: s.held.map((sr) => this.playerView(sr)),
      skipped: s.skipped.map((sr) => this.playerView(sr)),
      counts: this._counts(),
      timer: this.timerSnapshot(),
      totalPlayers: this.players.list.length,
      chat: this.chat.slice(-60),
      persist: this._persistHealth(),
    };
  }

  timerSnapshot() {
    const t = this.timer;
    return {
      running: t.running,
      remainingMs: t.running && t.endsAt ? Math.max(0, t.endsAt - Date.now()) : 0,
      durationMs: t.durationMs,
    };
  }

  _counts() {
    let sold = 0, unsold = 0;
    for (const sr of Object.keys(this.state.results)) {
      if (this.state.results[sr].status === 'sold') sold += 1; else unsold += 1;
    }
    return { sold, unsold, pool: this.state.pool.length, held: this.state.held.length, skipped: this.state.skipped.length };
  }

  /** History for the operator log / audit, newest last. */
  history(limit = 200) {
    const voided = this.state._voided || new Set();
    return this.events.slice(-limit).map((e) => ({
      id: e.id, type: e.type, ts: e.ts, actor: e.actor, data: e.data,
      voided: voided.has(e.id),
    }));
  }

  /** Team squad detail for the team view. */
  teamDetail(teamId) {
    return teamStats(this.state, this.players, teamId);
  }
}

module.exports = { AuctionEngine };
