# build-release.ps1
# Windows PowerShell build script for Tasky desktop
# Run from repository root after Next.js standalone has been built

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$DESKTOP = Join-Path $PWD "apps\desktop"
$DIST = Join-Path $DESKTOP "dist"
$BINARIES = Join-Path $DESKTOP "src-tauri\binaries"
$NODE_VERSION = "v22.19.0"
$NODE_URL = "https://nodejs.org/dist/$NODE_VERSION/win-x64/node.exe"

Write-Host "[build-desktop] Starting desktop build..."

# 1. Build Next.js standalone
Write-Host "[build-desktop] Building Next.js standalone..."
npm run build -w apps/web --if-present

# 2. Run prebuild to copy assets
Write-Host "[build-desktop] Copying assets..."
New-Item -ItemType Directory -Force -Path $DIST
node scripts/prebuild-desktop.mjs

# 3. Download Node.js portable
New-Item -ItemType Directory -Force -Path $BINARIES
$NODE_BIN = Join-Path $BINARIES "node-x86_64-pc-windows-msvc.exe"
if (-Not (Test-Path $NODE_BIN)) {
    Write-Host "[build-desktop] Downloading Node.js portable..."
    Invoke-WebRequest -Uri $NODE_URL -OutFile $NODE_BIN
}

# 4. Tauri build
Write-Host "[build-desktop] Building with Tauri..."
Set-Location $DESKTOP
npm run build
Set-Location $PSScriptRoot

Write-Host "[build-desktop] Done. Installer in apps/desktop/src-tauri/target/*/release/bundle/"