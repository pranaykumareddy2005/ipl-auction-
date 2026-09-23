'use strict';
// Derived views over reduced state. Needs the player master to know overseas
// status. These are the numbers the UI and validation both rely on.

function isOverseas(player) {
  if (!player) return false;
  // Uncapped Indians / capped Indians are domestic; everything else overseas.
  return player.country && player.country !== 'India';
}

/** Financials + squad composition for one team, derived from results. */
function teamStats(state, players, teamId) {
  const team = state.teams.find((t) => t.id === teamId);
  const base = team ? team.purseL : 0;
  const adjust = state.purseAdjust[teamId] || 0;
  let spent = 0, count = 0, overseas = 0;
  const squad = [];
  for (const srKey of Object.keys(state.results)) {
    const r = state.results[srKey];
    if (r.status !== 'sold' || r.teamId !== teamId) continue;
    const sr = Number(srKey);
    const p = players.bySr[sr];
    spent += r.priceL;
    count += 1;
    if (isOverseas(p)) overseas += 1;
    squad.push({ sr, name: p ? p.name : `#${sr}`, role: p ? p.role : '', country: p ? p.country : '', priceL: r.priceL, overseas: isOverseas(p) });
  }
  squad.sort((a, b) => b.priceL - a.priceL);
  const remaining = base + adjust - spent;
  const slotsLeft = state.settings.squadMax - count;
  // Max bid must keep ₹base for each remaining mandatory slot (min 1 filled by this bid).
  const reservePerSlot = 0; // college event: no forced minimum reserve; keep simple + safe
  const maxBidL = remaining - reservePerSlot * Math.max(0, slotsLeft - 1);
  return {
    teamId, name: team ? team.name : `#${teamId}`,
    short: team ? team.short : `T${teamId}`, color: team ? team.color : '#888',
    base, adjust, spent, remaining, count, overseas, squad, slotsLeft, maxBidL,
  };
}

function allTeamStats(state, players) {
  return state.teams.map((t) => teamStats(state, players, t.id));
}

module.exports = { isOverseas, teamStats, allTeamStats };
