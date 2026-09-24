'use strict';
// Rebuilds data/players.json + data/photos from the user-provided dataset in
// "ipl data/": players_dataset.csv (189 IPL 2025 players) + faces/<slug>.png.
// Then appends 31 more real IPL 2025 players (→ 220), giving face-less players
// the hollow-avatar placeholder (real faces can be dropped in later as
// data/photos/<sr>.png).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IPL = path.join(ROOT, 'ipl data');
const FACES = path.join(IPL, 'faces');
const PHOTOS = path.join(ROOT, 'data', 'photos');
const AVATAR = path.join(FACES, '_avatar.png');

const BASE = { '2 Cr': 200, '1 Cr': 100, '50 L': 50, '30 L': 30 };
function roleOf(r) {
  r = String(r || '');
  if (/Wicket/i.test(r)) return 'WICKETKEEPER';
  if (/All\s*Rounder/i.test(r)) return 'ALL-ROUNDER';
  if (/Bowler/i.test(r)) return 'BOWLER';
  return 'BATTER';
}

// --- parse the CSV (189) ---
const lines = fs.readFileSync(path.join(IPL, 'players_dataset.csv'), 'utf8').trim().split(/\r?\n/);
const rows = lines.slice(1).map((l) => l.split(','));
const players = [];
const photoOps = []; // {sr, srcFile}
let sr = 0;
for (const c of rows) {
  sr += 1;
  const [name, basePrice, role, nat, set, imageFile] = c;
  players.push({
    sr, code: 'P' + String(sr).padStart(3, '0'),
    name: name.trim(),
    country: /indian/i.test(nat) ? 'India' : 'Overseas',
    role: roleOf(role),
    cu: '', base: BASE[basePrice.trim()] || 30, set: set.trim(),
  });
  photoOps.push({ sr, src: path.join(FACES, imageFile.trim()) });
}

// --- 31 more real IPL 2025 players (hollow avatar face for now) ---
const ADD = [
  // 14 from the previous curated set, not present in the CSV (spellings fixed)
  ['Yuzvendra Chahal', 'India', 'BOWLER', 200], ['Rashid Khan', 'Overseas', 'BOWLER', 200],
  ['Riyan Parag', 'India', 'ALL-ROUNDER', 100], ['Axar Patel', 'India', 'ALL-ROUNDER', 200],
  ['Shivam Dube', 'India', 'ALL-ROUNDER', 100], ['Romario Shepherd', 'Overseas', 'ALL-ROUNDER', 100],
  ['Azmatullah Omarzai', 'Overseas', 'ALL-ROUNDER', 100], ['Josh Inglis', 'Overseas', 'WICKETKEEPER', 100],
  ['Prince Yadav', 'India', 'BOWLER', 30], ['Sakib Hussain', 'India', 'BOWLER', 30],
  ['Yara Prithviraj', 'India', 'BOWLER', 30], ['Xavier Bartlett', 'Overseas', 'BOWLER', 50],
  ['Shreyas Gopal', 'India', 'ALL-ROUNDER', 30], ['Ajay Mandal', 'India', 'ALL-ROUNDER', 30],
  // 17 more real IPL 2025 players
  ['Andre Russell', 'Overseas', 'ALL-ROUNDER', 200], ['Glenn Maxwell', 'Overseas', 'ALL-ROUNDER', 200],
  ['Sam Curran', 'Overseas', 'ALL-ROUNDER', 200], ['Ravichandran Ashwin', 'India', 'ALL-ROUNDER', 200],
  ['Faf du Plessis', 'Overseas', 'BATTER', 200], ['Devon Conway', 'Overseas', 'WICKETKEEPER', 100],
  ['Rahmanullah Gurbaz', 'Overseas', 'WICKETKEEPER', 100], ['Mayank Yadav', 'India', 'BOWLER', 100],
  ['Mohsin Khan', 'India', 'BOWLER', 50], ['Vijaykumar Vyshak', 'India', 'BOWLER', 50],
  ['Rasikh Salam', 'India', 'BOWLER', 30], ['Simarjeet Singh', 'India', 'BOWLER', 30],
  ['Nuwan Thushara', 'Overseas', 'BOWLER', 50], ['Vijay Shankar', 'India', 'ALL-ROUNDER', 50],
  ['Ramandeep Singh', 'India', 'ALL-ROUNDER', 50], ['Harpreet Brar', 'India', 'ALL-ROUNDER', 50],
  ['Vishnu Vinod', 'India', 'WICKETKEEPER', 30],
];
for (const [name, country, role, base] of ADD) {
  sr += 1;
  players.push({ sr, code: 'P' + String(sr).padStart(3, '0'), name, country, role, cu: '', base, set: 'Extra' });
  photoOps.push({ sr, src: AVATAR }); // hollow face; replace later with data/photos/<sr>.png
}

// --- write players.json (preserve CATS from the existing master) ---
const prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'players.json'), 'utf8'));
const out = {
  PLAYERS: players,
  STARS: prev.STARS || {},
  CATS: prev.CATS || {},
  STATS: prev.STATS || {},
  meta: { source: 'ipl data/players_dataset.csv (189) + 31 IPL2025 additions', count: players.length, built: new Date().toISOString() },
};
fs.writeFileSync(path.join(ROOT, 'data', 'players.json'), JSON.stringify(out, null, 1));

// --- rebuild data/photos from scratch so sr → face stays consistent ---
for (const f of fs.readdirSync(PHOTOS)) { try { fs.unlinkSync(path.join(PHOTOS, f)); } catch (e) {} }
let real = 0, avatar = 0, miss = 0;
for (const op of photoOps) {
  if (!fs.existsSync(op.src)) { miss++; continue; }
  const ext = path.extname(op.src).toLowerCase() || '.png';
  fs.copyFileSync(op.src, path.join(PHOTOS, op.sr + ext));
  if (op.src === AVATAR) avatar++; else real++;
}
console.log(`players: ${players.length} | photos copied — real/dataset: ${real}, hollow-avatar: ${avatar}, missing: ${miss}`);
