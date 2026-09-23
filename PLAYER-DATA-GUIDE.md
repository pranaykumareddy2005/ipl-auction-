# Player Data Guide — IPL Auction 2026

This is how you load the **full player list** (details, prices, highlights, photos, and
optional career stats) into the auction app.

You edit **one spreadsheet**, run **one command**, and restart the server. That's it.

---

## 1. Open the template

Open **`data/players-template.csv`** in **Excel** or **Google Sheets**
(File → Open, or drag it in). It already contains all **625 players** so you can edit
in place and add new rows at the bottom — you don't start from scratch.

When you're done, **save it as `data/players.csv`** (keep it as CSV / comma-separated).

> Tip: In Excel, use *Save As → CSV UTF-8 (Comma delimited)*.

---

## 2. The columns

| Column | Required? | What to put | Example |
|---|---|---|---|
| `sr` | for existing players | The player's serial number (unique ID). **Leave blank for a new player** — one is assigned automatically. | `11` |
| `name` | **yes** | Player's full name | `Jasprit Bumrah` |
| `country` | yes | Country. Anyone **not `India`** counts as **overseas**. | `India`, `Australia` |
| `role` | yes | One of: `BATTER`, `BOWLER`, `ALL-ROUNDER`, `WICKETKEEPER` | `BOWLER` |
| `capped` | yes | One of: `Capped`, `Uncapped`, `Associate` | `Capped` |
| `base` | yes | Base / starting price. Write it plainly with the unit. | `2 Cr`, `30 L`, `1.5 Cr` |
| `category` | optional | Force a display category/colour. Leave blank to auto-pick from role. Codes: `M` marquee, `BA` batter, `WK` keeper, `AL` all-rounder, `FA` pace, `SP` spin (add `U` prefix for emerging: `UBA`…). | `M` |
| `last_ipl_team` | optional | Shown as "Last IPL side" on the big screen | `Mumbai Indians` |
| `highlights` | optional | Key highlights shown on screen. **Separate multiple with a `|`**. | `2022 T20 WC winner \| IPL 2022 Orange Cap` |
| `matches` | optional | Career matches (broadcast stat strip) | `120` |
| `runs` | optional | Career runs | `1326` |
| `strike_rate` | optional | Batting strike rate | `137` |
| `wickets` | optional | Career wickets (for bowlers) | `145` |
| `economy` | optional | Bowling economy | `7.4` |
| `average` | optional | Batting/bowling average | `31.2` |

**Money format for `base`:** write `2 Cr`, `1.50 Cr`, or `30 L`. A plain number
(like `200`) is read as **lakhs**. (100 Lakh = 1 Crore.)

**Stats are optional.** If you fill them, the big screen shows a real broadcast-style
strip (`MTS · RUNS · SR · WKTS…`). If you leave them blank, it shows the player's
role/country/category instead — nothing breaks either way.

---

## 3. Photos (optional)

Put a photo for a player in the **`data/photos/`** folder, named by that player's
**`sr` number**, as a **`.jpg`**:

```
data/photos/1.jpg     ← player with sr 1  (Jos Buttler)
data/photos/11.jpg    ← player with sr 11 (Jasprit Bumrah)
```

Square-ish images look best (they're shown in a circle). Players without a photo show a
neat silhouette placeholder. Photos are picked up when the server (re)starts.

---

## 4. Load it into the app

From the project folder (`C:\Users\pranay\Desktop\ipl auction`), run:

```
node scripts/import-csv.js
```

It reads `data/players.csv`, checks it, and rebuilds `data/players.json`. It will tell you
how many players, stars and stats it loaded — or point out any problem rows (e.g. a
duplicate `sr`).

Then **restart the server** so it loads the new data:

```
node server.js
```

Refresh the screens — your full player list is live.

---

## 5. Common tasks

- **Add a new player:** add a row at the bottom, fill everything **except `sr`** (leave it
  blank — a number is assigned). Then re-import.
- **Remove a player:** delete their row, then re-import. *(Do this before the auction
  starts — removing someone already auctioned would break the record.)*
- **Change a base price / fix a name:** edit the cell, save, re-import, restart.
- **Start the whole list from scratch:** delete every row except the header, add your own.

> Keep a backup of your filled `data/players.csv` — that's your master. `players.json` is
> generated from it and can always be rebuilt by re-importing.
