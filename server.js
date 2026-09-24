'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const players = require('./lib/players');
const { RoomManager } = require('./lib/rooms');
const { isConfigured, ping, pool } = require('./lib/db');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT || 3000;

// --- boot: master players (shared across all rooms) + room manager ---
const master = players.load(DATA_DIR, ROOT);
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });
const rooms = new RoomManager({ players: master, photosDir: PHOTOS_DIR });

// --- per-room SSE clients ---
const roomClients = new Map(); // code -> Set<res>
function roomBroadcast(code, snap) {
  const set = roomClients.get(code);
  if (!set || !set.size) return;
  const payload = `data: ${JSON.stringify(snap)}\n\n`;
  for (const res of set) { try { res.write(payload); } catch (e) { /* noop */ } }
}
// Wire a room's engine so every state change fans out to that room's screens.
function wireRoom(room) {
  if (!roomClients.has(room.code)) roomClients.set(room.code, new Set());
  room.engine.subscribe((snap) => roomBroadcast(room.code, snap));
}
// Heartbeat. Real state changes are already pushed event-driven via _notify().
// So here we only stream a fresh snapshot while a timer is COUNTING DOWN (for the
// live countdown); otherwise we send a tiny SSE keepalive comment that does NOT
// trigger a client re-render. This avoids a full snapshot + re-render every second
// on idle rooms (the main source of UI lag).
let _hbTick = 0;
setInterval(() => {
  _hbTick++;
  for (const [code, set] of roomClients) {
    if (!set.size) continue;
    const room = rooms.get(code);
    if (!room) continue;
    if (room.engine.timer && room.engine.timer.running) {
      roomBroadcast(code, room.engine.snapshot());
    } else if (_hbTick % 20 === 0) { // ~every 20s: keepalive only
      for (const res of set) { try { res.write(':ka\n\n'); } catch (e) { /* noop */ } }
    }
  }
}, 1000).unref();

// --- helpers ---
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJSON(res, code, obj) {
  let body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (res._gz && body.length > 512) { body = zlib.gzipSync(body); headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; }
  res.writeHead(code, headers);
  res.end(body);
}
function safeReviver(key, val) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return val;
}
function within(dir, file) { return file === dir || file.startsWith(dir + path.sep); }

// Behind a reverse proxy (nginx), the real client IP is in X-Forwarded-For.
// Only trust it when TRUST_PROXY is set, else a client could spoof it to dodge limits.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
function clientIp(req) {
  if (TRUST_PROXY) { const xff = req.headers['x-forwarded-for']; if (xff) return String(xff).split(',')[0].trim(); }
  return req.socket.remoteAddress || 'unknown';
}

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
// Static serving with an mtime-keyed cache (raw + pre-gzipped). Edits invalidate
// automatically (mtime changes), so no stale files, but repeat loads are cheap.
const staticCache = new Map(); // file -> {mtimeMs, raw, gz, ctype}
function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!within(PUBLIC_DIR, file)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    let ent = staticCache.get(file);
    if (!ent || ent.mtimeMs !== st.mtimeMs) {
      const raw = fs.readFileSync(file);
      const ctype = MIME[path.extname(file)] || 'application/octet-stream';
      const gz = /text|javascript|json|svg/.test(ctype) ? zlib.gzipSync(raw) : null;
      ent = { mtimeMs: st.mtimeMs, raw, gz, ctype };
      staticCache.set(file, ent);
    }
    const isHtml = ent.ctype.startsWith('text/html');
    const headers = { 'Content-Type': ent.ctype, 'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600', Vary: 'Accept-Encoding' };
    if (res._gz && ent.gz) { headers['Content-Encoding'] = 'gzip'; res.writeHead(200, headers); return res.end(ent.gz); }
    res.writeHead(200, headers); res.end(ent.raw);
  });
}

// Generic sliding-window IP throttle.
function makeThrottle(windowMs, max) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; hits.set(ip, e); }
    if (hits.size > 5000) hits.clear();
    e.count += 1;
    return e.count > max;
  };
}
const claimThrottled = makeThrottle(60000, 20);   // 20 claim attempts / min / IP
const createThrottled = makeThrottle(3600000, 15); // 15 new rooms / hour / IP (anti-spam)

function buildReport(engine) {
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

// --- router ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res._gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');

  // Health check for uptime monitors / load balancers.
  if (req.method === 'GET' && (p === '/healthz' || p === '/health')) {
    try { await pool.query('select 1'); return sendJSON(res, 200, { ok: true, rooms: rooms.rooms.size, uptime: Math.round(process.uptime()) }); }
    catch (e) { return sendJSON(res, 503, { ok: false, error: 'db unavailable' }); }
  }

  // Player photos (shared by every room)
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

  // Static assets / pages
  if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

  // Global player master (same for every room)
  if (req.method === 'GET' && p === '/api/players') return sendJSON(res, 200, { players: master.list, cats: master.cats, stars: master.stars });

  // ---- Rooms: create / list / lookup ----
  if (req.method === 'POST' && p === '/api/rooms') {
    const ip = clientIp(req);
    if (createThrottled(ip)) return sendJSON(res, 429, { ok: false, error: 'Too many rooms created — try again later' });
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJSON(res, 413, { ok: false, error: 'Request too large' });
    try {
      const room = await rooms.create(body && body.name);
      wireRoom(room);
      // hostKey is returned ONCE to the creator; they store it locally.
      return sendJSON(res, 200, { ok: true, code: room.code, name: room.name, hostKey: room.hostKey });
    } catch (e) { console.error('[create room]', e.message); return sendJSON(res, 500, { ok: false, error: 'Could not create room' }); }
  }
  // NOTE: no public "list all rooms" endpoint — room codes are private join secrets.

  const rm = p.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
  if (rm && req.method === 'GET') {
    const room = rooms.get(rm[1]);
    if (!room) return sendJSON(res, 404, { ok: false, error: 'Room not found' });
    return sendJSON(res, 200, { ok: true, code: room.code, name: room.name, phase: room.engine.state.phase, teams: room.engine.state.teams.length });
  }

  // ---- Room-scoped routes: /api/room/:code/... ----
  const mr = p.match(/^\/api\/room\/([A-Za-z0-9]+)\/(.+)$/);
  if (mr) {
    const room = rooms.get(mr[1]);
    if (!room) return sendJSON(res, 404, { ok: false, error: 'Room not found' });
    const sub = mr[2];
    const engine = room.engine;

    // SSE state stream (scoped to this room)
    if (req.method === 'GET' && sub === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\n\n`);
      res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
      const set = roomClients.get(room.code) || (roomClients.set(room.code, new Set()), roomClients.get(room.code));
      set.add(res);
      req.on('close', () => set.delete(res));
      return;
    }
    if (req.method === 'GET' && sub === 'state') return sendJSON(res, 200, engine.snapshot());
    if (req.method === 'GET' && sub === 'history') {
      const lim = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
      return sendJSON(res, 200, { events: engine.history(lim) });
    }
    if (req.method === 'GET' && sub === 'pool') return sendJSON(res, 200, { order: engine.state.pool, held: engine.state.held, skipped: engine.state.skipped });
    if (req.method === 'GET' && sub === 'report') return sendJSON(res, 200, buildReport(engine));
    const tm = sub.match(/^team\/(\d+)$/);
    if (req.method === 'GET' && tm) return sendJSON(res, 200, engine.teamDetail(Number(tm[1])));

    // Auctioneer command (host key required)
    if (req.method === 'POST' && sub === 'command') {
      if (!room.hostOk(req.headers['x-op-key'])) return sendJSON(res, 401, { ok: false, error: 'Invalid auctioneer key' });
      if (Number(req.headers['content-length']) > 1e6) return sendJSON(res, 413, { ok: false, error: 'Request too large' });
      const body = await readBody(req);
      if (body && body.__tooLarge) return sendJSON(res, 413, { ok: false, error: 'Request too large' });
      if (!body || !body.name) return sendJSON(res, 400, { ok: false, error: 'Bad request' });
      if (body.name === 'startTimer') { engine.startTimer(); return sendJSON(res, 200, { ok: true }); }
      if (body.name === 'stopTimer') { engine.stopTimer(); return sendJSON(res, 200, { ok: true }); }
      const result = engine.command(body.name, body.payload || {}, { actor: 'operator' });
      if (!result.ok) return sendJSON(res, 409, { ok: false, error: result.error });
      let warning;
      try { await result.write; } catch (e) { warning = 'Applied locally but not saved to the database — check the connection'; }
      return sendJSON(res, 200, warning ? { ok: true, rev: result.rev, warning } : { ok: true, rev: result.rev });
    }

    // Team CLAIM (FCFS, no PIN) — anyone with the join link
    if (req.method === 'POST' && sub === 'team/claim') {
      const ip = clientIp(req);
      if (claimThrottled(ip)) return sendJSON(res, 429, { ok: false, error: 'Too many attempts — wait a minute' });
      const body = await readBody(req);
      if (!body || body.teamId == null) return sendJSON(res, 400, { ok: false, error: 'Pick a team' });
      try {
        const r = await room.claim(Number(body.teamId));
        if (!r.ok) return sendJSON(res, 409, { ok: false, error: r.error || 'Could not claim' });
        return sendJSON(res, 200, r);
      } catch (e) { console.error('[claim]', e.message); return sendJSON(res, 500, { ok: false, error: 'Could not claim team' }); }
    }

    // Team RELEASE (auctioneer reassigns / frees a team)
    if (req.method === 'POST' && sub === 'team/release') {
      if (!room.hostOk(req.headers['x-op-key'])) return sendJSON(res, 401, { ok: false, error: 'Invalid auctioneer key' });
      const body = await readBody(req);
      if (!body || body.teamId == null) return sendJSON(res, 400, { ok: false, error: 'Bad request' });
      try { return sendJSON(res, 200, await room.release(Number(body.teamId))); }
      catch (e) { console.error('[release]', e.message); return sendJSON(res, 500, { ok: false, error: 'Could not release team' }); }
    }

    // Team BID (bearer token from claim)
    if (req.method === 'POST' && sub === 'team/bid') {
      const teamId = room.verifyTeam(req.headers['x-team-token']);
      if (teamId == null) return sendJSON(res, 401, { ok: false, error: 'Session expired — rejoin from the link' });
      if (!engine.state.teams.find((t) => t.id === teamId)) return sendJSON(res, 409, { ok: false, error: 'Team no longer exists' });
      const body = await readBody(req);
      if (body && body.__tooLarge) return sendJSON(res, 413, { ok: false, error: 'Request too large' });
      const payload = { teamId };
      if (body && body.amountL != null) payload.amountL = Number(body.amountL);
      if (body && body.expectedSr != null) payload.expectedSr = Number(body.expectedSr);
      const result = engine.command('placeBid', payload, { actor: `team:${teamId}` });
      if (!result.ok) return sendJSON(res, 409, { ok: false, error: result.error });
      let warning;
      try { await result.write; } catch (e) { warning = 'Bid applied but not saved — check the connection'; }
      return sendJSON(res, 200, warning ? { ok: true, rev: result.rev, warning } : { ok: true, rev: result.rev });
    }

    return sendJSON(res, 404, { ok: false, error: 'Unknown room route' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use — another server is likely running.`);
    console.error(`    Close it, or start this one on a different port:  PORT=3001 node server.js\n`);
    process.exit(1);
  }
  throw e;
});
// Graceful shutdown: systemd/pm2 send SIGTERM. Flush pending DB writes so an
// acknowledged auction action is never lost across a restart/deploy.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`\n[shutdown] ${sig} — flushing pending writes…`);
  setTimeout(() => process.exit(0), 8000).unref(); // hard cap if something hangs
  try { server.close(); } catch (e) {}
  try { await Promise.all([...rooms.rooms.values()].map((r) => r.engine.flush().catch(() => {}))); } catch (e) {}
  try { await pool.end(); } catch (e) {}
  console.log('[shutdown] done.');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Never let one bad request take down a live auction; log and keep serving (state is in Postgres).
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.stack) || e));

// --- async boot: verify DB, rehydrate rooms, then listen ---
(async () => {
  if (!isConfigured()) { console.error('\n  ✗ PGPASSWORD not set. Add it to .env (see .env.example).\n'); process.exit(1); }
  const pg = await ping();
  if (!pg.ok) { console.error('\n  ✗ Cannot reach Postgres:', pg.error, '\n'); process.exit(1); }
  const n = await rooms.loadAll();
  for (const room of rooms.rooms.values()) wireRoom(room);
  console.log(`[boot] players: ${master.list.length} | rooms restored: ${n} | db: ${pg.version.split(' ').slice(0, 2).join(' ')}`);
  server.listen(PORT, () => {
    console.log(`\n  IPL Auction — multi-room platform`);
    console.log(`  ─────────────────────────────────────`);
    console.log(`  Landing / create-join : http://localhost:${PORT}/`);
    console.log(`  Rooms live in Postgres (Supabase).`);
    console.log(`  ─────────────────────────────────────\n`);
  });
})().catch((e) => { console.error('[boot] failed:', e.message); process.exit(1); });

module.exports = { server, rooms };
