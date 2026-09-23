'use strict';
// Canonical list of event types. Every state change is one of these, appended
// to the append-only log. State is a pure reduction over the ordered events.

const EVENTS = {
  // --- setup ---
  AUCTION_CONFIGURED: 'AUCTION_CONFIGURED',   // { settings }
  TEAMS_SET: 'TEAMS_SET',                       // { teams:[{id,name,short,color,owner,purseL}] }
  QUEUE_SET: 'QUEUE_SET',                       // { order:[sr,...] } — reorders the upcoming pool
  PLAYER_SET_NEXT: 'PLAYER_SET_NEXT',           // { sr } — move a player to front of queue

  // --- lifecycle ---
  AUCTION_STARTED: 'AUCTION_STARTED',           // {}
  AUCTION_PAUSED: 'AUCTION_PAUSED',             // {}
  AUCTION_RESUMED: 'AUCTION_RESUMED',           // {}
  AUCTION_COMPLETED: 'AUCTION_COMPLETED',       // {}
  AUCTION_RESET: 'AUCTION_RESET',               // { settings, teams, order } — wipe progress back to setup
  UNSOLD_ROUND_STARTED: 'UNSOLD_ROUND_STARTED', // { order?:[sr,...] } — re-pool unsold players

  // --- presenting / bidding ---
  PLAYER_PRESENTED: 'PLAYER_PRESENTED',         // { sr } — put a player on the block
  BID_PLACED: 'BID_PLACED',                     // { sr, teamId, amountL }
  PLAYER_SOLD: 'PLAYER_SOLD',                   // { sr, teamId, priceL }
  PLAYER_UNSOLD: 'PLAYER_UNSOLD',               // { sr }
  PLAYER_SKIPPED: 'PLAYER_SKIPPED',             // { sr } — set aside, revisit later
  PLAYER_HELD: 'PLAYER_HELD',                   // { sr } — hold for later in this round
  HELD_BROUGHT_NEXT: 'HELD_BROUGHT_NEXT',       // { sr } — bring a held player to front

  // --- corrections (never destroy history) ---
  PLAYER_REOPENED: 'PLAYER_REOPENED',           // { sr } — undo a sale, refund team, re-pool
  PURSE_ADJUSTED: 'PURSE_ADJUSTED',             // { teamId, deltaL, reason }
  UNDO: 'UNDO',                                 // { targetId } — void a prior undoable event

  // --- meta ---
  NOTE: 'NOTE',                                 // { text } — operator annotation, no state effect
};

let _seq = 0;
/** Create a new event envelope. `applied` order + monotonic id give total order. */
function makeEvent(type, data, meta) {
  _seq += 1;
  return {
    id: `${Date.now().toString(36)}-${(_seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    data: data || {},
    ts: Date.now(),
    actor: (meta && meta.actor) || 'operator',
  };
}

/** Events that a generic UNDO is allowed to void (most recent first at runtime). */
const UNDOABLE = new Set([
  EVENTS.BID_PLACED,
  EVENTS.PLAYER_SOLD,
  EVENTS.PLAYER_UNSOLD,
  EVENTS.PLAYER_SKIPPED,
  EVENTS.PLAYER_HELD,
  EVENTS.PLAYER_PRESENTED,
  EVENTS.PURSE_ADJUSTED,
  EVENTS.PLAYER_REOPENED,
  EVENTS.HELD_BROUGHT_NEXT,
  EVENTS.PLAYER_SET_NEXT,
]);

module.exports = { EVENTS, makeEvent, UNDOABLE };
