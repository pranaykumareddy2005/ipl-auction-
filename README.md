# IPL Auction 2026 — Live Auction Console

A **server-authoritative, event-sourced** auction system for running a real, physical
IPL-style auction event. One operator drives the room, a big screen shows the block,
and every team tracks its purse in real time. Built with **zero npm dependencies** —
just Node.js — so it runs reliably on a single laptop with no build step.

## Quick start

```bash
node server.js
```

Then open, on the same machine or any device on the same Wi-Fi (use the laptop's
LAN IP instead of `localhost` for other devices):

| Screen | URL | For |
|---|---|---|
| **Role picker** | `http://localhost:3000/` | Landing page |
| **Operator console** | `http://localhost:3000/operator.html` | You — running the auction (needs the key) |
| **Presentation** | `http://localhost:3000/presentation.html` | Projector / big screen |
| **Team view** | `http://localhost:3000/team.html` | Each franchise table (phone/tablet) |
| **Report** | `http://localhost:3000/report.html` | Final squads + spending |

**Operator key:** `ipl2026` (change with `AUCTION_OP_KEY=yourkey node server.js`).
**Port:** 3000 (change with `PORT=3001 node server.js`).

## Running an event — the flow

1. **Operator → Teams & Budget:** 10 IPL teams are pre-filled; edit names/colors/owners,
   set purse (₹120 Cr default), squad max, overseas max, and bid timer. **Save**.
2. **Player Pool:** add players to the auction queue (all 625, by category, marquee-first,
   or search). Reorder with ▲▼, shuffle, or reverse. **▶ Start Auction**.
3. **Live:** **Call next** puts a player on the block. When a team raises its card, tap
   that team's button to register the bid (bid rises by the standard IPL step; timer
   resets). Tap **SOLD** to award to the leader, or **UNSOLD / HOLD / SKIP**.
4. **Corrections:** **Undo last**, **Correct bid** (wrong team/amount), **Reopen** a sold
   player (auto-refunds the purse), **Adjust purse**, **Pause/Resume**.
5. **Unsold round:** after the main pool drains, start a second round for unsold players.
6. **Complete** → open the **Report** for squads, top buys, spending, and CSV/JSON export.

**Operator keyboard shortcuts:** `1`–`9`,`0` = bid for team 1–10 · `Enter` = SOLD ·
`Space` = call next · `U` = undo.

## Why it's safe for a live event

- **Server is the single source of truth.** Every screen renders only what the server
  sends over a live stream (SSE). Clients never invent state.
- **Every action is validated server-side:** no bid below the next increment, no team
  bidding against itself, no team over-spending its purse, no selling a full squad, no
  player owned by two teams.
- **Event-sourced + durable.** Every change is appended to `data/events.log` and flushed
  to disk (`fsync`) before it's acknowledged. **If the server crashes or the laptop loses
  power, restarting replays the log and restores the exact state** — mid-auction, mid-bid.
- **Nothing is ever destroyed.** Undo / correct / reopen are recorded as new events that
  *void* prior ones, so the full audit history stays intact.
- **Reconnects are automatic.** Close and reopen any screen (or refresh the operator) and
  it resyncs instantly to the authoritative state.

## Data

- `auction-data.json` — original 577-player master (name, role, country, capped status, base).
- `data/ipl2025-squads.txt` — the real IPL 2025 squads (source).
- `scripts/prepare-data.js` — merges them into **`data/players.json` = 625 players**
  (577 + 48 retained stars). **IPL 2026: no retentions, nobody pre-assigned.**
  Re-run with `node scripts/prepare-data.js` if you edit the sources.
- Money is stored in **lakhs** internally (100 L = ₹1 Cr).

## Verify it works

```bash
node scripts/simulate.js
```

Runs a full end-to-end simulation — 10 teams, 100 players, 500+ bids, reordering, skips,
holds, unsold round, reopen (with refund check), undo, purse corrections, pause/resume,
and a simulated **server restart** — then asserts every integrity invariant (purses exact,
single ownership, no backwards bids, queue consistency, byte-identical recovery).

## Project layout

```
server.js              HTTP + SSE server, command endpoint, recovery on boot
lib/
  money.js             lakh/crore formatting + bid increments
  events.js            event types + factory
  reducer.js           pure event-log → state (honors UNDO voids)
  commands.js          all write validation (the integrity gate)
  selectors.js         team financials / overseas counts
  store.js             durable append-only event log (fsync)
  engine.js            authoritative auction: dispatch, snapshot, recovery
  players.js           player master loader
public/
  index / operator / presentation / team / report .html
  operator.js, bus.js, app.css
scripts/
  prepare-data.js      build data/players.json
  simulate.js          full end-to-end test + invariant checks
data/
  players.json         merged 625-player master
  events.log           runtime event log (safe to delete to reset an auction)
```

**To reset for a fresh auction:** stop the server and delete `data/events.log`.
