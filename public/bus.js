// Shared client helpers for the MULTI-ROOM platform.
// Every auction page carries its room in the URL: ?room=CODE. All room API calls
// and the SSE stream are scoped to that code. The landing page has no room and
// uses createRoom()/roomInfo().
(function (g) {
  'use strict';

  const ROOM = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  const base = () => '/api/room/' + ROOM;

  function fmtL(L) {
    L = Number(L) || 0;
    if (L >= 100) { const c = L / 100; return '₹' + (c % 1 === 0 ? c : c.toFixed(2)) + ' Cr'; }
    return '₹' + L + ' L';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  async function getJSON(url) { const r = await fetch(url); return r.json(); }

  // ---- room lifecycle (landing page) ----
  async function createRoom(name) {
    try {
      const r = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error — is the server running?' }; }
  }
  async function roomInfo(code) {
    try { const r = await fetch('/api/rooms/' + encodeURIComponent(code)); return await r.json(); }
    catch (e) { return { ok: false, error: 'Network error' }; }
  }

  // ---- live state for the current room ----
  // identity (optional) declares who this screen is so it shows up in room presence:
  //   { role:'team', teamId, token } | { role:'operator', key } | { role:'screen' }
  function connect(onState, onConn, identity) {
    let es;
    function streamUrl() {
      const q = new URLSearchParams();
      if (identity && identity.role) {
        q.set('role', identity.role);
        if (identity.role === 'team') { q.set('team', identity.teamId); q.set('token', identity.token || ''); }
        else if (identity.role === 'operator') { q.set('key', identity.key || ''); }
      }
      const qs = q.toString();
      return base() + '/stream' + (qs ? '?' + qs : '');
    }
    function open() {
      es = new EventSource(streamUrl());
      es.onopen = () => onConn && onConn(true);
      es.onmessage = (e) => { try { onState(JSON.parse(e.data)); } catch (err) {} };
      es.onerror = () => { onConn && onConn(false); };
    }
    open();
    return { close: () => es && es.close() };
  }
  function state() { return getJSON(base() + '/state'); }

  // ---- auctioneer command (host key) ----
  async function command(name, payload, opKey) {
    try {
      const r = await fetch(base() + '/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-op-key': opKey || '' },
        body: JSON.stringify({ name, payload: payload || {} }),
      });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error — is the server running?' }; }
  }

  // ---- team join / rejoin (team + passcode) + bidding ----
  async function joinTeam(teamId, pin) {
    try {
      const r = await fetch(base() + '/team/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, pin }),
      });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error — is the server running?' }; }
  }

  // ---- operator: view / rotate team passcodes ----
  async function teamsAuth(opKey) {
    try {
      const r = await fetch(base() + '/teams-auth', { headers: { 'x-op-key': opKey || '' } });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error' }; }
  }
  async function regenPin(teamId, opKey) {
    try {
      const r = await fetch(base() + '/team/regen-pin', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-op-key': opKey || '' },
        body: JSON.stringify({ teamId }),
      });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error' }; }
  }
  async function releaseTeam(teamId, opKey) {
    try {
      const r = await fetch(base() + '/team/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-op-key': opKey || '' },
        body: JSON.stringify({ teamId }),
      });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error' }; }
  }
  async function teamBid(token, amountL, expectedSr) {
    const body = {};
    if (amountL != null) body.amountL = amountL;
    if (expectedSr != null) body.expectedSr = expectedSr;
    try {
      const r = await fetch(base() + '/team/bid', {
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

  g.Bus = {
    ROOM, base, fmtL, esc, getJSON,
    createRoom, roomInfo,
    connect, state, command,
    joinTeam, releaseTeam, teamBid, teamsAuth, regenPin,
    toast, connBadge,
  };
})(window);
