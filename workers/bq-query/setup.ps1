# setup.ps1 — one-paste setup for the cornerstone-bq-query Worker's read-only access.
#
# Creates a dedicated least-privilege service account, grants it read-only access to the life_ops
# dataset (dataset-level READER) + the ability to run query jobs (project jobUser), mints its key,
# and generates the bearer token. Idempotent: safe to re-run.
#
# Requires the Google Cloud SDK (gcloud + bq) on PATH. If they're not, run this once in the session:
#   $env:Path += ';' + "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin"
#
# After this finishes, deploy with the wrangler commands it prints.

$ErrorActionPreference = 'Stop'

$PROJECT    = 'your-gcp-project'
$DATASET    = 'life_ops'
$SA_NAME    = 'cornerstone-bq-reader'
$SA         = "$SA_NAME@$PROJECT.iam.gserviceaccount.com"
$SECRETS    = "$env:USERPROFILE\secrets\cornerstone"
$KEY_PATH   = "$SECRETS\bq-reader-sa.json"
$TOKEN_PATH = "$SECRETS\bq-query-token.txt"

# --- preflight ---
foreach ($cmd in @('gcloud','bq')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd not found on PATH. Run: `$env:Path += ';' + `"`$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin`""
  }
}
New-Item -ItemType Directory -Force -Path $SECRETS | Out-Null

Write-Host "== 1/5  Service account ==" -ForegroundColor Cyan
$exists = (gcloud iam service-accounts list --project $PROJECT --filter="email:$SA" --format='value(email)' 2>$null)
if ($exists) {
  Write-Host "   exists: $SA"
} else {
  gcloud iam service-accounts create $SA_NAME --project $PROJECT `
    --display-name 'Cornerstone read-only BQ query Worker' | Out-Null
  Write-Host "   created: $SA"
}

Write-Host "== 2/5  Project role: bigquery.jobUser (run query jobs) ==" -ForegroundColor Cyan
# add-iam-policy-binding is idempotent (no duplicate binding is created).
gcloud projects add-iam-policy-binding $PROJECT `
  --member "serviceAccount:$SA" --role 'roles/bigquery.jobUser' --condition=None | Out-Null
Write-Host "   granted jobUser"

Write-Host "== 3/5  dataViewer role (read data, no write) ==" -ForegroundColor Cyan
# Try dataset-level IAM first (tightest). If the project lacks the dataset-IAM allowlist
# (`bq add-iam-policy-binding` for datasets is in preview), fall back to project-level
# dataViewer. In a single-dataset project this grants identical effective access.
bq add-iam-policy-binding `
  --member="serviceAccount:$SA" `
  --role="roles/bigquery.dataViewer" `
  "${PROJECT}:${DATASET}" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host "   granted dataViewer on dataset $DATASET (tight)"
} else {
  Write-Host "   dataset-level IAM not allowlisted; falling back to project-level dataViewer" -ForegroundColor Yellow
  gcloud projects add-iam-policy-binding $PROJECT `
    --member="serviceAccount:$SA" `
    --role="roles/bigquery.dataViewer" `
    --condition=None | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "could not grant dataViewer at project or dataset level (exit $LASTEXITCODE)"
  }
  Write-Host "   granted dataViewer on project $PROJECT"
}

Write-Host "== 4/5  Service-account key ==" -ForegroundColor Cyan
if (Test-Path $KEY_PATH) {
  Write-Host "   key already exists: $KEY_PATH (skipping; delete it to rotate)"
} else {
  gcloud iam service-accounts keys create $KEY_PATH --iam-account $SA | Out-Null
  Write-Host "   wrote $KEY_PATH"
}

Write-Host "== 5/5  Bearer token ==" -ForegroundColor Cyan
if (Test-Path $TOKEN_PATH) {
  Write-Host "   token already exists: $TOKEN_PATH (skipping; delete it to rotate)"
} else {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') | Set-Content -Path $TOKEN_PATH -NoNewline -Encoding ascii
  Write-Host "   wrote $TOKEN_PATH"
}

Write-Host ""
Write-Host "Done. Now deploy the worker:" -ForegroundColor Green
Write-Host "  cd $PSScriptRoot"
Write-Host "  npm install"
Write-Host "  npm run typecheck"
Write-Host "  Get-Content `"$KEY_PATH`" -Raw | npx wrangler secret put GCP_SA_KEY"
Write-Host "  Get-Content `"$TOKEN_PATH`" -Raw | npx wrangler secret put QUERY_TOKEN"
Write-Host "  npm run deploy"
Write-Host ""
Write-Host "Smoke test (after deploy):" -ForegroundColor Green
Write-Host "  curl.exe `"https://cornerstone-bq-query.YOUR-SUBDOMAIN.workers.dev/healthz`""
Write-Host "  `$t = Get-Content `"$TOKEN_PATH`""
Write-Host "  curl.exe `"https://cornerstone-bq-query.YOUR-SUBDOMAIN.workers.dev/named?name=weight_trend&start=2026-05-01&end=2026-05-25&token=`$t`""
