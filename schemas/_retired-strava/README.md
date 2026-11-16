# Retired Strava schemas (2026-06-03)

Strava ingestion was decommissioned on **2026-06-03** — run/walk tracking consolidated to Oura
(`raw_oura_workout` + `raw_oura_heartrate` cover activity type / HR / strain / Z2 zones). Strava's
June-2026 API policy also added a paid-subscription requirement (existing devs cut off ~6/30 without
a sub) plus AI-ingestion / persistent-storage restrictions — and the brain never read Strava data,
so the leg was pure dormant collection.

These files are the historical DDL for the dropped tables: `raw_strava_activity`,
`raw_strava_athlete`, `raw_strava_zones`. The tables were `DROP`ped and `metrics_daily` recreated
without the Strava CTEs. The `cornerstone-strava` worker is kept (cron emptied → never fires) for a
possible future revisit.

**To revive:** re-create these tables, re-add the `strava_daily` / `strava_metrics` CTEs to
`../05_metrics_daily_view.sql`, restore the worker cron in `workers/strava/wrangler.toml`, and redeploy.
