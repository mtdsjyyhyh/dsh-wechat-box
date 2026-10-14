<#
  migrate.ps1 -- drive the dsh-wechat-box migration in reviewable steps.

    pwsh -File migrate.ps1 -Check       # read-only status of everything
    pwsh -File migrate.ps1 -Phase2      # hand WeChat over to the new plugin
    pwsh -File migrate.ps1 -Rollback    # restore the pre-migration profile

  Phase 1 (already done, kept here for reproducibility) installs the plugin with
  the safety valve CLOSED: the host half and the web switch load, but the WeChat
  transport does not connect, so @xmanrui/dsh-im keeps owning the bot.

  Phase 2 does two things IN THE SAME RESTART, and they must stay together:
    - sets weixinEnabled: true for dsh-wechat-box
    - removes @xmanrui/dsh-im from the profile bundles
  Two long-poll consumers on one bot steal each other's messages and share one
  cursor, so enabling one without disabling the other corrupts both.

  Rollback restores package.json + the plugin patch from the baseline snapshot
  and turns the valve back off. The plugin is never deleted, so rollback is
  always available.

  NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 decodes a
  .ps1 without a BOM using the ANSI code page, so non-ASCII comments can break
  parsing (see ~/.dsh/AGENTS.md).
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Phase1,
  [switch]$Phase2,
  [switch]$Rollback,
  [string]$Profile = 'desktop',
  # Test seams. test-migrate.ps1 points these at a scratch copy so the
  # destructive paths are exercised before the user runs them for real.
  # NOTE: $PluginRoot, not $PluginDir -- PowerShell variable names are
  # case-insensitive, so a $PluginDir parameter and the computed $pluginDir
  # (the junction INSIDE the profile) would be the same variable, and the
  # junction path would silently overwrite the caller's package location.
  [string]$ProfileRoot,
  [string]$PluginRoot = $PSScriptRoot,
  [string]$BaselineRoot
)

$ErrorActionPreference = 'Stop'

$profileDir = if ($ProfileRoot) { $ProfileRoot } else { Join-Path $env:USERPROFILE ".dsh\profiles\$Profile" }
$pkgPath = Join-Path $profileDir 'package.json'
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'
$pluginDir = Join-Path $profileDir 'node_modules\dsh-wechat-box'
$pluginPatch = Join-Path $PluginRoot 'cordis.patch.yml'
$baselineRoot = if ($BaselineRoot) { $BaselineRoot } else { Join-Path $PluginRoot '_baseline' }

if (-not (Test-Path -LiteralPath $pkgPath)) { throw "profile not found: $pkgPath" }

# PS 5.1's `Set-Content -Encoding UTF8` prepends a BOM, and the DSH host parses
# the profile manifest verbatim with JSON.parse() -- a BOM is a syntax error
# that kills the host at startup ("Unexpected token '\uFEFF'"). This is exactly
# how DSH broke on 2026-10-14 after -Phase2. All manifest/patch writes go
# through here, never Set-Content.
function Write-Utf8NoBom([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Bundles {
  $json = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  return @($json.dsh.profile.bundles)
}

function Set-Bundles([string[]]$bundles) {
  $json = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $json.dsh.profile.bundles = $bundles
  Write-Utf8NoBom $pkgPath ($json | ConvertTo-Json -Depth 32)
  # Fail fast: never let a syntactically broken profile reach the loader.
  $null = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-ValveState {
  if (-not (Test-Path -LiteralPath $pluginPatch)) { return 'plugin patch missing' }
  $text = Get-Content -LiteralPath $pluginPatch -Raw -Encoding UTF8
  if ($text -match 'weixinEnabled:\s*true') { return 'OPEN (transport connects)' }
  if ($text -match 'weixinEnabled:\s*false') { return 'CLOSED (transport stays down)' }
  return 'absent (defaults to CLOSED)'
}

function Set-Valve([bool]$open) {
  $text = Get-Content -LiteralPath $pluginPatch -Raw -Encoding UTF8
  $next = if ($open) { $text -replace 'weixinEnabled:\s*false', 'weixinEnabled: true' }
          else { $text -replace 'weixinEnabled:\s*true', 'weixinEnabled: false' }
  if ($next -eq $text -and $text -notmatch 'weixinEnabled:') {
    throw "cannot flip the valve: weixinEnabled not found in $pluginPatch"
  }
  Write-Utf8NoBom $pluginPatch $next
}

function New-Backup([string]$tag) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dir = Join-Path $baselineRoot "migration-$tag-$stamp"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Copy-Item $pkgPath (Join-Path $dir 'profile-package.json') -Force
  if (Test-Path -LiteralPath $profilePatch) { Copy-Item $profilePatch (Join-Path $dir 'profile-cordis.patch.yml') -Force }
  Copy-Item $pluginPatch (Join-Path $dir 'plugin-cordis.patch.yml') -Force
  return $dir
}

$bundles = Get-Bundles
$hasNew = $bundles -contains 'dsh-wechat-box'
$hasOld = $bundles -contains '@xmanrui/dsh-im'

if ($Check) {
  "profile            : $profileDir"
  "plugin linked      : $(Test-Path -LiteralPath $pluginDir)"
  "dsh-wechat-box     : $(if ($hasNew) { 'in bundles' } else { 'NOT in bundles' })"
  "@xmanrui/dsh-im    : $(if ($hasOld) { 'in bundles (still owns WeChat)' } else { 'removed' })"
  "safety valve       : $(Get-ValveState)"
  "transport state    : $(Test-Path (Join-Path $env:USERPROFILE '.dsh\storages\wechat-box-transport.json'))"
  $entry = Test-Path (Join-Path $pluginDir 'lib\index.js')
  "package resolves   : $entry"
  ""
  if ($hasNew -and $hasOld) { "STATE: phase 1 -- safe, WeChat still served by dsh-im" }
  elseif ($hasNew -and -not $hasOld) { "STATE: phase 2 -- dsh-wechat-box owns WeChat" }
  else { "STATE: not installed" }
  exit 0
}

if ($Rollback) {
  $snap = Get-ChildItem $baselineRoot -Directory -Filter 'migration-*' |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $snap) { throw "no migration backup under $baselineRoot" }
  Copy-Item (Join-Path $snap.FullName 'profile-package.json') $pkgPath -Force
  if (Test-Path (Join-Path $snap.FullName 'profile-cordis.patch.yml')) {
    Copy-Item (Join-Path $snap.FullName 'profile-cordis.patch.yml') $profilePatch -Force
  }
  if (Test-Path (Join-Path $snap.FullName 'plugin-cordis.patch.yml')) {
    Copy-Item (Join-Path $snap.FullName 'plugin-cordis.patch.yml') $pluginPatch -Force
  }
  $null = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  "restored from : $($snap.Name)"
  "safety valve  : $(Get-ValveState)"
  "bundles       : $((Get-Bundles) -join ', ')"
  "Rolled back. Restart DSH to apply."
  exit 0
}

if ($Phase1) {
  $dir = New-Backup 'phase1'
  if (-not (Test-Path -LiteralPath $pluginDir)) {
    New-Item -ItemType Junction -Path $pluginDir -Target $PluginRoot | Out-Null
    "linked        : $pluginDir"
  } else { "linked        : already present" }
  if (-not $hasNew) { Set-Bundles ($bundles + 'dsh-wechat-box'); "bundles       : added dsh-wechat-box" }
  Set-Valve $false
  "safety valve  : $(Get-ValveState)"
  "backup        : $dir"
  "Restart DSH, then check the beacon route. WeChat is untouched in this phase."
  exit 0
}

if ($Phase2) {
  if (-not $hasNew) { throw 'dsh-wechat-box is not in the profile bundles; run -Phase1 first' }
  $dir = New-Backup 'phase2'
  # Order matters for review, not for effect: both land before the restart.
  Set-Bundles ($bundles | Where-Object { $_ -ne '@xmanrui/dsh-im' })
  Set-Valve $true
  "backup        : $dir"
  "@xmanrui/dsh-im : removed from bundles"
  "safety valve  : $(Get-ValveState)"
  ""
  "Now restart DSH. After the restart, dsh-wechat-box owns the bot and"
  "dsh-im no longer polls it, so there is exactly one consumer."
  "Rollback any time with: pwsh -File migrate.ps1 -Rollback"
  exit 0
}

"Nothing to do. Use -Check, -Phase1, -Phase2 or -Rollback."
