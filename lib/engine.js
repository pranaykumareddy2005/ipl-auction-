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
  constructor({ store, players, photosDir }) {
    this.store = store;
    this.players = players;
    this.photosDir = photosDir || null;
    this.photos = new Map();     // sr -> photo filename on disk (jpg/png/webp)
    this.photoVer = Date.now();  // cache-busting token, bumped on upload
    this._scanPhotos();
    this.events = store ? store.loadAll() : [];
    this.state = reduce(this.events);
    this.subs = new Set();
    // Transient (not event-sourced) presentation timer.
    this.timer = { running: false, endsAt: null, durationMs: 0 };
    // Deterministic change counter: equals the number of persisted events, so it
    // is identical before and after a restart (clients use it to detect changes).
    this.rev = this.events.length;
  }

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
    this.store && this.store.append(res.events);
    this.events = this.events.concat(res.events);
    this.state = reduce(this.events);
    this.rev = this.events.length;

    // Timer side-effects: reset on a new player / new bid, stop on resolution.
    this._syncTimer(name, res.events);
    this._notify();
    return { ok: true, rev: this.rev };
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
    const stats = allTeamStats(s, this.players);
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
