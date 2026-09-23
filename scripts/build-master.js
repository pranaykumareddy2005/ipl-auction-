'use strict';
// Builds the FINAL ~675-player master (data/players.json):
//   our curated 625 (real roles/countries/base prices)
//   + data-16's STARS enrichment (last_ipl_team + highlights) for the capped subset
//   + repo-only players from macayu17/ipl-auction-arena (role from its rating sheets)
//   + player ratings merged into STATS
// sr numbering is preserved from prepare-data, so existing sr-keyed photos stay valid.
//
//   node scripts/build-master.js

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { normName } = require('../lib/players');

const ROOT = path.join(__dirname, '..');
const RAW = 'https://raw.githubusercontent.com/macayu17/ipl-auction-arena/main/';
const RATING_SHEETS = ['IPL%20AUCTION%20DATA%20SHEET.csv', 'ipl%20%20PLAYER%20DETAILS.csv'];

function parseCSV(t) {
  const rows = []; let row = [], f = '', i = 0, q = false; t = t.replace(/^﻿/, '');
  while (i < t.length) { const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { f += '"'; i += 2; continue; } if (c === '"') { q = false; i++; continue; } f += c; i++; continue; }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(f); f = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; continue; }
    f += c; i++; }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function roleOf(cat) {
  const c = String(cat || '').toUpperCase();
  if (c.includes('KEEP') || c.includes('WK')) return 'WICKETKEEPER';
  if (c.includes('ALL')) return 'ALL-ROUNDER';
  if (c.includes('BOWL')) return 'BOWLER';
  if (c.includes('BAT')) return 'BATTER';
  return '-';
}
function baseFromRating(r) {
  r = Number(r) || 0;
  if (r >= 90) return 200; if (r >= 85) return 150; if (r >= 80) return 100;
  if (r >= 75) return 75; if (r >= 70) return 50; if (r > 0) return 40; return 20;
}

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ipl-auction/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.text();
}

async function main() {
  // 1) capture data-16's enrichment before regenerating
  let richStars = {}, richStats = {};
  try { const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'players.json'), 'utf8'));
    richStars = cur.STARS || {}; richStats = cur.STATS || {}; } catch (e) {}
  console.log(`Captured enrichment: ${Object.keys(richStars).length} stars, ${Object.keys(richStats).length} stats`);

  // 2) regenerate our curated 625 base
  cp.execSync('node scripts/prepare-data.js', { cwd: ROOT, stdio: 'ignore' });
  const master = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'players.json'), 'utf8'));
  console.log(`Regenerated curated base: ${master.PLAYERS.length} players`);

  // 3) merge enrichment (data-16's richer team+highlights win)
  master.STARS = Object.assign({}, master.STARS, richStars);
  master.STATS = Object.assign({}, master.STATS || {}, richStats);

  // 4) pull the repo rating sheets → role + rating by name
  const ratingBy = {};
  for (const sheet of RATING_SHEETS) {
    try {
      const rows = parseCSV(await getText(RAW + sheet)).filter((r) => r.some((c) => String(c).trim()));
      for (const r of rows) {
        const name = (r[0] || '').trim();
        if (!name || /player/i.test(name) && /name/i.test(r.join(''))) continue;
        const nm = normName(name); if (!nm) continue;
        const cat = r[1] || ''; const rating = Number(r[2] || r[1]) || null;
        if (!ratingBy[nm]) ratingBy[nm] = { name, role: roleOf(cat), rating: isNaN(rating) ? null : rating };
      }
    } catch (e) { console.warn('  (skip sheet ' + sheet + ': ' + e.message + ')'); }
  }
  console.log(`Repo rating sheet names: ${Object.keys(ratingBy).length}`);

  // 5) add a CURATED set of real, correctly-spelled retired legends (the repo's raw
  //    extras were umpires, a "script writer", and misspelled duplicates — excluded).
  //    [name, country, role, base(lakh)]
  const LEGENDS = [
    ['AB de Villiers', 'South Africa', 'WICKETKEEPER', 200], ['Chris Gayle', 'West Indies', 'BATTER', 200],
    ['Suresh Raina', 'India', 'BATTER', 150], ['Virender Sehwag', 'India', 'BATTER', 150],
    ['Dale Steyn', 'South Africa', 'BOWLER', 150], ['Kieron Pollard', 'West Indies', 'ALL-ROUNDER', 150],
    ['Shane Watson', 'Australia', 'ALL-ROUNDER', 150], ['Harbhajan Singh', 'India', 'BOWLER', 100],
    ['Brendon McCullum', 'New Zealand', 'WICKETKEEPER', 150], ['Eoin Morgan', 'England', 'BATTER', 100],
    ['Dwayne Smith', 'West Indies', 'BATTER', 75], ['Chris Lynn', 'Australia', 'BATTER', 100],
    ['Imran Tahir', 'South Africa', 'BOWLER', 100], ['James Faulkner', 'Australia', 'ALL-ROUNDER', 100],
    ['Mitchell Johnson', 'Australia', 'BOWLER', 100], ['Morne Morkel', 'South Africa', 'BOWLER', 100],
    ['Albie Morkel', 'South Africa', 'ALL-ROUNDER', 75], ['Murali Vijay', 'India', 'BATTER', 75],
    ['Parthiv Patel', 'India', 'WICKETKEEPER', 50], ['Wriddhiman Saha', 'India', 'WICKETKEEPER', 75],
    ['Stuart Binny', 'India', 'ALL-ROUNDER', 40], ['George Bailey', 'Australia', 'BATTER', 75],
    ['Lendl Simmons', 'West Indies', 'BATTER', 75], ['Corey Anderson', 'New Zealand', 'ALL-ROUNDER', 75],
    ['Mitchell McClenaghan', 'New Zealand', 'BOWLER', 75], ['Kedar Jadhav', 'India', 'ALL-ROUNDER', 75],
    ['JP Duminy', 'South Africa', 'ALL-ROUNDER', 100], ['Darren Sammy', 'West Indies', 'ALL-ROUNDER', 50],
    ['Moises Henriques', 'Australia', 'ALL-ROUNDER', 75], ['Chris Morris', 'South Africa', 'ALL-ROUNDER', 100],
    ['Angelo Mathews', 'Sri Lanka', 'ALL-ROUNDER', 100], ['Ben Stokes', 'England', 'ALL-ROUNDER', 200],
    ['Cameron Green', 'Australia', 'ALL-ROUNDER', 150], ['Shivil Kaushik', 'India', 'BOWLER', 30],
    ['Yusuf Pathan', 'India', 'ALL-ROUNDER', 75], ['Irfan Pathan', 'India', 'ALL-ROUNDER', 75],
    ['Robin Uthappa', 'India', 'WICKETKEEPER', 75], ['Ambati Rayudu', 'India', 'BATTER', 75],
    ['Dwayne Bravo', 'West Indies', 'ALL-ROUNDER', 150], ['Lasith Malinga', 'Sri Lanka', 'BOWLER', 150],
    ['Aaron Finch', 'Australia', 'BATTER', 100], ['Steve Smith', 'Australia', 'BATTER', 150],
    ['David Warner', 'Australia', 'BATTER', 200], ['Kane Williamson', 'New Zealand', 'BATTER', 150],
    ['Shakib Al Hasan', 'Bangladesh', 'ALL-ROUNDER', 100], ['Shikhar Dhawan', 'India', 'BATTER', 150],
    ['Manish Pandey', 'India', 'BATTER', 75], ['Piyush Chawla', 'India', 'BOWLER', 50],
    ['Amit Mishra', 'India', 'BOWLER', 50], ['Cheteshwar Pujara', 'India', 'BATTER', 50],
    ['Hashim Amla', 'South Africa', 'BATTER', 100],
  ];
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) { const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur; }
    return prev[n];
  }
  const existingNames = master.PLAYERS.map((p) => normName(p.name));
  const isDup = (nm) => existingNames.some((e) => e === nm || (Math.abs(e.length - nm.length) <= 2 && lev(e, nm) <= 2));

  let maxSr = Math.max(...master.PLAYERS.map((p) => p.sr));
  const addedNames = [];
  for (const [name, country, role, base] of LEGENDS) {
    const nm = normName(name);
    if (isDup(nm)) continue; // already in the current roster
    maxSr += 1;
    master.PLAYERS.push({ sr: maxSr, code: `L${maxSr}`, name, country, role, cu: 'Capped', base });
    existingNames.push(nm); addedNames.push(name);
  }
  console.log(`Added curated legends: ${addedNames.length}`);
  console.log('  ' + addedNames.join(', '));

  // 5b) drop exact duplicates (same name AND role — accidental repeats), keeping the first.
  //     Same name with different roles (e.g. two real "Akash Singh") are kept.
  const dedup = [], keyseen = new Set();
  for (const p of master.PLAYERS) {
    const key = normName(p.name) + '|' + (p.role || '');
    if (keyseen.has(key)) continue;
    keyseen.add(key); dedup.push(p);
  }
  if (dedup.length !== master.PLAYERS.length) console.log(`Removed ${master.PLAYERS.length - dedup.length} exact duplicate(s)`);
  master.PLAYERS = dedup;

  // 6) merge ratings into STATS for everyone we have a rating for
  let rated = 0;
  for (const p of master.PLAYERS) {
    const info = ratingBy[normName(p.name)];
    if (info && info.rating != null) { master.STATS[p.sr] = Object.assign({}, master.STATS[p.sr], { rating: info.rating }); rated += 1; }
  }

  master.meta = { season: 'IPL Auction 2026', retentions: false, totalPlayers: master.PLAYERS.length,
    sources: ['auction-data.json', 'ipl2025-squads', 'data-16 enrichment', 'macayu17/ipl-auction-arena'], builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(ROOT, 'data', 'players.json'), JSON.stringify(master));
  console.log(`\n✓ Final master: ${master.PLAYERS.length} players · ${Object.keys(master.STARS).length} enriched · ${rated} rated`);
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
