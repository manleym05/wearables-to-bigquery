// Hevy v1 API client.
// Auth: header `api-key: <key>`. No OAuth.
// Pagination: ?page=1&pageSize=N. Max pageSize varies by endpoint.
//   /v1/workouts: max 10 per page
//   /v1/exercise_templates: max 100 per page
//   /v1/routines: max 5 per page
// Workouts come back sorted newest-first by start_time.

const API_BASE = "https://api.hevyapp.com";

export interface Set {
  index: number;
  type: string;                  // 'normal' | 'warmup' | 'drop' | 'failure'
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  custom_metric?: number | null;
}

export interface Exercise {
  index: number;
  title: string;
  notes?: string;
  exercise_template_id: string;
  supersets_id?: number | null;
  sets: Set[];
}

export interface Workout {
  id: string;
  title: string;
  description?: string;
  start_time: string;       // ISO 8601
  end_time: string;
  updated_at?: string;
  created_at?: string;
  exercises: Exercise[];
}

export interface ExerciseTemplate {
  id: string;
  title: string;
  type: string;             // 'weight_reps' | 'weight_distance' | 'reps_only' | etc.
  primary_muscle_group?: string;
  secondary_muscle_groups?: string[];
  equipment?: string;
  is_custom?: boolean;
}

interface WorkoutsPage {
  page: number;
  page_count: number;
  workouts: Workout[];
}

interface ExerciseTemplatesPage {
  page: number;
  page_count: number;
  exercise_templates: ExerciseTemplate[];
}

async function get<T>(path: string, params: Record<string, string>, apiKey: string): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { "api-key": apiKey } });
  if (!res.ok) throw new Error(`hevy ${path} HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// Paginate workouts newest-first, stop as soon as we cross startYmd (inclusive on both ends).
export async function getWorkoutsInRange(
  apiKey: string, startYmd: string, endYmd: string,
): Promise<Workout[]> {
  const startEpoch = Date.parse(`${startYmd}T00:00:00Z`);
  const endEpoch = Date.parse(`${endYmd}T23:59:59Z`);
  const out: Workout[] = [];
  const pageSize = 10;
  for (let page = 1; page < 500; page++) {
    const body = await get<WorkoutsPage>("/v1/workouts", { page: String(page), pageSize: String(pageSize) }, apiKey);
    const workouts = body.workouts ?? [];
    let oldestInPage = Infinity;
    for (const w of workouts) {
      const ts = Date.parse(w.start_time);
      if (Number.isNaN(ts)) continue;
      oldestInPage = Math.min(oldestInPage, ts);
      if (ts >= startEpoch && ts <= endEpoch) out.push(w);
    }
    // Early-exit: page is older than the window's start, or no more pages.
    if (workouts.length === 0) break;
    if (oldestInPage < startEpoch) break;
    if (page >= (body.page_count ?? page)) break;
  }
  return out;
}

export async function getAllExerciseTemplates(apiKey: string): Promise<ExerciseTemplate[]> {
  const out: ExerciseTemplate[] = [];
  const pageSize = 100;
  for (let page = 1; page < 50; page++) {
    const body = await get<ExerciseTemplatesPage>(
      "/v1/exercise_templates",
      { page: String(page), pageSize: String(pageSize) },
      apiKey,
    );
    const templates = body.exercise_templates ?? [];
    out.push(...templates);
    if (templates.length === 0) break;
    if (page >= (body.page_count ?? page)) break;
  }
  return out;
}
