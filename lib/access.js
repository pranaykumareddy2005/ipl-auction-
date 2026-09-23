'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Per-team access PINs for web bidding. Deliberately kept OUT of the event log
// (which is world-readable via /api/history) — stored in data/access.json.
// A login exchanges {teamId, code} for a bearer token:
//     token = "<teamId>.<HMAC(secret,'team:'+teamId)>"
// The server re-derives the HMAC on every team bid, so a token proves control of
// exactly one team and nothing else. The secret is generated once and persisted
// so tokens survive a server restart.

class TeamAccess {
  constructor(file) {
    this.file = file;
    this.secret = crypto.randomBytes(24).toString('hex');
    this.codes = {};                 // teamId(string) -> PIN(string)
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (d && d.secret) this.secret = d.secret;
        this.codes = (d && d.codes) || {};
        return;
      }
    } catch (e) { /* corrupt — start fresh */ }
    this._save();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ secret: this.secret, codes: this.codes }, null, 2));
    } catch (e) { /* noop */ }
  }

  setCodes(map) {
    const clean = {};
    for (const k of Object.keys(map || {})) {
      const code = String(map[k] == null ? '' : map[k]).trim();
      if (code) clean[String(Number(k))] = code;
    }
    this.codes = clean;
    this._save();
  }

  getCodes() { return Object.assign({}, this.codes); }
  hasCode(teamId) { return !!this.codes[String(Number(teamId))]; }

  // Signature binds the team id AND its current PIN, so changing or removing a
  // team's PIN automatically invalidates any token issued against the old one.
  _sig(teamId) {
    const code = this.codes[String(Number(teamId))];
    if (!code) return null;
    return crypto.createHmac('sha256', this.secret).update('team:' + Number(teamId) + ':' + code).digest('hex').slice(0, 40);
  }

  /** Verify a submitted PIN for a team (constant-time). Returns a token or null. */
  login(teamId, code) {
    const want = this.codes[String(Number(teamId))];
    if (!want) return null;
    if (!eq(code, want)) return null;
    const sig = this._sig(teamId);
    return sig ? Number(teamId) + '.' + sig : null;
  }

  /** Return the teamId a bearer token authorizes, or null. */
  verify(token) {
    if (!token || typeof token !== 'string') return null;
    const i = token.indexOf('.');
    if (i < 0) return null;
    const teamId = Number(token.slice(0, i));
    if (!Number.isFinite(teamId)) return null;
    const want = this._sig(teamId);
    if (!want) return null;
    return eq(token.slice(i + 1), want) ? teamId : null;
  }
}

function eq(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

module.exports = { TeamAccess };
