'use strict';
// Turns data/players.csv (the filled template) into data/players.json — the master
// the app runs on. Safe to re-run anytime you edit the sheet.
//
//   node scripts/import-csv.js
//   node scripts/import-csv.js path/to/your.csv

const fs = require('fs');
const path = require('path');
const { parseAmountToL } = require('../lib/money');

const ROOT = path.join(__dirname, '..');
const CSV = process.argv[2] || path.join(ROOT, 'data', 'players.csv');

// --- minimal RFC-4180 CSV parser (handles quotes, commas, newlines in quotes) ---
function parseCSV(text) {
  const rows = []; let row = [], field = '', i = 0, q = false;
  text = text.replace(/^﻿/, ''); // strip BOM
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function main() {
  if (!fs.existsSync(CSV)) {
    console.error(`\n  ✗ Not found: ${CSV}`);
    console.error(`    Fill in data/players-template.csv, save it as data/players.csv, then re-run.\n`);
    process.exit(1);
  }
  const rows = parseCSV(fs.readFileSync(CSV, 'utf8')).filter((r) => r.some((c) => String(c).trim() !== ''));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const get = (r, name) => { const i = col(name); return i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : ''; };

  // carry over category colours from the original dataset
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'auction-data.json'), 'utf8'));
  const PLAYERS = [], STARS = {}, STATS = {};
  const seen = new Set();
  let maxSr = 0, auto = 0, errors = [];

  rows.forEach((r, idx) => {
    const line = idx + 2; // human row number (header is row 1)
    const name = get(r, 'name');
    if (!name) { return; } // skip blank rows
    let sr = parseInt(get(r, 'sr'), 10);
    if (!sr || isNaN(sr)) sr = null;
    if (sr && seen.has(sr)) { errors.push(`Row ${line}: duplicate sr ${sr}`); return; }

    const role = (get(r, 'role') || '').toUpperCase() || '-';
    const cu = get(r, 'capped') || 'Uncapped';
    const baseL = parseAmountToL(get(r, 'base')) || 20;
    const country = get(r, 'country') || 'India';

    const p = { sr, name, code: '', country, role, cu, base: baseL };
    const catOverride = get(r, 'category').toUpperCase();
    if (catOverride) p.cat = catOverride;
    PLAYERS.push(p);
    if (sr) { seen.add(sr); maxSr = Math.max(maxSr, sr); }

    const team = get(r, 'last_ipl_team');
    const hi = get(r, 'highlights').split('|').map((s) => s.trim()).filter(Boolean);
    if (team || hi.length) STARS[name] = { team: team || '', hi };

    const stat = {};
    for (const k of ['matches', 'runs', 'strike_rate', 'wickets', 'economy', 'average', 'rating']) {
      const v = get(r, k);
      if (v !== '') stat[k] = isNaN(Number(v)) ? v : Number(v);
    }
    p.__stat = stat; // temp, keyed to sr after auto-assign below
  });

  // assign serials to any rows left blank, then build STATS by sr
  for (const p of PLAYERS) {
    if (!p.sr) { p.sr = ++maxSr; auto++; }
    p.code = p.code || `P${p.sr}`;
    if (p.__stat && Object.keys(p.__stat).length) STATS[p.sr] = p.__stat;
    delete p.__stat;
  }

  if (errors.length) { console.error('\n  ✗ Problems found:\n   ' + errors.join('\n   ') + '\n'); process.exit(1); }

  const out = {
    PLAYERS, STARS, STATS, CATS: base.CATS,
    meta: { season: 'IPL Auction 2026', retentions: false, totalPlayers: PLAYERS.length, source: path.basename(CSV), builtAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(ROOT, 'data', 'players.json'), JSON.stringify(out));
  console.log(`\n  ✓ Imported ${PLAYERS.length} players (${auto} auto-numbered) → data/players.json`);
  console.log(`    Stars/highlights: ${Object.keys(STARS).length} · with stats: ${Object.keys(STATS).length}`);
  console.log(`    Restart the server (node server.js) to load the new data.\n`);
}

main();
