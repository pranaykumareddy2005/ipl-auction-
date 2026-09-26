'use strict';
/* End-to-end load / stress / correctness / auth suite against the REAL server.js,
   backed by the in-memory DB stub (no external Postgres, no data pollution). */
const http = require('http');
const harness = require('./harness');

const PORT = 4599;
process.env.PORT = String(PORT);
process.env.PGPASSWORD = 'stub';
process.env.TRUST_PROXY = '1'; // so we can simulate distinct captain IPs (real captains aren't all one IP)
harness.inject();
let _ipc = 0;
function nextIp() { _ipc++; return '10.' + ((_ipc >> 16) & 255) + '.' + ((_ipc >> 8) & 255) + '.' + (_ipc & 255); }
// silence the server's boot chatter for clean test output
const _log = console.log; console.log = () => {};
require('../server.js');
console.log = _log;

const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });
// Run `total` tasks with at most `concurrency` in flight (avoids one machine trying to
// open thousands of localhost sockets at once — a client/OS limit, not a server one).
async function runPool(total, concurrency, taskFn) {
  let next = 0; const results = [];
  async function worker() { while (next < total) { const k = next++; results[k] = await taskFn(k); } }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
    for (const k of Object.keys(h)) if (h[k] == null) delete h[k]; // drop undefined headers
    if (data) h['Content-Length'] = data.length;
    const r = http.request(BASE + path, { method, headers: h, agent }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, json: null, err: e.message }));
    if (data) r.write(data); r.end();
  });
}
// SSE listener that counts frames + records latest snapshot
function sse(path) {
  const o = { messages: 0, last: null, req: null, closed: false };
  o.req = http.get(BASE + path, { agent }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (line) { o.messages++; try { o.last = JSON.parse(line.slice(5).trim()); } catch (e) {} }
      }
    });
  });
  o.req.on('error', () => {});
  o.close = () => { if (!o.closed) { o.closed = true; try { o.req.destroy(); } catch (e) {} } };
  return o;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pct(arr, p) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }
function stats(arr) { const avg = arr.reduce((a, b) => a + b, 0) / (arr.length || 1); return { n: arr.length, avg: +avg.toFixed(3), p50: +pct(arr, 50).toFixed(3), p95: +pct(arr, 95).toFixed(3), p99: +pct(arr, 99).toFixed(3), max: +Math.max(0, ...arr).toFixed(3) }; }

let PASS = 0, FAIL = 0; const fails = [];
function ok(cond, msg) { if (cond) { PASS++; console.log('   \x1b[32m✓\x1b[0m ' + msg); } else { FAIL++; fails.push(msg); console.log('   \x1b[31m✗ ' + msg + '\x1b[0m'); } }
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

const TEAMS = [
  ['CSK','CSK','#f9cd05'],['MI','MI','#1f6bd6'],['RCB','RCB','#e2231a'],['KKR','KKR','#7b3fbf'],['RR','RR','#e8388b'],
  ['DC','DC','#2561c2'],['SRH','SRH','#f26522'],['GT','GT','#1eb2c4'],['PBKS','PBKS','#d71920'],['LSG','LSG','#00a19a'],
];

async function newRoom(nTeams = 10) {
  const c = await req('POST', '/api/rooms', { body: { name: 'Test Room' } });
  const code = c.json.code, key = c.json.hostKey;
  const H = { 'x-op-key': key };
  const teams = TEAMS.slice(0, nTeams).map((t, i) => ({ id: i, name: t[0], short: t[1], color: t[2], purseL: 100000000 }));
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'setTeams', payload: { teams } } });
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'configure', payload: { purseL: 100000000, squadMax: 99, overseasMax: 99, timerSec: 20 } } });
  const players = (await req('GET', '/api/players')).json.players.slice(0, 60).map((p) => p.sr);
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'setQueue', payload: { order: players } } });
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'start' } });
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'present', payload: { sr: players[0] } } });
  const auth = await req('GET', `/api/room/${code}/teams-auth`, { headers: H });
  const pins = {}; auth.json.teams.forEach((t) => (pins[t.teamId] = t.pin));
  const tokens = {};
  for (let i = 0; i < nTeams; i++) { const j = await req('POST', `/api/room/${code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: i, pin: pins[i] } }); tokens[i] = j.json && j.json.token; }
  return { code, key, pins, tokens, sr: players[0], nTeams };
}

(async () => {
  await sleep(300); // let server bind
  const health = await req('GET', '/healthz');
  ok(health.status === 200 && health.json.ok, 'server boots & /healthz ok');

  // ---------------- 1. SETUP + AUTH + PRESENCE ----------------
  head('1 · Setup, passcode auth & presence');
  const R = await newRoom(10);
  ok(!!R.code, 'room created, teams saved, auction started');
  ok(Object.values(R.pins).every((p) => /^\d{4}$/.test(p)), 'all 10 teams got 4-digit passcodes');
  ok(Object.values(R.tokens).every(Boolean), 'all 10 teams joined with passcode → tokens issued');
  const wrong = await req('POST', `/api/room/${R.code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: 0, pin: '0000' === R.pins[0] ? '1111' : '0000' } });
  ok(wrong.status === 401, 'wrong passcode rejected (401)');
  // open streams: 10 teams + operator + screen
  const streams = [];
  for (let i = 0; i < 10; i++) streams.push(sse(`/api/room/${R.code}/stream?role=team&team=${i}&token=${encodeURIComponent(R.tokens[i])}`));
  const opStream = sse(`/api/room/${R.code}/stream?role=operator&key=${encodeURIComponent(R.key)}`);
  const scr = sse(`/api/room/${R.code}/stream?role=screen`);
  await sleep(400);
  const pres = scr.last && scr.last.presence;
  ok(pres && pres.teams.length === 10, `presence shows all 10 teams online (got ${pres ? pres.teams.length : 'none'})`);
  ok(pres && pres.operators >= 1, 'presence shows operator online');

  // ---------------- 2. REJOIN FROM NEW DEVICE ----------------
  head('2 · Rejoin from another device (session takeover)');
  const oldTok = R.tokens[3];
  const rejoin = await req('POST', `/api/room/${R.code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: 3, pin: R.pins[3] } });
  ok(rejoin.status === 200 && rejoin.json.token && rejoin.json.token !== oldTok, 'rejoin issues a fresh token');
  ok(rejoin.json.rejoined === true, 'server flags it as a rejoin');
  const oldBid = await req('POST', `/api/room/${R.code}/team/bid`, { headers: { 'x-team-token': oldTok }, body: {} });
  ok(oldBid.status === 401, 'old device token is now invalid (401)');
  R.tokens[3] = rejoin.json.token;
  const newBid = await req('POST', `/api/room/${R.code}/team/bid`, { headers: { 'x-team-token': R.tokens[3] }, body: {} });
  ok(newBid.status === 200, 'new device can bid immediately (continues the auction)');

  // ---------------- 3. SUSTAINED LOAD (mash war) ----------------
  head('3 · Sustained load — 10 teams mashing bids');
  const monitor = sse(`/api/room/${R.code}/stream?role=screen`);
  await sleep(50);
  const lat = []; let accepted = 0, rejected = 0, errors = 0;
  const DURATION = 3000; const end = Date.now() + DURATION;
  async function teamLoop(i) {
    while (Date.now() < end) {
      const t0 = process.hrtime.bigint();
      const r = await req('POST', `/api/room/${R.code}/team/bid`, { headers: { 'x-team-token': R.tokens[i] }, body: { expectedSr: R.sr } });
      lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (r.status === 200) accepted++; else if (r.status === 409 || r.status === 401) rejected++; else errors++;
    }
  }
  const mStart = monitor.messages;
  await Promise.all(Array.from({ length: 10 }, (_, i) => teamLoop(i)));
  await sleep(150);
  const msgs = monitor.messages - mStart;
  const total = accepted + rejected + errors;
  const S = stats(lat);
  console.log(`   requests: ${total} in ${DURATION}ms  → ${Math.round(total / (DURATION/1000))}/s`);
  console.log(`   accepted bids: ${accepted}  |  rejected (self-lead/etc): ${rejected}  |  hard errors: ${errors}`);
  console.log(`   bid ack latency ms → avg ${S.avg}  p50 ${S.p50}  p95 ${S.p95}  p99 ${S.p99}  max ${S.max}`);
  console.log(`   SSE frames to a screen during window: ${msgs} (~${Math.round(msgs/(DURATION/1000))}/s — coalesced)`);
  ok(errors === 0, 'zero hard errors under sustained load');
  ok(accepted > 100, `plenty of bids accepted (${accepted})`);
  ok(S.p99 < 50, `p99 bid ack under 50ms (got ${S.p99}ms)`);
  ok(msgs / (DURATION/1000) < 60, `broadcast coalesced well under bid rate (${Math.round(msgs/(DURATION/1000))}/s)`);
  const cur = monitor.last && monitor.last.bidding && monitor.last.bidding.currentBidL;
  ok(cur > 0, `bid price climbed to ₹${cur} L during the war`);

  // ---------------- 4. BURST STRESS ----------------
  head('4 · Burst stress — 8000 bids, 200 concurrent in flight');
  const R2 = await newRoom(10);
  const NB = 8000, CONC = 200;
  const bl = []; const t0 = Date.now();
  const burst = await runPool(NB, CONC, async (k) => {
    const s = process.hrtime.bigint();
    const r = await req('POST', `/api/room/${R2.code}/team/bid`, { headers: { 'x-team-token': R2.tokens[k % 10] }, body: { expectedSr: R2.sr } });
    bl.push(Number(process.hrtime.bigint() - s) / 1e6);
    return r;
  });
  const burstMs = Date.now() - t0;
  const b200 = burst.filter((x) => x.status === 200).length;
  const b5xx = burst.filter((x) => x.status >= 500).length;
  const bDrop = burst.filter((x) => x.status === 0).length;
  const BS = stats(bl);
  console.log(`   ${NB} bids @ ${CONC} concurrent in ${burstMs}ms → ${Math.round(NB / (burstMs/1000))}/s`);
  console.log(`   accepted ${b200} · server 5xx ${b5xx} · socket drops ${bDrop} · latency p95 ${BS.p95}ms p99 ${BS.p99}ms max ${BS.max}ms`);
  ok(b5xx === 0, 'zero server 5xx errors under heavy burst');
  ok(bDrop === 0, 'zero dropped connections under bounded concurrency');
  ok(Math.round(NB / (burstMs/1000)) > 1000, `sustained >1000 bids/s (got ${Math.round(NB / (burstMs/1000))}/s)`);
  const h2 = await req('GET', '/healthz');
  ok(h2.status === 200, 'server still healthy after burst');

  // ---------------- 5. MULTI-ROOM CONCURRENCY ----------------
  head('5 · Multi-room — 5 rooms bidding in parallel');
  const mrooms = await Promise.all(Array.from({ length: 5 }, () => newRoom(6)));
  const mlat = []; let mErr = 0;
  const mEnd = Date.now() + 2000;
  async function mLoop(room, i) { while (Date.now() < mEnd) { const t = process.hrtime.bigint(); const r = await req('POST', `/api/room/${room.code}/team/bid`, { headers: { 'x-team-token': room.tokens[i] }, body: { expectedSr: room.sr } }); mlat.push(Number(process.hrtime.bigint() - t) / 1e6); if (r.status === 0 || r.status >= 500) mErr++; } }
  await Promise.all(mrooms.flatMap((room) => Array.from({ length: 6 }, (_, i) => mLoop(room, i))));
  const MS = stats(mlat);
  console.log(`   ${mrooms.length} rooms × 6 teams · ${MS.n} bids · p95 ${MS.p95}ms · p99 ${MS.p99}ms · max ${MS.max}ms`);
  ok(mErr === 0, 'no errors across concurrent rooms');
  ok(MS.p99 < 80, `cross-room p99 under 80ms (got ${MS.p99}ms)`);

  // ---------------- 6. CORRECTNESS INVARIANTS ----------------
  head('6 · Correctness after load (sell → purse/ownership)');
  // sell the contested player in room R, then verify winner + purse math
  const before = (await req('GET', `/api/room/${R.code}/state`)).json;
  const leader = before.bidding.leadingTeamId; const price = before.bidding.currentBidL;
  const sell = await req('POST', `/api/room/${R.code}/command`, { headers: { 'x-op-key': R.key }, body: { name: 'sold' } });
  ok(sell.status === 200, 'operator SOLD accepted');
  const rep = (await req('GET', `/api/room/${R.code}/report`)).json;
  const winner = rep.teams.find((t) => t.id === leader);
  ok(rep.sold.length === 1 && rep.sold[0].teamId === leader, 'player awarded to the last leader (no lost bid)');
  ok(winner && winner.spent === price, `winner purse debited exactly ₹${price} L`);
  ok(rep.teams.every((t) => t.remaining >= 0), 'no team purse went negative under load');
  ok(rep.teams.every((t) => t.remaining === t.base + t.adjust - t.spent), 'purse math consistent for every team');
  // single ownership: the sold player belongs to exactly one team
  const owners = rep.sold.filter((s) => s.sr === before.current.sr);
  ok(owners.length === 1, 'sold player owned by exactly one team');

  // ---------------- 7. PRESENCE TEARDOWN ----------------
  head('7 · Presence updates on disconnect');
  streams[0].close(); streams[1].close();
  await sleep(400);
  const pres2 = scr.last && scr.last.presence;
  ok(pres2 && pres2.teams.length <= 8, `two teams dropped → presence fell to ${pres2 ? pres2.teams.length : '?'}`);

  // cleanup
  [...streams, opStream, scr, monitor].forEach((s) => s.close());
  await sleep(100);

  head('RESULT');
  console.log(`  DB queries executed against stub: ${harness.dbStub._stats().queries}`);
  console.log(`  \x1b[1m${PASS} passed, ${FAIL} failed\x1b[0m`);
  if (FAIL) { console.log('  failed:'); fails.forEach((f) => console.log('   - ' + f)); }
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
