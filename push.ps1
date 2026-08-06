$folder = $PSScriptRoot
Set-Location $folder

# Trova git
$gitPaths = @(
    "C:\Users\Alberto\AppData\Local\GitHubDesktop\app-3.6.3\resources\app\git\cmd\git.exe",
    "C:\Program Files\Git\cmd\git.exe",
    "C:\Program Files\Git\bin\git.exe",
    "C:\Program Files (x86)\Git\cmd\git.exe"
)
$git = $null
foreach ($p in $gitPaths) {
    if (Test-Path $p) { $git = $p; break }
}
if (-not $git) {
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) { $git = $gitCmd.Source }
}
if (-not $git) {
    Write-Host "Git non trovato. Installalo da https://git-scm.com" -ForegroundColor Red
    Start-Sleep -Seconds 4
    exit 1
}

$status = & $git status --porcelain
if (-not $status) {
    Write-Host "Nessuna modifica da pushare." -ForegroundColor Yellow
    Start-Sleep -Seconds 2
    exit
}

Write-Host "Modifiche rilevate:" -ForegroundColor Cyan
& $git status --short

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$msg = "auto: $timestamp"

& $git add -A
& $git commit -m $msg
& $git push

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nPush completato: $msg" -ForegroundColor Green
} else {
    Write-Host "`nErrore durante il push." -ForegroundColor Red
}

Start-Sleep -Seconds 3
