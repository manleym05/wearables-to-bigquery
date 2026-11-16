# cornerstone-hevy-push

The first **outbound action** Worker in Cornerstone. Pushes Life HQ's daily prescribed lift session into Hevy as a routine — so when the owner opens the app, the workout is already there.

**Status:** Deployed and **validated end-to-end 2026-05-26**. Live at `https://cornerstone-hevy-push.YOUR-SUBDOMAIN.workers.dev`. Routines land in the Hevy "Life HQ" folder (`folder_id 2935250`). Idempotent create → PUT verified with live routine UUID `ec4c0998-02d6-4708-b6c7-3a2abfd99ef7`. Audit rows landing in `life_ops.action_log`.

This Worker is the pattern every future action component (grocery ordering, calendar writes, etc.) will follow: admin-token auth, vendor secrets server-side, HITL-gated upstream, gate enforcement in the Worker (not just the agent), and audit to `life_ops.action_log`. See `Cornerstone/docs/11-hevy-push-shipped.md` for the three runtime gotchas that surfaced during validation (response envelope shape, BQ JSON-string column type, PUT rep_range strictness).

---

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/healthz` | Liveness. No auth. |
| `GET`  | `/` | Usage banner. No auth. |
| `GET`  | `/contract` | **Full payload contract + accepted exercise vocabulary.** Bearer auth. Call this instead of guessing. |
| `POST` | `/push-routine` | Push or update today's routine. Bearer auth. Idempotent. |
| `POST` | `/ensure-folder` | One-time bootstrap: create the "Life HQ" routine folder in Hevy. Returns the numeric `folder_id` to copy into `wrangler.toml` `[vars] HEVY_FOLDER_ID`. |

## Payload contract

*Added 2026-07-26 (Life HQ passback P4b). Two required fields were undocumented and `gameplan_name`
had to be spelled exactly — that cost three rejection rounds in one live Sunday session. The contract
is now also machine-readable: `GET /contract`, and it is echoed in the body of every 400.*

### Required

| Field | Type | Notes |
|---|---|---|
| `date` | `"YYYY-MM-DD"` | **400 without it.** |
| `training_day` | string | **400 without it.** e.g. `"Upper"`, `"Day 2 Lower (Strength bias)"`. |
| `gate` | `GREEN`\|`YELLOW`\|`AMBER`\|`RED` | Must be in `ALLOWED_GATES`. `RED` short-circuits — nothing is pushed, a `skipped` audit row is written, response is **200**. |
| `idempotency_key` | string | Stable per logical push. Re-sending PUTs the same Hevy routine instead of duplicating. |
| `exercises[]` | array | Non-empty. |
| `exercises[].gameplan_name` | string | **`name` is accepted as an alias.** Unknown names → 422 carrying `accepted_exercises` **and** did-you-mean `suggestions`. |
| `exercises[].sets` | integer | ≥ 1. |

### Optional

| Field | Type | Notes |
|---|---|---|
| `intent` | `full`\|`deload`\|`express`\|`travel` | Default `full`. Rendered into the generated title (e.g. `DELOAD`). A **misspelling is a 400**, not a silent fallback to `full`. |
| `title` | string | **Honoured verbatim when supplied.** Otherwise generated. |
| `notes` | string | **Leads** the Hevy routine notes; the generated gate/caps line is appended after it. |
| `gate_modifier` | string | Diagnostic label, rendered into the notes. |
| `exercises[].reps` | string | `"5"` \| `"6-8"` \| `"8-10 ea"` \| `null`. |
| `exercises[].rpe` | number | Rendered into the exercise note — Hevy has no per-set RPE field. |
| `exercises[].note` | string | Per-exercise note. |
| `exercises[].target_weight_lb` | number | lb → kg. Defaults to the last logged top weight for that exercise. |
| `exercises[].set_weights_lb` | number[] | Per-set override; index 0 = first set. |
| `exercises[].rest_seconds` | number | Defaults by movement pattern: 150 compound / 75 accessory / 30 core. |

### Title and notes composition

The Worker used to **overwrite** caller-supplied `title` and `notes`. Two deload routines pushed as
`"Life HQ — Tue 7/28 DELOAD Upper (60%)"` came back as `"Life HQ — Tue 7/28 Upper (GREEN)"` noted
`"GREEN — full plan"`. On a 60%-volume deload week that is actively wrong, and a mislabeled routine
title is exactly the failure mode P3 exists to eliminate. Current behaviour:

- **`title` supplied** → used verbatim.
- **`title` omitted** → generated as `Life HQ — {Dow} {M/D} {INTENT }{DayLabel} ({GATE})`,
  e.g. `Life HQ — Tue 7/28 DELOAD Upper (GREEN)`. The gate word is kept — intent sits *alongside*
  it rather than displacing it.
- **`notes` supplied** → leads, with the generated `Life HQ {date} — {day} | Intent: … | Gate: … |
  Caps applied: …` line appended. The generated line is appended rather than replaced because
  `applied_caps` is **safety information**: it records what the gate actually stripped, and dropping
  it would make an enforced cap invisible in the app.

The response carries `intent`, `title_source` (`caller`\|`generated`) and `notes_source` so the
caller can confirm what landed.

### `POST /push-routine`

Auth: `Authorization: Bearer <ADMIN_TOKEN>` (or `?token=…`).

Deload example (the 2026-07-28 case that motivated P4a):

```json
{
  "date": "2026-07-28",
  "training_day": "Upper",
  "gate": "GREEN",
  "intent": "deload",
  "title": "Life HQ — Tue 7/28 DELOAD Upper (60%)",
  "notes": "Deload week: 60% volume, back off from last week's top sets.",
  "idempotency_key": "plan-2026-07-28-deload-upper",
  "exercises": [
    {"name": "Flat Barbell Bench", "sets": 2, "reps": "8", "weight_lb": 135,
     "note": "DELOAD: back off from 155x8x3."}
  ]
}
```

Note `name` rather than `gameplan_name` — both work. With `title` omitted, the generated title would
have been `Life HQ — Tue 7/28 DELOAD Upper (GREEN)`; the intent survives either way.

Request body (minimal — all weight/rest fields optional, backwards compatible):

```json
{
  "date": "2026-05-26",
  "training_day": "Day 2 Lower (Strength bias)",
  "gate": "YELLOW",
  "gate_modifier": "rpe7_cap_no_top_sets",
  "exercises": [
    {"gameplan_name": "Front Squat",            "sets": 3, "reps": "5",       "rpe": 8, "note": null},
    {"gameplan_name": "Romanian Deadlift",      "sets": 3, "reps": "6-8",     "rpe": 8},
    {"gameplan_name": "Bulgarian Split Squat",  "sets": 3, "reps": "8-10 ea", "rpe": 8},
    {"gameplan_name": "Leg Curl",               "sets": 3, "reps": "10-12",   "rpe": 9},
    {"gameplan_name": "Standing Calf Raise",    "sets": 4, "reps": "8-12",    "rpe": 9},
    {"gameplan_name": "Plank + Pallof Press",   "sets": 3, "reps": "—",       "rpe": null}
  ],
  "idempotency_key": "plan-2026-05-26-day2-lower"
}
```

Request body (full — with prescribed weight per set and target rest between sets):

```json
{
  "date": "2026-05-26",
  "training_day": "Day 2 Lower (Strength bias)",
  "gate": "YELLOW",
  "gate_modifier": "rpe7_cap_no_top_sets",
  "exercises": [
    {
      "gameplan_name": "Front Squat", "sets": 3, "reps": "5", "rpe": 8,
      "target_weight_lb": 140,         // ← all 3 sets seeded at 140 lb
      "rest_seconds": 180              // ← Hevy shows a 3-min countdown after each set
    },
    {
      "gameplan_name": "Romanian Deadlift", "sets": 3, "reps": "6-8", "rpe": 8,
      "set_weights_lb": [185, 185, 185], // ← per-set; could ramp e.g. [135, 185, 185]
      "rest_seconds": 150
    },
    {
      "gameplan_name": "Bulgarian Split Squat", "sets": 3, "reps": "8-10 ea", "rpe": 8,
      "target_weight_lb": 50, "rest_seconds": 90
    },
    {"gameplan_name": "Leg Curl",            "sets": 3, "reps": "10-12", "rpe": 9, "target_weight_lb": 75, "rest_seconds": 60},
    {"gameplan_name": "Standing Calf Raise", "sets": 4, "reps": "8-12",  "rpe": 9, "rest_seconds": 45},
    {"gameplan_name": "Plank + Pallof Press","sets": 3, "reps": "—",     "rpe": null, "rest_seconds": 30}
  ],
  "idempotency_key": "plan-2026-05-26-day2-lower"
}
```

**Optional fields (per exercise):**

| Field | Type | What it does |
|---|---|---|
| `target_weight_lb` | number (lb) | Seeds all sets in this exercise at this weight (converted to kg internally) |
| `set_weights_lb` | array of (number\|null) | Per-set weight override; index N = set N. Missing/null indexes fall back to `target_weight_lb`. Use for ramping (e.g. `[135, 185, 185]`) or drops |
| `rest_seconds` | integer | Hevy renders an inter-set countdown timer at this duration. **When omitted, the Worker fills a pattern-based default** (heavy compound 150s / accessory 75s / core 30s) — see `defaultRestSeconds()` in `routine.ts` — so every pushed exercise always carries a timer. Send an explicit value to override. |

All optional. Omit any of them and the Worker still produces a valid routine — Hevy shows blank weight for an exercise with no weight, but **always** shows a rest timer (explicit or defaulted).

Success response (201/200 depending on create vs update):

```json
{
  "ok": true,
  "status": "created",
  "routine_id": "b459cba5-cd6d-463c-abd6-54f8eafcadcb",
  "hevy_url": "https://app.hevy.com/routine/b459cba5-…",
  "title": "Life HQ — Tue 5/26 Lower Strength bias (YELLOW)",
  "note": "YELLOW — RPE 7 cap on strength compounds (2 adjusted)",
  "idempotency_key": "plan-2026-05-26-day2-lower",
  "folder_id_used": 2936553,
  "folder_recovered": false,
  "folder_recovery_note": null,
  "put_404_recovered": false,
  "put_404_recovery_note": null
}
```

When a self-heal fires:

| Field | Meaning |
|---|---|
| `folder_recovered: true` | Hevy rejected the configured `HEVY_FOLDER_ID` with 400 "Invalid routine folder id" on POST. Worker listed/created a fresh "Life HQ" folder and retried (or fell back to root if even that failed). `folder_recovery_note` tells you whether to update `wrangler.toml`. |
| `put_404_recovered: true` | The cached `routine_id` (from a prior successful push with the same idempotency key) returned 404 on PUT — meaning the owner deleted that routine in the Hevy app between pushes. Worker recreated it via POST; `routine_id` in the response is the **new** id, and the next push with the same key will PUT to it. |

RED gate → skip (no Hevy call), `{"ok": true, "status": "skipped", "note": "RED — rest day; no routine pushed"}` and an action_log row with `status="skipped"`.

Validation failure → 422 with `{"ok": false, "errors": [...]}`. Unknown exercise names fail loudly here rather than silently push a wrong template.

---

## Why these design choices

### RPE in the exercise notes (not per set)
Hevy's `PostRoutinesRequestSet` doesn't accept an `rpe` field — only the response shape carries RPE (from logged sessions). We encode RPE in the *exercise* `notes` (e.g. `"RPE 7"`), where Hevy renders it as a per-exercise cue. The agent's payload still carries `rpe` per exercise because each gameplan exercise has one prescribed RPE; sets share it.

### Hevy response shape — `{routine: [{...}]}` (not the bare `Routine`)
Verified empirically (despite the OpenAPI spec). `pickRoutine()` in `src/hevy.ts` defensively handles all four plausible shapes (bare-array, envelope+array — which Hevy actually returns, envelope+object, bare-object). The same wrapping applies to `POST /v1/routine_folders` (returns `{ routine_folder: { … } }`).

### PUT is stricter than POST — omit nullable set fields, don't send `null`
`POST /v1/routines` accepts `rep_range: null`; `PUT /v1/routines/{id}` rejects it (`400: rep_range must be of type object`). `routine.ts` builds the `RoutineSet` object conditionally — only attaches `reps` / `rep_range` when non-null — so the same payload satisfies both verbs.

### Idempotency keyed in `action_log`, not by routine title
Title-based dedup would require fetching every existing routine (Hevy's GET /v1/routines is paginated at max 5/page). We instead store the Hevy `routine_id` alongside the `(subject_id, action_type, idempotency_key)` tuple in `life_ops.action_log`. A re-pushed key → PUT to the same routine. The agent constructs the key deterministically: `life-hq-{YYYY-MM-DD}-{training-day-slug}`.

### Self-heal on PUT 404 — recreate the routine
The cached `routine_id` can go stale if the owner deletes the routine in the Hevy app between pushes (caught live 2026-05-27). On PUT 404 the Worker falls back to POST via `createWithFolderHeal()` — the fresh POST writes a new `action_log` row with the new `routine_id`, so subsequent pushes with the same idempotency key PUT to the new routine. Same shape as the folder-id 400 self-heal, different upstream error. Recovery is surfaced as `put_404_recovered: true` in the response and as a `self_heal` block in the audit row's `payload_json`.

### Gate enforcement in the Worker
The agent decides the gate (from biometrics). The Worker enforces the *consequences* of that gate — RED skips, YELLOW caps RPE on strength compounds at 7, AMBER drops one set on compounds and caps RPE 7 elsewhere. If the agent ever produces a misaligned payload (e.g., RPE 8 with gate YELLOW), the Worker fixes it before it reaches Hevy. Gate logic = safety boundary, lives in code not prompt.

### Compound exercises
`"Plank + Pallof Press"` resolves through `COMPOUNDS` (in `exercise-map.ts`) into two flat Hevy exercises with the same sets/reps. Same for `"Plank + Side Plank"`.

### `@` removal in notes
Reported community issue: notes containing `@` cause silent 400. `sanitizeNotes()` rewrites `@` → `at` and normalizes whitespace.

---

## Deploy

Wrangler is installed locally (not globally) — use `npx wrangler …`. PowerShell's `curl` is `Invoke-WebRequest` (no `-X` flag); use `Invoke-RestMethod` or `curl.exe`.

```powershell
cd <repo>\workers\hevy-push
npm install
# secrets (one-time)
npx wrangler secret put ADMIN_TOKEN     # any strong random string, share with whatever calls this; save to $env:USERPROFILE\secrets\cornerstone\hevy-push-admin-token.txt
npx wrangler secret put HEVY_API_KEY    # from https://hevy.com/settings?developer (Pro only)

# GCP SA — pipe the JSON file via Get-Content to avoid clipboard mangling
Get-Content "$env:USERPROFILE\secrets\cornerstone\cornerstone-hevy-push-sa.json" -Raw | npx wrangler secret put GCP_SA_KEY

npx wrangler deploy
```

Then bootstrap the Hevy folder once:

```powershell
$ADMIN = (Get-Content "$env:USERPROFILE\secrets\cornerstone\hevy-push-admin-token.txt" -Raw).Trim()
$folder = Invoke-RestMethod -Method POST -Uri "https://cornerstone-hevy-push.YOUR-SUBDOMAIN.workers.dev/ensure-folder?token=$ADMIN"
$folder
# Response includes folder_id (numeric). Copy into wrangler.toml [vars] HEVY_FOLDER_ID and `npx wrangler deploy` again.
# (Already done for this Worker — folder_id = 2935250.)
```

### Required GCP SA permissions

Minimal least-privilege role for `cornerstone-hevy-push@<project>.iam.gserviceaccount.com`:

| Action | BQ permission |
|---|---|
| Insert action_log rows | `bigquery.tables.updateData` on `life_ops.action_log` |
| Run idempotency lookup query | `bigquery.jobs.create` (project-scope) + `bigquery.tables.getData` on `life_ops.action_log` |

Equivalently: `roles/bigquery.jobUser` (project) + `roles/bigquery.dataEditor` scoped to `life_ops.action_log` (table-level grant if you want full least-privilege; dataset-level is also fine).

---

## Layout

```
src/
  index.ts          HTTP handler, auth, routing, audit-log write
  env.ts            Env interface (vars + secrets)
  jwt.ts            GCP OAuth2 JWT minter (BQ scope only)
  hevy.ts           Hevy v1 API client (POST/PUT routines; folders)
  routine.ts        Compose PostRoutinesRequestBody from agent input
  exercise-map.ts   Gameplan-name → Hevy template_id (39 exercises + aliases + compounds)
  reps.ts           Parser for "5" / "6-8" / "8-10 ea" / "—"
  gate.ts           HRV gate enforcement (GREEN/YELLOW/AMBER/RED → modifier)
  bq.ts             action_log read+write helpers
```

Canonical exercise map source-of-truth is `Cornerstone/configs/hevy-exercise-map.yaml` — when adding new exercises, edit the YAML and mirror into `exercise-map.ts` (Workers can't read FS at runtime).

---

## Last Updated

2026-07-19 — **last-logged weight seeding** (`bq.ts` `getLastSessionWeights`): now returns, per exercise, the top set weight + reps from the most recent day that exercise was logged **across all sessions**, instead of only the last session whose *title* matched the day-type (`LIKE '%lower%'`). Hevy workout titles aren't the gameplan day names, so title-matching left Lower days seeding almost nothing (caught live — Lower repeatedly pushed with blank weights, filled by hand). `index.ts` no longer computes/passes a title pattern; the "last wk" note label became "last" (the reference can be older than a week). Deployed (version `371e7bd6`). Verified: a Lower push with no explicit weights auto-seeded Front Squat / RDL / Bulgarian / Leg Curl / Pallof.

2026-06-22 — **default rest timers**: when a payload omits `rest_seconds`, the Worker now fills a pattern-based default (compound 150s / accessory 75s / core 30s) via `defaultRestSeconds()` in `routine.ts`, so every pushed exercise ships with a Hevy countdown timer. Explicit `rest_seconds` still wins. Triggered by the owner (6/22) — manual pushes were sending no rest, so the app showed no timer between sets. Deployed (version `a1ba0345`).

2026-05-27 — PUT 404 self-heal: cached `routine_id` returning 404 (routine deleted in Hevy app) falls back to POST; new fields `put_404_recovered` + `put_404_recovery_note` in response + a `self_heal` block in audit `payload_json`. Mirrors the 2026-05-26 folder-id 400 self-heal pattern. Live trigger: Life HQ handoff 2026-05-27 (the owner workaround via `IDEMPOTENCY_SUFFIX=-r2` retired).
2026-05-26 (PM2) — payload extended with three optional prescription fields: `target_weight_lb`, `set_weights_lb[]`, `rest_seconds`. Worker converts lb→kg (1-decimal), attaches `weight_kg` per set + `rest_seconds` per exercise to the Hevy body. Backwards compatible — payloads omitting the fields produce identical routines to before. Folder-id self-heal also shipped (auto-recovers if `HEVY_FOLDER_ID` becomes invalid).
2026-05-26 (PM) — end-to-end validated; production code clean (debug fields stripped). Three runtime gotchas documented in `Cornerstone/docs/11-hevy-push-shipped.md` lessons-learned section.
2026-05-26 — initial build per `Life HQ/semantic-model/hevy-push-integration.md` + handoff `2026-05-26 — Hevy routine-push`.
