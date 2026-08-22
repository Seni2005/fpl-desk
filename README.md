# FPL Desk

A personal Fantasy Premier League planner that lives at its own URL, updates itself, and costs nothing to run.

It shows your squad, flags injuries and suspensions, tracks which players are drifting toward a price rise or fall, ranks transfer targets, and lays out fixture difficulty for the next five gameweeks.

## How it works

The FPL API sends no CORS headers, so a web page cannot call it directly from a browser. This project gets around that by doing the fetching on GitHub's servers instead:

```
GitHub Actions (every 3 hours)
  └─ scripts/fetch.mjs  ── calls the FPL API, builds a compact snapshot
       └─ data/snapshot.json  ── committed back to the repo
            └─ index.html  ── reads it from the same origin, renders everything
```

Everything the page shows is computed in your browser from that one snapshot file, so it loads instantly and works offline once cached.

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

## A note on the price watch

FPL does not publish the thresholds that trigger a price change. This estimates the pressure on a player from net transfers measured against how many managers own them, which is the same signal the public prediction sites use. It is a good early warning and it is not a guarantee — treat a full bar as "likely tonight", not "certain".

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

## Troubleshooting

**Page says "waiting on the first data refresh"** — the workflow hasn't run yet. Actions → Run workflow.

**Workflow fails with a permissions error** — Settings → Actions → General → Workflow permissions → **Read and write permissions**.

**Scheduled runs stopped** — GitHub pauses schedules on repos with no activity for 60 days. Any commit, or one manual run, wakes it up.

**Squad panel is empty but everything else works** — `config.json` still has `"teamId": null`, or the ID has a typo. It should be a bare number with no quotes.
