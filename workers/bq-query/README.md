# cornerstone-bq-query

Token-authed, **read-only** BigQuery query Worker over `life_ops`. Lets Life HQ (and any future
consumer) read the data layer with a bearer token instead of loading the GCP service-account
private key into model context on every render. Mirrors the `cornerstone-maps` pattern: the SA is
held server-side, the endpoint is token-gated, JSON comes out.

**Why this exists:** the daily card render runs in a sandbox that can't mount
`$env:USERPROFILE\secrets\`, so it was reading the SA private key into context each run to hit the BQ
REST API — a daily key-exposure smell. This Worker retires that: the consumer holds only a
low-sensitivity bearer token (same trust level as the Maps `ADMIN_TOKEN`). See
`Life HQ/reviews/handoffs.md` → 2026-05-21 "render auth" reverse handoff.

## Routes

All routes except `/healthz` and `/` require the token, via `?token=…` or
`Authorization: Bearer …`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness — returns `ok` |
| GET | `/queries` | list named queries + their declared params |
| GET | `/named?name=<id>&<param>=<value>` | run a named query (params from query string) |
| POST | `/named` | run a named query — body `{ "name": "...", "params": {...} }` |
| POST | `/sql` | run an arbitrary single read-only `SELECT`/`WITH` — body `{ "sql": "...", "params"?: {...}, "maxBytes"?: number }` |

`@subject_id` is injected automatically from `SUBJECT_ID` — don't pass it.

### Response shape

```json
{
  "ok": true,
  "rowCount": 2,
  "totalRows": 2,
  "truncated": false,
  "fields": [{ "name": "day", "type": "DATE" }, { "name": "weight_lb", "type": "FLOAT" }],
  "rows": [{ "day": "2026-05-22", "weight_lb": 170.5 }],
  "totalBytesProcessed": 2368,
  "cacheHit": false
}
```

Numbers (`INT64`/`FLOAT64`/`NUMERIC`), booleans, and `JSON` columns are coerced to native JSON
types; `DATE`/`TIMESTAMP`/`STRING` stay strings. `truncated` is `true` if the result set exceeded
the 50,000-row page cap (paginate with your own `LIMIT/OFFSET` if you hit it — not expected for
render queries).

## Robustness

- **Pagination:** results are fetched across pages up to 50k rows; `truncated` flags overflow.
- **Retries:** transient BigQuery failures (429 / 5xx / network) are retried with backoff.
- **Cost cap:** every query runs with `maximumBytesBilled`; `/sql`'s optional `maxBytes` may only
  *lower* the cap, never raise it above `MAX_BYTES_BILLED`.
- **Error codes:** validation problems return 4xx; upstream BigQuery failures return 502/504.
- **Auth:** constant-time token comparison.

## Read-only guarantees

1. **IAM (hard boundary):** the Worker's SA is `cornerstone-bq-reader@` with **only**
   `roles/bigquery.dataViewer` on `life_ops` + `roles/bigquery.jobUser` on the project. No
   `dataEditor` — BigQuery refuses any write regardless of the SQL submitted.
2. **Statement guard (`/sql`):** must be a single statement starting with `SELECT`/`WITH`; `;`-
   separated scripts and DML/DDL leading keywords are rejected before the query is sent.
3. **Cost cap:** every query runs with `maximumBytesBilled = MAX_BYTES_BILLED` (default 1 GiB).
   `/sql` may pass a smaller `maxBytes`; on the free tier real cost is ~$0.

## Examples

```bash
BASE=https://cornerstone-bq-query.YOUR-SUBDOMAIN.workers.dev
TOK=$(cat ~/secrets/cornerstone/bq-query-token.txt)

# Named: last night's Oura rollup
curl "$BASE/named?name=oura_daily_on&day=2026-05-25&token=$TOK"

# Named: weight trend (POST form)
curl -X POST "$BASE/named" -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d '{"name":"weight_trend","params":{"start":"2026-05-01","end":"2026-05-25"}}'

# Passthrough: ad-hoc read-only SQL with a typed param
curl -X POST "$BASE/sql" -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT day, value FROM life_ops.metrics_daily WHERE metric=@m AND day=@d",
       "params":{"m":"hrv_avg_ms","d":{"type":"DATE","value":"2026-05-24"}}}'

# Introspect available named queries
curl "$BASE/queries?token=$TOK"
```

## One-time setup

**Fast path:** run `.\setup.ps1` from this folder — it creates the SA, grants dataset-level READER
+ project `jobUser`, mints the key, and generates the token (all idempotent), then prints the
wrangler deploy commands. The manual steps below are the same thing, spelled out.

### 1. Create the read-only service account (run by the owner; gcloud)

```bash
PROJECT=your-gcp-project
gcloud iam service-accounts create cornerstone-bq-reader \
  --project "$PROJECT" --display-name "Cornerstone read-only BQ query Worker"

SA="cornerstone-bq-reader@${PROJECT}.iam.gserviceaccount.com"

# jobUser at project level (lets it run query jobs)
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:${SA}" --role roles/bigquery.jobUser

# dataViewer scoped to the life_ops dataset ONLY (read, no write).
# Easiest via console: BigQuery > life_ops > Sharing > Permissions > Add principal
#   principal = $SA, role = BigQuery Data Viewer.
# (Dataset-level grants aren't a single gcloud flag; the console path is simplest.)

# Mint the key (store locally; never commit):
gcloud iam service-accounts keys create \
  "$env:USERPROFILE\secrets\cornerstone\bq-reader-sa.json" --iam-account "$SA"
```

### 2. Generate a bearer token

```bash
# any high-entropy string; save it where Life HQ's render can read it
openssl rand -hex 32 > $env:USERPROFILE\secrets\cornerstone\bq-query-token.txt
```

### 3. Deploy

```bash
cd <repo>\workers\bq-query
npm install
npm run typecheck
npx wrangler secret put GCP_SA_KEY    # paste contents of bq-reader-sa.json
npx wrangler secret put QUERY_TOKEN   # paste contents of bq-query-token.txt
npm run deploy
curl https://cornerstone-bq-query.YOUR-SUBDOMAIN.workers.dev/healthz   # -> ok
```

## Handoff to Life HQ

Once deployed, Life HQ's render path swaps SA-key-via-REST for token calls to this Worker. Log the
swap in `Life HQ/reviews/handoffs.md` and update `Life HQ/pipelines/render-daily-card.py` /
`card-render-queries.md` to call `/named` or `/sql` with the bearer token. Port hot render queries
into `src/queries.ts` over time so the consumer is fully name-driven (no embedded SQL).
