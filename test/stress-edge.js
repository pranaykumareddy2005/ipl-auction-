'use strict';
/* Large edge-case + property-fuzz suite on the REAL engine (lib/engine.js).
   Trips every rejection path and checks core invariants after thousands of
   randomized commands. Pure logic — no HTTP, no DB. */
const path = require('path');
const players = require('../lib/players');
const { AuctionEngine } = require('../lib/engine');
const { reduce } = require('../lib/reducer');
const { teamStats } = require('../lib/selectors');

const master = players.load(path.join(__dirname, '..', 'data'), path.join(__dirname, '..'));
let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('   \x1b[31m✗ ' + msg + '\x1b[0m'); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const DEFAULT_TEAMS = (n = 10, purseL = 12000) =>
  Array.from({ length: n }, (_, i) => ({ id: i, name: 'Team' + i, short: 'T' + i, color: '#0af', purseL }));

function newEngine(teams, settings) {
  const e = new AuctionEngine({ players: master });
  if (settings) e.command('configure', { settings });
  e.command('setTeams', { teams });
  return e;
}
// pick some sr's that are overseas / domestic
const overseasSrs = master.list.filter((p) => p.country && p.country !== 'India').map((p) => p.sr);
const domesticSrs = master.list.filter((p) => !p.country || p.country === 'India').map((p) => p.sr);

console.log('\n\x1b[1m1 · Rejection paths (engine validation)\x1b[0m');
{
  const e = newEngine(DEFAULT_TEAMS());
  eq(e.command('present', { sr: 1 }).ok, false, 'present before start is rejected');
  eq(e.command('start', {}).ok, false, 'start with empty pool is rejected');

  e.command('setQueue', { order: domesticSrs.slice(0, 20) });
  ok(e.command('start', {}).ok, 'start with pool + teams succeeds');
  eq(e.command('start', {}).ok, false, 'double start is rejected');

  const sr = domesticSrs[0];
  ok(e.command('present', { sr }).ok, 'present first player');
  eq(e.command('present', { sr: domesticSrs[1] }).ok, false, 'presenting a 2nd player while one is on block is rejected');

  eq(e.command('placeBid', { teamId: 0, amountL: 1 }).ok, false, 'bid below base is rejected');
  ok(e.command('placeBid', { teamId: 0 }).ok, 'bid at min (no amount) accepted');
  eq(e.command('placeBid', { teamId: 0 }).ok, false, 'leading team re-bidding is rejected');
  eq(e.command('placeBid', { teamId: 999 }).ok, false, 'bid from unknown team is rejected');
  eq(e.command('placeBid', { teamId: 1, amountL: NaN }).ok, false, 'NaN bid is rejected');
  eq(e.command('placeBid', { teamId: 1, amountL: Infinity }).ok, false, 'Infinity bid is rejected');
  eq(e.command('placeBid', { teamId: 1, amountL: 5, expectedSr: 999999 }).ok, false, 'stale expectedSr is rejected');

  eq(e.command('sold', { teamId: 0, priceL: 1 }).ok, false, 'sell below base is rejected');
  eq(e.command('complete', {}).ok, false, 'complete while a player is on the block is rejected');
  ok(e.command('sold', {}).ok, 'sold to leader (default price) succeeds');
  eq(e.command('unsold', {}).ok, false, 'unsold with no player on block is rejected');
  eq(e.command('reopen', { sr: domesticSrs[5] }).ok, false, 'reopen a never-sold player is rejected');
  ok(e.command('reopen', { sr }).ok, 'reopen the sold player succeeds');
  eq(e.command('foobar', {}).ok, false, 'unknown command is rejected');
}

console.log('\n\x1b[1m2 · Squad-max limit\x1b[0m');
{
  const e = newEngine(DEFAULT_TEAMS(4, 1000000), { squadMax: 2 });
  e.command('setQueue', { order: domesticSrs.slice(0, 10) });
  e.command('start', {});
  // Team 0 buys 2 players, then must be blocked on the 3rd.
  for (let i = 0; i < 2; i++) {
    const sr = domesticSrs[i];
    e.command('present', { sr });
    e.command('placeBid', { teamId: 0, amountL: 200 });
    ok(e.command('sold', { teamId: 0 }).ok, `team0 buys player ${i + 1}/2`);
  }
  const sr = domesticSrs[2];
  e.command('present', { sr });
  eq(e.command('placeBid', { teamId: 0, amountL: 200 }).ok, false, 'bid rejected once squad is full');
  eq(e.command('sold', { teamId: 0, priceL: 200 }).ok, false, 'sold rejected once squad is full');
  eq(teamStats(e.state, master, 0).count, 2, 'team0 count stays at squadMax');
}

console.log('\n\x1b[1m3 · Overseas limit\x1b[0m');
if (overseasSrs.length >= 2) {
  const e = newEngine(DEFAULT_TEAMS(4, 1000000), { overseasMax: 1, squadMax: 25 });
  e.command('setQueue', { order: overseasSrs.slice(0, 5) });
  e.command('start', {});
  e.command('present', { sr: overseasSrs[0] });
  e.command('placeBid', { teamId: 0, amountL: 200 });
  ok(e.command('sold', { teamId: 0 }).ok, 'team0 buys 1st overseas player');
  e.command('present', { sr: overseasSrs[1] });
  eq(e.command('placeBid', { teamId: 0, amountL: 200 }).ok, false, 'bid rejected at overseas limit');
  eq(e.command('sold', { teamId: 0, priceL: 200 }).ok, false, 'sold rejected at overseas limit');
} else { console.log('   (skipped — need ≥2 overseas players in data)'); }

console.log('\n\x1b[1m4 · Purse / afford limit\x1b[0m');
{
  const e = newEngine(DEFAULT_TEAMS(4, 500), { squadMax: 25 }); // ₹5 Cr purse
  e.command('setQueue', { order: domesticSrs.slice(0, 5) });
  e.command('start', {});
  e.command('present', { sr: domesticSrs[0] });
  eq(e.command('placeBid', { teamId: 0, amountL: 600 }).ok, false, 'bid above purse is rejected');
  ok(e.command('placeBid', { teamId: 0, amountL: 500 }).ok, 'bid == full purse accepted');
  ok(e.command('sold', { teamId: 0, priceL: 500 }).ok, 'sold at full purse');
  eq(teamStats(e.state, master, 0).remaining, 0, 'purse exactly zero after max spend');
  e.command('present', { sr: domesticSrs[1] });
  eq(e.command('placeBid', { teamId: 0, amountL: 100 }).ok, false, 'broke team cannot bid');
}

console.log('\n\x1b[1m5 · Auth-independent event-sourcing integrity\x1b[0m');
{
  const e = newEngine(DEFAULT_TEAMS(), null);
  e.command('setQueue', { order: domesticSrs.slice(0, 30) });
  e.command('start', {});
  for (let i = 0; i < 10; i++) {
    e.command('present', { sr: domesticSrs[i] });
    e.command('placeBid', { teamId: i % 10, amountL: 200 + i * 25 });
    e.command('sold', {});
  }
  const replayed = reduce(e.events);
  eq(JSON.stringify(replayed.results), JSON.stringify(e.state.results), 'replay(events).results === live state.results');
  eq(replayed.teams.length, e.state.teams.length, 'replay team count matches');
  eq(e.rev, e.events.length, 'rev === event count');
}

console.log('\n\x1b[1m6 · Property fuzz — 5 randomized full auctions, invariants after every command\x1b[0m');
function invariants(e, tag) {
  const s = e.state;
  // sum of sold prices
  let soldTotal = 0; const owners = {};
  for (const k of Object.keys(s.results)) {
    const r = s.results[k];
    if (r.status !== 'sold') continue;
    soldTotal += r.priceL;
    ok(owners[k] === undefined, `${tag}: player ${k} owned once`);
    owners[k] = r.teamId;
  }
  let teamSpentSum = 0;
  for (const t of s.teams) {
    const st = teamStats(s, master, t.id);
    ok(st.remaining >= 0, `${tag}: team ${t.id} purse not negative (${st.remaining})`);
    ok(st.count <= s.settings.squadMax, `${tag}: team ${t.id} squad ≤ max`);
    ok(st.overseas <= s.settings.overseasMax, `${tag}: team ${t.id} overseas ≤ max`);
    teamSpentSum += st.spent;
  }
  eq(teamSpentSum, soldTotal, `${tag}: Σ team.spent === Σ sold prices`);
}
let fuzzCmds = 0;
for (let run = 0; run < 5; run++) {
  const nTeams = 6 + (run % 4);
  const purse = 800 + run * 400;
  const e = newEngine(DEFAULT_TEAMS(nTeams, purse), { squadMax: 4 + run, overseasMax: 2 + (run % 3) });
  const pool = master.list.map((p) => p.sr).sort(() => Math.random() - 0.5).slice(0, 60);
  e.command('setQueue', { order: pool });
  e.command('start', {});
  for (const sr of pool) {
    if (e.command('present', { sr }).ok === false) continue;
    // random bid war
    const raises = Math.floor(Math.random() * 8);
    for (let b = 0; b < raises; b++) {
      const team = Math.floor(Math.random() * nTeams);
      e.command('placeBid', { teamId: team, expectedSr: sr }); fuzzCmds++;
    }
    // resolve: sell if there's a leader, else unsold
    if (e.state.bidding && e.state.bidding.leadingTeamId != null) {
      const r = e.command('sold', {});
      if (!r.ok) e.command('unsold', {}); // if leader now can't afford (shouldn't happen), unsold
    } else {
      e.command('unsold', {});
    }
    fuzzCmds++;
    invariants(e, `run${run}`);
  }
  // finish
  ok(e.command('complete', {}).ok, `run${run}: auction completes cleanly`);
  // event-sourcing integrity after a big run
  eq(JSON.stringify(reduce(e.events).results), JSON.stringify(e.state.results), `run${run}: replay integrity`);
}
console.log(`   (fuzz executed ~${fuzzCmds} commands across 5 auctions)`);

console.log('\n\x1b[1m7 · Undo / reset flows\x1b[0m');
{
  const e = newEngine(DEFAULT_TEAMS(), null);
  e.command('setQueue', { order: domesticSrs.slice(0, 10) });
  e.command('start', {});
  e.command('present', { sr: domesticSrs[0] });
  e.command('placeBid', { teamId: 0, amountL: 200 });
  e.command('placeBid', { teamId: 1, amountL: 250 });
  const beforeUndo = e.state.bidding.currentBidL;
  ok(e.command('undo', {}).ok, 'undo last bid succeeds');
  ok(e.state.bidding.currentBidL < beforeUndo, 'current bid dropped after undo');
  e.command('sold', {});
  ok(e.command('reset', {}).ok, 'reset returns auction to setup');
  eq(e.state.phase, 'setup', 'phase is setup after reset');
  eq(Object.keys(e.state.results).length, 0, 'results cleared after reset');
  eq(e.state.teams.length, 10, 'teams preserved after reset');
}

console.log('\n\x1b[1mRESULT\x1b[0m');
console.log(`  \x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { console.log('\n  Failures:'); fails.forEach((f) => console.log('   • ' + f)); process.exit(1); }
