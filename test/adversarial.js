'use strict';
/* Adversarial + concurrency suite against the REAL server.js (in-memory DB stub).
   Security (prototype pollution, forged/cross-room tokens, injection-shaped codes,
   oversized/malformed bodies, auth) + races (session takeover, sell-vs-bid). */
const http = require('http');
const harness = require('./harness');

const PORT = 4600;
process.env.PORT = String(PORT);
process.env.PGPASSWORD = 'stub';
process.env.TRUST_PROXY = '1';
harness.inject();
const _log = console.log; console.log = () => {};
require('../server.js');
console.log = _log;

const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const BASE = `http://127.0.0.1:${PORT}`;
let _ip = 0; const nextIp = () => '10.5.' + ((_ip >> 8) & 255) + '.' + ((++_ip) & 255);
let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; } else { FAIL++; fails.push(m); console.log('   \x1b[31m✗ ' + m + '\x1b[0m'); } };

function req(method, path, { headers = {}, body = null, rawBody = null } = {}) {
  return new Promise((resolve) => {
    const data = rawBody != null ? Buffer.from(rawBody) : (body == null ? null : Buffer.from(JSON.stringify(body)));
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
    for (const k of Object.keys(h)) if (h[k] == null) delete h[k];
    if (data) h['Content-Length'] = data.length;
    const r = http.request(BASE + path, { method, headers: h, agent }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth(timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const h = await req('GET', '/healthz'); if (h.status === 200 && h.json && h.json.ok) return true; await sleep(200); }
  return false;
}
const TEAMS = Array.from({ length: 10 }, (_, i) => ({ id: i, name: 'Team' + i, short: 'T' + i, color: '#0af', purseL: 12000 }));

async function makeRoom(name) {
  const c = await req('POST', '/api/rooms', { headers: { 'x-forwarded-for': nextIp() }, body: { name } });
  const code = c.json.code, key = c.json.hostKey, H = { 'x-op-key': key };
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'setTeams', payload: { teams: TEAMS } } });
  const srs = (await req('GET', '/api/players')).json.players.slice(0, 20).map((p) => p.sr);
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'setQueue', payload: { order: srs } } });
  await req('POST', `/api/room/${code}/command`, { headers: H, body: { name: 'start' } });
  const auth = await req('GET', `/api/room/${code}/teams-auth`, { headers: H });
  const pins = {}; auth.json.teams.forEach((t) => (pins[t.teamId] = t.pin));
  return { code, key, H, srs, pins };
}

(async () => {
  await waitHealth(); // don't fire the first request before the server is listening
  console.log('\n\x1b[1m1 · Prototype pollution is neutralized\x1b[0m');
  {
    const r = await req('POST', '/api/rooms', { headers: { 'x-forwarded-for': nextIp() }, rawBody: '{"name":"x","__proto__":{"pwned":1},"constructor":{"prototype":{"pwned2":1}}}' });
    ok(r.status === 200, 'request with __proto__ payload still handled');
    ok(({}).pwned === undefined && ({}).pwned2 === undefined, 'Object.prototype NOT polluted');
  }

  console.log('\n\x1b[1m2 · Malformed / oversized / injection-shaped input\x1b[0m');
  {
    const bad = await req('POST', '/api/rooms', { headers: { 'x-forwarded-for': nextIp() }, rawBody: '{not valid json' });
    ok(bad.status === 200 || bad.status === 400, 'malformed JSON does not crash server (' + bad.status + ')');
    const huge = await req('POST', '/api/rooms', { headers: { 'x-forwarded-for': nextIp() }, rawBody: JSON.stringify({ name: 'A'.repeat(2_000_000) }) });
    ok(huge.status === 413 || huge.status === 200, 'oversized body handled (' + huge.status + ')');
    const inj = await req('GET', "/api/room/ROBERT');DROP TABLE rooms;--/state");
    ok(inj.status === 404, 'injection-shaped room code → 404, no route match');
    const missing = await req('GET', '/api/room/ZZZZZZ/state');
    ok(missing.status === 404, 'unknown room → 404');
    const h = await req('GET', '/healthz');
    ok(h.status === 200 && h.json.ok, 'server still healthy after hostile inputs');
  }

  console.log('\n\x1b[1m3 · Auth: host key + team token cannot be forged\x1b[0m');
  const A = await makeRoom('room A');
  {
    const noKey = await req('POST', `/api/room/${A.code}/command`, { body: { name: 'pause' } });
    ok(noKey.status === 401, 'command without host key → 401');
    const wrongKey = await req('POST', `/api/room/${A.code}/command`, { headers: { 'x-op-key': 'not-the-key' }, body: { name: 'pause' } });
    ok(wrongKey.status === 401, 'command with wrong host key → 401');
    const teamsAuthNoKey = await req('GET', `/api/room/${A.code}/teams-auth`);
    ok(teamsAuthNoKey.status === 401, 'reading passcodes without host key → 401');

    await req('POST', `/api/room/${A.code}/command`, { headers: A.H, body: { name: 'present', payload: { sr: A.srs[0] } } });
    const garbage = await req('POST', `/api/room/${A.code}/team/bid`, { headers: { 'x-team-token': 'garbage' }, body: {} });
    ok(garbage.status === 401, 'bid with garbage token → 401');
    const noDot = await req('POST', `/api/room/${A.code}/team/bid`, { headers: { 'x-team-token': '5' }, body: {} });
    ok(noDot.status === 401, 'bid with malformed token → 401');
    const forged = await req('POST', `/api/room/${A.code}/team/bid`, { headers: { 'x-team-token': '5.' + 'a'.repeat(40) }, body: {} });
    ok(forged.status === 401, 'bid with forged signature → 401');
  }

  console.log('\n\x1b[1m4 · Cross-room token is worthless in another room\x1b[0m');
  {
    const jr = await req('POST', `/api/room/${A.code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: 3, pin: A.pins[3] } });
    const tokenA = jr.json.token; ok(!!tokenA, 'joined team 3 in room A');
    const B = await makeRoom('room B');
    await req('POST', `/api/room/${B.code}/command`, { headers: B.H, body: { name: 'present', payload: { sr: B.srs[0] } } });
    const cross = await req('POST', `/api/room/${B.code}/team/bid`, { headers: { 'x-team-token': tokenA }, body: {} });
    ok(cross.status === 401, 'room A token rejected by room B (secrets differ)');
  }

  console.log('\n\x1b[1m5 · Wrong passcode + rate limiting\x1b[0m');
  {
    const wrong = await req('POST', `/api/room/${A.code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: 4, pin: '0000' } });
    ok(wrong.status === 401 || (wrong.json && !wrong.json.ok), 'wrong passcode rejected');
    const ip = nextIp(); let throttled = false;
    for (let i = 0; i < 40; i++) { const r = await req('POST', `/api/room/${A.code}/team/join`, { headers: { 'x-forwarded-for': ip }, body: { teamId: 4, pin: '9999' } }); if (r.status === 429) { throttled = true; break; } }
    ok(throttled, 'repeated wrong-passcode attempts get rate-limited (429)');
  }

  console.log('\n\x1b[1m6 · Regen passcode + release invalidate the live token\x1b[0m');
  {
    const jr = await req('POST', `/api/room/${A.code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: 6, pin: A.pins[6] } });
    const tok = jr.json.token;
    await req('POST', `/api/room/${A.code}/command`, { headers: A.H, body: { name: 'present', payload: { sr: A.srs[1] } } });
    const before = await req('POST', `/api/room/${A.code}/team/bid`, { headers: { 'x-team-token': tok }, body: {} });
    ok(before.status === 200, 'token bids fine before regen');
    await req('POST', `/api/room/${A.code}/team/regen-pin`, { headers: A.H, body: { teamId: 6 } });
    const after = await req('POST', `/api/room/${A.code}/team/bid`, { headers: { 'x-team-token': tok }, body: {} });
    ok(after.status === 401, 'old token is dead after passcode regeneration');

    const jr2 = await req('POST', `/api/room/${A.code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: 7, pin: A.pins[7] } });
    await req('POST', `/api/room/${A.code}/command`, { headers: A.H, body: { name: 'team/release' } }).catch(() => {});
    await req('POST', `/api/room/${A.code}/team/release`, { headers: A.H, body: { teamId: 7 } });
    const afterRel = await req('POST', `/api/room/${A.code}/team/bid`, { headers: { 'x-team-token': jr2.json.token }, body: {} });
    ok(afterRel.status === 401, 'released team\'s token is dead');
  }

  console.log('\n\x1b[1m7 · Race — 40 simultaneous joins of the SAME team (session takeover)\x1b[0m');
  {
    const C = await makeRoom('race room');
    await req('POST', `/api/room/${C.code}/command`, { headers: C.H, body: { name: 'present', payload: { sr: C.srs[0] } } });
    const results = await Promise.all(Array.from({ length: 40 }, () =>
      req('POST', `/api/room/${C.code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: 2, pin: C.pins[2] } })));
    const tokens = results.map((r) => r.json && r.json.token).filter(Boolean);
    ok(tokens.length === 40, 'every concurrent join returned a token (40)');
    // Only ONE session may be live at the end (latest nonce wins).
    let valid = 0;
    for (const t of tokens) { const b = await req('POST', `/api/room/${C.code}/team/bid`, { headers: { 'x-team-token': t }, body: { amountL: 200 } }); if (b.status === 200) valid++; }
    ok(valid <= 1, `at most one token stays valid after the storm (got ${valid})`);
    const h = await req('GET', '/healthz'); ok(h.status === 200, 'server healthy after join storm');
  }

  console.log('\n\x1b[1m8 · Race — sell while bids are still flooding in\x1b[0m');
  {
    const D = await makeRoom('sell race');
    const toks = {};
    for (let i = 0; i < 10; i++) { const j = await req('POST', `/api/room/${D.code}/team/join`, { headers: { 'x-forwarded-for': nextIp() }, body: { teamId: i, pin: D.pins[i] } }); toks[i] = j.json.token; }
    const sr = D.srs[0];
    await req('POST', `/api/room/${D.code}/command`, { headers: D.H, body: { name: 'present', payload: { sr } } });
    // Fire 300 bids and, midway, the operator hammers SOLD a few times.
    const bids = Array.from({ length: 300 }, (_, k) => () => req('POST', `/api/room/${D.code}/team/bid`, { headers: { 'x-team-token': toks[k % 10] }, body: { expectedSr: sr } }));
    const sells = Array.from({ length: 5 }, () => () => req('POST', `/api/room/${D.code}/command`, { headers: D.H, body: { name: 'sold' } }));
    // interleave
    const all = []; let bi = 0, si = 0;
    for (let k = 0; k < bids.length + sells.length; k++) {
      if (k % 60 === 59 && si < sells.length) all.push(sells[si++]()); else if (bi < bids.length) all.push(bids[bi++]());
    }
    while (si < sells.length) all.push(sells[si++]());
    await Promise.all(all);
    await sleep(200);
    const st = (await req('GET', `/api/room/${D.code}/state`)).json;
    // Exactly one sold result for sr, owned by one team, purse consistent.
    const rep = (await req('GET', `/api/room/${D.code}/report`)).json;
    const soldThis = rep.sold.filter((x) => x.sr === sr);
    ok(soldThis.length === 1, 'player sold exactly once despite concurrent SOLD spam');
    let anyNeg = false; for (const t of rep.teams) if (t.remaining < 0) anyNeg = true;
    ok(!anyNeg, 'no team purse went negative in the sell/bid race');
    const owner = soldThis[0] && rep.teams.find((t) => t.id === soldThis[0].teamId);
    ok(owner && owner.spent === soldThis[0].priceL || owner.spent >= soldThis[0].priceL, 'winner purse debited consistently');
    const h = await req('GET', '/healthz'); ok(h.status === 200 && h.json.ok, 'server healthy after sell/bid race');
  }

  console.log('\n\x1b[1mRESULT\x1b[0m');
  console.log(`  \x1b[1m${PASS} passed, ${FAIL} failed\x1b[0m`);
  if (FAIL) { console.log('\n  Failures:'); fails.forEach((f) => console.log('   • ' + f)); }
  await sleep(300);
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.error('ADVERSARIAL CRASH', e); process.exit(2); });
