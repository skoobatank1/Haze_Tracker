# CLAUDE.md — CheckHaze (Haze Tracker repo)

Read `PROJECT.md` first: it is the full project summary (structure, panels, data sources, open items, change log).

## Rules for every change

1. **Update `PROJECT.md` in the same commit.** Edit the affected section(s) (layout, panels, sources, open items) and add a dated line to the Change log. Update the "Last updated" date. A change isn't done until PROJECT.md reflects it.
2. **Bump cache-bust versions** in `v2/index.html` (`style.css?v=N`, `app.js?v=N`) for whichever file changed, and record the new numbers in PROJECT.md.
3. **Update the Methodology overlay** (`v2/index.html`) when a data source, calculation, threshold or limitation changes.
4. **Work in `/v2/` only.** v1 (repo root) is frozen.
5. **Desktop layout is settled.** Phone-only changes go inside the `@media (max-width: 760px)` block. After layout changes, re-check desktop (e.g. 1366×768 and 1700×870) as well as phones (390px and 360px, via an iframe harness).
6. **No invented data.** Verify any external source before using it; if a value can't be verified, show nothing or a plain error.
7. Commit or push only when the owner asks.
