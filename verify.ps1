<#
  verify.ps1 -- 重启后的阶段 1 自检，一条命令给结论。

  只读：不往微信发任何消息、不改任何文件。
  用法：  pwsh -File <repo>\verify.ps1
  可选：  -Port 19387   指定宿主端口

  判读逻辑写在输出里，不需要你对照文档。
#>
[CmdletBinding()]
param([int]$Port = 19387)

$ErrorActionPreference = 'Continue'
$base = "http://127.0.0.1:$Port"
$stateUrl = "$base/api/dsh-wechat-box/state"
$beaconUrl = "$base/api/dsh-wechat-box/beacon"
$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$probe = Join-Path (Split-Path -Parent $PSScriptRoot) '_recon\probe2.mjs'

function Line($mark, $text) { Write-Host ("  [{0}] {1}" -f $mark, $text) }
function Head($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }

Write-Host ""
Write-Host "dsh-wechat-box 阶段 1 自检" -ForegroundColor White
Write-Host "端口 $Port    时间 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# ---- 1. 宿主进程 ----------------------------------------------------------
Head "1. 宿主进程"
$proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Sort-Object StartTime | Select-Object -First 1
if ($proc) {
  $up = [math]::Round(((Get-Date) - $proc.StartTime).TotalMinutes, 1)
  Line 'i' ("PID {0}，启动于 {1}，已运行 {2} 分钟" -f $proc.Id, $proc.StartTime, $up)
} else {
  Line '!' "没找到 DeepSeek Harness 进程"
}

# ---- 1b. 文件级启动追踪（不依赖 web 服务器，坏的就是它）-------------------
Head "1b. 启动追踪 wechat-box-boot.log"
$bootLog = Join-Path $env:USERPROFILE '.dsh\wechat-box-boot.log'
if (Test-Path $bootLog) {
  $lines = @(Get-Content $bootLog -Encoding UTF8)
  # 只认当前 DSH 进程写的行：测试脚本也会往同一个文件追加，按 pid 过滤才准。
  $hostPids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $hostLines = $lines | Where-Object {
    if ($_ -match 'pid=(\d+) ') { $hostPids -contains [int]$Matches[1] } else { $false }
  }
  if ($hostLines) {
    $hostLines | Select-Object -Last 12 | ForEach-Object { Line 'i' $_ }
    $stages = ($hostLines | ForEach-Object { ($_ -split ' ', 3)[2] }) -join ' -> '
    Line 'i' "本次启动的步骤链：$stages"
    if ($stages -notmatch 'module-imported') {
      Line 'XX' "宿主根本没加载这个模块（bundle 被跳过了？查 bundles / dsh.bundle.patch）"
    } elseif ($stages -match 'routes-registered') {
      Line 'OK' "路由已注册 —— 但若第 2 节仍 401，说明是别的原因"
    } elseif ($stages -match 'routes-unavailable|routes-threw') {
      Line 'XX' "路由注册失败，原因见上面那一行"
    } elseif ($stages -match 'apply-threw|setup-failed') {
      Line 'XX' "apply 抛错了，原因见上面那一行（这就是我们要找的）"
    } elseif ($stages -match 'inject-webServer-requested' -and $stages -notmatch 'inject-webServer-resolved') {
      Line 'XX' "请求注入 webServer 后回调从未执行 —— 这才是真因"
    } else {
      Line '!' "步骤链不完整，见上面各行"
    }
  } else {
    Line '!' "日志里没有本次宿主启动的记录 —— 说明模块没被加载"
  }
} else {
  Line '!' "还没有 $bootLog（宿主从未加载过带追踪的版本）"
}

# ---- 2. 宿主半边：路由是否注册 --------------------------------------------
Head "2. 宿主半边（路由）"
$state = $null
try {
  $state = Invoke-RestMethod $stateUrl -TimeoutSec 10
  Line 'OK' "GET /api/dsh-wechat-box/state -> 200，插件已加载"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 401) {
    Line 'XX' "401 —— 路由没注册，插件宿主半边没起来"
    Line '  ' "这不是页面问题。请把下面这段发给 agent："
    Line '  ' "  state 路由 401；bundles 里有 dsh-wechat-box；junction $(Test-Path (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-wechat-box'))"
  } else {
    Line 'XX' ("请求失败：{0}" -f $_.Exception.Message)
  }
}

# ---- 3. 插件自述状态 ------------------------------------------------------
if ($state) {
  Head "3. 插件状态（它自己报的）"
  Line 'i' ("weixinEnabled         = {0}   （阶段 1 应为 False：安全阀关着，不接微信）" -f $state.weixinEnabled)
  Line 'i' ("transportReady        = {0}   （阶段 1 应为 False）" -f $state.transportReady)
  Line 'i' ("hasTransport/hasBridge= {0} / {1}" -f $state.hasTransport, $state.hasBridge)
  Line 'i' ("applyError            = {0}" -f $(if ($state.applyError) { $state.applyError } else { '(无)' }))
  Line 'i' ("transportError        = {0}" -f $state.transportError)
  Line 'i' ("bridgeError           = {0}" -f $(if ($state.bridgeError) { $state.bridgeError } else { '(无)' }))
  Line 'i' ("已注册的会话数        = {0}" -f (@($state.available).Count))
  Line 'i' ("questionsRegistered   = {0}   approvalsRegistered = {1}   （阶段 1 都应为 False）" -f $state.questionsRegistered, $state.approvalsRegistered)

  if ($state.applyError) {
    Line '!' "插件装配失败，原因见上面 applyError —— 把它发给 agent 即可"
  } elseif ($state.transportError -like '*disabled by config*') {
    Line 'OK' "安全阀生效：传输层已构造但未连接，你的微信没有被打扰"
  }
}

# ---- 4. 客户端半边：三级信标 ----------------------------------------------
Head "4. 客户端半边（三级信标）"
$stages = @()
try {
  $beacon = Invoke-RestMethod $beaconUrl -TimeoutSec 10
  $stages = @($beacon.beacons | ForEach-Object { $_.stage })
  if ($beacon.count -eq 0) {
    Line 'XX' "beacons 为空 —— 页面里 bundle 没被执行"
    Line '  ' "去看：设置 → 插件 → 插件列表 里的「当前页面的同步失败」"
  } else {
    foreach ($b in $beacon.beacons) {
      Line 'i' ("{0,-12} {1}" -f $b.stage, $(if ($b.detail) { $b.detail } else { '' }))
    }
    $has = { param($n) $stages -contains $n }
    if ($stages -contains 'error') {
      Line 'XX' "注册抛错了 —— detail 里就是原因，发给 agent"
    } elseif ((& $has 'registered')) {
      Line 'OK' "开关已注册 → 页面上应该能看见（会话标题右侧的「微信」胶囊）"
    } elseif ((& $has 'factory')) {
      Line 'XX' "插件物化了但注册没完成 —— 见上面的 error 条目"
    } elseif ((& $has 'eval')) {
      Line 'XX' "bundle 执行了但插件没被物化（factory 没跑）"
    }
  }
} catch {
  Line 'XX' ("beacon 路由不可用：{0}" -f $_.Exception.Message)
}

# ---- 5. 宿主是否公告了这个客户端 bundle（不需要鉴权）---------------------
Head "5. 客户端 bundle 是否被宿主公告"
if ((Test-Path $node) -and (Test-Path $probe)) {
  & $node $probe 2>&1 | Where-Object { $_ -match 'dsh-wechat-box|in graph|computed rev|host API' } | ForEach-Object { Line 'i' $_ }
  Line 'i' "200 = 宿主已公告；404 = 没公告（查 bundles / dsh.bundle.patch）"
} else {
  Line '-' "跳过（探针脚本不可用）"
}

# ---- 结论 -----------------------------------------------------------------
Head "结论"
if (-not $state) {
  Write-Host "  插件未加载。若刚重启过，请把第 2 节的输出发给 agent。" -ForegroundColor Yellow
} elseif ($state.applyError) {
  Write-Host "  插件加载了但装配失败 —— 发 applyError。" -ForegroundColor Yellow
} elseif ($stages -contains 'registered') {
  Write-Host "  阶段 1 通过。去界面看会话标题右侧的「微信」胶囊。" -ForegroundColor Green
  Write-Host "  确认可见后，下一步是阶段 2（启用微信 + 停 dsh-im）：" -ForegroundColor Green
  Write-Host "    pwsh -File $PSScriptRoot\migrate.ps1 -Check" -ForegroundColor Green
  Write-Host "    pwsh -File $PSScriptRoot\migrate.ps1 -Phase2" -ForegroundColor Green
} else {
  Write-Host "  插件活着，但客户端半边的状态待定 —— 见第 4 节。" -ForegroundColor Yellow
}
Write-Host ""
