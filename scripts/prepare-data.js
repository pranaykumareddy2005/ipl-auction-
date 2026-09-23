'use strict';
// Builds data/players.json = the 577-player master + every 2025-squad player not
// already present (chiefly the retained megastars). This is IPL Auction 2026:
// NO retentions — everyone lands in the auction pool, nobody pre-assigned.
//
// Run: node scripts/prepare-data.js

const fs = require('fs');
const path = require('path');
const { normName } = require('../lib/players');
const { parseAmountToL } = require('../lib/money');

const ROOT = path.join(__dirname, '..');
const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'auction-data.json'), 'utf8'));

// Spelling variants in the squad list that already exist in the 577 master.
// squad-name (normalized) -> master player's normalized name (for lookup).
const ALIAS = {
  rashwin: 'ravichandaranashwin',
  mohammedshami: 'mohammadshami',
  mohammedsiraj: 'mohammadsiraj',
  noorahmed: 'noorahmad',
  khaleelahmed: 'syedkhaleelahmed',
  tnatrajan: 'tnatarajan',
  shahbazahmed: 'shahbazahamad',
  saikishore: 'rsaikishore',
  kumarkartikeya: 'kumarkartikeyasingh',
  yudhvirsingh: 'yudhvircharak',
  arshadkhan: 'mohdarshadkhan',
  gurnoorbrar: 'gurnoorsinghbrar',
  nishantsidhu: 'nishantsindhu',
  klshrijith: 'shrijithkrishnan',
  washingtonsundar: 'washingtonsundar',
};

// Curated metadata for players truly absent from the 577 (retained stars + a few).
// base is a fresh-2026 starting price tier, not a 2025 sold price.
const NEW_PLAYERS = [
  ['Ruturaj Gaikwad', 'India', 'BATTER', 'Capped', 200],
  ['Shivam Dube', 'India', 'ALL-ROUNDER', 'Capped', 150],
  ['Ravindra Jadeja', 'India', 'ALL-ROUNDER', 'Capped', 200],
  ['Matheesha Pathirana', 'Sri Lanka', 'BOWLER', 'Capped', 150],
  ['MS Dhoni', 'India', 'WICKETKEEPER', 'Capped', 200],
  ['Jasprit Bumrah', 'India', 'BOWLER', 'Capped', 200],
  ['Suryakumar Yadav', 'India', 'BATTER', 'Capped', 200],
  ['Hardik Pandya', 'India', 'ALL-ROUNDER', 'Capped', 200],
  ['Rohit Sharma', 'India', 'BATTER', 'Capped', 200],
  ['Tilak Varma', 'India', 'BATTER', 'Capped', 150],
  ['Virat Kohli', 'India', 'BATTER', 'Capped', 200],
  ['Rajat Patidar', 'India', 'BATTER', 'Capped', 150],
  ['Yash Dayal', 'India', 'BOWLER', 'Capped', 75],
  ['Rinku Singh', 'India', 'BATTER', 'Capped', 150],
  ['Varun Chakravarthy', 'India', 'BOWLER', 'Capped', 150],
  ['Sunil Narine', 'West Indies', 'ALL-ROUNDER', 'Capped', 150],
  ['Andre Russell', 'West Indies', 'ALL-ROUNDER', 'Capped', 150],
  ['Harshit Rana', 'India', 'BOWLER', 'Capped', 75],
  ['Ramandeep Singh', 'India', 'ALL-ROUNDER', 'Uncapped', 40],
  ['Sanju Samson', 'India', 'WICKETKEEPER', 'Capped', 200],
  ['Yashasvi Jaiswal', 'India', 'BATTER', 'Capped', 200],
  ['Riyan Parag', 'India', 'ALL-ROUNDER', 'Capped', 150],
  ['Dhruv Jurel', 'India', 'WICKETKEEPER', 'Capped', 100],
  ['Shimron Hetmyer', 'West Indies', 'BATTER', 'Capped', 150],
  ['Sandeep Sharma', 'India', 'BOWLER', 'Capped', 50],
  ['Shashank Singh', 'India', 'ALL-ROUNDER', 'Uncapped', 40],
  ['Prabhsimran Singh', 'India', 'WICKETKEEPER', 'Uncapped', 40],
  ['Axar Patel', 'India', 'ALL-ROUNDER', 'Capped', 200],
  ['Kuldeep Yadav', 'India', 'BOWLER', 'Capped', 150],
  ['Tristan Stubbs', 'South Africa', 'BATTER', 'Capped', 150],
  ['Abhishek Porel', 'India', 'WICKETKEEPER', 'Uncapped', 40],
  ['Heinrich Klaasen', 'South Africa', 'WICKETKEEPER', 'Capped', 200],
  ['Travis Head', 'Australia', 'BATTER', 'Capped', 200],
  ['Abhishek Sharma', 'India', 'ALL-ROUNDER', 'Capped', 150],
  ['Nitish Kumar Reddy', 'India', 'ALL-ROUNDER', 'Capped', 100],
  ['Pat Cummins', 'Australia', 'BOWLER', 'Capped', 200],
  ['Rashid Khan', 'Afghanistan', 'BOWLER', 'Capped', 200],
  ['Shubman Gill', 'India', 'BATTER', 'Capped', 200],
  ['Sai Sudharsan', 'India', 'BATTER', 'Capped', 150],
  ['Rahul Tewatia', 'India', 'ALL-ROUNDER', 'Uncapped', 40],
  ['Shahrukh Khan', 'India', 'BATTER', 'Uncapped', 40],
  ['Nicholas Pooran', 'West Indies', 'WICKETKEEPER', 'Capped', 200],
  ['Ravi Bishnoi', 'India', 'BOWLER', 'Capped', 100],
  ['Mayank Yadav', 'India', 'BOWLER', 'Uncapped', 75],
  ['Ayush Badoni', 'India', 'ALL-ROUNDER', 'Uncapped', 40],
  ['Mohsin Khan', 'India', 'BOWLER', 'Uncapped', 40],
  ['Karan Sharma', 'India', 'ALL-ROUNDER', 'Uncapped', 30],
  ['Darshan Markande', 'India', 'BOWLER', 'Uncapped', 30],
];

function parseSquads(txt) {
  let team = null; const rows = [];
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const hm = t.match(/Squads:\s*(.+?)\s*\(([A-Z]+)\)/);
    if (hm) { team = { name: hm[1], short: hm[2] }; continue; }
    if (/^IPL 2025/i.test(t)) continue;
    let name, priceText, retained = false;
    if (/\(Retained\)/i.test(t)) { retained = true; name = t.replace(/\(Retained\)/i, '').trim(); }
    else if (t.includes(':')) { const i = t.indexOf(':'); name = t.slice(0, i).trim(); priceText = t.slice(i + 1).trim(); }
    else { name = t; }
    if (!name) continue;
    rows.push({ name, team: team && team.short, teamName: team && team.name, retained, priceL: parseAmountToL(priceText) });
  }
  return rows;
}

function main() {
  const squads = parseSquads(fs.readFileSync(path.join(ROOT, 'data', 'ipl2025-squads.txt'), 'utf8'));
  const byName = {};
  for (const p of src.PLAYERS) byName[normName(p.name)] = p;

  let maxSr = Math.max(...src.PLAYERS.map((p) => p.sr));
  const players = src.PLAYERS.slice();
  const real2025 = {}; // sr -> {team, teamName, retained, priceL}
  const addedByName = {};

  // 1) Add curated new players.
  for (const [name, country, role, cu, base] of NEW_PLAYERS) {
    maxSr += 1;
    const p = { sr: maxSr, code: `X${maxSr}`, name, country, role, cu, base };
    players.push(p);
    byName[normName(name)] = p;
    addedByName[normName(name)] = p;
  }

  // 2) Attach real-2025 reference to every squad player (matched, aliased, or new).
  let matched = 0, viaAlias = 0, viaNew = 0, unresolved = [];
  for (const r of squads) {
    const n = normName(r.name);
    let p = byName[n];
    if (!p && ALIAS[n]) { p = byName[ALIAS[n]]; if (p) viaAlias++; }
    else if (p && addedByName[n]) viaNew++;
    else if (p) matched++;
    if (!p) { unresolved.push(r.name); continue; }
    real2025[p.sr] = { team: r.team, teamName: r.teamName, retained: r.retained, priceL: r.priceL };
  }

  const out = {
    PLAYERS: players,
    STARS: src.STARS,
    CATS: src.CATS,
    REAL2025: real2025,
    meta: {
      season: 'IPL Auction 2026',
      retentions: false,
      totalPlayers: players.length,
      addedFromSquads: NEW_PLAYERS.length,
      builtAt: new Date().toISOString(),
    },
  };
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'players.json'), JSON.stringify(out));

  console.log('Master players :', players.length, `(577 + ${NEW_PLAYERS.length} added)`);
  console.log('Squad rows     :', squads.length);
  console.log('  matched directly:', matched, ' via alias:', viaAlias, ' newly added:', viaNew);
  console.log('  unresolved:', unresolved.length, unresolved.length ? unresolved.join(', ') : '');
  console.log('Wrote data/players.json');
}

main();
