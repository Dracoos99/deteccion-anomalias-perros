<#
  One-time setup of Google Cloud for the simulator on Cloud Run Jobs and for the deploys from GitHub Actions.
  It can be run again: it creates only what is missing and refreshes the simulator data.

  Needs the Google Cloud CLI signed in with an owner of the project:  gcloud auth login
  Usage (PowerShell, from the repository root, where ml/data/processed/sim exists):
    .\scripts\cloud\setup-gcp.ps1 -GithubRepo usuario/repositorio

  What it does:
    1. APIs of Cloud Run, Artifact Registry, IAM and Workload Identity Federation.
    2. A bucket with the prepared simulator signals (ml/data/processed/sim, about 245 MB).
    3. An Artifact Registry repository for the simulator image (keeps the latest 3).
    4. Daily backups of the Firestore database, kept 7 days (what the app promises when data are deleted).
    5. Service accounts: sim-runner (runs the job) and github-deployer (used by GitHub Actions).
    6. Roles: the job reads the bucket and writes Firestore; the Functions may start the job; GitHub may deploy.
    7. Workload Identity Federation: only the main branch of the given repository can act as github-deployer.
    8. Prints the variables to set in GitHub.
#>
param(
  [Parameter(Mandatory = $true)][string]$GithubRepo,
  [string]$ProjectId = "proyectotp1-15497",
  [string]$Region = "us-central1",
  [string]$Bucket = "",
  [string]$SimData = "ml/data/processed/sim"
)
$ErrorActionPreference = "Continue"
if (-not $Bucket) { $Bucket = "$ProjectId-sim-data" }

# Terminals opened before installing the Google Cloud CLI do not have it in PATH: use the default install folder.
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  $sdk = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin"
  if (-not (Test-Path (Join-Path $sdk "gcloud.cmd"))) { throw "No encuentro gcloud. Instala Google Cloud CLI o abre una terminal nueva." }
  $env:Path = "$sdk;$env:Path"
}
$account = (& gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>$null)
if (-not $account) { throw "No hay una sesión de gcloud: ejecuta primero  gcloud auth login" }
Write-Host "Cuenta de Google Cloud: $account"

function Run([string[]]$GcloudArgs) {
  & gcloud @GcloudArgs
  if ($LASTEXITCODE -ne 0) { throw "Falló: gcloud $($GcloudArgs -join ' ')" }
}
function Exists([string[]]$GcloudArgs) {
  & gcloud @GcloudArgs --quiet *> $null
  return ($LASTEXITCODE -eq 0)
}
function Bind([string]$Member, [string]$Role) {
  Run @("projects", "add-iam-policy-binding", $ProjectId, "--member=$Member", "--role=$Role", "--condition=None", "--quiet", "--format=none")
}

if (-not (Test-Path (Join-Path $SimData "manifest.json"))) { throw "No encuentro $SimData/manifest.json: corre este script desde la raíz del repositorio." }
if ($GithubRepo -notmatch '^[\w.-]+/[\w.-]+$') { throw "GithubRepo debe tener la forma usuario/repositorio." }

Write-Host "`n1/8 Proyecto y APIs" -ForegroundColor Cyan
Run @("config", "set", "project", $ProjectId)
$number = (& gcloud projects describe $ProjectId --format="value(projectNumber)").Trim()
Run @("services", "enable", "run.googleapis.com", "artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "iam.googleapis.com",
  "iamcredentials.googleapis.com", "sts.googleapis.com", "cloudresourcemanager.googleapis.com", "storage.googleapis.com")

Write-Host "`n2/8 Bucket con los datos del simulador" -ForegroundColor Cyan
if (-not (Exists @("storage", "buckets", "describe", "gs://$Bucket"))) {
  Run @("storage", "buckets", "create", "gs://$Bucket", "--location=$Region", "--uniform-bucket-level-access")
}
Run @("storage", "rsync", $SimData, "gs://$Bucket/sim", "--recursive")

Write-Host "`n3/8 Repositorio de imágenes" -ForegroundColor Cyan
if (-not (Exists @("artifacts", "repositories", "describe", "simulator", "--location=$Region"))) {
  Run @("artifacts", "repositories", "create", "simulator", "--repository-format=docker", "--location=$Region", "--description=Simulador")
}
$policy = Join-Path $env:TEMP "simulator-cleanup.json"
'[{"name":"keep-latest","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}},{"name":"delete-older","action":{"type":"Delete"},"condition":{"tagState":"any","olderThan":"1d"}}]' |
  Set-Content -Encoding ascii $policy
Run @("artifacts", "repositories", "set-cleanup-policies", "simulator", "--location=$Region", "--policy=$policy", "--no-dry-run", "--quiet")

Write-Host "`n4/8 Copias de seguridad de Firestore" -ForegroundColor Cyan
# Daily, kept 7 days. Created once: another run leaves an existing schedule as it is.
$schedules = (& gcloud firestore backups schedules list --database="(default)" --format="value(name)" 2>$null)
if (-not $schedules) {
  Run @("firestore", "backups", "schedules", "create", "--database=(default)", "--recurrence=daily", "--retention=7d")
}

Write-Host "`n5/8 Cuentas de servicio" -ForegroundColor Cyan
$sim = "sim-runner@$ProjectId.iam.gserviceaccount.com"
$deployer = "github-deployer@$ProjectId.iam.gserviceaccount.com"
$runtime = "$number-compute@developer.gserviceaccount.com"
if (-not (Exists @("iam", "service-accounts", "describe", $sim))) {
  Run @("iam", "service-accounts", "create", "sim-runner", "--display-name=Simulador en Cloud Run")
}
if (-not (Exists @("iam", "service-accounts", "describe", $deployer))) {
  Run @("iam", "service-accounts", "create", "github-deployer", "--display-name=Despliegues desde GitHub Actions")
}

Write-Host "`n6/8 Roles" -ForegroundColor Cyan
Bind "serviceAccount:$sim" "roles/datastore.user"
Run @("storage", "buckets", "add-iam-policy-binding", "gs://$Bucket", "--member=serviceAccount:$sim", "--role=roles/storage.objectViewer", "--quiet", "--format=none")
Bind "serviceAccount:$runtime" "roles/run.jobsExecutorWithOverrides"
foreach ($role in @("roles/firebase.admin", "roles/cloudfunctions.admin", "roles/run.admin", "roles/iam.serviceAccountUser",
    "roles/artifactregistry.admin", "roles/cloudbuild.builds.editor", "roles/serviceusage.serviceUsageConsumer",
    "roles/firebasehosting.admin", "roles/firebaserules.admin", "roles/datastore.indexAdmin")) {
  Bind "serviceAccount:$deployer" $role
}

Write-Host "`n7/8 Workload Identity Federation (GitHub → Google Cloud, sin claves)" -ForegroundColor Cyan
if (-not (Exists @("iam", "workload-identity-pools", "describe", "github", "--location=global"))) {
  Run @("iam", "workload-identity-pools", "create", "github", "--location=global", "--display-name=GitHub Actions")
}
$condition = "assertion.repository == '$GithubRepo' && assertion.ref == 'refs/heads/main'"
if (Exists @("iam", "workload-identity-pools", "providers", "describe", "github-oidc", "--location=global", "--workload-identity-pool=github")) {
  Run @("iam", "workload-identity-pools", "providers", "update-oidc", "github-oidc", "--location=global", "--workload-identity-pool=github",
    "--attribute-condition=$condition")
} else {
  Run @("iam", "workload-identity-pools", "providers", "create-oidc", "github-oidc", "--location=global", "--workload-identity-pool=github",
    "--display-name=GitHub OIDC", "--issuer-uri=https://token.actions.githubusercontent.com",
    "--attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref",
    "--attribute-condition=$condition")
}
Run @("iam", "service-accounts", "add-iam-policy-binding", $deployer, "--role=roles/iam.workloadIdentityUser",
  "--member=principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/github/attribute.repository/$GithubRepo",
  "--quiet", "--format=none")

Write-Host "`n8/8 Variables para GitHub (Settings > Secrets and variables > Actions > Variables)" -ForegroundColor Cyan
$web = @{}
$envFile = "web/.env.production.local"
if (Test-Path $envFile) {
  Get-Content $envFile | Where-Object { $_ -match '^\s*VITE_[A-Z_]+=' } | ForEach-Object { $k, $v = $_ -split '=', 2; $web[$k.Trim()] = $v.Trim() }
}
$vars = [ordered]@{
  GCP_PROJECT_ID                 = $ProjectId
  GCP_REGION                     = $Region
  GCP_WORKLOAD_IDENTITY_PROVIDER = "projects/$number/locations/global/workloadIdentityPools/github/providers/github-oidc"
  GCP_DEPLOYER_SA                = $deployer
  GCP_SIMULATOR_SA               = $sim
  SIM_DATA_BUCKET                = $Bucket
  FIREBASE_API_KEY               = $web["VITE_FIREBASE_API_KEY"]
  FIREBASE_AUTH_DOMAIN           = $web["VITE_FIREBASE_AUTH_DOMAIN"]
  FIREBASE_APP_ID                = $web["VITE_FIREBASE_APP_ID"]
  FIREBASE_MESSAGING_SENDER_ID   = $web["VITE_FIREBASE_MESSAGING_SENDER_ID"]
  FIREBASE_VAPID_KEY             = $web["VITE_FIREBASE_VAPID_KEY"]
}
$vars.GetEnumerator() | ForEach-Object { "{0,-32} {1}" -f $_.Key, $_.Value }
$out = "github-variables.txt"
# UTF-8 without BOM (Set-Content -Encoding utf8 adds one in Windows PowerShell, and `gh variable set -f` rejects it).
[System.IO.File]::WriteAllLines((Join-Path (Get-Location).Path $out), [string[]]($vars.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }))
Write-Host "`nListo. Las variables también quedaron en $out (no se versiona). Para cargarlas:  gh variable set -f $out --repo $GithubRepo  y luego bórralo." -ForegroundColor Green
