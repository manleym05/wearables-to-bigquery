# wearables-to-bigquery

Pull your own health and calendar data out of the apps that hold it and into a BigQuery
dataset you control, using one small Cloudflare Worker per source.

Oura, Withings, Strava, Hevy and Google Calendar each expose an API, and each one expires
tokens, paginates and rate-limits differently. This repo is the glue: eight Workers that
handle the OAuth dance, poll on a cron, and load rows into BigQuery through a staging table
and a `MERGE`, so re-running a backfill never duplicates data.

It runs on free tiers. BigQuery's free allowance covers years of personal biometric data,
and Cloudflare's 100k requests/day is far more than a half-hourly cron needs.

```
Vendor APIs  →  Cloudflare Workers  →  BigQuery (staging → MERGE → tables)  →  your queries
   OAuth          cron + backfill          idempotent loads
```

## Why you might want this

Most "export your data" tools give you a CSV dump and stop. This gives you a **live dataset**
that keeps itself current, with a schema designed for asking cross-source questions — how
sleep tracks against training load, what a travel week does to resting heart rate — that no
single vendor app can answer because no single vendor has all the data.

Everything is yours: your Google Cloud project, your Cloudflare account, your tokens. No
third-party service sits in the middle.

## What's in here

| Path | What it is |
|---|---|
| `schemas/` | BigQuery DDL, one `.sql` per table, numbered in apply order. Start at `schemas/README.md`. |
| `workers/oura/` | 16 Oura endpoints: sleep, readiness, activity, stress, SpO2, VO2 max, workouts, intraday heart rate. OAuth with refresh-token rotation. |
| `workers/withings/` | Body composition — weight, fat mass, muscle mass. |
| `workers/strava/` | Activities and splits. |
| `workers/hevy/` | Strength training: workouts, sets, reps, weights. |
| `workers/hevy-push/` | The reverse direction — writes a planned routine back into Hevy. |
| `workers/calendar/` | Google Calendar events, including a plan overlay that never marks you busy. |
| `workers/maps/` | Travel time enrichment. |
| `workers/bq-query/` | A small read API over the dataset, so other apps can query without BigQuery credentials. |
| `apps-script/calendar/` | Alternative Calendar ingest via Google Apps Script, if you'd rather not run a Worker for it. |

## Getting started

You need a Google Cloud project with BigQuery enabled, a Cloudflare account, and
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/) installed.

**1. Create the dataset and tables.**

```bash
bq mk --dataset --location=US your-gcp-project:life_ops
for f in schemas/*.sql; do bq query --use_legacy_sql=false < "$f"; done
```

Edit `schemas/06_seed_profile_static.sql` and `schemas/07_seed_targets.sql` first — they ship
with example values and are the only two files that describe a person rather than a structure.

**2. Make a service account** with the BigQuery Data Editor and Job User roles, and download
its JSON key. Every Worker uses it to load rows.

**3. Configure and deploy one Worker.** Start with Oura — it's the richest source.

```bash
cd workers/oura
```

Open `wrangler.toml` and replace the placeholders:

| Placeholder | Where it comes from |
|---|---|
| `YOUR_CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard, right-hand sidebar |
| `YOUR_KV_NAMESPACE_ID` | `wrangler kv namespace create OURA_STATE` |
| `your-gcp-project` | Your Google Cloud project ID |

Then set the secrets — these are never committed:

```bash
wrangler secret put OURA_CLIENT_ID       # from developer.ouraring.com
wrangler secret put OURA_CLIENT_SECRET
wrangler secret put OURA_REDIRECT_URI    # https://<your-worker>.workers.dev/oauth/callback
wrangler secret put GCP_SA_KEY           # the whole service-account JSON, one line
wrangler secret put BACKFILL_TOKEN       # any random string; gates the manual routes
wrangler deploy
```

**4. Authorize and backfill.**

```bash
# visit this once in a browser to grant access
open "https://<your-worker>.workers.dev/oauth/start?token=<BACKFILL_TOKEN>"

# then pull your history
curl "https://<your-worker>.workers.dev/backfill?start=2024-01-01&end=2026-01-01&token=<BACKFILL_TOKEN>"
```

The cron takes over from there. Each Worker's own `README.md` covers its endpoints and quirks.

## Design notes worth knowing

**Loads are idempotent.** Every Worker writes to a staging table, `MERGE`s into the target on
a natural key, then drops the staging table. Run the same backfill five times and you get the
same rows. This matters more than it sounds — wearable APIs revise data after the fact, and
sleep data for last night can change by tomorrow afternoon.

**`subject_id` is on every table.** It's `1` for you. It exists so that adding a second person
later is a data change, not a migration.

**Refresh tokens rotate.** Oura and Withings both invalidate the old refresh token when you use
it, so the new one must be persisted immediately or the chain breaks and you re-authorize by
hand. The Workers keep theirs in KV and write the new token before using the access token.

**Timezones are decided at write time.** A "day" for sleep data isn't midnight-to-midnight, and
the vendor's idea of which day a sleep session belongs to doesn't always match yours. The
`timezone` in `profile_static` drives that normalization.

## Status and scope

This is a personal project, published because the integration work is tedious and reusable —
the Oura OAuth notes alone cost a weekend. It is not a product and has no support promise.

Expect to adapt it. Vendor APIs change, and the specific metrics in `schemas/05_metrics_daily_view.sql`
reflect one person's interests. The parts that generalize are the ingest pattern, the OAuth
handling and the table design.

## License

MIT — see [LICENSE](LICENSE).
