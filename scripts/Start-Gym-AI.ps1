param([switch]$NoTunnel)
$ErrorActionPreference = 'Stop'
$chatgpt = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $chatgpt
$logs = Join-Path $chatgpt 'logs'
$store = Join-Path $chatgpt 'store'
$node = Join-Path $root 'windows\runtime\node.exe'
$connectorDir = $chatgpt
$utf8 = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path $logs, $store | Out-Null
$log = Join-Path $logs 'autostart.log'

function Log($message) {
  $line = (Get-Date).ToString('o') + '  ' + $message
  [IO.File]::AppendAllText($log, $line + "`r`n", $utf8)
}
function Alive($url) {
  try { Invoke-RestMethod -Uri $url -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
function Wait-For($url, $seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Alive $url) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

Log 'autostart begin'

if (-not (Alive 'http://127.0.0.1:30347/api/health')) {
  Log 'openGym is not running; starting it'
  try {
    & (Join-Path $root 'windows\Start-openGym.ps1') -NoBrowser
  } catch {
    Log ('openGym start failed: ' + $_.Exception.Message)
  }
  if (-not (Wait-For 'http://127.0.0.1:30347/api/health' 60)) { Log 'openGym did not become healthy' }
} else {
  Log 'openGym already running'
}

if (-not (Alive 'http://127.0.0.1:8787/healthz')) {
  Log 'starting ChatGPT connector'
  $out = Join-Path $logs 'connector.log'
  $err = Join-Path $logs 'connector-error.log'
  $process = Start-Process -FilePath $node -ArgumentList '"src/main.mjs"' -WorkingDirectory $connectorDir `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  [IO.File]::WriteAllText((Join-Path $store 'connector.pid'), [string]$process.Id, $utf8)
  if (-not (Wait-For 'http://127.0.0.1:8787/healthz' 30)) { Log 'connector did not become healthy' }
} else {
  Log 'connector already running'
}

if (-not (Alive 'http://127.0.0.1:8081/__healthz')) {
  Log 'starting openGym app proxy'
  $out = Join-Path $logs 'app-proxy.log'
  $err = Join-Path $logs 'app-proxy-error.log'
  $process = Start-Process -FilePath $node -ArgumentList '"src/app-proxy.mjs"' -WorkingDirectory $connectorDir `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  [IO.File]::WriteAllText((Join-Path $store 'appproxy.pid'), [string]$process.Id, $utf8)
  if (-not (Wait-For 'http://127.0.0.1:8081/__healthz' 20)) { Log 'app proxy did not become healthy' }
} else {
  Log 'app proxy already running'
}

if (-not $NoTunnel) {
  $modeFile = Join-Path $store 'tunnel-mode.txt'
  if (Test-Path -LiteralPath $modeFile) {
    $mode = (Get-Content -LiteralPath $modeFile -Raw).Trim()
    if ($mode -and $mode -ne 'none' -and $mode -ne 'secure') {
      Log ('starting tunnel: ' + $mode)
      try {
        $tunnelArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
          (Join-Path $PSScriptRoot 'tunnel.ps1') + '" -Mode ' + $mode + ' -Quiet'
        Start-Process -FilePath 'powershell.exe' -ArgumentList $tunnelArgs -WindowStyle Hidden `
          -RedirectStandardOutput (Join-Path $logs 'tunnel-autostart.log') `
          -RedirectStandardError (Join-Path $logs 'tunnel-autostart-error.log') | Out-Null
      } catch { Log ('tunnel failed: ' + $_.Exception.Message) }
    }
  }
}

Log 'autostart done'
