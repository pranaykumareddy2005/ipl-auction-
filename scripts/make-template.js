'use strict';
// Regenerates data/players-template.csv from the current data/players.json so the
// editable sheet always matches the live master. Run after build-master / import.
//   node scripts/make-template.js

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'players.json'), 'utf8'));

const fmtBase = (L) => (L >= 100 ? ((L / 100) % 1 === 0 ? L / 100 : (L / 100).toFixed(2)) + ' Cr' : L + ' L');
const esc = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const cols = ['sr', 'name', 'country', 'role', 'capped', 'base', 'category', 'last_ipl_team', 'highlights', 'rating', 'matches', 'runs', 'strike_rate', 'wickets', 'economy', 'average'];
const stat = (sr, k) => (d.STATS && d.STATS[sr] && d.STATS[sr][k] != null ? d.STATS[sr][k] : '');

const lines = [cols.join(',')];
for (const p of d.PLAYERS) {
  const s = d.STARS[p.name] || {};
  const row = [p.sr, p.name, p.country, p.role, p.cu, fmtBase(p.base), p.cat || '', s.team || '', (s.hi || []).join(' | '),
    stat(p.sr, 'rating'), stat(p.sr, 'matches'), stat(p.sr, 'runs'), stat(p.sr, 'strike_rate'), stat(p.sr, 'wickets'), stat(p.sr, 'economy'), stat(p.sr, 'average')];
  lines.push(row.map(esc).join(','));
}
fs.writeFileSync(path.join(ROOT, 'data', 'players-template.csv'), lines.join('\n'));
console.log(`Wrote data/players-template.csv — ${d.PLAYERS.length} players, ${cols.length} columns`);
