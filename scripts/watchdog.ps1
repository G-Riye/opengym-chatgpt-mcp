# openGym watchdog: keeps the four local pieces + the public tunnel alive.
# Started by openGym-Watchdog.vbs at logon (hidden window). Checks every -IntervalSec
# (default 300s) and only acts when something is actually down, so it is quiet.
param(
  [int]$IntervalSec = 300,
  [switch]$Once,
  [switch]$Verbose
)
$ErrorActionPreference = 'Continue'
$chatgpt = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $chatgpt
$node = Join-Path $root 'windows\runtime\node.exe'
$store = Join-Path $chatgpt 'store'
$logs = Join-Path $chatgpt 'logs'
$utf8 = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$logFile = Join-Path $logs 'watchdog.log'

# Windows PowerShell 5.1 refuses Start-Process -Redirect* when the environment holds
# both NO_PROXY and no_proxy (case-only duplicates). Drop the lowercase copies here.
foreach ($name in 'no_proxy', 'http_proxy', 'https_proxy') {
  try { Remove-Item -Path ('Env:' + $name) -ErrorAction Stop } catch { }
}

function Log($message) {
  $line = (Get-Date).ToString('o') + '  ' + $message
  try { [IO.File]::AppendAllText($logFile, $line + "`r`n", $utf8) } catch { }
  if ($Verbose) { Write-Host $line }
}
function Read-Text($file) {
  if (Test-Path -LiteralPath $file) { return ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)).Trim() }
  return ''
}
function Alive($url, $timeout = 3) {
  try { Invoke-RestMethod -Uri $url -TimeoutSec $timeout | Out-Null; return $true } catch { return $false }
}
function Ready() {
  try { return (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:20241/ready' -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

function Ensure-OpenGym {
  if (Alive 'http://127.0.0.1:30347/api/health') { return }
  Log 'openGym API down -> starting openGym'
  $script = Join-Path $root 'windows\Start-openGym.ps1'
  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" -NoBrowser') `
      -WindowStyle Hidden | Out-Null
  } catch { Log ('openGym start failed: ' + $_.Exception.Message) }
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Seconds 1; if (Alive 'http://127.0.0.1:30347/api/health') { Log 'openGym is up'; return } }
  Log 'openGym did not come up'
}

function Ensure-Connector {
  if (Alive 'http://127.0.0.1:8787/healthz') { return }
  Log 'connector down -> starting it'
  try {
    $p = Start-Process -FilePath $node -ArgumentList '"src/main.mjs"' -WorkingDirectory $chatgpt -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $logs 'connector.log') -RedirectStandardError (Join-Path $logs 'connector-error.log')
    [IO.File]::WriteAllText((Join-Path $store 'connector.pid'), [string]$p.Id, $utf8)
  } catch { Log ('connector start failed: ' + $_.Exception.Message) }
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; if (Alive 'http://127.0.0.1:8787/healthz') { return } }
  Log 'connector did not come up'
}

function Ensure-AppProxy {
  if (Alive 'http://127.0.0.1:8081/__healthz') { return }
  Log 'app proxy down -> starting it'
  try {
    $p = Start-Process -FilePath $node -ArgumentList '"src/app-proxy.mjs"' -WorkingDirectory $chatgpt -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $logs 'app-proxy.log') -RedirectStandardError (Join-Path $logs 'app-proxy-error.log')
    [IO.File]::WriteAllText((Join-Path $store 'appproxy.pid'), [string]$p.Id, $utf8)
  } catch { Log ('app proxy start failed: ' + $_.Exception.Message) }
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; if (Alive 'http://127.0.0.1:8081/__healthz') { return } }
  Log 'app proxy did not come up'
}

function Ensure-Tunnel {
  $mode = Read-Text (Join-Path $store 'tunnel-mode.txt')
  if (-not $mode -or $mode -eq 'none') {
    Log 'tunnel mode is none - public access stays off (set it with scripts\tunnel.ps1 -Mode cloudflare)'
    return
  }
  if ($mode -ne 'cloudflare') { return }   # named/quick/tailscale are started by other scripts
  if (Ready) { return }
  Log 'tunnel not ready -> restarting cloudflared (cloudflare mode)'
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $exe = Join-Path $chatgpt 'tools\cloudflared.exe'
  $cfg = Join-Path $store 'cloudflared.yml'
  if (-not (Test-Path $exe) -or -not (Test-Path $cfg)) { Log 'cloudflared or its config is missing'; return }
  try {
    $p = Start-Process -FilePath $exe -ArgumentList ('tunnel --config "' + $cfg + '" --protocol http2 --no-autoupdate run') -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $logs 'cloudflared.log') -RedirectStandardError (Join-Path $logs 'cloudflared-error.log')
    [IO.File]::WriteAllText((Join-Path $store 'tunnel.pid'), [string]$p.Id, $utf8)
  } catch { Log ('cloudflared start failed: ' + $_.Exception.Message); return }
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 2; if (Ready) { Log 'tunnel is up'; return } }
  Log 'tunnel still not ready - check logs\cloudflared-error.log (often Clash fake-ip: turn TUN off and retry)'
}

function Tick {
  Ensure-OpenGym
  Ensure-Connector
  Ensure-AppProxy
  Ensure-Tunnel
}

Log ('watchdog started (interval ' + $IntervalSec + 's)')
Start-Sleep -Seconds 30
Tick
if ($Once) { Log 'watchdog -Once done'; exit 0 }

while ($true) {
  Start-Sleep -Seconds ([Math]::Max(60, $IntervalSec))
  try { Tick } catch { Log ('tick error: ' + $_.Exception.Message) }
}
