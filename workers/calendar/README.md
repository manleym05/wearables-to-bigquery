# cornerstone-calendar

Google Calendar **write** facade — the only Cornerstone worker permitted to mutate a calendar, and
only the dedicated **"Life HQ – Daily Plan"** calendar (hard scope-lock by `CALENDAR_ID`). The
`life-hq-brain` Worker's `calendar_write` tool calls it via a Service Binding; the brain never holds
Google creds. Mirrors `cornerstone-bq-query`: SA held server-side, SA→JWT→access-token via Web
Crypto, bearer-token-gated HTTPS, JSON out. No cron — on-demand only.

## Contract

| Method | Path | Auth | Body / query |
|---|---|---|---|
| `GET` | `/healthz` | none | → `ok` |
| `POST` | `/write` | Bearer `ADMIN_TOKEN` | `{ target_date, blocks[], calendar_id?, dry_run? }` |
| `GET` | `/list?date=YYYY-MM-DD` | Bearer | agent-owned events for that day |
| `GET` | `/events?date=YYYY-MM-DD&calendar=<id>?` | Bearer | read-only (2026-06-09): every event on the day with its LIVE (user-dragged) ET wall-time + `lifehq_kind`/`lifehq_type` — the brain's re-plan pin-detection source. Never mutates. |

`blocks[]` = `{ type, summary, start:"HH:MM", end:"HH:MM", colorId?, description?, drive_time_min? }`
— exactly the output of the brain's `block_emit` + `reach_out` projections.

- **Idempotent per day.** `/write` lists events tagged `lifehq_planned=true` **and** `lifehq_day=<target_date>`,
  deletes them, then inserts the new blocks (each re-stamped with those `extendedProperties.private`).
  Real meetings carry no such tag and are **never** touched. `"dry_run": true` returns what *would* change.
- **Scope lock.** Any `calendar_id` ≠ `CALENDAR_ID` → `403`.
- **Overnight blocks** (end ≤ start, e.g. `22:30`→`06:00`) roll the end to the next day.
- Events insert `transparency: transparent` (never marks you "busy") with reminders off.
- `/write` returns `207` with an `errors[]` array if any single op failed (best-effort, not all-or-nothing).

## One-time Google setup (the owner)

The SA needs WRITE access to the dedicated calendar. Pick one:

**A — reuse the bq-reader SA (lowest friction):**
1. Enable the Calendar API:
   `gcloud services enable calendar-json.googleapis.com --project your-gcp-project`
2. Google Calendar → **Life HQ – Daily Plan** → *Settings and sharing* → **Share with specific people** →
   add `cornerstone-bq-reader@your-gcp-project.iam.gserviceaccount.com` → **"Make changes to events"**.
3. `wrangler secret put GCP_SA_KEY` — paste the **same** bq-reader SA JSON used by cornerstone-bq-query.

**B — dedicated SA (cleaner least-priv):** mint `cornerstone-calendar-writer@…`, download its key, do
step 2 with that SA, then `wrangler secret put GCP_SA_KEY` with the new key. No GCP IAM roles needed —
calendar access comes from the **share**, not IAM, so no domain-wide delegation.

> The JWT requests scope `https://www.googleapis.com/auth/calendar.events`. The share is what grants
> access to this specific calendar; the scope just authorizes the `events.*` methods.

## Deploy

```bash
npm install
npm run typecheck
wrangler secret put GCP_SA_KEY     # SA JSON (see above)
wrangler secret put ADMIN_TOKEN    # new random bearer; store at secrets/cornerstone/calendar-admin-token.txt
npm run deploy
```

## Test (after the Google setup lands)

```bash
BASE=https://cornerstone-calendar.YOUR-SUBDOMAIN.workers.dev
TOK=<ADMIN_TOKEN>

curl $BASE/healthz                                   # -> ok

# DRY RUN first — see the plan, mutate nothing
curl -s -X POST "$BASE/write?token=$TOK" -H 'content-type: application/json' -d '{
  "target_date":"2026-06-08","dry_run":true,
  "blocks":[{"type":"wake","summary":"⏰ test","start":"06:00","end":"06:15","colorId":"8"}]}'

# real write → verify via /list → wipe (blocks:[])
curl -s -X POST "$BASE/write?token=$TOK" -H 'content-type: application/json' -d '{"target_date":"2026-06-08","blocks":[{"type":"wake","summary":"⏰ test","start":"06:00","end":"06:15","colorId":"8"}]}'
curl -s "$BASE/list?date=2026-06-08&token=$TOK"
curl -s -X POST "$BASE/write?token=$TOK" -H 'content-type: application/json' -d '{"target_date":"2026-06-08","blocks":[]}'
```

## Wiring into the brain (Build 1b — next)

In `life-hq-brain/wrangler.toml`:
```toml
[[services]]
binding = "CALENDAR"
service = "cornerstone-calendar"
```
plus `wrangler secret put CALENDAR_TOKEN` (= this worker's `ADMIN_TOKEN`). The `calendar_write` tool
calls `env.CALENDAR.fetch("https://cornerstone-calendar/write", …)` via the binding — avoids the
same-zone `workers.dev` 1042 subrequest restriction.

## Notes
- No cron — on-demand only (driven by the brain's render → block-emit → calendar_write).
- Wrangler 3.x on Windows prints a cosmetic `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
  on exit — ignore (same as the brain).
