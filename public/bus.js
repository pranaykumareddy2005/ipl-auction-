// Shared client helpers: SSE state stream, command POST, formatting.
(function (g) {
  'use strict';

  function fmtL(L) {
    L = Number(L) || 0;
    if (L >= 100) { const c = L / 100; return '₹' + (c % 1 === 0 ? c : c.toFixed(2)) + ' Cr'; }
    return '₹' + L + ' L';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // Connect to the authoritative state stream. onState(snapshot) fires on every change.
  function connect(onState, onConn) {
    let es;
    function open() {
      es = new EventSource('/api/stream');
      es.onopen = () => onConn && onConn(true);
      es.onmessage = (e) => { try { onState(JSON.parse(e.data)); } catch (err) {} };
      es.onerror = () => { onConn && onConn(false); /* EventSource auto-reconnects */ };
    }
    open();
    return { close: () => es && es.close() };
  }

  // Fire an operator command. Returns {ok,error?}.
  async function command(name, payload, opKey) {
    try {
      const r = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-op-key': opKey || '' },
        body: JSON.stringify({ name, payload: payload || {} }),
      });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error — is the server running?' }; }
  }

  async function getJSON(url) { const r = await fetch(url); return r.json(); }

  // Team web-bidding. login -> {ok, token}; bid uses that bearer token.
  async function teamLogin(teamId, code) {
    try {
      const r = await fetch('/api/team/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, code }),
      });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error — is the server running?' }; }
  }
  async function teamBid(token, amountL, expectedSr) {
    const body = {};
    if (amountL != null) body.amountL = amountL;
    if (expectedSr != null) body.expectedSr = expectedSr;
    try {
      const r = await fetch('/api/team/bid', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-team-token': token || '' },
        body: JSON.stringify(body),
      });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error — is the server running?' }; }
  }

  let toastT;
  function toast(msg, kind) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.className = 'toast show ' + (kind || '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.className = 'toast ' + (kind || ''); }, 2600);
  }

  function connBadge(on) {
    let el = document.querySelector('.conn');
    if (!el) { el = document.createElement('div'); el.className = 'conn'; document.body.appendChild(el); }
    el.className = 'conn ' + (on ? 'on' : 'off');
    el.textContent = on ? '● live' : '○ reconnecting…';
  }

  g.Bus = { fmtL, esc, connect, command, getJSON, teamLogin, teamBid, toast, connBadge };
})(window);
