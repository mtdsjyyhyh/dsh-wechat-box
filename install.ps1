<#
  install.ps1 -- one-command install for the dsh-wechat-box DSH plugin.

  WHAT IT DOES (in order, each step prints what it did)

    1. checks that the DSH profile directory exists
    2. creates a junction  <profile>\node_modules\dsh-wechat-box -> <this repo>
    3. adds "dsh-wechat-box" to  dsh.profile.bundles   in the profile package.json
    4. adds "dsh-wechat-box": "link:<this repo>" to  dependencies
       (this second one is what makes the plugin show up in the DSH plugin
        manager -- a bundle entry alone does not)
    5. writes weixinEnabled into <this repo>\cordis.patch.yml
         default      -> false  (safety valve CLOSED: the host half loads and the
                                  web switch renders, but no WeChat connection is
                                  opened, so the plugin never fights another
                                  long-poll consumer for the same bot)
         -WeChat      -> true   (takes over WeChat)
    6. backs up every file it is about to change FIRST, into
         <this repo>\_baseline\install-<timestamp>\
    7. prints "restart DSH" plus the self-check commands

  USAGE

    powershell -ExecutionPolicy Bypass -File D:\path\to\install.ps1
    powershell -ExecutionPolicy Bypass -File D:\path\to\install.ps1 -WeChat
    powershell -ExecutionPolicy Bypass -File D:\path\to\install.ps1 -DryRun
    powershell -ExecutionPolicy Bypass -File D:\path\to\install.ps1 -Uninstall

  PARAMETERS

    -Profile <name>   DSH profile to install into. Default: desktop
    -WeChat           open the safety valve (weixinEnabled: true)
    -DryRun           print the plan and write NOTHING at all
    -Uninstall        remove the junction, the bundles entry and the dependency,
                      and close the valve (a backup is taken first)
    -ProfileRoot      override the profile directory (testing seam)
    -PluginRoot       override the repo location (testing seam)
    -BaselineRoot     override the backup root (testing seam)

  IDEMPOTENT: running it twice changes nothing the second time. It never appends
  a duplicate bundles entry, never duplicates the dependency, never rewrites a
  file whose content is already correct, and never touches an existing junction
  that already points at this repo. If the junction points somewhere ELSE, it
  stops instead of overwriting.

  NOTE: this file is deliberately ASCII-ONLY. Windows PowerShell 5.1 decodes a
  .ps1 that has no BOM using the ANSI code page, so a non-ASCII comment can make
  the whole script fail to parse. All file writes go through Write-Utf8NoBom for
  the same class of reason: PS 5.1's `Set-Content -Encoding UTF8` writes a BOM,
  and the DSH host parses package.json byte-for-byte with JSON.parse -- a BOM is
  a syntax error that kills the host at startup.
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$WeChat,
  [switch]$DryRun,
  [switch]$Uninstall,
  # Test seams: point these at a scratch copy to exercise the destructive paths.
  # NOTE: $PluginRoot, not $PluginDir -- PowerShell variable names are
  # case-insensitive, so $PluginDir would collide with the computed $pluginDir
  # (the junction INSIDE the profile) and silently overwrite the repo location.
  [string]$ProfileRoot,
  [string]$PluginRoot,
  [string]$BaselineRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# ---------------------------------------------------------------- paths -----
# $PluginRoot is resolved HERE, not as a parameter default.
#
# Windows PowerShell 5.1 does not populate $PSScriptRoot while it binds
# parameters, so a default of `= $PSScriptRoot` silently binds an EMPTY string
# under `powershell.exe -File install.ps1`, and every Join-Path below then dies
# with "Cannot bind argument to parameter 'Path' because it is an empty string".
# (It works under `-Command` and under `pwsh`, which is exactly the kind of
# difference that ships broken.) So: no default, resolve it in the body.
function Resolve-PluginRoot {
  # $PSCommandPath is the automatic "path of the running script" variable, but it
  # is only guaranteed inside a script BODY -- not while parameters are bound and
  # not inside a called function on every host. So try it, then $PSScriptRoot,
  # then the invocation's own command path (read defensively: under
  # Set-StrictMode a missing property is an exception, not $null).
  $candidates = New-Object System.Collections.ArrayList
  [void]$candidates.Add($PSCommandPath)
  [void]$candidates.Add($script:PSScriptRoot)
  if ($MyInvocation -and $MyInvocation.MyCommand) {
    try { [void]$candidates.Add($MyInvocation.MyCommand.Path) } catch { }
    try { [void]$candidates.Add($MyInvocation.MyCommand.Definition) } catch { }
  }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $full = (Get-Item -LiteralPath $candidate -Force).FullName
    if (Test-Path -LiteralPath $full -PathType Leaf) { return (Split-Path -Parent $full) }
    return $full
  }
  $here = (Get-Location).Path
  Write-Host "warning: could not determine this script's own directory; assuming $here" -ForegroundColor DarkYellow
  return $here
}

$resolvedPluginRoot = if ($PluginRoot) { $PluginRoot } else { Resolve-PluginRoot }
if (-not $resolvedPluginRoot) { throw 'could not determine the plugin repo directory; pass -PluginRoot <path>' }
$PluginRoot = $resolvedPluginRoot

$dshRoot      = Join-Path $env:USERPROFILE '.dsh'
$profileDir   = if ($ProfileRoot) { $ProfileRoot } else { Join-Path $dshRoot "profiles\$Profile" }
$pkgPath      = Join-Path $profileDir 'package.json'
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'
$pluginDir    = Join-Path $profileDir 'node_modules\dsh-wechat-box'
$pluginPatch  = Join-Path $PluginRoot 'cordis.patch.yml'
$baselineRoot = if ($BaselineRoot) { $BaselineRoot } else { Join-Path $PluginRoot '_baseline' }

$pkgName = 'dsh-wechat-box'
$nodeExe = Join-Path $dshRoot 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$verify  = Join-Path $PluginRoot 'verify.ps1'

$wantedValve = $WeChat.IsPresent
$targetValve = if ($Uninstall) { 'false' } else { $wantedValve.ToString().ToLowerInvariant() }

# ------------------------------------------------------------- helpers ------
function Write-Utf8NoBom([string]$path, [string]$text) {
  # Never Set-Content: see the BOM note in the header.
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-Text([string]$path) {
  return [System.IO.File]::ReadAllText($path)
}

# A PowerShell real array, always. Without this a single element unwraps to a
# bare string and `-contains` silently becomes a substring test.
function As-Array($value) {
  $list = New-Object System.Collections.ArrayList
  if ($null -ne $value) {
    foreach ($item in @($value)) { if ($null -ne $item) { [void]$list.Add($item) } }
  }
  return $list.ToArray()
}

function Get-JunctionTarget([string]$path) {
  $item = Get-Item -LiteralPath $path -Force
  if (-not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { return $null }
  $target = $item.Target
  if ($target -is [array]) { $target = $target[0] }
  if (-not $target) { return $null }
  return ([string]$target).Replace('/', '\').TrimEnd('\')
}

function Same-PathText([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  $x = $a.Replace('/', '\').TrimEnd('\')
  $y = $b.Replace('/', '\').TrimEnd('\')
  return [string]::Equals($x, $y, [System.StringComparison]::OrdinalIgnoreCase)
}

# Every mutation goes through New-Dir / Write-File, so -DryRun is enforced in
# one place instead of being remembered at every call site.
function New-Dir([string]$path) {
  if ($DryRun) { Write-Host "      [dry-run] New-Item -ItemType Directory -Path $path" -ForegroundColor DarkGray; return }
  New-Item -ItemType Directory -Path $path -Force | Out-Null
}
function Write-File([string]$path, [string]$text) {
  if ($DryRun) { Write-Host "      [dry-run] write $path ($($text.Length) chars, UTF-8 no BOM)" -ForegroundColor DarkGray; return }
  Write-Utf8NoBom $path $text
}

function Show-Action([string]$description) { Write-Host "  -> $description" }

# ---------------------------------------------------------------------------
# Text splices for the -Uninstall path.
#
# Deliberately not a JSON round-trip: ConvertTo-Json reformats the whole
# manifest (and in PS 5.1 also mangles a single-element array), so a one-line
# change would land as an unreviewable diff -- on a file whose corruption stops
# the DSH host from starting at all.
#
# Every pattern here spells horizontal whitespace as [ \t] and every line break
# as \r?\n. `\s` matches newlines, so a pattern like `,\s*"` jumps a line and
# deletes the NEIGHBOURING entry's comma. That is a syntax error, and the
# validation at the call site only catches it after the damage is done.
#
# Return $null when the entry is not found at all.
# ---------------------------------------------------------------------------
function Remove-ArrayEntry([string]$text, [string]$entry) {
  $e = [regex]::Escape($entry)
  # A: the entry is on its own line and the PREVIOUS line carries the comma.
  $first = [regex]::Match($text, '(?m),[ \t]*\r?\n[ \t]*"' + $e + '"[ \t]*\r?\n')
  if ($first.Success) { return $text.Remove($first.Index, $first.Length) }
  # B: the entry's own line carries the comma, so a later entry exists.
  $middle = [regex]::Match($text, '(?m)^[ \t]*"' + $e + '"[ \t]*,[ \t]*\r?\n')
  if ($middle.Success) { return $text.Remove($middle.Index, $middle.Length) }
  # C: LAST entry -- a previous line carries the comma, no comma follows.
  $last = [regex]::Match($text, '(?m),[ \t]*\r?\n([ \t]*)"' + $e + '"[ \t]*\r?\n')
  if ($last.Success) {
    return $text.Substring(0, $last.Index).TrimEnd(' ', "`t") + $text.Substring($last.Index + $last.Length)
  }
  # D: the only entry.
  $only = [regex]::Match($text, '(?m)^[ \t]*"' + $e + '"[ \t]*\r?\n')
  if ($only.Success) { return $text.Remove($only.Index, $only.Length) }
  return $null
}

function Remove-DepEntry([string]$text, [string]$entry) {
  $e = [regex]::Escape($entry)
  $property = '"[ \t]*:[ \t]*"[^"]*"[ \t]*'
  # FIRST property: the line break in front goes too, and the next property's
  # leading comma becomes dangling.
  $first = [regex]::Match($text, '(?m)^[ \t]*"' + $e + $property + '\r?\n')
  if ($first.Success -and $first.Index -eq 1) {
    $out = $text.Remove(0, $first.Length + 1)
    return [regex]::Replace($out, '(?m)^[ \t]*,(?=[ \t]*")', '', 1)
  }
  # MIDDLE property: its own line carries the comma.
  $middle = [regex]::Match($text, '(?m)^[ \t]*"' + $e + $property + ',[ \t]*\r?\n')
  if ($middle.Success) { return $text.Remove($middle.Index, $middle.Length) }
  # LAST property.
  $last = [regex]::Match($text, '(?m),[ \t]*\r?\n([ \t]*)"' + $e + $property + '\r?\n')
  if ($last.Success) {
    return $text.Substring(0, $last.Index).TrimEnd(' ', "`t") + $text.Substring($last.Index + $last.Length)
  }
  # ONLY property.
  $only = [regex]::Match($text, '(?m)^[ \t]*"' + $e + $property + '\r?\n')
  if ($only.Success) { return $text.Remove($only.Index, $only.Length) }
  return $null
}

# ---------------------------------------------------------------- start -----
Write-Host ''
Write-Host 'dsh-wechat-box installer' -ForegroundColor White
Write-Host "  profile      : $profileDir"
Write-Host "  plugin repo  : $PluginRoot"
Write-Host "  mode         : $(if ($DryRun) { 'DRY RUN (nothing is written)' } elseif ($Uninstall) { 'UNINSTALL' } else { 'INSTALL' })"
Write-Host "  safety valve : weixinEnabled = $targetValve"
Write-Host ''

# -DryRun writes nothing EXCEPT what the shell itself does with this process's
# own output: if you redirect it to a file (`> plan.txt`), that file is a write
# -DryRun cannot suppress. Everything the script controls -- the repo, the
# profile manifest, the junction, the backups, the boot log -- is skipped.
if ($DryRun -and [Console]::IsOutputRedirected) {
  Write-Host 'note: -DryRun output is redirected to a file. That file is created by the' -ForegroundColor DarkYellow
  Write-Host '      shell, not by this script; everything else stays untouched.' -ForegroundColor DarkYellow
}

# --------------------------------------------------- step 1: profile exists --
Write-Host 'STEP 1  check the DSH profile directory'
if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
  throw "DSH profile not found: $profileDir`nStart DSH once (or pass -Profile <name>) and try again."
}
$pkgPathOk = Test-Path -LiteralPath $pkgPath -PathType Leaf
if (-not $pkgPathOk) {
  throw "profile manifest not found: $pkgPath`nThis does not look like a DSH profile directory."
}
Write-Host "  ok: $profileDir"

# ------------------------------------------------- read the current state ---
$pkgRaw = Read-Text $pkgPath
try { $pkgJson = $pkgRaw | ConvertFrom-Json } catch { throw "profile package.json is not valid JSON: $($_.Exception.Message)" }

$depBlock = [regex]::Match($pkgRaw, '"dependencies"\s*:\s*\{')
$bundlesBlock = [regex]::Match($pkgRaw, '"bundles"\s*:\s*\[')

$bundles = As-Array $pkgJson.dsh.profile.bundles
$hasBundle = $false
foreach ($entry in $bundles) {
  if ([string]::Equals([string]$entry, $pkgName, [System.StringComparison]::OrdinalIgnoreCase)) { $hasBundle = $true }
}
# Property names, not values: a dependency entry's value is a version range or a
# path, and nothing here needs to print it.
$depProps = @()
if ($depBlock.Success) {
  $depProps = @($pkgJson.dependencies.PSObject.Properties | ForEach-Object { $_.Name })
}
$hasDep = $false
foreach ($name in $depProps) {
  if ([string]::Equals([string]$name, $pkgName, [System.StringComparison]::OrdinalIgnoreCase)) { $hasDep = $true }
}

$junctionState = 'absent'
$junctionIssue = $null
if (Test-Path -LiteralPath $pluginDir) {
  $junctionTarget = Get-JunctionTarget $pluginDir
  if ($junctionTarget) {
    if (Same-PathText $junctionTarget $PluginRoot) { $junctionState = 'ok' }
    else { $junctionState = 'wrong-target'; $junctionIssue = $junctionTarget }
  } else {
    $junctionState = 'not-a-junction'
  }
}

$patchRaw = $null
$patchValveText = 'plugin patch missing'
$patchValveValue = $null
if (Test-Path -LiteralPath $pluginPatch -PathType Leaf) {
  $patchRaw = Read-Text $pluginPatch
  $m = [regex]::Match($patchRaw, 'weixinEnabled:\s*(true|false)')
  if ($m.Success) {
    $patchValveValue = $m.Groups[1].Value
    $patchValveText = $patchValveValue
  } else {
    $patchValveText = 'absent (no weixinEnabled line)'
  }
}
$replaceValve = $false
if ($patchValveValue) {
  if ($patchValveValue -ne $targetValve) { $replaceValve = $true }
} elseif ($patchRaw) {
  throw "cannot set the safety valve: no 'weixinEnabled: true|false' line in $pluginPatch"
}

# -------------------------------------------------------- plan + guards -----
Write-Host ''
Write-Host 'PLAN'
Write-Host "  step 2  junction  $pluginDir  ->  $PluginRoot   [$junctionState]"
if ($Uninstall) {
  Write-Host "  step 3  remove '$pkgName' from dsh.profile.bundles            [$(if ($hasBundle) { 'present, will remove' } else { 'already absent' })]"
  Write-Host "  step 4  remove '$pkgName' from dependencies                   [$(if ($hasDep) { 'present, will remove' } else { 'already absent' })]"
} else {
  Write-Host "  step 3  add    '$pkgName' to dsh.profile.bundles              [$(if ($hasBundle) { 'already there' } else { 'will add' })]"
  Write-Host "  step 4  set    dependencies['$pkgName'] = 'link:$PluginRoot'  [$(if ($hasDep) { 'already there' } else { 'will add' })]"
}
Write-Host "  step 5  weixinEnabled = $targetValve    [was: $patchValveText]"

if ($junctionState -eq 'wrong-target') {
  throw "refusing to touch $pluginDir : it is a junction to '$junctionIssue', not to $PluginRoot. Remove it first if that is what you want."
}
if ($junctionState -eq 'not-a-junction') {
  throw "refusing to touch $pluginDir : a real file or directory is already there (not a junction). Move it away first."
}
if (-not $Uninstall -and -not $depBlock.Success) {
  throw 'profile package.json has no "dependencies" block, so the plugin cannot be registered in the DSH plugin manager. Add one (migrate.ps1 -Phase1 rewrites this manifest through ConvertTo-Json) and re-run.'
}
if (-not $Uninstall -and -not $bundlesBlock.Success) {
  throw 'profile package.json has no dsh.profile.bundles array; this does not look like a DSH profile.'
}

$willChangePkg = if ($Uninstall) { $hasBundle -or $hasDep } else { (-not $hasBundle) -or (-not $hasDep) }
$willChangePatch = $replaceValve
$willChangeJunction = if ($Uninstall) { $junctionState -eq 'ok' } else { $junctionState -eq 'absent' }

# --------------------------------------------------- step 6: backup first ---
Write-Host ''
Write-Host 'STEP 6  backup (taken before anything is changed)'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $baselineRoot "install-$stamp"
if ($willChangePkg -or $willChangePatch) {
  if ($DryRun) {
    Write-Host "      [dry-run] create $backupDir"
    Write-Host '      [dry-run] copy profile-package.json, profile-cordis.patch.yml, plugin-cordis.patch.yml'
  } else {
    New-Dir $backupDir
    Copy-Item -LiteralPath $pkgPath -Destination (Join-Path $backupDir 'profile-package.json') -Force
    if (Test-Path -LiteralPath $profilePatch -PathType Leaf) {
      Copy-Item -LiteralPath $profilePatch -Destination (Join-Path $backupDir 'profile-cordis.patch.yml') -Force
    }
    Copy-Item -LiteralPath $pluginPatch -Destination (Join-Path $backupDir 'plugin-cordis.patch.yml') -Force
    Write-Host "      backed up to $backupDir"
  }
} else {
  Write-Host '      nothing to back up: every file is already in the requested state'
}

# -------------------------------------------------------- step 2: junction --
Write-Host ''
Write-Host 'STEP 2  junction in the profile node_modules'
if ($Uninstall) {
  if ($junctionState -eq 'ok') {
    Show-Action "remove junction $pluginDir"
    if (-not $DryRun) { [System.IO.Directory]::Delete($pluginDir, $false) }
  } else {
    Write-Host '      already absent'
  }
} elseif ($junctionState -eq 'ok') {
  Write-Host "      already present and pointing at $PluginRoot"
} else {
  $parent = Split-Path -Parent $pluginDir
  if (-not (Test-Path -LiteralPath $parent)) { New-Dir $parent }
  Show-Action "New-Item -ItemType Junction -Path $pluginDir -Target $PluginRoot"
  if (-not $DryRun) {
    New-Item -ItemType Junction -Path $pluginDir -Target $PluginRoot | Out-Null
    $entry = Join-Path $pluginDir 'lib\index.js'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
      throw "junction created but $entry is not visible -- is $PluginRoot a complete checkout?"
    }
    Write-Host '      linked and the host entry resolves through it'
  }
}

# --------------------------------------------------- steps 3+4: manifest ----
Write-Host ''
Write-Host 'STEP 3/4  profile package.json (bundles + dependencies)'
if ($Uninstall) {
  $newPkgRaw = $pkgRaw
  if ($hasBundle) {
    Show-Action "remove '$pkgName' from dsh.profile.bundles"
    $spliced = Remove-ArrayEntry $newPkgRaw $pkgName
    if ($null -eq $spliced) { throw "found '$pkgName' in dsh.profile.bundles but could not splice it out; profile left untouched" }
    $newPkgRaw = $spliced
  } else { Write-Host "      '$pkgName' is not in dsh.profile.bundles" }
  if ($hasDep) {
    Show-Action "remove dependencies['$pkgName']"
    $spliced = Remove-DepEntry $newPkgRaw $pkgName
    if ($null -eq $spliced) { throw "found '$pkgName' in dependencies but could not splice it out; profile left untouched" }
    $newPkgRaw = $spliced
  } else { Write-Host "      '$pkgName' is not in dependencies" }
  if ($newPkgRaw -ne $pkgRaw) {
    if (-not $DryRun) {
      $null = $newPkgRaw | ConvertFrom-Json   # never let a broken manifest reach the loader
      Write-File $pkgPath $newPkgRaw
    }
    Write-Host '      wrote profile package.json (UTF-8, no BOM)'
  } else { Write-Host '      no change needed' }
} elseif ($hasBundle -and $hasDep) {
  Write-Host '      both entries already present; file left byte-identical'
} else {
  $newPkgRaw = $pkgRaw

  # Step 4: dependencies. Insert a literal anchor line right after the opening
  # brace of the dependencies block. No JSON re-serialisation and no regex
  # surgery on the existing text, so the rest of the manifest stays untouched.
  if ($hasDep) {
    Write-Host "      dependencies['$pkgName'] already present"
  } else {
    # The trailing comma belongs on the anchor only when something else follows
    # it. On an EMPTY container it would instead sit right before the closing
    # brace -- valid-looking, and a JSON syntax error.
    $depEmpty = (@($depProps)).Count -eq 0
    $after = $newPkgRaw.Substring($depBlock.Index + $depBlock.Length)
    $indentMatch = [regex]::Match($after, '(?<=\r?\n)[ \t]+(?=")')
    $indent = if ($indentMatch.Success) { $indentMatch.Value } else { '    ' }
    $anchor = $indent + '"' + $pkgName + '": "link:' + ($PluginRoot -replace '\\', '\\') + '"' + $(if ($depEmpty) { '' } else { ',' })
    $newPkgRaw = $newPkgRaw.Insert($depBlock.Index + $depBlock.Length, "`r`n$anchor")
    Show-Action "add dependencies['$pkgName'] = 'link:$PluginRoot'"
  }

  # Step 3: bundles. The entry gets a trailing comma on its own physical line so
  # the array keeps the exact shape the manifest already uses. Appending the
  # comma to the PREVIOUS line instead would make a one-line insertion a
  # three-line diff with broken indentation (tried; it looked like corruption).
  if ($hasBundle) {
    Write-Host "      dsh.profile.bundles already lists '$pkgName'"
  } else {
    $bundlesBlock = [regex]::Match($newPkgRaw, '"bundles"\s*:\s*\[')
    if (-not $bundlesBlock.Success) { throw 'profile package.json has no dsh.profile.bundles array' }
    $close = $newPkgRaw.IndexOf(']', $bundlesBlock.Index + $bundlesBlock.Length)
    if ($close -lt 0) { throw 'unterminated dsh.profile.bundles array in the profile manifest' }
    # Inside the array the layout is uniform, so the indent of the existing
    # entries is the indent of the ']' line (plus four spaces when the array is
    # empty, where there are no entries to read it from).
    $empty = (@($bundles)).Count -eq 0
    $before = $newPkgRaw.Substring(0, $close)
    $needsComma = -not $empty -and $before.TrimEnd().EndsWith('"')
    # Read the entry indent off the LAST entry that precedes the ']'. For the
    # empty array there is no such entry, so fall back to the ']' line's indent.
    $lastEntry = [regex]::Match($before, '(?m)^(?<indent>[ \t]+)"(?:[^"\\]|\\.)*"[ \t]*,?[ \t]*\r?\n[ \t]*$')
    $closeIndentMatch = [regex]::Match($newPkgRaw.Substring($close), '(?<=\r?\n)[ \t]+')
    $closeIndentFallback = if ($closeIndentMatch.Success) { $closeIndentMatch.Value } else { '    ' }
    $entryIndent = if ($lastEntry.Success) { $lastEntry.Groups['indent'].Value } else { $closeIndentFallback + '    ' }
    $closeIndent = if ($entryIndent.Length -ge 4) { $entryIndent.Substring(0, $entryIndent.Length - 4) } else { $closeIndentFallback }
    $entry = $(if ($needsComma) { ',' } else { '' }) + "`r`n" + $entryIndent + '"' + $pkgName + '"' + "`r`n" + $closeIndent
    $newPkgRaw = $newPkgRaw.Insert($close, $entry)
    Show-Action "append '$pkgName' to dsh.profile.bundles"
  }

  if ($newPkgRaw -ne $pkgRaw) {
    if ($DryRun) {
      Write-Host '      [dry-run] would write profile package.json (UTF-8, no BOM)'
    } else {
      $parsed = $newPkgRaw | ConvertFrom-Json   # fail fast: never let a broken manifest reach the loader
      $names = As-Array $parsed.dsh.profile.bundles
      $seen = $false
      foreach ($n in $names) { if ([string]::Equals([string]$n, $pkgName, [System.StringComparison]::OrdinalIgnoreCase)) { $seen = $true } }
      if (-not $seen) { throw 'internal error: the bundles entry did not survive the rewrite; the profile was left untouched' }
      if ($null -eq ($parsed.dependencies.PSObject.Properties |
        Where-Object { [string]::Equals($_.Name, $pkgName, [System.StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1)) {
        throw 'internal error: the dependency did not survive the rewrite; the profile was left untouched'
      }
      Write-File $pkgPath $newPkgRaw
      Write-Host '      wrote profile package.json (UTF-8, no BOM)'
    }
  }
}

# ---------------------------------------------------- step 5: safety valve --
Write-Host ''
Write-Host 'STEP 5  safety valve in the plugin patch'
if ($replaceValve) {
  Show-Action "set weixinEnabled: $targetValve in cordis.patch.yml"
  if (-not $DryRun) {
    $next = [regex]::Replace($patchRaw, 'weixinEnabled:\s*(true|false)', "weixinEnabled: $targetValve", 1)
    if ($next -eq $patchRaw) { throw "internal error: the weixinEnabled line did not change in $pluginPatch" }
    $after = Read-Text $pluginPatch
    if ($after -ne $patchRaw) { throw "refusing to write: $pluginPatch changed while this script was running. Re-run the installer." }
    Write-File $pluginPatch $next
    Write-Host "      cordis.patch.yml now says weixinEnabled: $targetValve"
  }
} else {
  Write-Host "      already weixinEnabled: $patchValveText; file left byte-identical"
}

# -------------------------------------------------------------- summary -----
Write-Host ''
Write-Host 'DONE' -ForegroundColor Green
if ($DryRun) {
  Write-Host '  DRY RUN: nothing was written. Re-run without -DryRun to apply the plan above.' -ForegroundColor Yellow
} else {
  if ($willChangeJunction -or $willChangePkg -or $willChangePatch) {
    Write-Host "  backup       : $backupDir"
  } else {
    Write-Host '  backup       : not needed (no change)'
  }
  Write-Host "  profile      : $profileDir"
  Write-Host "  plugin repo  : $PluginRoot"
  Write-Host "  weixinEnabled: $targetValve"
  Write-Host ''
  Write-Host '  RESTART DSH FOR THIS TO TAKE EFFECT.' -ForegroundColor Yellow
  Write-Host '  The host half is an ESM module the host has already imported; only a' -ForegroundColor Yellow
  Write-Host '  restart re-reads it. Refreshing the web page is not enough.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'SELF-CHECK'
if (Test-Path -LiteralPath $verify -PathType Leaf) {
  Write-Host "  & '$verify'"
} else {
  Write-Host '  (verify.ps1 was not found next to this script)'
}
Write-Host '  Invoke-RestMethod http://127.0.0.1:19387/api/dsh-wechat-box/state'
if (Test-Path -LiteralPath $nodeExe -PathType Leaf) {
  Write-Host "  & '$nodeExe' '$(Join-Path $PluginRoot 'lib\test-manifest.mjs')'"
}
Write-Host ''

exit 0
