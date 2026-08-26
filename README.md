# FPL Desk

A personal Fantasy Premier League planner that lives at its own URL, updates itself, and costs nothing to run.

## What's on it

- **Your squad** on a pitch, in your actual formation, with the bench below — each player showing their gameweek points and their next three fixtures, plus captain and vice armbands, injury pins and price-movement arrows.
- **Your leagues** - every mini-league you're in with your position and how it moved. Tap one for the table, with your row highlighted.
- **Planner** - try transfers against your real budget. It counts your hits, enforces the squad rules, and tells you whether the move is worth it.
- **Worth a look** - shortlists pulled out of the data: in form, best value, kind fixtures, differentials, budget enablers.
- **Any player, in detail** - click a name anywhere on the page for previous-season points, this season's gameweek-by-gameweek trend, underlying numbers and upcoming fixtures.
- **Price watch**, **transfer targets**, **fixture ticker** and the **injury board**.

## How it works

The FPL API sends no CORS headers, so a web page cannot call it directly from a browser. This project gets around that by doing the fetching on GitHub's servers instead:

```
GitHub Actions (every 3 hours)
  └─ scripts/fetch.mjs  ─ calls the FPL API, builds a compact snapshot
       ├─ data/snapshot.json  ─ players, teams, fixtures, your squad
       └─ data/details.json   ─ season-by-season history
            └─ index.html  ─ reads both from the same origin, renders everything
```

Everything the page shows is computed in your browser from those two files, so it loads instantly and works offline once cached.

Season history is one API call per player, so it is pulled for your fifteen plus the 180 most-owned players rather than all 700. Click a player outside that set and the panel says so rather than inventing numbers.

## Setting it up

**1. Create the repository**

Go to [github.com/new](https://github.com/new). Name it `fpl-desk`. Set it to **Public** — GitHub Pages and unlimited Actions minutes are free on public repos, and there is nothing private here. Don't add a README; you already have one.

**2. Upload these files**

On the empty repo page, click **uploading an existing file**, then drag in the whole contents of this folder — `index.html`, `config.json`, `README.md`, and the `scripts` and `.github` folders. Commit.

If you'd rather use a terminal:

```bash
cd fpl-desk
git init && git add -A && git commit -m "FPL Desk"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/fpl-desk.git
git push -u origin main
```

**3. Turn on Pages**

**Settings → Pages**. Under *Source* choose **Deploy from a branch**, branch `main`, folder `/ (root)`. Save. After a minute your page is live at:

```
https://YOUR-USERNAME.github.io/fpl-desk/
```

**4. Run the first refresh**

**Actions** tab → **Refresh FPL data** → **Run workflow**. If Actions asks you to enable workflows on a new repo, approve it. The job takes about twenty seconds. Reload your page and the data is there.

**5. Add your team ID**

Log in at [fantasy.premierleague.com](https://fantasy.premierleague.com), click **Points**, and read the number out of the address bar:

```
fantasy.premierleague.com/entry/1234567/event/2
                                ^^^^^^^
```

Open `config.json` in your repo, click the pencil, and set it:

```json
{ "teamId": 1234567 }
```

Commit. Saving that file kicks off a refresh by itself, so your squad appears within a minute or two. Without it every other part of the page still works — you just don't get the squad panel or the "owned" markers.

## Day to day

- **It refreshes on its own** every three hours. FPL changes prices at about 01:30 UTC, and the 02:00 run picks that up.
- **To force a refresh**, go to Actions → Refresh FPL data → Run workflow.
- **Add it to your phone's home screen** and it behaves like an app.
- Your filter and sort choices are remembered in your own browser. They never leave your device.

## Reading the fixture chips

Each chip is one fixture: the opponent's three-letter code, then the difficulty.

**UPPER CASE means home, lower case means away.** So `LIV3` is home to Liverpool, `liv3` is away at Liverpool.

The colours run from easiest to hardest — bright green (1), green (2), grey (3), orange (4), red (5). The digit is there so the chips still work if the colours are hard to tell apart; every chip also has a hover label spelling the fixture out in full.

## Your leagues

Standings are pulled for the mini-leagues you've joined — up to eight of them, top 25 each. Global tables like Overall and your country run to millions of managers, so only your position in those is tracked, not a table.

If a mini-league has more than 25 members and you're further down, the page says where you actually are rather than leaving you off the list.

## A note on the Planner's budget

FPL sells a player back to you at your purchase price plus half of any rise since, rounded down. The API does not expose purchase prices without logging in, so the planner values your existing players at **today's market price**. For anyone you have held since the start that is exact; for someone who has risen since you bought them it can be optimistic by a tenth or two. If a plan lands within £0.2m of your budget, check it on the real site before committing.

Free transfers are also not exposed by the public API, so there's a box in the planner header to set them yourself. It defaults to 1 and remembers what you set.

## Reading the price watch

Every player with movement is listed, not just the top few. Each row carries:

| Column | What it is |
|---|---|
| Price | What they cost right now |
| Season | Change since the season started |
| Progress | How close they are to the next change, signed. Positive is toward a rise |
| Status | Steady, rising, falling, or due |
| Owned | Share of all managers who have them |
| Own Δ | How that ownership shifted this gameweek, in percentage points |
| Net transfers | Transfers in minus transfers out this gameweek |

The bar is anchored at zero in the middle, with a hairline on each side marking 100% — the point a change becomes likely. That lets you see how far *past* due someone is, not just that they are past it. Full width is 200%.

FPL does not publish the thresholds that actually trigger a change, so progress is an estimate built from net transfers measured against ownership — the same signal the public prediction sites use. Treat "due" as likely tonight, not certain.

On a phone the table drops to player, price and progress rather than scrolling sideways.

## About the design

Colour on this page only ever means something: fixture difficulty, price direction, and availability. Everything else is ink on paper, separated by rules rather than cards. If something is coloured, it is data.

Contrast for every coloured chip was checked against a 4.5:1 target in both themes, and the difficulty chips print their number so they still read if the colours are hard to tell apart.

## A note on the Desk score

It is an estimate of points per gameweek, which is what lets a keeper and a striker sit in the same ranking. It blends the FPL model's expected points, the player's season average and recent form, then adjusts for the next five fixtures and for how reliably the player starts. Early in a season it leans heavily on the model, because two good games is not evidence.

It knows nothing about press conferences, rotation risk in a cup week, or who has just been handed penalties. Use it to build a shortlist, then apply what you actually know about the football.

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole dashboard — one file, no build step, no dependencies |
| `scripts/fetch.mjs` | Pulls the FPL API and writes the snapshot |
| `.github/workflows/refresh.yml` | The schedule that runs the fetch |
| `config.json` | Your team ID |
| `data/snapshot.json` | Generated. Never edit it by hand |
| `data/details.json` | Generated. Season-by-season history |

## Troubleshooting

**Page says "waiting on the first data refresh"** — the workflow hasn't run yet. Actions → Run workflow.

**Workflow fails with a permissions error** — Settings → Actions → General → Workflow permissions → **Read and write permissions**.

**Scheduled runs stopped** — GitHub pauses schedules on repos with no activity for 60 days. Any commit, or one manual run, wakes it up.

**Squad panel is empty but everything else works** — `config.json` still has `"teamId": null`, or the ID has a typo. It should be a bare number with no quotes.
