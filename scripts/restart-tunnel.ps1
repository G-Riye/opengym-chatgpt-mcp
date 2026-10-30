# Restart the public tunnel (Cloudflare / quick / named) and wait until it is really connected.
# The "ready" check is cloudflared's own metrics endpoint, so a 200 means the edge accepted us -
# a plain TCP/HTTP probe cannot tell a tunnel that is up from one stuck retrying.
$ErrorActionPreference = 'Continue'
$chatgpt = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $chatgpt
$store = Join-Path $chatgpt 'store'
$logs = Join-Path $chatgpt 'logs'
$tools = Join-Path $chatgpt 'tools'
$utf8 = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Read-Text($file) {
  if (Test-Path -LiteralPath $file) { return ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)).Trim() }
  return ''
}

$modeFile = Join-Path $store 'tunnel-mode.txt'
$mode = Read-Text $modeFile
if (-not $mode -or $mode -eq 'none') { $mode = 'cloudflare' }
Write-Host ''
Write-Host ('  tunnel mode : ' + $mode)

Write-Host '  stopping old cloudflared...'
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$exe = Join-Path $tools 'cloudflared.exe'
$out = Join-Path $logs 'cloudflared.log'
$err = Join-Path $logs 'cloudflared-error.log'
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
$proc = $null

if ($mode -eq 'cloudflare') {
  $config = Join-Path $store 'cloudflared.yml'
  if (-not (Test-Path $config)) { throw ('missing ' + $config + ' - run scripts\setup-cloudflare.ps1 once') }
  $proc = Start-Process -FilePath $exe -ArgumentList ('tunnel --config "' + $config + '" --protocol http2 --no-autoupdate run') `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
} elseif ($mode -eq 'named' -or $mode -eq 'quick') {
  Write-Host '  this mode is started by scripts\tunnel.ps1; run Tunnel-Quick.cmd / the named-tunnel command instead.'
  exit 2
} elseif ($mode -eq 'tailscale') {
  Write-Host '  tailscale funnel mode: run scripts\tunnel.ps1 -Mode tailscale'
  exit 2
}
if (-not $proc) { throw 'could not start cloudflared' }
[IO.File]::WriteAllText((Join-Path $store 'tunnel.pid'), [string]$proc.Id, $utf8)
Write-Host ('  cloudflared pid ' + $proc.Id + ', waiting for the edge...')

$ready = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:20241/ready' -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
  if ($proc.HasExited) { break }
}

$public = Read-Text (Join-Path $store 'public-url.txt')
if ($ready) {
  Write-Host ''
  Write-Host '  TUNNEL READY'
  if ($public) {
    Write-Host ('  app : ' + $public)
    if ((Test-Path (Join-Path $store 'cloudflare.json'))) {
      $cfg = Get-Content (Join-Path $store 'cloudflare.json') -Raw | ConvertFrom-Json
      if ($cfg.app) { Write-Host ('  openGym App : https://' + $cfg.app + '/') }
    }
  }
  Write-Host ''
  exit 0
}

$tail = (Get-Content $err -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
Write-Host ''
Write-Host '  TUNNEL NOT READY'
if ($tail -match '7844|quic|edge|timeout') {
  Write-Host ''
  Write-Host '  The edge cannot be reached on port 7844. The usual cause on this PC:'
  Write-Host '  Clash Verge is running with TUN + fake-ip, so cloudflared dials 198.18.x.x and the'
  Write-Host '  tunnel handshake times out.'
  Write-Host ''
  Write-Host '  Fix (30 seconds):'
  Write-Host '    1. Clash Verge -> 关闭 TUN 模式（或暂时退出 Clash）'
  Write-Host '    2. 再运行一次 Restart-Tunnel.cmd'
  Write-Host '    3. 成功后可以把 TUN 再打开（隧道会保持连接直到进程退出）'
} else {
  Write-Host $tail
}
Write-Host ''
Write-Host ('  log: ' + $err)
Write-Host ''
exit 1
