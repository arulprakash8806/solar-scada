# Solar Farm SCADA - Fly.io Deployment Script
# Run from the solar-scada root directory: .\deploy.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Deploy-Service {
    param($Name, $Dir)
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Deploying: $Name" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Set-Location "$Root\$Dir"
    fly deploy --wait-timeout 120
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: $Name deployment failed!" -ForegroundColor Red
        exit 1
    }
    Write-Host "$Name deployed successfully!" -ForegroundColor Green
}

Write-Host ""
Write-Host "Solar Farm SCADA - Fly.io Deployment" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Yellow

# Check flyctl is available
if (-not (Get-Command fly -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: flyctl not found. Install it first:" -ForegroundColor Red
    Write-Host "  iwr https://fly.io/install.ps1 -useb | iex" -ForegroundColor White
    exit 1
}

# Check logged in
fly auth whoami | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not logged in. Running fly auth login..." -ForegroundColor Yellow
    fly auth login
}

Write-Host ""
Write-Host "Pulling latest from GitHub..." -ForegroundColor Yellow
Set-Location $Root
git pull

# Deploy in order
Deploy-Service "1/4 - Solar Exporter (Python)" "exporter"
Deploy-Service "2/4 - Prometheus" "prometheus"
Deploy-Service "3/4 - Grafana" "grafana"
Deploy-Service "4/4 - Backend + Dashboard" "backend"

# Return to root
Set-Location $Root

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  All services deployed successfully!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Live URLs:" -ForegroundColor Yellow
Write-Host "  Dashboard  -> https://backend-dark-paper-3650.fly.dev" -ForegroundColor White
Write-Host "  Grafana    -> https://grafana-lingering-wave-5682.fly.dev" -ForegroundColor White
Write-Host "  Prometheus -> https://prometheus-long-frost-4688.fly.dev" -ForegroundColor White
Write-Host "  Exporter   -> https://exporter.fly.dev/metrics" -ForegroundColor White
Write-Host ""
Write-Host "Grafana login: admin / solar123" -ForegroundColor Cyan
