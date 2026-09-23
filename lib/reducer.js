'use strict';
const { EVENTS } = require('./events');

// Pure reduction: an ordered list of events -> authoritative auction state.
// UNDO events void a prior event by id; voided events are skipped when folding,
// so undo/redo/reopen all fall out of a single deterministic replay.

function initialState() {
  return {
    phase: 'setup',            // setup | live | paused | complete
    round: 'main',             // main | unsold
    settings: { purseL: 12000, squadMax: 25, overseasMax: 8, timerSec: 20, minTeams: 2 },
    teams: [],                 // [{id,name,short,color,owner,purseL}]
    pool: [],                  // ordered srs still to be auctioned this round
    held: [],                  // srs held aside
    skipped: [],               // srs skipped aside (revisit later)
    currentSr: null,           // player currently on the block
    bidding: null,             // {sr, baseL, currentBidL, leadingTeamId, bids:[{id,teamId,amountL}]}
    results: {},               // sr -> {status:'sold'|'unsold', teamId?, priceL?, round, ts}
    lastSold: null,            // {sr, teamId, priceL, ts} — most recent sale
    lastEvent: null,           // {kind:'sold'|'unsold'|'skipped', sr, teamId?, priceL?, ts} — for the result splash
    purseAdjust: {},           // teamId -> net delta in L
    version: 0,                // number of applied (non-voided) events
  };
}

function removeFrom(arr, sr) {
  const i = arr.indexOf(sr);
  if (i >= 0) arr.splice(i, 1);
}

function applyEvent(s, ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case EVENTS.AUCTION_CONFIGURED:
      s.settings = Object.assign({}, s.settings, d.settings || {});
      break;

    case EVENTS.TEAMS_SET:
      s.teams = (d.teams || []).map((t, i) => ({
        id: t.id != null ? t.id : i,
        name: t.name || `Team ${i + 1}`,
        short: t.short || (t.name ? t.name.slice(0, 3).toUpperCase() : `T${i + 1}`),
        color: t.color || '#888',
        owner: t.owner || '',
        purseL: t.purseL != null ? t.purseL : s.settings.purseL,
      }));
      break;

    case EVENTS.QUEUE_SET: {
      // Set/reorder the pool to the provided order. Excludes already-sold players
      // and the one on the block; anything pooled is pulled out of held/skipped.
      const blocked = new Set();
      for (const k of Object.keys(s.results)) if (s.results[k].status === 'sold') blocked.add(Number(k));
      if (s.currentSr != null) blocked.add(s.currentSr);
      const order = (d.order || []).map(Number).filter((sr, i, a) => a.indexOf(sr) === i && !blocked.has(sr));
      s.pool = order;
      for (const sr of order) { removeFrom(s.held, sr); removeFrom(s.skipped, sr); }
      break;
    }

    case EVENTS.PLAYER_SET_NEXT:
      // A player queued next must leave every other bucket, or it exists twice.
      removeFrom(s.pool, d.sr);
      removeFrom(s.held, d.sr);
      removeFrom(s.skipped, d.sr);
      s.pool.unshift(d.sr);
      break;

    case EVENTS.AUCTION_STARTED:
      s.phase = 'live';
      break;
    case EVENTS.AUCTION_PAUSED:
      if (s.phase === 'live') s.phase = 'paused';
      break;
    case EVENTS.AUCTION_RESUMED:
      if (s.phase === 'paused') s.phase = 'live';
      break;
    case EVENTS.AUCTION_COMPLETED:
      s.phase = 'complete';
      s.currentSr = null;
      s.bidding = null;
      break;

    case EVENTS.UNSOLD_ROUND_STARTED: {
      const unsold = Object.keys(s.results)
        .filter((sr) => s.results[sr].status === 'unsold')
        .map(Number);
      for (const sr of unsold) delete s.results[sr];
      const order = (d.order || unsold).filter((sr) => unsold.includes(sr));
      for (const sr of unsold) if (!order.includes(sr)) order.push(sr);
      s.pool = order;
      s.round = 'unsold';
      s.currentSr = null;
      s.bidding = null;
      break;
    }

    case EVENTS.PLAYER_PRESENTED:
      removeFrom(s.pool, d.sr);
      removeFrom(s.held, d.sr);
      removeFrom(s.skipped, d.sr);
      s.currentSr = d.sr;
      s.bidding = { sr: d.sr, baseL: d.baseL || 0, currentBidL: null, leadingTeamId: null, bids: [] };
      break;

    case EVENTS.BID_PLACED:
      if (s.bidding && s.bidding.sr === d.sr) {
        s.bidding.currentBidL = d.amountL;
        s.bidding.leadingTeamId = d.teamId;
        s.bidding.bids.push({ id: ev.id, teamId: d.teamId, amountL: d.amountL });
      }
      break;

    case EVENTS.PLAYER_SOLD:
      s.results[d.sr] = { status: 'sold', teamId: d.teamId, priceL: d.priceL, round: s.round, ts: ev.ts };
      s.lastSold = { sr: d.sr, teamId: d.teamId, priceL: d.priceL, ts: ev.ts };
      s.lastEvent = { kind: 'sold', sr: d.sr, teamId: d.teamId, priceL: d.priceL, ts: ev.ts };
      removeFrom(s.pool, d.sr);
      removeFrom(s.held, d.sr);
      removeFrom(s.skipped, d.sr);
      if (s.currentSr === d.sr) { s.currentSr = null; s.bidding = null; }
      break;

    case EVENTS.PLAYER_UNSOLD:
      s.results[d.sr] = { status: 'unsold', round: s.round, ts: ev.ts };
      s.lastEvent = { kind: 'unsold', sr: d.sr, ts: ev.ts };
      removeFrom(s.pool, d.sr);
      if (s.currentSr === d.sr) { s.currentSr = null; s.bidding = null; }
      break;

    case EVENTS.PLAYER_SKIPPED:
      removeFrom(s.pool, d.sr);
      if (!s.skipped.includes(d.sr)) s.skipped.push(d.sr);
      s.lastEvent = { kind: 'skipped', sr: d.sr, ts: ev.ts };
      if (s.currentSr === d.sr) { s.currentSr = null; s.bidding = null; }
      break;

    case EVENTS.PLAYER_HELD:
      removeFrom(s.pool, d.sr);
      if (!s.held.includes(d.sr)) s.held.push(d.sr);
      if (s.currentSr === d.sr) { s.currentSr = null; s.bidding = null; }
      break;

    case EVENTS.HELD_BROUGHT_NEXT:
      removeFrom(s.held, d.sr);
      removeFrom(s.pool, d.sr);
      s.pool.unshift(d.sr);
      break;

    case EVENTS.PLAYER_REOPENED:
      // Refund happens implicitly: clearing the sold result removes the spend.
      delete s.results[d.sr];
      removeFrom(s.pool, d.sr);
      s.pool.unshift(d.sr);
      break;

    case EVENTS.PURSE_ADJUSTED:
      s.purseAdjust[d.teamId] = (s.purseAdjust[d.teamId] || 0) + (d.deltaL || 0);
      break;

    case EVENTS.NOTE:
      break;

    default:
      break;
  }
}

/** Fold an ordered event list into state, honoring UNDO void markers. */
function reduce(events) {
  const voided = new Set();
  for (const ev of events) {
    if (ev.type === EVENTS.UNDO && ev.data && ev.data.targetId) voided.add(ev.data.targetId);
  }
  let s = initialState();
  for (const ev of events) {
    if (ev.type === EVENTS.UNDO) continue;
    if (voided.has(ev.id)) continue;
    if (ev.type === EVENTS.AUCTION_RESET) {
      // Discard all prior progress; keep teams, settings and the configured pool.
      const d = ev.data || {};
      s = initialState();
      if (d.settings) s.settings = Object.assign({}, s.settings, d.settings);
      if (d.teams) applyEvent(s, { type: EVENTS.TEAMS_SET, data: { teams: d.teams } });
      if (Array.isArray(d.order)) s.pool = d.order.map(Number);
      s.version += 1;
      continue;
    }
    applyEvent(s, ev);
    s.version += 1;
  }
  s._voided = voided;
  return s;
}

module.exports = { reduce, initialState };
