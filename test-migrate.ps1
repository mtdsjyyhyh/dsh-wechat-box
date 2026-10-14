<#
  test-migrate.ps1 -- exercise migrate.ps1 -Phase2 and -Rollback on a SCRATCH
  COPY, so the destructive paths are proven before the user runs them against
  the live profile.

  Read-only with respect to the real machine: everything happens under a temp
  directory, and the scratch "plugin dir" is a copy, never a junction into the
  real one. ASCII-only (no BOM needed).

  Usage: pwsh -File <repo>\test-migrate.ps1
#>
[CmdletBinding()]
param([string]$Source = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
$migrateScript = Join-Path $Source 'migrate.ps1'
$liveProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'

if (-not (Test-Path $migrateScript)) { throw "missing migrate.ps1 at $migrateScript" }
if (-not (Test-Path $liveProfile))   { throw "missing live profile at $liveProfile" }

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-migrate-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$profileDir = Join-Path $scratch 'profile'
$pluginDir = Join-Path $scratch 'plugin'
$baseline = Join-Path $scratch 'baseline'
New-Item -ItemType Directory -Path $profileDir, $pluginDir, $baseline -Force | Out-Null

# A faithful copy of the two files the migration edits.
Copy-Item (Join-Path $liveProfile 'package.json') (Join-Path $profileDir 'package.json') -Force
if (Test-Path (Join-Path $liveProfile 'cordis.patch.yml')) {
  Copy-Item (Join-Path $liveProfile 'cordis.patch.yml') (Join-Path $profileDir 'cordis.patch.yml') -Force
}
Copy-Item (Join-Path $Source 'cordis.patch.yml') (Join-Path $pluginDir 'cordis.patch.yml') -Force

# Snapshot live files byte-for-byte BEFORE anything runs, so the final check can
# be "the test did not touch live files" without hard-coding which phase the
# live profile happens to be in (phase 1 assertions went stale the moment
# phase 2 landed on the real machine).
$livePkgBefore = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $liveProfile 'package.json')))
$livePatchBefore = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $Source 'cordis.patch.yml')))

# Normalize the scratch copy to a deterministic PHASE 1 baseline (dsh-im in
# bundles, valve closed), whatever phase the live profile is in, so that
# phase1 -> phase2 -> rollback below means the same thing every run (the test
# first went stale the day phase 2 landed on the real machine). Written
# BOM-less so every BOM assertion below isolates what migrate.ps1 writes.
$scratchPkg = Join-Path $profileDir 'package.json'
$pkgObj = Get-Content $scratchPkg -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ($pkgObj.dsh.profile.bundles -contains '@xmanrui/dsh-im')) {
  $pkgObj.dsh.profile.bundles = @('@xmanrui/dsh-im') + $pkgObj.dsh.profile.bundles
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($scratchPkg, ($pkgObj | ConvertTo-Json -Depth 32), $utf8NoBom)
$scratchPatch = Join-Path $pluginDir 'cordis.patch.yml'
$patchText = Get-Content $scratchPatch -Raw -Encoding UTF8
$patchText = $patchText -replace 'weixinEnabled:\s*true', 'weixinEnabled: false'
if ($patchText -notmatch 'weixinEnabled:\s*false') { throw 'cannot normalize scratch valve to false' }
[System.IO.File]::WriteAllText($scratchPatch, $patchText, $utf8NoBom)

# Hashtable splat: an ARRAY splat would pass "-ProfileRoot" as a positional
# VALUE instead of a parameter name, which is how this test first failed.
$common = @{ ProfileRoot = $profileDir; PluginRoot = $pluginDir; BaselineRoot = $baseline }
$passed = 0
$failed = 0
function Check([string]$label, [bool]$condition) {
  if ($condition) { $script:passed++; Write-Host ("  ok  " + $label) }
  else { $script:failed++; Write-Host ("  FAIL " + $label) -ForegroundColor Red }
}
function Bundles {
  (Get-Content (Join-Path $profileDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).dsh.profile.bundles
}
function Valve {
  Get-Content (Join-Path $pluginDir 'cordis.patch.yml') -Raw -Encoding UTF8
}
function ValidJson([string]$path) {
  try { $null = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json; return $true } catch { return $false }
}
# ValidJson alone is NOT enough: Get-Content strips a BOM, but the DSH host does
# JSON.parse(fs.readFileSync(path, 'utf8')) on the raw bytes and dies on a BOM
# ("Unexpected token '\uFEFF'"), crashing the app at startup (2026-10-14).
# Regression, PowerShell 5.1: Set-Content -Encoding UTF8 writes a BOM.
function NoBom([string]$path) {
  $b = [System.IO.File]::ReadAllBytes($path)
  return -not ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

Write-Host "scratch: $scratch"
Write-Host ""

# --- baseline: the copy starts in phase 1 ----------------------------------
$out = & $migrateScript @common -Check 2>&1 | Out-String
Check "check reports a valid profile" ($out -match 'plugin linked|dsh-wechat-box')
Check "dsh-im is present in the copy" ((Bundles) -contains '@xmanrui/dsh-im')
Check "the valve starts closed" ((Valve) -match 'weixinEnabled:\s*false')

# --- phase 2 ---------------------------------------------------------------
$out = & $migrateScript @common -Phase2 2>&1 | Out-String
Check "phase2 ran without an error message" ($out -notmatch 'Exception|throw')
$after = Bundles
Check "phase2 removed @xmanrui/dsh-im" (-not ($after -contains '@xmanrui/dsh-im'))
Check "phase2 kept dsh-wechat-box" ($after -contains 'dsh-wechat-box')
Check "phase2 opened the valve" ((Valve) -match 'weixinEnabled:\s*true')
Check "phase2 wrote a backup" ((Get-ChildItem $baseline -Directory -ErrorAction SilentlyContinue | Measure-Object).Count -ge 1)
Check "package.json is still valid JSON" (ValidJson (Join-Path $profileDir 'package.json'))
Check "phase2 writes package.json without a BOM" (NoBom (Join-Path $profileDir 'package.json'))
Check "phase2 writes plugin patch without a BOM" (NoBom (Join-Path $pluginDir 'cordis.patch.yml'))

# --- rollback --------------------------------------------------------------
$out = & $migrateScript @common -Rollback 2>&1 | Out-String
Check "rollback ran without an error message" ($out -notmatch 'Exception|throw')
$restored = Bundles
Check "rollback restored @xmanrui/dsh-im" ($restored -contains '@xmanrui/dsh-im')
Check "rollback closed the valve again" ((Valve) -match 'weixinEnabled:\s*false')
Check "rollback kept dsh-wechat-box listed" ($restored -contains 'dsh-wechat-box')
Check "rollback leaves a BOM-free manifest" (NoBom (Join-Path $profileDir 'package.json'))

# --- the live profile was never touched ------------------------------------
$livePkgAfter = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $liveProfile 'package.json')))
$livePatchAfter = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $Source 'cordis.patch.yml')))
Check "live profile package.json untouched (byte-identical)" ($livePkgAfter -eq $livePkgBefore)
Check "live plugin patch untouched (byte-identical)" ($livePatchAfter -eq $livePatchBefore)

Write-Host ""
Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ("migrate dry-run: {0} passed, {1} failed" -f $passed, $failed)
if ($failed -gt 0) { exit 1 }
