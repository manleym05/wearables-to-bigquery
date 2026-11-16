-- raw_macrofactor_daily + raw_macrofactor_food — the nutrition domain.
-- Built 2026-07-26 from the Life HQ passback (P2). Closes the last major data gap: nutrition existed
-- only as a weekly spreadsheet parsed by hand in the Cowork session.
--
-- WHAT THIS UNBLOCKS
--   • `fct_sleep_dinner_chain` has never had a dinner arm — dinner timestamps live in the MF food log.
--   • Energy balance is unqueryable without it, so a deficit running alongside rising training
--     load stays invisible to every other view.
--   • Protein can't join to Hevy volume or Withings lean mass, so the recomp thesis is untestable.
--   • Sat fat / fiber can't be regressed against any lab-cadence lipid panel.
--
-- SIZING: ~15 food rows/day + 1 daily row ≈ 6,000 rows/year. A decade is ~60k rows, low single-digit MB.
-- There is no cost argument against this at any horizon.
--
-- NO PUBLIC API. MacroFactor exports on user action only, so this is a WEEKLY BATCH, not a feed — fine,
-- nutrition has no intraday requirement. Loaded by `scripts/ingest_macrofactor.py`.
--
-- ⚠️ SCHEMA-DRIFT RULE: `raw_json` MUST carry the complete source row on every insert. MF owns these
-- columns and will change them. The typed columns are a convenience; **raw_json is the contract.**
-- (It is written as an object always, never a JSON null — an NDJSON `"raw_json": null` lands as a JSON
-- null literal for which `IS NOT NULL` is TRUE, which silently poisons every downstream guard.)

-- ===== Sheet "Quick Export" — one row per day =====
CREATE TABLE IF NOT EXISTS life_ops.raw_macrofactor_daily (
  subject_id      INT64 NOT NULL,
  day             DATE  NOT NULL,
  -- MF model outputs
  expenditure      FLOAT64,   -- MF's TDEE estimate; cross-check against Oura total_calories
  trend_weight_lb  FLOAT64,   -- MF's smoothed weight (differs from the scale print — that's the point)
  scale_weight_lb  FLOAT64,
  -- intake + targets
  kcal FLOAT64, protein_g FLOAT64, fat_g FLOAT64, carbs_g FLOAT64,
  target_kcal FLOAT64, target_protein_g FLOAT64, target_fat_g FLOAT64, target_carbs_g FLOAT64,
  steps INT64,
  alcohol_g FLOAT64, caffeine_mg FLOAT64,
  -- fats
  sat_fat_g FLOAT64, mono_fat_g FLOAT64, poly_fat_g FLOAT64, trans_fat_g FLOAT64,
  -- carbs detail
  fiber_g FLOAT64, sugars_g FLOAT64, sugars_added_g FLOAT64, starch_g FLOAT64,
  -- minerals
  sodium_mg FLOAT64, potassium_mg FLOAT64, calcium_mg FLOAT64, magnesium_mg FLOAT64,
  iron_mg FLOAT64, zinc_mg FLOAT64, selenium_mcg FLOAT64,
  -- lipid-related intake, for comparison against lab panels
  omega3_g FLOAT64, omega3_epa_g FLOAT64, omega3_dha_g FLOAT64, omega3_ala_g FLOAT64, omega6_g FLOAT64,
  cholesterol_mg FLOAT64, choline_mg FLOAT64,
  -- vitamins
  vit_a_mcg FLOAT64, vit_c_mg FLOAT64, vit_d_mcg FLOAT64, vit_e_mg FLOAT64, vit_k_mcg FLOAT64,
  b12_mcg FLOAT64, folate_mcg FLOAT64,
  raw_json    JSON   NOT NULL,        -- the FULL source row — the schema-drift contract
  source      STRING NOT NULL,        -- 'macrofactor_xlsx'
  export_file STRING,                 -- provenance: which export produced this row
  ingested_at TIMESTAMP NOT NULL,
  PRIMARY KEY (subject_id, day) NOT ENFORCED
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "MacroFactor daily rollup (Quick Export sheet). Weekly XLSX batch. Cornerstone P2.");

-- ===== Sheet "Food Log" — one row per food entry =====
CREATE TABLE IF NOT EXISTS life_ops.raw_macrofactor_food (
  subject_id   INT64 NOT NULL,
  day          DATE  NOT NULL,
  -- ⚠️ This is the time the food was EATEN (as logged), NOT the time it was entered into the app.
  -- The export carries no entry-time, which is why batch logging is undetectable from the data and
  -- why fct_nutrition_daily has to infer it. See the batch-logging note in 46_fct_nutrition_daily.sql.
  eaten_at     TIMESTAMP,
  food_name    STRING,
  serving_size STRING, serving_qty FLOAT64, serving_weight_g FLOAT64,
  kcal FLOAT64, protein_g FLOAT64, fat_g FLOAT64, carbs_g FLOAT64,
  sat_fat_g FLOAT64, fiber_g FLOAT64, alcohol_g FLOAT64, caffeine_mg FLOAT64,
  sugars_added_g FLOAT64, sodium_mg FLOAT64, omega3_g FLOAT64,
  raw_json    JSON   NOT NULL,
  source      STRING NOT NULL,
  export_file STRING,
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY day
CLUSTER BY subject_id
OPTIONS (description = "MacroFactor per-entry food log. Day-replace on re-ingest. Cornerstone P2.");

-- IDEMPOTENCY (implemented in scripts/ingest_macrofactor.py — recorded here so the contract is
-- discoverable from the schema):
--   • daily → MERGE on (subject_id, day). Newest export_file wins. Exports overlap by design.
--   • food  → DELETE the day, then INSERT. NOT a MERGE: the food log is MUTABLE — the owner edits
--     portions and deletes mistaken entries. A MERGE on (eaten_at, food_name, serving_qty) would
--     leave deleted entries orphaned in BQ forever, inflating every intake total for that day.
--     Day-replace is the only construction that converges on the source of truth.
