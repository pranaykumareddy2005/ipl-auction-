'use strict';
const { EVENTS, makeEvent, UNDOABLE } = require('./events');
const { stepFor } = require('./money');
const { teamStats, isOverseas } = require('./selectors');

// A command validates intent against authoritative state and returns either
// { ok:true, events:[...] } or { ok:false, error }. The engine appends the
// events atomically. Nothing else is allowed to mutate state.

function fail(error) { return { ok: false, error }; }
function ok(events) { return { ok: true, events: Array.isArray(events) ? events : [events] }; }

function minNextBidL(bidding, baseL) {
  if (!bidding || bidding.currentBidL == null) return baseL;
  return bidding.currentBidL + stepFor(bidding.currentBidL);
}

const handlers = {
  configure(ctx, p) {
    if (ctx.state.phase !== 'setup') return fail('Can only configure during setup');
    return ok(makeEvent(EVENTS.AUCTION_CONFIGURED, { settings: p.settings || {} }));
  },

  setTeams(ctx, p) {
    if (ctx.state.phase !== 'setup') return fail('Teams can only be set during setup');
    const teams = p.teams || [];
    if (teams.length < 2) return fail('Need at least 2 teams');
    const ids = new Set();
    for (const t of teams) {
      if (ids.has(t.id)) return fail(`Duplicate team id ${t.id}`);
      ids.add(t.id);
    }
    return ok(makeEvent(EVENTS.TEAMS_SET, { teams }));
  },

  setQueue(ctx, p) {
    if (ctx.state.phase === 'complete') return fail('Auction is complete');
    return ok(makeEvent(EVENTS.QUEUE_SET, { order: (p.order || []).map(Number) }));
  },

  setNext(ctx, p) {
    const sr = Number(p.sr);
    if (!ctx.state.pool.includes(sr) && !ctx.state.held.includes(sr) && !ctx.state.skipped.includes(sr))
      return fail('Player is not available to queue next');
    return ok(makeEvent(EVENTS.PLAYER_SET_NEXT, { sr }));
  },

  start(ctx) {
    if (ctx.state.phase !== 'setup') return fail('Auction already started');
    if (ctx.state.teams.length < 2) return fail('Configure teams before starting');
    if (ctx.state.pool.length === 0) return fail('No players in the pool');
    return ok(makeEvent(EVENTS.AUCTION_STARTED, {}));
  },

  pause(ctx) {
    if (ctx.state.phase !== 'live') return fail('Auction is not live');
    return ok(makeEvent(EVENTS.AUCTION_PAUSED, {}));
  },

  resume(ctx) {
    if (ctx.state.phase !== 'paused') return fail('Auction is not paused');
    return ok(makeEvent(EVENTS.AUCTION_RESUMED, {}));
  },

  complete(ctx) {
    if (ctx.state.phase === 'complete') return fail('Auction already complete');
    if (ctx.state.phase === 'setup') return fail('Auction has not started');
    // A player still on the block would vanish (no result written) — resolve it first.
    if (ctx.state.currentSr != null)
      return fail('Resolve the current player (sell / unsold) before completing');
    return ok(makeEvent(EVENTS.AUCTION_COMPLETED, {}));
  },

  startUnsoldRound(ctx, p) {
    if (ctx.state.phase !== 'live' && ctx.state.phase !== 'paused')
      return fail('Auction must be live to start an unsold round');
    const hasUnsold = Object.values(ctx.state.results).some((r) => r.status === 'unsold');
    if (!hasUnsold) return fail('No unsold players to re-auction');
    if (ctx.state.currentSr != null) return fail('Resolve the current player first');
    return ok(makeEvent(EVENTS.UNSOLD_ROUND_STARTED, { order: (p.order || []).map(Number) }));
  },

  present(ctx, p) {
    if (ctx.state.phase !== 'live') return fail('Auction must be live to present a player');
    const sr = Number(p.sr);
    if (ctx.state.currentSr != null && ctx.state.currentSr !== sr)
      return fail('Another player is already on the block');
    if (ctx.state.results[sr] && ctx.state.results[sr].status === 'sold')
      return fail('Player already sold; reopen first');
    const player = ctx.players.bySr[sr];
    if (!player) return fail('Unknown player');
    return ok(makeEvent(EVENTS.PLAYER_PRESENTED, { sr, baseL: player.base }));
  },

  placeBid(ctx, p) {
    const s = ctx.state;
    if (s.phase !== 'live') return fail('Auction is not live');
    if (!s.bidding || s.currentSr == null) return fail('No player on the block');
    const sr = s.currentSr;
    // Guard against a late tap: if the caller expected a different player than the
    // one now on the block, reject rather than bid on whoever happens to be up.
    if (p.expectedSr != null && Number(p.expectedSr) !== sr) return fail('The player on the block just changed — check the screen');
    const teamId = p.teamId;
    const team = s.teams.find((t) => t.id === teamId);
    if (!team) return fail('Invalid team');
    if (s.bidding.leadingTeamId === teamId) return fail('Team already holds the leading bid');
    const minNext = minNextBidL(s.bidding, s.bidding.baseL);
    let amountL = p.amountL != null ? Number(p.amountL) : minNext;
    // Reject NaN/Infinity up front — otherwise every `<`/`>` comparison below is
    // false and a garbage amount would sail through, corrupting the current bid.
    if (!Number.isFinite(amountL)) return fail('Invalid bid amount');
    if (amountL < minNext) return fail(`Bid must be at least ₹${minNext} L`);
    const stats = teamStats(s, ctx.players, teamId);
    if (stats.slotsLeft <= 0) return fail(`${team.name} squad is full`);
    if (isOverseas(ctx.players.bySr[sr]) && stats.overseas >= s.settings.overseasMax)
      return fail(`${team.name} has reached the overseas limit (${s.settings.overseasMax})`);
    if (amountL > stats.maxBidL) return fail(`${team.name} cannot afford ₹${amountL} L (max ₹${stats.maxBidL} L)`);
    return ok(makeEvent(EVENTS.BID_PLACED, { sr, teamId, amountL }));
  },

  sold(ctx, p) {
    const s = ctx.state;
    if (s.phase !== 'live') return fail('Auction is not live');
    if (!s.bidding || s.currentSr == null) return fail('No player on the block');
    const sr = s.currentSr;
    const teamId = p.teamId != null ? p.teamId : s.bidding.leadingTeamId;
    const priceL = p.priceL != null ? Number(p.priceL) : s.bidding.currentBidL;
    if (teamId == null || priceL == null) return fail('No bid to sell — mark unsold instead');
    if (!Number.isFinite(priceL)) return fail('Invalid sale price');
    if (priceL < s.bidding.baseL) return fail(`Price cannot be below the base price (₹${s.bidding.baseL} L)`);
    const team = s.teams.find((t) => t.id === teamId);
    if (!team) return fail('Invalid team');
    const stats = teamStats(s, ctx.players, teamId);
    if (stats.slotsLeft <= 0) return fail(`${team.name} squad is full`);
    if (isOverseas(ctx.players.bySr[sr]) && stats.overseas >= s.settings.overseasMax)
      return fail(`${team.name} has reached the overseas limit (${s.settings.overseasMax})`);
    if (priceL > stats.maxBidL) return fail(`${team.name} cannot afford ₹${priceL} L`);
    return ok(makeEvent(EVENTS.PLAYER_SOLD, { sr, teamId, priceL }));
  },

  unsold(ctx) {
    const s = ctx.state;
    if (s.phase !== 'live') return fail('Auction is not live');
    if (s.currentSr == null) return fail('No player on the block');
    return ok(makeEvent(EVENTS.PLAYER_UNSOLD, { sr: s.currentSr }));
  },

  skip(ctx) {
    if (ctx.state.phase !== 'live') return fail('Auction is not live');
    if (ctx.state.currentSr == null) return fail('No player on the block');
    return ok(makeEvent(EVENTS.PLAYER_SKIPPED, { sr: ctx.state.currentSr }));
  },

  hold(ctx) {
    if (ctx.state.phase !== 'live') return fail('Auction is not live');
    if (ctx.state.currentSr == null) return fail('No player on the block');
    return ok(makeEvent(EVENTS.PLAYER_HELD, { sr: ctx.state.currentSr }));
  },

  bringHeldNext(ctx, p) {
    if (ctx.state.phase === 'complete') return fail('Auction is complete');
    const sr = Number(p.sr);
    if (!ctx.state.held.includes(sr)) return fail('Player is not on hold');
    return ok(makeEvent(EVENTS.HELD_BROUGHT_NEXT, { sr }));
  },

  reopen(ctx, p) {
    if (ctx.state.phase !== 'live' && ctx.state.phase !== 'paused')
      return fail('Auction must be live to reopen a player');
    const sr = Number(p.sr);
    const r = ctx.state.results[sr];
    if (!r || r.status !== 'sold') return fail('Only sold players can be reopened');
    return ok(makeEvent(EVENTS.PLAYER_REOPENED, { sr }));
  },

  adjustPurse(ctx, p) {
    if (ctx.state.phase === 'setup') return fail('Set up teams before adjusting purses');
    const teamId = p.teamId;
    const team = ctx.state.teams.find((t) => t.id === teamId);
    if (!team) return fail('Invalid team');
    const deltaL = Number(p.deltaL);
    if (!deltaL || isNaN(deltaL)) return fail('Adjustment must be a non-zero amount');
    const stats = teamStats(ctx.state, ctx.players, teamId);
    if (stats.remaining + deltaL < 0) return fail('Adjustment would make purse negative');
    return ok(makeEvent(EVENTS.PURSE_ADJUSTED, { teamId, deltaL, reason: p.reason || '' }));
  },

  note(ctx, p) {
    return ok(makeEvent(EVENTS.NOTE, { text: String(p.text || '') }));
  },

  // Wipe all auction progress (results, bids, current player) and return to setup,
  // keeping teams, settings and every player that was configured for the auction.
  reset(ctx) {
    const s = ctx.state;
    if (s.teams.length === 0) return fail('Nothing to restart — set up the auction first');
    // Every player that took part, re-pooled for a fresh run.
    const seen = new Set();
    for (const sr of s.pool) seen.add(sr);
    for (const sr of s.held) seen.add(sr);
    for (const sr of s.skipped) seen.add(sr);
    if (s.currentSr != null) seen.add(s.currentSr);
    for (const k of Object.keys(s.results)) seen.add(Number(k));
    // Preserve the most recent configured queue order where possible.
    let order = [];
    for (let i = ctx.events.length - 1; i >= 0; i--) {
      if (ctx.events[i].type === EVENTS.QUEUE_SET) { order = (ctx.events[i].data.order || []).map(Number); break; }
    }
    const finalOrder = order.filter((sr) => seen.has(sr));
    for (const sr of seen) if (!finalOrder.includes(sr)) finalOrder.push(sr);
    return ok(makeEvent(EVENTS.AUCTION_RESET, { settings: s.settings, teams: s.teams, order: finalOrder }));
  },

  // --- history-aware commands ---
  undo(ctx) {
    const target = lastUndoable(ctx.events, ctx.state._voided);
    if (!target) return fail('Nothing to undo');
    return ok(makeEvent(EVENTS.UNDO, { targetId: target.id, targetType: target.type }));
  },

  correctBid(ctx, p) {
    // Void the most recent bid on the current player, then place a corrected one.
    const s = ctx.state;
    if (!s.bidding) return fail('No active bidding to correct');
    const lastBidId = s.bidding.bids.length ? s.bidding.bids[s.bidding.bids.length - 1].id : null;
    if (!lastBidId) return fail('No bid to correct');
    const events = [makeEvent(EVENTS.UNDO, { targetId: lastBidId, targetType: EVENTS.BID_PLACED })];
    // Recompute state without that last bid to validate the correction.
    const rewound = ctx.reduceWith(events);
    const sub = handlers.placeBid({ state: rewound, players: ctx.players, events: ctx.events.concat(events) }, p);
    if (!sub.ok) return sub;
    return ok(events.concat(sub.events));
  },
};

/** Find the most recent applied (non-voided) event that a generic undo may reverse. */
function lastUndoable(events, voided) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === EVENTS.UNDO) continue;
    if (voided && voided.has(ev.id)) continue;
    if (UNDOABLE.has(ev.type)) return ev;
  }
  return null;
}

function dispatch(name, ctx, payload) {
  const h = handlers[name];
  if (!h) return fail(`Unknown command: ${name}`);
  try {
    return h(ctx, payload || {});
  } catch (e) {
    return fail(`Command failed: ${e.message}`);
  }
}

module.exports = { dispatch, handlers, lastUndoable, minNextBidL };
