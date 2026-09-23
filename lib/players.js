'use strict';
const fs = require('fs');
const path = require('path');

// Loads and normalizes the player master. Prefers data/players.json (the merged
// master produced by scripts/prepare-data.js) and falls back to auction-data.json.

const ROLE_CAT = {
  BATTER: ['BA', 'UBA'],
  WICKETKEEPER: ['WK', 'UWK'],
  'ALL-ROUNDER': ['AL', 'UAL'],
  BOWLER: ['FA', 'UFA'], // data has no pace/spin split; color bucket only, role text stays accurate
};

class PlayerMaster {
  constructor(data) {
    this.list = data.PLAYERS || [];
    this.stars = data.STARS || {};
    this.cats = data.CATS || {};
    this.stats = data.STATS || {};
    this.bySr = {};
    for (const p of this.list) this.bySr[p.sr] = p;
    this.byName = {};
    for (const p of this.list) this.byName[normName(p.name)] = p;
  }

  /** Category code for a player, used for display color + grouping. */
  catFor(p) {
    if (!p) return '-';
    if (p.cat) return p.cat;            // explicit category from the sheet wins
    if (this.stars[p.name]) return 'M'; // marquee / highlighted stars
    const pair = ROLE_CAT[p.role];
    if (!pair) return '-';
    const uncapped = p.cu && p.cu !== 'Capped';
    return uncapped ? pair[1] : pair[0];
  }

  catInfo(code) { return this.cats[code] || this.cats['-'] || { c: '888', label: 'OTHER' }; }
}

function normName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z]/g, '');
}

function load(dataDir, rootDir) {
  const merged = path.join(dataDir, 'players.json');
  const fallback = path.join(rootDir, 'auction-data.json');
  const file = fs.existsSync(merged) ? merged : fallback;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pm = new PlayerMaster(data);
  pm.sourceFile = file;
  return pm;
}

module.exports = { PlayerMaster, load, normName };
