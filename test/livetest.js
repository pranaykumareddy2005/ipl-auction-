'use strict';
/* LIVE test against the real Supabase-backed server in the user's project.
   Boots the actual server.js, runs a realistic mash, verifies persistence + crash
   recovery, then DELETES the throwaway room (cascade) so the DB is left clean. */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PROJ = path.join(__dirname, '..'); // this file lives in <project>/test/
const PORT = 4601;
process.loadEnvFile(PROJ + '/.env');            // load their DB creds for cleanup
const { Pool } = require(PROJ + '/node_modules/pg');

const BASE = `http://127.0.0.1:${PORT}`;
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _ip = 0; const nextIp = () => '10.9.' + ((_ip >> 8) & 255) + '.' + ((++_ip) & 255);
let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; console.log('   ✓ ' + m); } else { FAIL++; fails.push(m); console.log('   ✗ ' + m); } };

function req(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
    for (const k of Object.keys(h)) if (h[k] == null) delete h[k];
    if (data) h['Content-Length'] = data.length;
    const r = http.request(BASE + path, { method, headers: h, agent }, (res) => {
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
  const up = await waitHealth();
  ok(up, 'server booted & connected to Supabase (/healthz ok)');
  if (!up) { try { srv.kill(); } catch (e) {} process.exit(2); }

  console.log('\nLive setup');
  const c = await req('POST', '/api/rooms', { body: { name: 'LOAD TEST — auto delete' } });
  const code = c.json.code, key = c.json.hostKey; const H = { 'x-op-key': key };
  ok(!!code, 'created throwaway room ' + code + ' in Supabase');
  const teams = TEAMS.map((t, i) => ({ id: i, name: t[0], short: t[1], color: t[2], purseL: 100000000 }));
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'setTeams', payload: { teams } } });
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'configure', payload: { purseL: 100000000, squadMax: 99, overseasMax: 99, timerSec: 20 } } });
  const srs = (await req('GET', '/api/players')).json.players.slice(0, 30).map((p) => p.sr);
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'setQueue', payload: { order: srs } } });
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'start' } });
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'present', payload: { sr: srs[0] } } });
  const auth = await req('GET', `/api/room/${code}/teams-auth`, { headers: H });
  const pins = {}; auth.json.teams.forEach((t) => (pins[t.teamId] = t.pin));
  const tokens = {};
  for (let i = 0; i < 10; i++) { const j = await req('POST', `/api/room/${code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: i, pin: pins[i] } }); tokens[i] = j.json && j.json.token; }
  ok(Object.values(tokens).every(Boolean), 'all 10 teams joined with passcode against real DB');

  console.log('\nLive mash (realistic pace) + latency vs real Supabase');
  const lat = []; let accepted = 0, errors = 0;
  const NB = 120; // modest, realistic volume against a production DB
  for (let k = 0; k < NB; k++) {
    const i = k % 10; const t0 = process.hrtime.bigint();
    const r = await req('POST', `/api/room/${code}/team/bid`, { headers: { 'x-team-token': tokens[i] }, body: { expectedSr: srs[0] } });
    lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (r.status === 200) accepted++; else if (r.status >= 500 || r.status === 0) errors++;
  }
  lat.sort((a, b) => a - b);
  const p = (q) => +lat[Math.min(lat.length - 1, Math.floor(q / 100 * lat.length))].toFixed(2);
  console.log(`   ${NB} bids · accepted ${accepted} · errors ${errors}`);
  console.log(`   bid ack latency vs real Supabase → p50 ${p(50)}ms  p95 ${p(95)}ms  p99 ${p(99)}ms  (instant-ack: DB write is in the background)`);
  ok(errors === 0, 'no server errors bidding against real DB');
  ok(p(95) < 100, `p95 bid ack under 100ms even with remote DB (got ${p(95)}ms)`);

  const st = (await req('GET', `/api/room/${code}/state`)).json;
  const leader = st.bidding.leadingTeamId, price = st.bidding.currentBidL;
  const sell = await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'sold' } });
  ok(sell.status === 200, 'operator SOLD committed durably');
  await sleep(1500); // let background writes flush to Supabase

  console.log('\nCrash recovery — kill server, restart, verify state restored from Supabase');
  try { srv.kill('SIGTERM'); } catch (e) {}
  await sleep(2500);
  srv = boot();
  const up2 = await waitHealth();
  ok(up2, 'server restarted & reconnected');
  const rep = (await req('GET', `/api/room/${code}/report`)).json;
  ok(rep && rep.sold && rep.sold.length === 1, 'the SOLD player survived the restart (replayed from Supabase)');
  ok(rep && rep.sold[0].teamId === leader && rep.sold[0].priceL === price, `restored sale matches: team ${leader} @ ₹${price} L`);
  const win = rep.teams.find((t) => t.id === leader);
  ok(win && win.spent === price && win.remaining >= 0, 'restored purse math correct after recovery');

  console.log('\nCleanup — deleting throwaway room from Supabase');
  const pool = new Pool({ host: process.env.PGHOST, port: Number(process.env.PGPORT) || 5432, database: process.env.PGDATABASE || 'postgres', user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query('delete from rooms where code=$1', [code]); // cascades: events, claims, team_auth
    const chk = await pool.query('select count(*)::int n from events where room_code=$1', [code]);
    ok(chk.rows[0].n === 0, 'room + all its events/claims/passcodes removed (DB left clean)');
  } catch (e) { ok(false, 'cleanup delete failed: ' + e.message); }
  await pool.end();
  try { srv.kill('SIGTERM'); } catch (e) {}

  console.log(`\nLIVE RESULT: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) fails.forEach((f) => console.log('  - ' + f));
  await sleep(500);
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.error('LIVE TEST CRASH', e); process.exit(2); });
