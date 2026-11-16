# cornerstone-oura

Cloudflare Worker that ingests Oura v2 data into BigQuery (`your-gcp-project.life_ops`).
Two cron cadences + an HTTP `/backfill` route for historical loads:

- **`*/30 * * * *`** — the 14-endpoint daily-summary poll (sleep/readiness/activity + the rest of the v2 surface).
- **`17 10 * * *`** (~06:17 ET) — the intraday heart-rate incremental (`/heartrate`), high-frequency so it runs daily.

`scheduled()` branches on `event.cron`; the two strings must stay in sync with `wrangler.toml [triggers].crons`.

## Design

- **Summary path (14 endpoints):** `/v2/usercollection/{daily_sleep,daily_readiness,daily_activity,sleep,daily_stress,daily_spo2,daily_resilience,daily_cardiovascular_age,vO2_max,workout,session,enhanced_tag,rest_mode_period,sleep_time}` + `personal_info` + `ring_configuration`.
  - HRV (ms), RHR (bpm), phase durations come from `/sleep` (NOT the daily-score endpoints).
  - 3-day trailing re-pull window each tick (Oura finalizes data ~1–2h after wake); cursor = KV `OURA_STATE.last_seen`.
  - Date convention: `day` = wake date in `America/New_York`.
- **Intraday HR path (`/heartrate`):** one row per sample → `raw_oura_heartrate`.
  - ⚠️ Ranges by `start_datetime`/`end_datetime` (ISO datetime), **NOT** `start_date`/`end_date` like the other 14.
  - Incremental re-pulls `[now − 48h, now]` daily; the 24h overlap + idempotent MERGE self-heals late samples.
  - `day` is **not** wake-date — it's `DATE(ts,'America/New_York')`, a partition-pruning convenience for a continuous series.
- **Write path (both):** load NDJSON into a **per-invocation** `_staging_oura_*_<hash>` table (WRITE_TRUNCATE) → `MERGE` into target on natural key → drop staging in `finally`. Per-invocation staging avoids the concurrent-MERGE row-duplication race.
  - daily: `(subject_id, day)` · sleep/event: `(subject_id, <id>)` · **heartrate: `(subject_id, ts)`**
- Auth: RS256 JWT minted via Web Crypto from `GCP_SA_KEY`; exchanged at `oauth2.googleapis.com`.

## Setup (one-time)

Secrets are already set for the live worker (`OURA_PAT`, `GCP_SA_KEY`, `BACKFILL_TOKEN`) — heartrate reuses all
of them, no new credential. To stand up a fresh copy, see the secret-push commands below (use `cmd /c type` to
avoid PowerShell appending `\r\n` to byte-exact secrets):

```powershell
cd <repo>\workers\oura
npm install
npx wrangler kv namespace create OURA_STATE   # paste the id into wrangler.toml [[kv_namespaces]].id
cmd /c "type $env:USERPROFILE\secrets\cornerstone\oura.txt | npx wrangler secret put OURA_PAT"
cmd /c "type $env:USERPROFILE\secrets\cornerstone\your-gcp-project-sa-key.json | npx wrangler secret put GCP_SA_KEY"
cmd /c "type $env:USERPROFILE\secrets\cornerstone\backfill-token.txt | npx wrangler secret put BACKFILL_TOKEN"
```

## Deploy + backfill

```powershell
npm run typecheck
npx wrangler deploy

# Summary backfill (full ring history):
curl "https://cornerstone-oura.YOUR-SUBDOMAIN.workers.dev/backfill?start=<RING_START>&end=<TODAY>&token=<BACKFILL_TOKEN>"

# Intraday-HR backfill — high-frequency, so drive it per-week (each request stays fast; MERGE is idempotent):
#   /backfill?kind=hr&start=YYYY-MM-DD&end=YYYY-MM-DD  (the route also chunks any range into <=7-day windows internally)
```

`docs/12-oura-heartrate-shipped.md` has a ready-to-run PowerShell loop for the 90-day HR backfill.

## Validation (definition of done)

```sql
-- Summary: 30-day baselines, as a sanity check that the backfill landed sensible values
SELECT ROUND(AVG(hrv_avg_ms),1) hrv, ROUND(AVG(sleep_total_h),2) sleep_h, ROUND(AVG(readiness_score),1) readiness
FROM `your-gcp-project.life_ops.raw_oura_daily`
WHERE day >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY);

-- Heartrate: row/integrity check (n_rows == n_distinct_ts confirms the (subject_id, ts) key; raw_json stays SQL NULL)
SELECT COUNT(*) n_rows, COUNT(DISTINCT ts) n_distinct_ts,
       MIN(day) min_day, MAX(day) max_day,
       COUNTIF(day != DATE(ts,'America/New_York')) day_mismatch,
       COUNTIF(raw_json IS NOT NULL) nonnull_raw_json
FROM `your-gcp-project.life_ops.raw_oura_heartrate`;

-- Idempotency: re-run any backfill window; row count unchanged.
```

## Files

- `src/index.ts` — `scheduled()` (cron-branched: summary vs HR) + `fetch()` (`/healthz`, `/backfill[&kind=hr]`); `ingest()`, `ingestHeartrate()`, `backfillHeartrate()`
- `src/oura.ts` — paginated client for all v2 endpoints incl. `getHeartrate()` (datetime params, higher page cap)
- `src/shape.ts` — payload → staging row; day-rollup picks main sleep per day; `buildHeartrateRows()` (sample-grain)
- `src/bq.ts` — load job (multipart NDJSON) + `jobs.query` MERGE; staging schemas incl. `HEARTRATE_SCHEMA`
- `src/merge.ts` — MERGE SQL builders; `heartrateMergeSql()` derives `day = DATE(ts, tz)` in the INSERT
- `src/jwt.ts` — SA JSON → access token via Web Crypto (RS256 JWT-bearer)
- `src/env.ts` — `Env` type
