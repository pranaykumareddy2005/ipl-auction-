'use strict';
// Collects player photos: matches our players to the public IPL headshot URLs
// published in github.com/macayu17/ipl-auction-arena and downloads them into
// data/photos/<sr>.<ext> so they work offline during the event.
//
//   node scripts/fetch-photos.js
//
// Re-runnable: already-downloaded photos are skipped.

const fs = require('fs');
const path = require('path');
const { normName } = require('../lib/players');

const ROOT = path.join(__dirname, '..');
const PHOTOS = path.join(ROOT, 'data', 'photos');
const IMAGES_CSV = 'https://raw.githubusercontent.com/macayu17/ipl-auction-arena/main/public/player-images/player_images.csv';
const CONCURRENCY = 8;

function parseCSV(text) {
  const rows = []; let row = [], f = '', i = 0, q = false;
  text = text.replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i += 2; continue; } if (c === '"') { q = false; i++; continue; } f += c; i++; continue; }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(f); f = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; continue; }
    f += c; i++;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

async function download(url, dest, tries = 2) {
  for (let t = 0; t < tries; t++) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'ipl-auction/1.0' } });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 500) throw new Error('too small');
      fs.writeFileSync(dest, buf);
      return true;
    } catch (e) { if (t === tries - 1) return false; }
  }
  return false;
}

async function main() {
  fs.mkdirSync(PHOTOS, { recursive: true });
  const master = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'players.json'), 'utf8'));
  const bySr = master.PLAYERS;
  const nameToSr = {};
  for (const p of bySr) nameToSr[normName(p.name)] = p.sr;

  console.log('Fetching photo index…');
  const csvText = await (await fetch(IMAGES_CSV, { headers: { 'User-Agent': 'ipl-auction/1.0' } })).text();
  const rows = parseCSV(csvText);
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const ci = (n) => header.indexOf(n);

  // Build best name -> url map (prefer non-alias rows, first-wins otherwise).
  const urlFor = {};
  for (const r of rows) {
    const nm = normName(r[ci('player_name')]);
    const url = (r[ci('image_url')] || '').trim();
    const status = (r[ci('status')] || '').trim();
    if (!nm || !url) continue;
    if (!urlFor[nm] || status !== 'alias') urlFor[nm] = url;
  }

  // Match our players and queue downloads (skip ones already on disk).
  const existing = new Set(fs.readdirSync(PHOTOS).map((f) => f.replace(/\.[^.]+$/, '')));
  const jobs = [];
  let matched = 0;
  for (const p of bySr) {
    const url = urlFor[normName(p.name)];
    if (!url) continue;
    matched++;
    if (existing.has(String(p.sr))) continue;
    const ext = (url.split('?')[0].match(/\.(png|jpe?g|webp)$/i) || [, 'png'])[1].toLowerCase();
    jobs.push({ sr: p.sr, name: p.name, url, dest: path.join(PHOTOS, `${p.sr}.${ext}`) });
  }

  console.log(`Players: ${bySr.length} · matched to a photo: ${matched} · to download now: ${jobs.length}`);
  let done = 0, ok = 0;
  async function worker() {
    while (jobs.length) {
      const j = jobs.shift();
      const good = await download(j.url, j.dest);
      done++; if (good) ok++;
      if (done % 25 === 0 || !jobs.length) process.stdout.write(`\r  downloaded ${ok}/${done}…   `);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\n✓ Photos downloaded: ${ok} (failed: ${done - ok}). Saved to data/photos/`);
  console.log('  Restart the server (node server.js) to show them.');
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
