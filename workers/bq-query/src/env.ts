export interface Env {
  GCP_PROJECT: string;
  BQ_DATASET: string;
  SUBJECT_ID: string;
  TIMEZONE: string;
  MAX_BYTES_BILLED: string;

  GCP_SA_KEY: string;   // read-only query SA JSON
  QUERY_TOKEN: string;  // shared bearer token for all routes
}
