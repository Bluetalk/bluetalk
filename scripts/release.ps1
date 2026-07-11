# BlueTalk v2 release build (Windows).
#
# Baut Frontend + Tauri-Bundle (NSIS) mit signierten Updater-Artefakten und
# erzeugt release/latest.json fuer den Updater-Endpoint
# (https://github.com/Bluetalk/bluetalk/releases/latest/download/latest.json).
#
# Signaturschluessel: %USERPROFILE%\.tauri\bluetalk-v2.key
# Passwort: %USERPROFILE%\.tauri\bluetalk-v2.password.dpapi (DPAPI, CurrentUser)
# Alternativ TAURI_SIGNING_PRIVATE_KEY / _PASSWORD als Umgebungsvariablen setzen.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $keyPath = Join-Path $env:USERPROFILE '.tauri\bluetalk-v2.key'
    if (-not (Test-Path $keyPath)) {
        throw "Signaturschluessel fehlt: $keyPath (oder TAURI_SIGNING_PRIVATE_KEY setzen)"
    }
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw).Trim()
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $passwordPath = Join-Path $env:USERPROFILE '.tauri\bluetalk-v2.password.dpapi'
    if (Test-Path $passwordPath) {
        # Datei ist ein ConvertFrom-SecureString-Blob (DPAPI, CurrentUser).
        $secure = Get-Content $passwordPath -Raw | ConvertTo-SecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD =
                [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

Write-Host '== npm install =='
npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install fehlgeschlagen' }

Write-Host '== Tauri release build =='
npx tauri build
if ($LASTEXITCODE -ne 0) { throw 'tauri build fehlgeschlagen' }

# latest.json fuer den Updater erzeugen
$conf = Get-Content (Join-Path $repoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version
$bundleDir = Join-Path $repoRoot 'src-tauri\target\release\bundle\nsis'
$installer = Get-ChildItem $bundleDir -Filter '*-setup.exe' | Select-Object -First 1
$signature = Get-Content ($installer.FullName + '.sig') -Raw

$latest = [ordered]@{
    version   = $version
    notes     = "BlueTalk $version"
    pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature.Trim()
            url       = "https://github.com/Bluetalk/bluetalk/releases/download/v$version/$($installer.Name)"
        }
    }
}

$releaseDir = Join-Path $repoRoot 'release'
New-Item -ItemType Directory -Force $releaseDir | Out-Null
$latest | ConvertTo-Json -Depth 6 | Out-File (Join-Path $releaseDir 'latest.json') -Encoding utf8
Copy-Item $installer.FullName $releaseDir -Force
Copy-Item ($installer.FullName + '.sig') $releaseDir -Force

Write-Host ''
Write-Host "Fertig. Artefakte in $releaseDir :"
Get-ChildItem $releaseDir | ForEach-Object { Write-Host "  $($_.Name)" }
Write-Host ''
Write-Host "Upload zu GitHub-Release v$version (Installer, .sig und latest.json anhaengen)."
