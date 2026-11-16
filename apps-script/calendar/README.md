# Cornerstone — Calendar Apps Script

Apps Script that exports Google Calendar events from three calendars to BQ
`life_ops.raw_calendar_events`. Hourly trigger + one-off backfill.

Per `integration-architecture.md` §3, Apps Script (not a Cloudflare Worker) because:

- Runs as `you@example.com` with built-in OAuth — no token juggling
- `Calendar` + `BigQuery` advanced services are free
- Time-driven triggers are free
- 6-min execution limit comfortable for daily 30-day-trailing window

## Deploy (one-time, ~5 min)

### 1. Create the Apps Script project

1. Open **https://script.google.com** (signed in as `you@example.com` — not work)
2. Click **New project** (top-left)
3. Rename "Untitled project" → **`Cornerstone Calendar Ingest`**

### 2. Replace the default files with this repo's source

In the Script editor, you'll see one file `Code.gs`. We replace it + add the manifest.

**`Code.gs`:**
1. Open `Cornerstone/apps-script/calendar/Code.gs` in your editor
2. Select all, copy
3. In the Script editor, click the `Code.gs` tab, select all, paste, **Ctrl-S**

**`appsscript.json`:**
1. In the Script editor, click ⚙️ **Project Settings** (left sidebar)
2. Check **"Show 'appsscript.json' manifest file in editor"**
3. Go back to the **Editor** tab — `appsscript.json` now appears in the file list
4. Open `Cornerstone/apps-script/calendar/appsscript.json`, copy contents
5. In the Script editor's `appsscript.json` tab, select all, paste, **Ctrl-S**

### 3. Add Calendar + BigQuery advanced services

The manifest already declares these, but you also need to add them via the sidebar
to satisfy the editor (first-run requirement):

1. In the Script editor's left sidebar, click **Services** (the `+`)
2. Add **Calendar API** (identifier stays `Calendar`, version `v3`)
3. Add **BigQuery API** (identifier `BigQuery`, version `v2`)

### 4. First run — install the hourly trigger

This also walks through the OAuth consent dialog.

1. At the top of the editor, function dropdown → select `installTrigger`
2. Click **▶ Run**
3. First run pops up **"Authorization required"** — click **Review permissions**
4. Pick `you@example.com`
5. You'll see "Google hasn't verified this app" — click **Advanced → Go to Cornerstone Calendar Ingest (unsafe)**. This is expected for personal Apps Script projects.
6. Approve the scopes:
   - See, edit, share, and permanently delete all the calendars you can access using Google Calendar
   - View and manage your data in Google BigQuery and see the email address for your Google Account
7. After approval, the function runs and prints in the bottom log:
   `installed dailyRun trigger every 1 hour`

Verify under ⏱ **Triggers** (left sidebar): there should be one trigger,
`dailyRun`, time-driven, every hour. (If a stale daily 1 AM trigger is
still listed alongside the hourly one, delete it manually — `installTrigger`
clears prior `dailyRun` triggers on re-run but only if you paste the new code
first.)

**Cadence note:** bumped from daily 1 AM → hourly on 2026-05-27 to feed the
adaptive-agent wake-render workflow with fresh calendar data. Quota math:
24 runs × ~30s = ~12 min runtime/day and 24 BQ writes/day, both comfortably
within Apps Script free-tier caps (90 min runtime, 50K BQ ops/day).

### 5. Backfill historical data

1. Function dropdown → `backfillFull`
2. Click **▶ Run**
3. Wait — typically 30s–3min depending on calendar density. The log will show
   `backfillFull done: {"you@example.com": …, "partner@example.com": …, "you-work@example.com": …, "total_rows": …}`

### 6. Verify in BQ

```sql
SELECT calendar_id, COUNT(*) AS event_count, MIN(day) AS first_day, MAX(day) AS last_day
FROM `your-gcp-project.life_ops.raw_calendar_events`
GROUP BY calendar_id
ORDER BY event_count DESC;
```

Expected: 3 rows. work events will have `title IS NULL` (freeBusy redacts titles).

## Ongoing operation

The `dailyRun` trigger fires every hour and pulls a 30-day trailing window +
90-day lookahead. The MERGE pattern means re-runs are idempotent (same event id =
update in place).

If a calendar gets revoked or re-shared, the affected calendar's pull will log a
warning and the others continue normally.

## Source of truth

`Cornerstone/apps-script/calendar/` is canonical. To update the deployed project:

- **Manual:** copy/paste from local files into the Script editor tabs
- **CLI (optional):** install `@google/clasp`, `clasp login`, `clasp clone <scriptId>`,
  `clasp push` to sync. Script ID is visible in Script editor → Project Settings.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `BigQuery is not defined` on first run | Re-do step 3 (add advanced services) |
| `Calendar API has not been used in project...` | Open the link in the error to enable Calendar API in the GCP console (one-time) |
| `Permission denied` writing to BQ | Confirm you're signed in as `you@example.com` (the project owner). Other accounts won't have BQ Data Editor by default. |
| Stale data from work calendar cal | Verify subscription still works in Calendar UI: `Other calendars → you-work@example.com`. Re-subscribe if removed. |
| Backfill exceeds 6-min execution limit | Unlikely with current volume, but if it happens: chunk by date range — call `ingest_(new Date('2024-01-01'), new Date('2025-01-01'))` then `ingest_(new Date('2025-01-01'), new Date())`. |
