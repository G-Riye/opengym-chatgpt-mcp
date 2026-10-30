param(
  [ValidateSet('show', 'confirm', 'auto')]
  [string]$Mode = 'show'
)
$ErrorActionPreference = 'Stop'
$chatgpt = Split-Path -Parent $PSScriptRoot
$store = Join-Path $chatgpt 'store'
$file = Join-Path $store 'write-mode.txt'
$utf8 = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path $store | Out-Null

function Read-Mode {
  if (Test-Path -LiteralPath $file) {
    $v = ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)).Trim().ToLower()
    if ($v -eq 'auto' -or $v -eq 'confirm') { return $v }
  }
  return 'confirm'
}

if ($Mode -eq 'show') {
  $current = Read-Mode
  Write-Host ''
  Write-Host ('  当前写入模式: ' + $current)
  if ($current -eq 'auto') {
    Write-Host '  - 预览后可以直接 plan_apply(confirmation:"直接写入")，不需要你再说一遍“确认”。'
    Write-Host '  - 仍然保留：rev 冲突检查、写前备份（store\backups，30 份）、字段校验。'
  } else {
    Write-Host '  - 预览后必须你明确同意，模型才能用 plan_apply(confirmation:"确认写入") 写入。'
  }
  Write-Host ''
  Write-Host '  切换:  Write-Mode.cmd auto      免确认（你自己用）'
  Write-Host '         Write-Mode.cmd confirm   改回每次确认（默认）'
  Write-Host ''
  exit 0
}

[IO.File]::WriteAllText($file, $Mode + "`n", $utf8)
Write-Host ''
Write-Host ('  写入模式已设为: ' + $Mode)
if ($Mode -eq 'auto') {
  Write-Host '  - 模型可以在展示 changes 后直接写入（confirmation:"直接写入"）。'
  Write-Host '  - 想恢复逐次确认: Write-Mode.cmd confirm'
} else {
  Write-Host '  - 恢复为每次写入都需要你确认（confirmation:"确认写入"）。'
}
Write-Host '  - 该设置只影响写入确认；rev 冲突检查与备份始终生效。'
Write-Host '  - 连接器无需重启（每次写入前都会重新读取）。'
Write-Host ''
