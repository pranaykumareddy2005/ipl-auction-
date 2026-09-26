'use strict';
/* LIVE "1-hour break" scenario against real Supabase.
   Proves: pause mid-player → EVERYONE leaves (server killed, simulating admin +
   all teams closing devices) → restart → paused state + on-block player + bids +
   every team's join all survive → teams rejoin with the SAME passcode → resume →
   auction continues and sells. Deletes the throwaway room afterwards. */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PROJ = path.join(__dirname, '..');
const PORT = 4602;
process.loadEnvFile(PROJ + '/.env');
const { Pool } = require(PROJ + '/node_modules/pg');
const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _ip = 0; const nextIp = () => '10.7.' + ((_ip >> 8) & 255) + '.' + ((++_ip) & 255);
let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; console.log('   ✓ ' + m); } else { FAIL++; fails.push(m); console.log('   ✗ ' + m); } };

function req(method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
    for (const k of Object.keys(h)) if (h[k] == null) delete h[k];
    if (data) h['Content-Length'] = data.length;
    const r = http.request(BASE + p, { method, headers: h, agent }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    if (data) r.write(data); r.end();
  });
}
async function waitHealth(timeoutMs = 25000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const h = await req('GET', '/healthz'); if (h.status === 200 && h.json && h.json.ok) return true; await sleep(400); }
  return false;
}
function boot() {
  const srv = spawn(process.execPath, ['server.js'], { cwd: PROJ, env: { ...process.env, PORT: String(PORT), TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  return srv;
}
const TEAMS = [['CSK','CSK','#f9cd05'],['MI','MI','#1f6bd6'],['RCB','RCB','#e2231a'],['KKR','KKR','#7b3fbf'],['RR','RR','#e8388b'],['DC','DC','#2561c2'],['SRH','SRH','#f26522'],['GT','GT','#1eb2c4'],['PBKS','PBKS','#d71920'],['LSG','LSG','#00a19a']];

(async () => {
  console.log('Booting REAL server against Supabase…');
  let srv = boot();
  ok(await waitHealth(), 'server up & connected to Supabase');

  console.log('\nBefore the break — set up, sell 2 players, then present a 3rd and bid on it');
  const c = await req('POST', '/api/rooms', { body: { name: 'BREAK TEST — auto delete' } });
  const code = c.json.code, key = c.json.hostKey; const H = { 'x-op-key': key };
  ok(!!code, 'created throwaway room ' + code);
  const teams = TEAMS.map((t, i) => ({ id: i, name: t[0], short: t[1], color: t[2], purseL: 12000 }));
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'setTeams', payload: { teams } } });
  const srs = (await req('GET', '/api/players')).json.players.slice(0, 20).map((p) => p.sr);
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'setQueue', payload: { order: srs } } });
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'start' } });

  // Every team joins with its passcode (simulating all reps on their phones).
  const auth = await req('GET', `/api/room/${code}/teams-auth`, { headers: H });
  const pins = {}; auth.json.teams.forEach((t) => (pins[t.teamId] = t.pin));
  const tokens = {};
  for (let i = 0; i < 10; i++) { const j = await req('POST', `/api/room/${code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: i, pin: pins[i] } }); tokens[i] = j.json && j.json.token; }
  ok(Object.values(tokens).every(Boolean), 'all 10 teams joined with passcode');

  // Sell 2 players so there is real progress to preserve.
  for (let k = 0; k < 2; k++) {
    await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'present', payload: { sr: srs[k] } } });
    await req('POST', `/api/room/${code}/team/bid`, { headers: { 'x-team-token': tokens[k] }, body: { amountL: 300, expectedSr: srs[k] } });
    await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'sold' } });
  }
  // Present a 3rd player and put a live bid on it — this is what's "on the block" when the break hits.
  const blockSr = srs[2];
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'present', payload: { sr: blockSr } } });
  await req('POST', `/api/room/${code}/team/bid`, { headers: { 'x-team-token': tokens[5] }, body: { amountL: 250, expectedSr: blockSr } });
  const before = (await req('GET', `/api/room/${code}/state`)).json;
  ok(before.bidding && before.bidding.sr === blockSr && before.bidding.leadingTeamId === 5, 'player on the block with a leading bid (team 5 @ ₹250 L)');

  console.log('\n⏸  ADMIN PAUSES for the 1-hour break');
  const pz = await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'pause' } });
  ok(pz.status === 200, 'pause accepted');
  const paused = (await req('GET', `/api/room/${code}/state`)).json;
  ok(paused.phase === 'paused', 'phase is now "paused"');
  // While paused, bids must be rejected — no one can sneak a bid during the break.
  const sneak = await req('POST', `/api/room/${code}/team/bid`, { headers: { 'x-team-token': tokens[6] }, body: { amountL: 500, expectedSr: blockSr } });
  ok(sneak.status === 409, 'a bid during the break is rejected (auction not live)');
  await sleep(1500); // flush writes to Supabase

  console.log('\n🚪 EVERYONE LEAVES — admin closes laptop, all reps close phones (server killed)');
  try { srv.kill('SIGTERM'); } catch (e) {}
  await sleep(2500);

  console.log('\n🔁 ONE HOUR LATER — server comes back, state rebuilt from Supabase');
  srv = boot();
  ok(await waitHealth(), 'server restarted & reconnected to Supabase');
  const after = (await req('GET', `/api/room/${code}/state`)).json;
  ok(after.phase === 'paused', 'still PAUSED after the break (not lost, not reset)');
  ok(after.counts.sold === 2, 'both pre-break sales preserved (sold=2)');
  ok(after.bidding && after.bidding.sr === blockSr, 'the player on the block is still on the block');
  ok(after.bidding && after.bidding.leadingTeamId === 5 && after.bidding.currentBidL === 250, 'the live bid on that player survived (team 5 @ ₹250 L)');
  // Purse math for a team that bought before the break.
  const t0 = after.teams.find((t) => t.teamId === 0);
  ok(t0 && t0.spent === 300 && t0.count === 1, 'a buyer\'s purse/squad preserved (team 0: 1 player, ₹300 L spent)');

  console.log('\n👥 Teams rejoin after the break with the SAME passcode (from any device)');
  let rejoined = 0;
  for (let i = 0; i < 10; i++) { const j = await req('POST', `/api/room/${code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: i, pin: pins[i] } }); if (j.json && j.json.token) { tokens[i] = j.json.token; rejoined++; } }
  ok(rejoined === 10, 'all 10 teams rejoined with their original passcode');

  console.log('\n▶️  ADMIN RESUMES — auction continues from the exact same spot');
  const rz = await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'resume' } });
  ok(rz.status === 200, 'resume accepted');
  const live = (await req('GET', `/api/room/${code}/state`)).json;
  ok(live.phase === 'live', 'phase is "live" again');
  // A team can now outbid on the same player and win it.
  const bid = await req('POST', `/api/room/${code}/team/bid`, { headers: { 'x-team-token': tokens[7] }, body: { amountL: 300, expectedSr: blockSr } });
  ok(bid.status === 200, 'bidding works again after resume');
  const sold = await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'sold' } });
  ok(sold.status === 200, 'the on-block player sells after the break');
  const fin = (await req('GET', `/api/room/${code}/state`)).json;
  ok(fin.counts.sold === 3, 'now 3 players sold — auction continued seamlessly');

  console.log('\nCleanup — deleting throwaway room from Supabase');
  const pool = new Pool({ host: process.env.PGHOST, port: Number(process.env.PGPORT) || 5432, database: process.env.PGDATABASE || 'postgres', user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query('delete from rooms where code=$1', [code]);
    const chk = await pool.query('select count(*)::int n from events where room_code=$1', [code]);
    ok(chk.rows[0].n === 0, 'room + all events/claims/passcodes removed (DB left clean)');
  } catch (e) { ok(false, 'cleanup failed: ' + e.message); }
  await pool.end();
  try { srv.kill('SIGTERM'); } catch (e) {}

  console.log(`\nBREAK-SCENARIO RESULT: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) fails.forEach((f) => console.log('  - ' + f));
  await sleep(500);
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.error('BREAK TEST CRASH', e); process.exit(2); });
