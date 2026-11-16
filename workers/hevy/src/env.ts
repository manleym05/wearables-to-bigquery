export interface Env {
  HEVY_STATE: KVNamespace;

  GCP_PROJECT: string;
  BQ_DATASET: string;
  SUBJECT_ID: string;
  TIMEZONE: string;

  HEVY_API_KEY: string;
  GCP_SA_KEY: string;
  ADMIN_TOKEN: string;
}
