'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { EventStore } = require('./lib/store');
const players = require('./lib/players');
const { AuctionEngine } = require('./lib/engine');
const { TeamAccess } = require('./lib/access');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT || 3000;
const OP_KEY = process.env.AUCTION_OP_KEY || 'ipl2026';

// --- boot: load master + engine (replays event log for crash recovery) ---
const master = players.load(DATA_DIR, ROOT);
const store = new EventStore(path.join(DATA_DIR, 'events.log'));
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });
const engine = new AuctionEngine({ store, players: master, photosDir: PHOTOS_DIR });
const access = new TeamAccess(path.join(DATA_DIR, 'access.json'));
console.log(`[boot] players: ${master.list.length} | events replayed: ${engine.events.length} | phase: ${engine.state.phase}`);

// --- SSE clients ---
const clients = new Set();
function broadcast(snap) {
  const payload = `data: ${JSON.stringify(snap)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch (e) { /* noop */ } }
}
engine.subscribe(broadcast);
// Heartbeat keeps SSE connections alive and pushes the ticking timer.
setInterval(() => { if (clients.size) broadcast(engine.snapshot()); }, 1000).unref();

// --- helpers ---
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
// Constant-time comparison of the operator key (avoids timing side-channels).
function keyOk(provided) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(OP_KEY);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}
// Drop dangerous keys so a JSON body can never pollute Object.prototype downstream.
function safeReviver(key, val) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return val;
}
// A resolved file must sit strictly inside the allowed directory (separator boundary).
function within(dir, file) { return file === dir || file.startsWith(dir + path.sep); }

function readBody(req) {
  return new Promise((resolve) => {
    let data = '', done = false;
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { done = true; try { req.destroy(); } catch (e) {} resolve({ __tooLarge: true }); }
    });
    req.on('end', () => { if (done) return; try { resolve(data ? JSON.parse(data, safeReviver) : {}); } catch (e) { resolve(null); } });
    req.on('error', () => { if (!done) resolve(null); });
  });
}
function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!within(PUBLIC_DIR, file)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// In-memory brute-force throttle for team-PIN logins, keyed by client IP.
// PINs are short, so cap attempts to make guessing impractical.
const loginHits = new Map();
function loginThrottled(ip) {
  const now = Date.now();
  let e = loginHits.get(ip);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + 60000 }; loginHits.set(ip, e); }
  if (loginHits.size > 5000) loginHits.clear(); // bound memory
  e.count += 1;
  return e.count > 12; // more than 12 attempts/minute from one IP → block
}

// --- router ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // Baseline hardening headers on every response (safe with inline scripts).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Player photos
  if (req.method === 'GET' && p.startsWith('/photos/')) {
    const name = path.basename(p.split('?')[0]);
    const file = path.join(PHOTOS_DIR, name);
    if (!within(PHOTOS_DIR, file)) { res.writeHead(403); return res.end('forbidden'); }
    const ext = path.extname(file).toLowerCase();
    const ctype = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('no photo'); }
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=31536000' });
      res.end(buf);
    });
  }

  // Static assets
  if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

  // SSE state stream
  if (req.method === 'GET' && p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'GET' && p === '/api/state') return sendJSON(res, 200, engine.snapshot());
  if (req.method === 'GET' && p === '/api/players') return sendJSON(res, 200, { players: master.list, cats: master.cats, stars: master.stars });
  if (req.method === 'GET' && p === '/api/history') {
    const lim = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
    return sendJSON(res, 200, { events: engine.history(lim) });
  }
  if (req.method === 'GET' && p === '/api/pool') return sendJSON(res, 200, { order: engine.state.pool, held: engine.state.held, skipped: engine.state.skipped });
  if (req.method === 'GET' && p === '/api/config') return sendJSON(res, 200, { totalPlayers: master.list.length, opKeyRequired: true });

  if (req.method === 'GET' && p.startsWith('/api/team/')) {
    const id = Number(p.split('/').pop());
    return sendJSON(res, 200, engine.teamDetail(id));
  }

  if (req.method === 'GET' && p === '/api/report') return sendJSON(res, 200, buildReport());

  // Command endpoint (operator only)
  if (req.method === 'POST' && p === '/api/command') {
    if (!keyOk(req.headers['x-op-key'])) return sendJSON(res, 401, { ok: false, error: 'Invalid operator key' });
    if (Number(req.headers['content-length']) > 1e6) return sendJSON(res, 413, { ok: false, error: 'Request too large' });
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJSON(res, 413, { ok: false, error: 'Request too large' });
    if (!body || !body.name) return sendJSON(res, 400, { ok: false, error: 'Bad request' });
    if (body.name === 'startTimer') { engine.startTimer(); return sendJSON(res, 200, { ok: true }); }
    if (body.name === 'stopTimer') { engine.stopTimer(); return sendJSON(res, 200, { ok: true }); }
    const result = engine.command(body.name, body.payload || {}, { actor: 'operator' });
    return sendJSON(res, result.ok ? 200 : 409, result);
  }

  // --- Team web-bidding: PIN management (operator) + login + bid ---
  // Operator reads/sets the per-team PINs (never exposed without the op key).
  if (req.method === 'GET' && p === '/api/team-codes') {
    if (!keyOk(req.headers['x-op-key'])) return sendJSON(res, 401, { ok: false, error: 'Invalid operator key' });
    return sendJSON(res, 200, { ok: true, codes: access.getCodes() });
  }
  if (req.method === 'POST' && p === '/api/team-codes') {
    if (!keyOk(req.headers['x-op-key'])) return sendJSON(res, 401, { ok: false, error: 'Invalid operator key' });
    const body = await readBody(req);
    if (!body || typeof body.codes !== 'object' || body.codes === null) return sendJSON(res, 400, { ok: false, error: 'Bad request' });
    access.setCodes(body.codes);
    return sendJSON(res, 200, { ok: true, codes: access.getCodes() });
  }

  // A team rep exchanges {teamId, code} for a bearer token scoped to that team.
  if (req.method === 'POST' && p === '/api/team/login') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (loginThrottled(ip)) return sendJSON(res, 429, { ok: false, error: 'Too many attempts — wait a minute and try again' });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { ok: false, error: 'Bad request' });
    const teamId = Number(body.teamId);
    const team = engine.state.teams.find((t) => t.id === teamId);
    if (!team) return sendJSON(res, 404, { ok: false, error: 'Unknown team' });
    const token = access.login(teamId, body.code);
    if (!token) return sendJSON(res, 401, { ok: false, error: access.hasCode(teamId) ? 'Wrong PIN' : 'No PIN set for this team yet — ask the operator' });
    return sendJSON(res, 200, { ok: true, token, teamId, name: team.name });
  }

  // Place a bid as the authenticated team. Reuses the engine's placeBid validation.
  if (req.method === 'POST' && p === '/api/team/bid') {
    const teamId = access.verify(req.headers['x-team-token']);
    if (teamId == null) return sendJSON(res, 401, { ok: false, error: 'Session expired — enter your team PIN again' });
    if (!engine.state.teams.find((t) => t.id === teamId)) return sendJSON(res, 409, { ok: false, error: 'Team no longer exists' });
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJSON(res, 413, { ok: false, error: 'Request too large' });
    const payload = { teamId };
    if (body && body.amountL != null) payload.amountL = Number(body.amountL);
    if (body && body.expectedSr != null) payload.expectedSr = Number(body.expectedSr);
    const result = engine.command('placeBid', payload, { actor: `team:${teamId}` });
    return sendJSON(res, result.ok ? 200 : 409, result);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

function buildReport() {
  const s = engine.state;
  const teams = engine.snapshot().teams.map((t) => ({
    id: t.teamId, name: t.name, spent: t.spent, remaining: t.remaining, base: t.base,
    adjust: t.adjust, count: t.count, overseas: t.overseas, squad: t.squad,
  }));
  const sold = [], unsold = [];
  for (const srKey of Object.keys(s.results)) {
    const r = s.results[srKey]; const pv = engine.playerView(Number(srKey));
    if (r.status === 'sold') sold.push({ ...pv, teamId: r.teamId, priceL: r.priceL });
    else unsold.push(pv);
  }
  sold.sort((a, b) => b.priceL - a.priceL);
  return {
    season: 'IPL Auction 2026', generatedAt: new Date().toISOString(),
    phase: s.phase, counts: engine._counts(), teams,
    topBuys: sold.slice(0, 10), sold, unsold,
    totalSpendL: sold.reduce((a, b) => a + b.priceL, 0),
  };
}

server.listen(PORT, () => {
  console.log(`\n  IPL Auction 2026 server running`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Landing / role picker : http://localhost:${PORT}/`);
  console.log(`  Operator console      : http://localhost:${PORT}/operator.html`);
  console.log(`  Presentation screen   : http://localhost:${PORT}/presentation.html`);
  console.log(`  Team view             : http://localhost:${PORT}/team.html`);
  console.log(`  Operator key          : ${OP_KEY}   (set AUCTION_OP_KEY to change)`);
  console.log(`  ─────────────────────────────────────\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use — another auction server is likely running.`);
    console.error(`    Close it, or start this one on a different port:  PORT=3001 node server.js\n`);
    process.exit(1);
  }
  throw e;
});

process.on('SIGINT', () => { console.log('\n[shutdown] closing event log…'); store.close(); process.exit(0); });
module.exports = { engine, server };
