export interface Env {
  // Vars
  GCP_PROJECT: string;
  BQ_DATASET: string;
  SUBJECT_ID: string;
  TIMEZONE: string;
  HEVY_API_BASE: string;
  WORKER_VERSION: string;
  HEVY_FOLDER_ID: string;          // "" → default folder
  ALLOWED_GATES: string;

  // Secrets
  HEVY_API_KEY: string;
  GCP_SA_KEY: string;
  ADMIN_TOKEN: string;
}
