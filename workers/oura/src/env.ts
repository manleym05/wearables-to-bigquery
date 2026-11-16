export interface Env {
  // KV namespace for cursor + OAuth state/tokens
  OURA_STATE: KVNamespace;

  // vars (wrangler.toml [vars])
  GCP_PROJECT: string;
  BQ_DATASET: string;
  SUBJECT_ID: string;
  TIMEZONE: string;
  OURA_SCOPE: string;

  // secrets (wrangler secret put)
  OURA_CLIENT_ID: string;
  OURA_CLIENT_SECRET: string;
  OURA_REDIRECT_URI: string;
  GCP_SA_KEY: string;
  BACKFILL_TOKEN: string;
  // Deprecated PAT fallback — used only until the one-time /oauth/start grant lands in KV.
  // Delete the secret (`wrangler secret delete OURA_PAT`) after OAuth is confirmed working.
  OURA_PAT?: string;
}
