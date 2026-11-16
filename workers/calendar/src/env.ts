export interface Env {
  GCP_PROJECT: string;
  TIMEZONE: string;
  SUBJECT_ID: string;
  /** The dedicated "Life HQ – Daily Plan" calendar — the ONLY writable target (scope-lock). */
  CALENDAR_ID: string;

  GCP_SA_KEY: string;   // SA JSON; the dedicated cal is shared to it w/ "Make changes to events"
  ADMIN_TOKEN: string;  // shared bearer for /write + /list
}
