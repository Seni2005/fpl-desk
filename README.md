# FPL Desk

A personal Fantasy Premier League planner that lives at its own URL, updates itself, and costs nothing to run.

## What's on it

**The page opens by telling you what to do.** Which eleven to start, who to captain and
vice, the bench order, the one transfer worth making, expected points, the hit it would
cost, how confident the recommendation is, and the biggest risk you are carrying. Every
answer has a **Why?** that unfolds the evidence behind it.

- **A gameweek banner that knows where the round is.** Three states, not two: *live* while matches are on with the count played and in play, *final* once every match is done — which is most of the week, and where your gameweek points now stay — and *upcoming* once the next deadline passes and there is nothing to score yet. Every recommendation is tagged with the gameweek it applies to, so live points and next week's advice never get confused.
- **Matches** — every Premier League fixture in the round, grouped by calendar day **in Sydney time**, with kickoff times, live clocks and scores where they exist, difficulty colouring on both clubs, and a marker on every match involving one of your players.
- **Team health** — a 0-100 composite across expected points, fixtures, minutes security, value, injury risk and bench strength, with the weakest component named.
- **Decision / Analyst modes** — the same terminal at two densities. Decision answers the question in plain language with colour-coded badges (🔥 high goal threat, 🎯 chance creator, 🚑 flagged) that each print the number they came from. Analyst adds the full tables of xGI, xPts, fixture difficulty and simulated distributions, and unfolds every raw dump. Nothing is deleted in either direction. The switch sits in the sticky header and is remembered between visits.
- **Planner** — plot transfers across the next six gameweeks, run a Plan A against a Plan B, and see which is worth more once hits are paid. A first visit opens a four-step walkthrough.
- **The formation sandbox** — the planner's editing surface is a pitch. Pick a gameweek, tap any player to get a ranked list of affordable replacements, **or search the whole league by name or club** for someone specific. Watch the bank update as you stage moves. Play a **Wildcard, Free Hit, Triple Captain or Bench Boost** and the projection recalculates immediately: free transfers for the week, a tripled armband, or all fifteen counting. One of each chip, one week at a time.
- **What changed** — price moves, availability, form and ownership swings since the previous refresh, with your own players marked.
- **Your squad** on a pitch in your actual formation, with its own status line saying whether the round is updating, final, or not started, and how fresh the numbers are. Each card carries its gameweek score — the captain's doubled and shown with the working (`👑 24 pts` over `12 pts × 2`) — and **keeps it until the next deadline**, with the next three fixtures colour-coded underneath the whole time. Injury pins and price arrows throughout.
- **Your leagues** — every mini-league you're in with your position and how it moved. Tap one for the table, your row highlighted.
- **Targets** — every player scored six ways (Overall, Short, Long, Value, Differential, Captain), each column sortable, each row carrying a sparkline of the last ten gameweeks and a caret that expands **in place** to fourteen underlying numbers (xG/90, xA/90, xGI/90, xGC/90, xMin, starts, BPS, defensive actions, ownership, EO, net transfers…) with a plain-language explanation on each.
- **A price-against-points scatter** above the table, with both axes named in words, a median-value diagonal you read positionally, and a tooltip on every point. It follows the filters, so it always describes the list beneath it.
- **Any player, in detail** — click a name anywhere for a breakdown of exactly why the algorithm rates him, what its main concern is, a simulated distribution for the next gameweek, previous seasons and upcoming fixtures.
- **Price watch** with the financial impact on you, **fixture ticker** with swing markers, and the **injury board**.

## How it works

The FPL API sends no CORS headers, so a web page cannot call it directly from a browser. This project gets around that by doing the fetching on GitHub's servers instead:

```
GitHub Actions (every 3 hours; every 15 min during weekend match windows)
  └─ scripts/fetch.mjs  ── calls the FPL API; also diffs against the previous
       │                    refresh and appends to the time series
       ├─ data/snapshot.json  ── players, teams, fixtures, every squad, leagues
       ├─ data/details.json   ── season-by-season and per-gameweek history
       ├─ data/changes.json   ── what moved since the last refresh
       └─ data/timeline.json  ── one row per player per gameweek
            └─ js/engine.js   ── all the analysis. Pure functions, no DOM.
                 └─ js/ui.js  ── fetches, renders, wires. No analysis.
                      └─ index.html
```

**The engine and the interface are separate on purpose.** `js/engine.js` holds every
calculation — projections, the six scores, formation search, the simulator, plan
evaluation — as pure functions that take data and return data. It imports nothing and
touches no DOM, which means the same code runs in the browser and under `node --test`.
`js/ui.js` only fetches, renders and wires. If a calculation appears there, it belongs
in the engine instead.

```bash
npm test          # 73 unit tests over the engine
npm run refresh   # run the fetcher locally
npm run palette   # regenerate and re-verify the difficulty ramp
```

`npm run palette` is the one that matters if you ever touch the fixture colours:
it generates the five tiers at fixed lightness targets and then tries to break
them — text contrast, monotonic lightness, and monotonic lightness under three
colourblindness simulations. It prints PASS or FAIL. A FAIL is not shippable.

Tests run in CI on every push that touches `js/`, `tests/` or `scripts/`. They are
deliberately in a separate workflow from the data refresh, so a failing test never
stops the snapshot updating.

Season history is one API call per player, so it is pulled for everyone's fifteen plus the 180 most-owned players rather than all 700. Click a player outside that set and the panel says so rather than inventing numbers.

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
{ "teams": [ { "name": "Me", "id": 1234567 } ] }
```

Commit. Saving that file kicks off a refresh by itself, so your squad appears within a minute or two. Without it every other part of the page still works — you just don't get the squad panel or the "owned" markers.

## Sharing it with a friend

Add him to the same list:

```json
{ "teams": [
    { "name": "Seni", "id": 1234567 },
    { "name": "Alex", "id": 7654321 }
] }
```

Commit, and send him your normal link. With two or more people listed the page
opens by asking **whose team** — his name, his squad, his planner, his leagues.

- He needs no GitHub account and no setup. He gives you his team ID once; that
  is the whole job.
- **It asks every visit rather than remembering.** On a link two people share, a
  remembered choice quietly shows you someone else's squad and you would not
  notice it was wrong.
- Choosing puts `?team=…` in the address bar, so you can copy that link and
  send it to someone to land them straight on their own squad.
- **Switch any time** with the name in the top-right of the header.
- Add as many people as you like. The heavy data — players, prices, fixtures,
  history — is fetched once no matter how many of you there are; each extra
  person costs three API calls plus one per mini-league.

A note on what this exposes: FPL squads are already public — anyone can look up
any team ID on the FPL site — so a shared link shows nothing that was private to
begin with. Nobody can change anyone's team from here either; the planner is a
sandbox and never touches the real thing.

**If he'd rather have his own copy**, he can fork the repo, put only his own ID
in `config.json`, and follow steps 1–5 above. He gets his own URL and his own
refresh schedule, entirely separate from yours.

## Day to day

- **It refreshes on its own** every three hours, and every fifteen minutes on Saturdays and Sundays between 11:00 and 22:00 UTC, when matches are actually being played. FPL changes prices at about 01:30 UTC, and the 02:00 run picks that up.
- **Live scores are as fresh as the last refresh, and the page says how fresh that is.** There is no server here, so the banner carries an "updated N minutes ago" stamp rather than pretending to be a live ticker. During a match window that is usually under fifteen minutes old; overnight it can be a couple of hours. The page will never show you a minute marker like `(64')`, because it cannot honestly know one.
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

## The models, and what they assume

**Projections.** Every score is expected points per gameweek, which is what lets a
keeper and a striker sit in one ranking. Each player gets a projection for each of the
next six gameweeks, blending the FPL model's own expected points, his season rate and
recent form, then adjusting for that specific fixture and the chance he plays. A double
gameweek counts twice; a blank scores nothing.

**The six scores.** *Overall* averages five gameweeks. *Short* weights the next match
hardest. *Long* ignores form entirely and leans on the season rate plus underlying
numbers, so a player in a rough patch with a good run coming still reads well — and it
discounts by how long each availability flag typically keeps someone out, so a one-match
ban costs far less than an open-ended injury. *Value* is points per £10m. *Differential*
is what you gain on the average manager after his effective ownership. *Captain* is the
doubled return from the next gameweek alone.

**The simulator.** Point distributions are built up from the scoring events — goals and
assists sampled from per-90 rates, clean sheets from expected goals conceded, minutes
from the player's own record — rather than assuming a shape. That is where the haul and
blank probabilities come from.

**Rank impact rests on two estimates, and the page says so.** FPL does not publish
captaincy, so the share of managers captaining each player is inferred from ownership and
projected return. Turning a points edge into a rank movement also needs a distribution of
manager totals, which is assumed normal with an 18-point single-gameweek spread widening
over the season. Both are stated in the interface next to the numbers they produce.
Treat rank figures as directional.

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

**`DESIGN.md` is the full spec.** The short version:

It is a terminal, not a dashboard — a trading desk and a scoreboard, not a SaaS landing page. Three laws, all enforced by an automated audit that runs in both modes at four viewport widths:

1. **Colour is data.** Fixture difficulty, direction of travel, availability, and whether a match involves your players. Nothing is coloured for decoration, which is what makes a coloured pixel worth stopping on.
2. **Flat.** 1px rules, zero radius, zero shadow, zero gradient, zero blur. Depth is rule weight and ground value.
3. **Figures are monospace.** Every number is JetBrains Mono with tabular figures, so columns align and a changed digit shows without reading the whole value.

Dark charcoal by default on every machine — deliberately not wired to your OS setting, because an analysis surface should not change value because the clock rolled over. INVERT gives you the light mirror and it is remembered.

**The two modes differ by density and scope, not by style.** Decision hides the deep sections and folds the raw dumps away; Analyst restores them. Both are the same terminal. An earlier version made Decision a softer, card-based product and it read as two different apps.

The fixture difficulty ramp was generated in OKLCH at fixed lightness targets so brightness descends monotonically across the five tiers. That is the accessibility guarantee: under total colour loss the ramp still reads in the right **order**, which a hue-only scale cannot do. Verified against deuteranope, protanope and tritanope simulations, with every text pair clearing 4.5:1 — and each chip still prints its difficulty digit as a second encoding.

## Finding a specific player to bring in

Tapping a player in the sandbox opens the picker. It leads with a ranked
shortlist — same position, affordable, available, sorted by projected gain —
which answers *who should I get*.

The search box answers the other question: *can I have him?* It reaches every
player in the league, by surname or by club, and **nothing is filtered out**. A
picker that silently omits someone cannot tell you why he is missing, which is
exactly what you want to know when you have a name in your head. So results come
back in three bands:

| Band | What it means |
|---|---|
| **You can make now** | Right position, affordable, under the club limit, not already yours |
| **Blocked by money or the club limit** | Shown with how much short, or which club you are already full on — things you could clear by selling someone |
| **The rules won't allow** | Wrong position, or already in your squad. Nothing you can do about it |

Each blocked row keeps its name, price and projection and loses only its button,
with a short chip saying why and the full sentence on hover.

## Chips in the planner

The four FPL chips are modelled where they change the maths:

| Chip | What the planner does |
|---|---|
| Wildcard | That week's transfers cost nothing, and the new squad carries forward |
| Free Hit | That week's transfers cost nothing, and the squad reverts the following week |
| Triple Captain | The armband multiplier goes from ×2 to ×3 for that week only |
| Bench Boost | All fifteen players count that week, not the best eleven |

One of each per plan, one chip per week, and the projection recalculates the moment you tap. The chip you've spent in another week is shown disabled with the week it went into, rather than silently vanishing.

Chips are planned here, not played here — the planner never touches your real team. Play the chip on the FPL site when you've decided.

## A note on the Desk score

It is an estimate of points per gameweek, which is what lets a keeper and a striker sit in the same ranking. It blends the FPL model's expected points, the player's season average and recent form, then adjusts for the next five fixtures and for how reliably the player starts. Early in a season it leans heavily on the model, because two good games is not evidence.

It knows nothing about press conferences, rotation risk in a cup week, or who has just been handed penalties. Use it to build a shortlist, then apply what you actually know about the football.

## Files

| Path | What it is |
|---|---|
| `index.html` | Markup and styles |
| `DESIGN.md` | The design system: type, colour, layout, affordances, chart rules |
| `tools/palette.mjs` | Generates the difficulty ramp and proves it colourblind-safe |
| `tools/cvd.mjs` | The contrast and colour-vision simulation used to check it |
| `js/engine.js` | Every calculation. Pure, DOM-free, importable by Node |
| `js/ui.js` | Fetching, rendering, wiring. No calculations |
| `tests/` | Engine unit tests and a deterministic fixture |
| `scripts/fetch.mjs` | Pulls the FPL API and writes the snapshot |
| `.github/workflows/refresh.yml` | The schedule that runs the fetch |
| `config.json` | The team IDs of everyone who uses the page |
| `data/snapshot.json` | Generated. Never edit it by hand |
| `data/details.json` | Generated. Season-by-season history |

## Troubleshooting

**Page says "waiting on the first data refresh"** — the workflow hasn't run yet. Actions → Run workflow.

**Workflow fails with a permissions error** — Settings → Actions → General → Workflow permissions → **Read and write permissions**.

**Scheduled runs stopped** — GitHub pauses schedules on repos with no activity for 60 days. Any commit, or one manual run, wakes it up.

**You uploaded an update and the page looks unchanged** — look at the build number beside `FPL DESK` in the header. If it does not match the `<meta name="build">` in the `index.html` you uploaded, you are being served a cached page. Hard-refresh (Cmd/Ctrl + Shift + R), and check **Actions → pages-build-deployment** has actually finished; GitHub Pages can take a couple of minutes and its CDN a couple more. Every release bumps that number and the `?v=` on the scripts, so a half-updated site is not possible — only a fully stale one, which a refresh clears.

**Squad panel is empty but everything else works** — either you haven't picked a squad yet (use the name in the top-right), or `config.json` has no valid `id`. It should be a bare number with no quotes.

**A name is greyed out in the chooser** — that team ID failed to fetch on the last refresh, usually a typo in the ID. Everyone else is unaffected; fix the number and the next refresh picks it up.
