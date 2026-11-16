export interface Env {
  // KV namespace for OAuth state + tokens + last_seen cursor
  WITHINGS_STATE: KVNamespace;

  // vars (wrangler.toml [vars])
  GCP_PROJECT: string;
  BQ_DATASET: string;
  SUBJECT_ID: string;
  TIMEZONE: string;
  WITHINGS_SCOPE: string;

  // secrets (wrangler secret put)
  WITHINGS_CLIENT_ID: string;
  WITHINGS_CLIENT_SECRET: string;
  WITHINGS_REDIRECT_URI: string;
  GCP_SA_KEY: string;
  ADMIN_TOKEN: string;
}
