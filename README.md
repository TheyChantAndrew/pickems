# Fam Bash Pickems

NFL pick'em for Fam Bash. The live site is [fambash-pickems.vercel.app](https://fambash-pickems.vercel.app/), deployed from the Vercel project `andy-rodriguez/fambash-pickems`.

## Stack

- Static pages in `public/` (no build step). Vercel serves that directory.
- Node 22 serverless functions in `api/`, region `pdx1` (`vercel.json`).
- Turso (libSQL) via `@libsql/client`. Picks, the live week, and imported slates live there.
- ESPN's public scoreboard for the schedule and live scores. No cron job.

## How a week works

1. Andy opens `/admin` and loads a week from ESPN (`POST /api/admin/paid` with `load_espn`). That writes the slate to Turso `meta` under `week_data:<week>`. `make_current` sets `meta.current_week`.
2. If Turso has no slate, `data/weekN.json` is the fallback.
3. `/submit` calls `GET /api/games`, then saves picks with `POST /api/submit`. Picks are rows in `entries` (JSON picks, tiebreaker, edit-code hash, paid, void).
4. The board (`public/index.html` + `public/live.js`) polls `GET /api/games?board=1`, which joins those picks with the ESPN scoreboard.
5. Submissions lock from `/admin` (`meta` key `picks_lock:<week>`), not at kickoff.

Kickoff labels and the Monday flag use `America/Los_Angeles`. A Monday night game is often already Tuesday in UTC; it still counts as Monday.

## Monday picks

Monday games (including a week with two of them) stay hidden until every earlier game is final. The last Monday game is the tiebreaker. That used to be a `sunday_final` flag stored on the slate. ESPN imports always store `false`, and nothing updated it, so Monday picks never came back.

The board now decides this when it reads the week: if ESPN shows every non-Monday game final, or the scoreboard is missing and the clock is 4 hours past the last of those kickoffs, Monday picks are shown. A game ESPN still has in progress keeps them hidden. Nothing is written back to Turso. The later Monday game stays the tiebreaker when there are two.

## Env

Required on Vercel:

- `TURSO_DATABASE_URL` (`libsql://...` or `https://...`)
- `TURSO_AUTH_TOKEN`

Optional:

- `ESPN_SCOREBOARD_URL` — override the ESPN scoreboard base URL
- `ADMIN_TOKEN_SHA256` / `PORTAL_TOKEN_SHA256` — rotate the admin or portal token without a code change
- `PICKEMS_DATA_DIR` — override the fallback `data/` directory

`node scripts/migrate.mjs` creates the tables. The functions also migrate on their first request. Deploy is a Vercel push of this repo; there is no separate build.
