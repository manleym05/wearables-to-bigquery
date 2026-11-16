export interface Env {
  STRAVA_STATE: KVNamespace;

  GCP_PROJECT: string;
  BQ_DATASET: string;
  SUBJECT_ID: string;
  TIMEZONE: string;
  STRAVA_SCOPE: string;

  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_REDIRECT_URI: string;
  GCP_SA_KEY: string;
  ADMIN_TOKEN: string;
}
