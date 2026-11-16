# BigQuery schemas — `life_ops` dataset

DDL for the Cornerstone data layer. Project `your-gcp-project`, dataset `life_ops` (US multi-region).

## Apply order

Run in numeric order. Tables first, then the view (depends on `raw_oura_daily`), then seeds.

| # | File | Creates |
|---|---|---|
| 01 | `01_raw_oura_daily.sql` | `raw_oura_daily` table (daily Oura trend, wake-date keyed) |
| 02 | `02_raw_oura_sleep.sql` | `raw_oura_sleep` table (per-session detail; source of HRV ms / RHR bpm) |
| 03 | `03_profile_static.sql` | `profile_static` table |
| 04 | `04_targets.sql` | `targets` table (effective-dated) |
| 05 | `05_metrics_daily_view.sql` | `metrics_daily` view (full long-format unification: Oura + Withings + Strava + Hevy + Calendar). Withings measure uses per-column latest-non-null aggregation — see 2026-05-25 note below) |
| 06 | `06_seed_profile_static.sql` | seeds the owner into `profile_static` (idempotent MERGE) |
| 07 | `07_seed_targets.sql` | seeds STABILIZE-phase targets (idempotent MERGE) |
| 08 | `08_raw_oura_daily_stress.sql` | `raw_oura_daily_stress` (daily stress/recovery seconds + day summary) |
| 09 | `09_raw_oura_daily_spo2.sql` | `raw_oura_daily_spo2` (avg SpO2 + breathing disturbance index) |
| 10 | `10_raw_oura_daily_resilience.sql` | `raw_oura_daily_resilience` (level + 3 contributor sub-scores) |
| 11 | `11_raw_oura_daily_cardio_age.sql` | `raw_oura_daily_cardio_age` (vascular age + pulse-wave velocity) |
| 12 | `12_raw_oura_vo2_max.sql` | `raw_oura_vo2_max` (sparse VO2 max measurements) |
| 13 | `13_raw_oura_workout.sql` | `raw_oura_workout` (per-workout events, Oura's view incl. Strava-synced) |
| 14 | `14_raw_oura_session.sql` | `raw_oura_session` (meditation/breathing/nap; time-series in `raw_json`) |
| 15 | `15_raw_oura_enhanced_tag.sql` | `raw_oura_enhanced_tag` (user-applied tags — causal signals) |
| 16 | `16_raw_oura_rest_mode_period.sql` | `raw_oura_rest_mode_period` (illness/injury/recovery periods) |
| 17 | `17_raw_oura_sleep_time.sql` | `raw_oura_sleep_time` (recommended optimal bedtime per day) |
| 18 | `18_raw_oura_personal_info.sql` | `raw_oura_personal_info` (single-row, age/weight/height snapshot) |
| 19 | `19_raw_oura_ring_config.sql` | `raw_oura_ring_config` (ring metadata, multi-row for upgrades) |
| 20 | `20_alter_raw_oura_daily.sql` | ALTER: adds enrichment columns to `raw_oura_daily` (calories, MET minutes, sedentary, contributors JSON) |
| 21 | `21_raw_withings_measure.sql` | `raw_withings_measure` (pivoted measure groups — weight, body comp, BP, SpO2, VO2, etc.) |
| 22 | `22_raw_withings_sleep.sql` | `raw_withings_sleep` (nightly sleep summary from Withings mat/watch) |
| 23 | `23_raw_withings_activity.sql` | `raw_withings_activity` (daily activity from Withings watch) |
| 24 | `24_raw_withings_workout.sql` | `raw_withings_workout` (per-workout: HR zones, distance, calories) |
| 25 | `25_raw_withings_heart.sql` | `raw_withings_heart` (ECG screenings + BP cuff readings) |
| 26 | `26_raw_withings_device.sql` | `raw_withings_device` (devices snapshot) |
| 27 | `27_raw_strava_activity.sql` | `raw_strava_activity` (per-activity summaries — type, distance, HR, watts, etc.) |
| 28 | `28_raw_strava_athlete.sql` | `raw_strava_athlete` (profile singleton) |
| 29 | `29_raw_strava_zones.sql` | `raw_strava_zones` (HR + power zone definitions) |
| 30 | `30_raw_hevy_workout.sql` | `raw_hevy_workout` (per-session, with set_count/volume/avg_rpe derived) |
| 31 | `31_raw_hevy_set.sql` | `raw_hevy_set` (per-set: weight/reps/rpe/type, joinable to exercise_template) |
| 32 | `32_raw_hevy_exercise_template.sql` | `raw_hevy_exercise_template` (catalog — 433 stock + custom exercises) |
| 33 | `33_raw_calendar_events.sql` | `raw_calendar_events` (Google Calendar from 3 cals; loaded by Apps Script daily) |
| 34 | `34_raw_maps_directions.sql` | `raw_maps_directions` (Maps Directions cache; populated on-demand by `cornerstone-maps` Worker) |
| 35 | `35_action_log.sql` | `action_log` (audit table for all outbound action components — first writer: `cornerstone-hevy-push`. Future writers: grocery ordering, calendar writes) |
| 36 | `36_raw_oura_heartrate.sql` | `raw_oura_heartrate` (intraday HR, one row per sample) |
| 37 | `37_fct_workout_strain.sql` | `fct_workout_strain` (per-session strain + Z2 creep) |
| 38 | `38_fct_sleep_dinner_chain.sql` | `fct_sleep_dinner_chain` (overnight HR curve → morning recovery) |
| 39 | `39_fct_daily_load_ledger.sql` | `fct_daily_load_ledger` (daily spend↔recovery ledger; **carries the P1 trend columns — re-apply after 42**) |
| 40 | `40_review_scorecard_views.sql` | `metrics_weekly`, `longevity_scorecard`, `review_targets_current`, `longevity_monthly` |
| 41 | `41_raw_oura_ring_battery_level.sql` | `raw_oura_ring_battery_level` |
| 42 | `42_fct_recovery_trend.sql` | **`fct_recovery_trend`** — HRV/RHR trend vs a NON-OVERLAPPING 28d baseline + `gate_trend_flag`. The W30 guardrail (P1) |
| 43 | `43_fct_cardio_efficiency.sql` | **`fct_cardio_efficiency`** — pace + m/beat at equal cardiac cost; the non-Oura-derived corroborator |
| 44 | `44_fct_session_reconciliation.sql` | **`fct_session_reconciliation`** — logged vs prescribed exercise contents → `match_quality` / `effective_split` (P3) |
| 45 | `45_raw_macrofactor.sql` | **`raw_macrofactor_daily`** + **`raw_macrofactor_food`** — nutrition raw layer (P2) |
| 46 | `46_fct_nutrition_daily.sql` | **`fct_nutrition_daily`** — targets vs actuals, energy balance, meal timing + `timing_confidence` (P2) |
| 47 | `47_fct_fuel_vs_load.sql` | **`fct_fuel_vs_load`** — fuel + load on day D vs recovery read forward at D+1…D+5 (P2 view #3) |

**Note on 38:** `fct_sleep_dinner_chain` gained its dinner arm on 2026-07-26 and now depends on
`fct_nutrition_daily` (46) and `raw_macrofactor_food` (45) — apply those first.

## Apply (Windows cmd, from this folder)

```
cd /d "<repo>\schemas"
bq query --use_legacy_sql=false < 01_raw_oura_daily.sql
bq query --use_legacy_sql=false < 02_raw_oura_sleep.sql
bq query --use_legacy_sql=false < 03_profile_static.sql
bq query --use_legacy_sql=false < 04_targets.sql
bq query --use_legacy_sql=false < 05_metrics_daily_view.sql
bq query --use_legacy_sql=false < 06_seed_profile_static.sql
bq query --use_legacy_sql=false < 07_seed_targets.sql
bq query --use_legacy_sql=false < 08_raw_oura_daily_stress.sql
bq query --use_legacy_sql=false < 09_raw_oura_daily_spo2.sql
bq query --use_legacy_sql=false < 10_raw_oura_daily_resilience.sql
bq query --use_legacy_sql=false < 11_raw_oura_daily_cardio_age.sql
bq query --use_legacy_sql=false < 12_raw_oura_vo2_max.sql
bq query --use_legacy_sql=false < 13_raw_oura_workout.sql
bq query --use_legacy_sql=false < 14_raw_oura_session.sql
bq query --use_legacy_sql=false < 15_raw_oura_enhanced_tag.sql
bq query --use_legacy_sql=false < 16_raw_oura_rest_mode_period.sql
bq query --use_legacy_sql=false < 17_raw_oura_sleep_time.sql
bq query --use_legacy_sql=false < 18_raw_oura_personal_info.sql
bq query --use_legacy_sql=false < 19_raw_oura_ring_config.sql
bq query --use_legacy_sql=false < 20_alter_raw_oura_daily.sql
bq query --use_legacy_sql=false < 21_raw_withings_measure.sql
bq query --use_legacy_sql=false < 22_raw_withings_sleep.sql
bq query --use_legacy_sql=false < 23_raw_withings_activity.sql
bq query --use_legacy_sql=false < 24_raw_withings_workout.sql
bq query --use_legacy_sql=false < 25_raw_withings_heart.sql
bq query --use_legacy_sql=false < 26_raw_withings_device.sql
bq query --use_legacy_sql=false < 27_raw_strava_activity.sql
bq query --use_legacy_sql=false < 28_raw_strava_athlete.sql
bq query --use_legacy_sql=false < 29_raw_strava_zones.sql
bq query --use_legacy_sql=false < 30_raw_hevy_workout.sql
bq query --use_legacy_sql=false < 31_raw_hevy_set.sql
bq query --use_legacy_sql=false < 32_raw_hevy_exercise_template.sql
bq query --use_legacy_sql=false < 33_raw_calendar_events.sql
bq query --use_legacy_sql=false < 34_raw_maps_directions.sql
bq query --use_legacy_sql=false < 35_action_log.sql
bq query --use_legacy_sql=false < 36_raw_oura_heartrate.sql
bq query --use_legacy_sql=false < 37_fct_workout_strain.sql
bq query --use_legacy_sql=false < 38_fct_sleep_dinner_chain.sql
bq query --use_legacy_sql=false < 40_review_scorecard_views.sql
bq query --use_legacy_sql=false < 41_raw_oura_ring_battery_level.sql
bq query --use_legacy_sql=false < 42_fct_recovery_trend.sql
bq query --use_legacy_sql=false < 43_fct_cardio_efficiency.sql
bq query --use_legacy_sql=false < 44_fct_session_reconciliation.sql
bq query --use_legacy_sql=false < 45_raw_macrofactor.sql
bq query --use_legacy_sql=false < 46_fct_nutrition_daily.sql
bq query --use_legacy_sql=false < 47_fct_fuel_vs_load.sql
bq query --use_legacy_sql=false < 38_fct_sleep_dinner_chain.sql # AFTER 45+46 — dinner arm joins both
bq query --use_legacy_sql=false < 39_fct_daily_load_ledger.sql  # AFTER 42 — it joins fct_recovery_trend
bq query --use_legacy_sql=false < 05_metrics_daily_view.sql     # re-apply after adding new sources
```

**Ordering notes.** Two views must be applied late because they join views defined further down the
list:

- `39` (`fct_daily_load_ledger`) after `42` — it LEFT JOINs `fct_recovery_trend`.
- `38` (`fct_sleep_dinner_chain`) after `45` + `46` — the dinner arm joins `raw_macrofactor_food` and
  `fct_nutrition_daily`.

Everything else is order-independent within its own layer.

## Conventions

- **`subject_id`** on every table. `1` = the owner. Future-proofs a second subject (`2`) without migration.
- **Wake-date** sleep convention: a sleep is stamped with the date you woke up.
- **Timezone**: normalize to `America/New_York` (from `profile_static.timezone`).
- **Idempotency**: raw tables load via MERGE on natural key — `(subject_id, day)` for daily-rollup
  tables, `(subject_id, <entity>_id)` for per-event tables. The Worker source-dedupes via QUALIFY
  before MERGE so concurrent invocations + Oura API duplicates can't produce target duplicates.
  Seeds use MERGE so they re-run safely.
- **`raw_json`** column preserves full vendor payload for debugging back to source.
- **Partition by date, cluster by `subject_id`** — keeps query bytes (cost) low.
- **`PRIMARY KEY ... NOT ENFORCED`** documents the natural key and helps the optimizer;
  BigQuery does not enforce uniqueness, so the load path must.

## metrics_daily — Withings tie-break fix (2026-05-25)

`withings_measure_latest` used to pick one whole row per day (`ROW_NUMBER() ... ORDER BY
measured_at DESC = 1`). Withings splits one weigh-in into several measure-groups sharing the **same
`measured_at`** (scale body-comp group, a heart-pulse group, an all-null group), so the tie-break
landed nondeterministically on a null-weight group and dropped `weight_lb` / `body_fat_pct` /
`lean_mass_lb` for ~half of days (verified missing 5/14, 5/15, 5/16, 5/19). The CTE now aggregates
**each column independently to its latest non-null value** via
`ARRAY_AGG(col IGNORE NULLS ORDER BY measured_at DESC LIMIT 1)[SAFE_OFFSET(0)]`, which both stops
the drop and merges metrics arriving in different same-instant groups. Output schema unchanged.
Deployed via `CREATE OR REPLACE VIEW` 2026-05-25; verified weight present for every weigh-in day.
See `Life HQ/reviews/handoffs.md` (2026-05-21 reverse handoff).

## Not in Phase 1 (deferred)

`events`/`phases` views, MacroFactor/Plaid/Apple-Health/Weather raw tables,
`meal_plans`/`grocery_lists` (Phase 3 — see arch doc §9).
