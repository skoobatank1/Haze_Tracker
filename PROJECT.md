# CheckHaze — Project Summary

A live Singapore haze dashboard: current PSI/PM2.5 by region, NEA's official forecast and health advisory, wind, trends, and haze news, all on one page.

> **Keep this file current.** Every change to the site should update the relevant section(s) below and add a line to the [Change log](#change-log). See `CLAUDE.md`.

_Last updated: 2026-10-31_

---

## Links

| What | URL |
|---|---|
| Live site (v2, current build) | https://skoobatank1.github.io/Haze_Tracker/v2/ |
| v1 (frozen original) | https://skoobatank1.github.io/Haze_Tracker/ |
| Repo | https://github.com/skoobatank1/Haze_Tracker |
| Analytics (GoatCounter dashboard) | https://checkhaze.goatcounter.com |

Hosting is **GitHub Pages** from the `main` branch. A push to `main` goes live in roughly 30–90 seconds.

## Structure

```
/                 v1 — original build, frozen. Do not change.
  index.html, css/style.css, js/app.js
/v2/              v2 — the live, actively developed build ("CheckHaze")
  index.html      page structure + Methodology & Sources overlay
  css/style.css   all styling, incl. the phone layout (<=760px)
  js/app.js       all data fetching and rendering
PROJECT.md        this file
CLAUDE.md         working rules for Claude Code sessions
```

- No build step and no backend: plain HTML/CSS/JS, served statically.
- External libraries: Chart.js 4.5.1 (cdnjs) and Google Fonts (DM Sans, DM Mono).
- **Cache-busting:** `v2/index.html` loads `css/style.css?v=N` and `js/app.js?v=N`. Bump N whenever that file changes, or visitors get stale files. Current: CSS `v=43`, JS `v=40`.

## Name

- **v2 display name:** "CheckHaze", used in the page title, header and browser tab ("98 · CheckHaze").
- **URL unchanged:** the site address still uses the old `Haze_Tracker` repo name (owner's decision, 2026-10-31).
- **v1:** keeps "Singapore Haze Tracker".

## Layout

### Desktop (>760px): single screen, no scrolling

A 12-column grid, with every panel sized to fit the viewport and no panel scrollbars.

| Columns 1–9 (three rows of panels) | Columns 10–12 |
|---|---|
| PSI Min/Max/Range · Nowcast · Latest Headlines | **Personal Advisory** (spans all 3 rows) |
| Wind · PSI Forecast · Regional Map | |
| 7/14/21-Day Trend (wider) · 24-Hour Trend | |

- **Header:** CheckHaze title; a scrolling marquee of all 5 regions' PSI (22px numbers) next to the hourly ▲/▼ trend badge; live humidity; SGT clock; heartbeat dot.
- **1100px and narrower:** two panels per row.
- **Short screens (≤820px tall, desktop widths only):** Nowcast and Range spacing tightens and headlines clamp to one line.

### Phones (≤760px): stacked and scrollable

The one-screen rule is dropped and panels stack in one column at their natural height, in this order:

1. Nowcast
2. PSI Forecast (titled "PSI Forecast (24h)", subheader hidden)
3. Wind
4. PSI Min/Max/Range
5. Personal Advisory (full 4-column table)
6. Trend
7. 24-Hour Trend
8. Headlines
9. Regional Map

Other phone-only rules:
- Nowcast band labels sit on their own line so the PSI and PM2.5 columns align.
- Chart status lines are clamped to 3 lines.

## Panels

| Panel | What it shows | Source |
|---|---|---|
| **Header marquee** | Live 24-hr PSI for each of the 5 regions, scrolling; pauses on hover | NEA PSI API |
| **Hourly trend badge + favicon** | Current reading vs the previous hourly reading. Favicon: red ▲ worsening, green ▼ improving, grey bar if exactly flat, band-coloured dot only until the first trend exists. Fetched at startup (1 call) so the arrow appears within seconds | NEA PSI API |
| **PSI Min, Max, Range** | True min/max across all 5 regions over the last 24h and last 7 days, with the current island average marker. PSI only | NEA PSI history |
| **Momentum badge** | Mean PSI over the last 24h vs the previous 24h | Computed |
| **Nowcast** | Island-average PSI (24-hr) and PM2.5 (1-hr) with their band, plus a per-region bar list (worst first). ⚠ marks a region more than 25 PSI / 30 µg/m³ above average. Shows "Driven by X" if a non-PM2.5 pollutant dominates | NEA PSI + PM2.5 APIs |
| **Latest Headlines** | Singapore-only haze news, newest first, as many as fit. Kept if ST files it under `/singapore/` or the title names Singapore/S'pore | The Straits Times haze-tag RSS (CORS-open, fetched directly) |
| **Personal Advisory** | NEA's official 24-hr PSI advisory table: 5 bands × 3 groups (Healthy; Elderly/Pregnant/Children; Chronic lung/heart disease), exact NEA wording. The row matching the current live PSI is highlighted. The font auto-fits (11.5px max, shrinks only if needed) | NEA advisory guide (hard-coded text) |
| **PSI Forecast** | NEA's published forecast gauge image (a range, e.g. "51–70"), shown whole. The image URL is discovered live from the haze.gov.sg homepage HTML (CORS-open), picked by keyword and position (NEA renames these files every few days; see Open items). The "Advice:" band tag comes from the advisory image's filename and shows only when that filename names a band. NEA's alt text is **not** used as data (it has been stale) | haze.gov.sg |
| **Wind** | Live mean direction/speed (km/h) with a spinning windmill and a **compass arrow** (top-right) pointing where the wind blows to; the arrow turns red for W–SW (Sumatra) winds. Also a 24h temperature/humidity forecast strip and a 3-day outlook sentence | NEA wind + forecast APIs |
| **Regional Map** | Link-out to ASMC's live map (no embeddable map exists) | asmc.asean.org |
| **Trend chart** | PSI and PM2.5 hourly lines. **7D / 14D / 21D toggle, 14D default.** Beyond 14 days the x-axis labels every 2nd day | NEA PSI + PM2.5 history |
| **24-Hour Trend** | Same, last 24h, anchored to the latest real reading | NEA history |
| **Methodology (ℹ button)** | Full disclosure of every source, calculation and limitation | — |

### NEA API endpoints (data.gov.sg)

- `api.data.gov.sg/v1/environment/psi` — PSI and sub-indices (live and `?date=` history)
- `api-open.data.gov.sg/v2/real-time/api/pm25` — PM2.5 (live and history)
- `.../relative-humidity`
- `.../wind-direction`
- `.../wind-speed`
- `.../4-day-weather-forecast`
- `.../24-hour-weather-forecast`

### Refresh cadence

| Data | Refresh |
|---|---|
| Live PSI/PM2.5 | 5 min |
| Weather / wind | 5 min |
| History | 15 min. Default window is 14 days; 21D is fetched lazily on first toggle and stays loaded for the session. Past days are cached after their first fetch (even an empty one), so only today and yesterday are refetched |
| Hourly trend | At startup, then 15 min |
| Forecast | Discovery result cached per calendar day (localStorage); a forced, cache-bypassing re-check runs hourly |
| Headlines | 20 min |

## Principles (how this project is built)

1. **No invented data.** If a figure can't be fetched or verified, show nothing or a plain error; never a guess. The forecast is shown as NEA's own image because the number exists nowhere as text or readable pixels.
2. **Disclose everything** in the Methodology overlay, including sources, computed (non-NEA) figures such as averages, thresholds that are our own choice, and known limitations.
3. **Desktop is one screen with no scrollbars.** On phones it is a scrollable stack. Phone-only changes go inside the `@media (max-width: 760px)` block so the desktop layout can't move.
4. **v1 stays frozen.** All work happens in `/v2/`.

## How to test locally

```bash
# from the repo root
python -m http.server 8765 --bind 127.0.0.1
# open http://127.0.0.1:8765/v2/
```

- **Phone widths:** headless Chrome won't make windows narrower than about 500px, so test phones by loading the page in a 390px- or 360px-wide `<iframe>` inside a temporary harness page.
- **Desktop sizes checked so far:** 1280×720, 1366×768, 1600×900, 1700×840/870, 1920×1080.

## Open items / known limitations

- **Analytics covers v2 only.**
  - **Setup:** GoatCounter (site code `checkhaze`), script just before `</body>` in `v2/index.html`. Free for reasonable personal use and cookie-free, so no consent banner (per goatcounter.com, 2026-10-31).
  - **Start date:** counting starts from the push that added it (2026-10-31); earlier visits can't be recovered.
  - **Ad-blockers:** visitors with ad-blockers may not be counted.
  - **v1:** not tracked.
- **NEA forecast file naming is unstable.**
  - **Gauge names seen so far:** `chart_1_19-oct.png`, `chart_20-oct.png`, `psi-forecast_2026-10-31.png`.
  - **Advisory names seen so far:** `unhealthy_19-oct.png`, `table-of-advice_20-oct.png`, `psi-advisory_good---moderate-(2).png`.
  - **How discovery copes:** it matches by keyword and position, and accepts both date styles and `-(n)` suffixes. If NEA changes the page again, the panel shows a plain "not recognised, see haze.gov.sg" message and `discoverForecastImages()` in `v2/js/app.js` needs updating.
  - **Advice tag:** shows nothing when the filename has no band (e.g. `table-of-advice_…`).
- **NEA alt text is unreliable:** on 31 Oct it said "70–100 … 26 October" while the image showed 51–70 for 31 Oct. Never use it as data.
- **PM2.5 rate limiting:** NEA's PM2.5 endpoint throttles bursts. Older days in the trend chart can show gaps, and the status line lists them. The first page load makes up to ~28 history calls (14 days × 2); selecting 21D for the first time in a session adds up to ~14 more.
- **Tooltips on phones:** hover-only details (exact values, region sources) aren't available on most touch browsers.
- **Headlines filter:** a rule, not curation. A Singapore story filed outside `/singapore/` without "Singapore" in the title is missed.
- **No probabilistic forecast model** has been built (an earlier idea).

## Change log

Newest first. One line per change; add to it with every update.

- **2026-10-31 (later)**
  - History fetch now loads only the default 14-day window on page load; the extra week for 21D is fetched lazily on first selection of that toggle (and cached for the rest of the session) — most visitors never select it, so this cuts their NEA call volume by a third.
  - Day-cache bug fix: a historical day that genuinely has zero NEA data points is now cached on first fetch like any other day, instead of being silently re-fetched on every 15-minute reload forever.
  - PSI Forecast's homepage scrape (`discoverForecastImages()`) is now cached per calendar day in localStorage; repeat page loads/reloads on the same day reuse it instead of re-scraping haze.gov.sg. The hourly background re-check still bypasses the cache to catch same-day changes or the next day's rollover.
- **2026-10-31**
  - Display name changed to **CheckHaze** (v2 only; URL unchanged).
  - Trend chart gains a **21D** option (7D / 14D / 21D, 14D default). History fetch extended to 21 days; the chart redraws as each window completes; x-axis labels every 2nd day beyond 14 days.
  - Added PROJECT.md and CLAUDE.md.
  - Added GoatCounter visitor analytics to v2 (`checkhaze.goatcounter.com`), with a Methodology note.
  - Fixed PSI Forecast after NEA renamed its images (`psi-forecast_2026-10-31.png`): discovery is now keyword/position-based, accepts both date styles and `-(2)` suffixes, and shows an accurate error. The Advice tag works again ("Good to Moderate").
  - Fixed Range min/max labels overlapping ("5571") when values are close: they now sit either side of their ticks.
- **2026-10-19**
  - Mobile: Nowcast band labels aligned.
  - Mobile: panel order changed (Wind after Forecast, Range above Advisory); forecast title shortened to "PSI Forecast (24h)".
  - Stacked, scrollable phone layout (≤760px); desktop unchanged.
  - Trend default switched to 14D; favicon arrow now fetched at startup (grey bar when flat); advisory font back to 11.5px; headline/advisory refit after font load.
  - Wind compass arrow; larger marquee numbers.
  - 7D/14D trend toggle with day caching; PSI-only range; rain indicator removed; Nowcast footer removed and band moved inline.
  - Forecast now discovered from haze.gov.sg HTML (old guessed filename always 404'd); headlines switched to ST haze-tag feed, Singapore-only; 3-across grid; advisory spans full height; marquee dot removed.
- **2026-10-18**
  - v2 branched off as a copy of v1 under `/v2/`.
  - Restructure (full advisory table, forecast, regional map, headlines, scrolling regional ticker, triangle favicon, single-viewport layout).
- **2026-10-17**
  - v1 built: live readings, nowcast, personal advisory, trend charts, wind, live-feel touches, methodology overlay.
