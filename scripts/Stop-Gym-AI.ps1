param([switch]$All)
$ErrorActionPreference = 'SilentlyContinue'
$chatgpt = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $chatgpt
$store = Join-Path $chatgpt 'store'
$node = Join-Path $root 'windows\runtime\node.exe'

foreach ($name in @('tunnel.pid', 'connector.pid', 'appproxy.pid')) {
  $file = Join-Path $store $name
  if (Test-Path -LiteralPath $file) {
    $id = (Get-Content -LiteralPath $file -Raw).Trim()
    if ($id) { Stop-Process -Id ([int]$id) -Force }
    Remove-Item -LiteralPath $file -Force
  }
}
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
if ($All) {
  & (Join-Path $root 'windows\Stop-openGym.ps1')
  Write-Host 'openGym stopped too.'
}
Write-Host 'ChatGPT connector stopped.'
