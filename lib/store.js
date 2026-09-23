'use strict';
const fs = require('fs');
const path = require('path');

// Durable append-only event log (JSON Lines). Each append is fsync'd so a crash
// or power loss never loses an acknowledged event. Recovery = read + replay.

class EventStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'a');
  }

  /** Load and parse every event ever appended, in order. Skips corrupt trailing lines. */
  loadAll() {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); }
      catch (e) { /* ignore a torn last line from an interrupted write */ }
    }
    return out;
  }

  /** Durably append one or more events. */
  append(events) {
    const list = Array.isArray(events) ? events : [events];
    if (!list.length) return;
    const buf = list.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeSync(this.fd, buf);
    fs.fsyncSync(this.fd);
  }

  close() {
    try { fs.closeSync(this.fd); } catch (e) { /* noop */ }
  }
}

module.exports = { EventStore };
