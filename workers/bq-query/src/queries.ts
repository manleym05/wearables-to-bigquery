// Named, parameterized read-only queries. Life HQ calls these by id (`/named?name=...`) so its
// render path never embeds SQL or ships the SA private key. @subject_id is injected automatically
// by the worker from env.SUBJECT_ID; declared params below must be supplied by the caller.
//
// Add render queries here as they stabilize; until then, anything ad-hoc can go through /sql.
// (Life HQ's canonical render SQL lives in Life HQ/pipelines/card-render-queries.md — port the
// hot ones here over time so the consumer is fully name-driven.)

export interface NamedQuery {
  description: string;
  params: Record<string, string>; // param name -> BigQuery type (e.g. "DATE", "INT64")
  sql: string;
}

export const NAMED_QUERIES: Record<string, NamedQuery> = {
  oura_daily_on: {
    description:
      "Oura daily rollup for a wake-date (scores + HRV/RHR/sleep). HRV/RHR are NULL when only a nap exists for the day (pending) — never a nap's values.",
    params: { day: "DATE" },
    sql: `
      SELECT day, sleep_score, readiness_score, activity_score,
             hrv_avg_ms, rhr_low_bpm, rhr_avg_bpm,
             sleep_total_h, sleep_deep_h, sleep_rem_h, sleep_light_h, sleep_efficiency_pct,
             respiratory_rate, body_temp_dev_c, steps
      FROM life_ops.raw_oura_daily
      WHERE subject_id = @subject_id AND day = @day`,
  },

  primary_sleep_on: {
    description:
      "Primary overnight sleep session (longest long_sleep, naps excluded) for a wake-date — the HRV/RHR source of truth.",
    params: { day: "DATE" },
    sql: `
      SELECT day, sleep_id, type, bedtime_start, bedtime_end,
             total_sleep_h, avg_hrv_ms, hr_lowest_bpm, hr_avg_bpm,
             efficiency_pct, deep_sleep_h, rem_sleep_h, light_sleep_h
      FROM life_ops.raw_oura_sleep
      WHERE subject_id = @subject_id AND day = @day AND type = 'long_sleep'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY day ORDER BY total_sleep_h DESC) = 1`,
  },

  metrics_on: {
    description: "All unified metrics_daily rows for a day (long format).",
    params: { day: "DATE" },
    sql: `
      SELECT metric, value, unit, source
      FROM life_ops.metrics_daily
      WHERE subject_id = @subject_id AND day = @day
      ORDER BY source, metric`,
  },

  weight_trend: {
    description: "Daily weight / body-fat / lean-mass between two dates (inclusive).",
    params: { start: "DATE", end: "DATE" },
    sql: `
      SELECT day,
        MAX(IF(metric = 'weight_lb',    value, NULL)) AS weight_lb,
        MAX(IF(metric = 'body_fat_pct', value, NULL)) AS body_fat_pct,
        MAX(IF(metric = 'lean_mass_lb', value, NULL)) AS lean_mass_lb
      FROM life_ops.metrics_daily
      WHERE subject_id = @subject_id AND source = 'withings'
        AND day BETWEEN @start AND @end
      GROUP BY day ORDER BY day`,
  },

  meeting_load_on: {
    description: "Per-calendar meeting counts/minutes for a day.",
    params: { day: "DATE" },
    sql: `
      SELECT metric, value, unit
      FROM life_ops.metrics_daily
      WHERE subject_id = @subject_id AND source = 'calendar' AND day = @day
      ORDER BY metric`,
  },
};
