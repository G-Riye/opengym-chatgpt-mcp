# Creates (once) the named Cloudflare Tunnel used to publish openGym and its MCP connector,
# writes store\cloudflare.json + store\cloudflared.yml, then start it with:
#   scripts\tunnel.ps1 -Mode cloudflare
param(
  [string]$Tunnel = 'opengym',
  [string]$App = '',
  [string]$Mcp = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$store = Join-Path $root 'store'
$tools = Join-Path $root 'tools'
New-Item -ItemType Directory -Force -Path $store, $tools | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$exe = Join-Path $tools 'cloudflared.exe'
if (-not (Test-Path -LiteralPath $exe)) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe
}
$cert = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
if (-not (Test-Path -LiteralPath $cert)) {
  throw "Cloudflare is not logged in. Run once:`n  `"$exe`" tunnel login`nthen rerun this script."
}
$hostsFile = Join-Path $store 'cloudflare.json'
$cfg = $null
if (Test-Path -LiteralPath $hostsFile) {
  try { $cfg = Get-Content -LiteralPath $hostsFile -Raw | ConvertFrom-Json } catch { $cfg = $null }
}
if ($cfg -and $cfg.tunnel) { $Tunnel = [string]$cfg.tunnel }
if (-not $App) { if ($cfg -and $cfg.app) { $App = [string]$cfg.app } else { throw 'Pass -App gym.yourdomain (or write store\cloudflare.json first).' } }
if (-not $Mcp) { if ($cfg -and $cfg.mcp) { $Mcp = [string]$cfg.mcp } else { throw 'Pass -Mcp mcp.yourdomain (or write store\cloudflare.json first).' } }
if ($App -notmatch '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' -or $Mcp -notmatch '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') {
  throw 'App/Mcp must be bare hostnames (no scheme, no path), e.g. gym.example.com'
}
$list = & $exe tunnel list 2>$null
$tunnelId = ''
foreach ($line in $list) {
  if ($line -match ('\s' + [regex]::Escape($Tunnel) + '\s')) { $tunnelId = (($line -replace '^\s+', '') -split '\s+')[0] }
}
if (-not $tunnelId) {
  $created = (& $exe tunnel create $Tunnel 2>&1) -join "`n"
  $m = [regex]::Match($created, 'with id ([0-9a-f-]{36})')
  if (-not $m.Success) { throw ("cloudflared tunnel create did not report an id:`n" + $created) }
  $tunnelId = $m.Groups[1].Value
}
foreach ($hostname in @($App, $Mcp)) {
  & $exe tunnel route dns $Tunnel $hostname 2>&1 | Out-Null
}
$creds = Join-Path $env:USERPROFILE ('.cloudflared\' + $tunnelId + '.json')
if (-not (Test-Path -LiteralPath $creds)) { throw ('Tunnel credentials file missing: ' + $creds) }
[IO.File]::WriteAllText($hostsFile, ([ordered]@{ tunnel = $Tunnel; app = $App; mcp = $Mcp } | ConvertTo-Json), $utf8)
$yml = @"
tunnel: $tunnelId
credentials-file: $creds
no-autoupdate: true
ingress:
  - hostname: $App
    service: http://127.0.0.1:8081
  - hostname: $Mcp
    service: http://127.0.0.1:8787
  - service: http_status:404
"@
[IO.File]::WriteAllText((Join-Path $store 'cloudflared.yml'), $yml, $utf8)
Write-Host 'Cloudflare Tunnel is configured:'
Write-Host ("  tunnel : " + $Tunnel + " (" + $tunnelId + ")")
Write-Host ("  app    : https://" + $App + "/   -> 127.0.0.1:8081")
Write-Host ("  mcp    : https://" + $Mcp + "/   -> 127.0.0.1:8787")
Write-Host ''
Write-Host 'Start it with:  scripts\tunnel.ps1 -Mode cloudflare'
