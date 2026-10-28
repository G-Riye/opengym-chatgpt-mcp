param(
  [ValidateSet('quick', 'named', 'tailscale', 'cloudflare', 'secure', 'stop', 'status')]
  [string]$Mode = 'quick',
  [string]$Name = 'opengym',
  [string]$PublicUrl = '',
  [int]$Port = 8787,
  [switch]$Quiet,
  [switch]$Reauth
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$store = Join-Path $root 'store'
$tools = Join-Path $root 'tools'
$logs = Join-Path $root 'logs'
$mcpTokenFile = Join-Path $root 'secrets\mcp-token'
$pidFile = Join-Path $store 'tunnel.pid'
$modeFile = Join-Path $store 'tunnel-mode.txt'
$urlFile = Join-Path $store 'public-url.txt'
$utf8 = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path $store, $tools, $logs | Out-Null

function Say($message) { if (-not $Quiet) { Write-Host $message } }
function Write-Utf8($file, $text) { [IO.File]::WriteAllText($file, [string]$text, $utf8) }
function Read-Text($file) { if (Test-Path -LiteralPath $file) { return (Get-Content -LiteralPath $file -Raw).Trim() } return '' }
function LocalToken {
  $token = Read-Text $mcpTokenFile
  if (-not $token) { throw "MCP token not found. Start the connector once: node src/main.mjs" }
  return $token
}
function Set-Public($url) {
  $clean = $url.Trim().TrimEnd('/')
  Write-Utf8 $urlFile $clean
  Write-Utf8 $modeFile $Mode
  $token = LocalToken
  Say ""
  Say "Public base : $clean"
  Say "ChatGPT URL : $clean/mcp/$token"
  return "$clean/mcp/$token"
}
function Stop-Tunnel {
  if (Test-Path -LiteralPath $pidFile) {
    $old = Read-Text $pidFile
    if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $previous = Read-Text $modeFile
  if ($previous -eq 'tailscale') {
    try { & tailscale funnel reset 2>$null | Out-Null } catch {}
  }
  Remove-Item -LiteralPath $urlFile -Force -ErrorAction SilentlyContinue
  Write-Utf8 $modeFile 'none'
}

if ($Mode -eq 'stop') {
  Stop-Tunnel
  Say 'Tunnel stopped.'
  exit 0
}
if ($Mode -eq 'status') {
  Say ("mode   : " + (Read-Text $modeFile))
  Say ("public : " + (Read-Text $urlFile))
  if (Test-Path -LiteralPath $pidFile) { Say ("pid    : " + (Read-Text $pidFile)) }
  exit 0
}

Stop-Tunnel

if ($Mode -eq 'cloudflare') {
  $exe = Join-Path $tools 'cloudflared.exe'
  if (-not (Test-Path -LiteralPath $exe)) {
    Say 'Downloading cloudflared (portable, one time)...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe
  }
  $cert = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
  if (-not (Test-Path -LiteralPath $cert)) {
    throw ("Cloudflare is not logged in. Run once:`n  `"" + $exe + "`" tunnel login`nthen rerun: scripts\tunnel.ps1 -Mode cloudflare")
  }
  $hostsFile = Join-Path $store 'cloudflare.json'
  $configFile = Join-Path $store 'cloudflared.yml'
  if (-not (Test-Path -LiteralPath $hostsFile) -or -not (Test-Path -LiteralPath $configFile)) {
    throw ("Missing " + $hostsFile + " or " + $configFile + ". Run scripts\setup-cloudflare.ps1 once to create the tunnel and its DNS routes.")
  }
  $cfg = Get-Content -LiteralPath $hostsFile -Raw | ConvertFrom-Json
  if (-not $cfg.app -or -not $cfg.mcp) { throw 'cloudflare.json needs "app" and "mcp" hostnames' }
  $out = Join-Path $logs 'cloudflared.log'
  $err = Join-Path $logs 'cloudflared-error.log'
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  $args = 'tunnel --config "' + $configFile + '" --no-autoupdate run'
  $process = Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  Write-Utf8 $pidFile $process.Id
  Start-Sleep -Seconds 4
  if ($process.HasExited) { throw ("cloudflared exited. See " + $err) }
  Write-Utf8 $modeFile 'cloudflare'
  Write-Utf8 $urlFile ('https://' + $cfg.mcp)
  Write-Utf8 (Join-Path $store 'app-url.txt') ('https://' + $cfg.app)
  $token = LocalToken
  $appToken = Read-Text (Join-Path $root 'secrets\app-token')
  Say ''
  Say ('openGym App : https://' + $cfg.app + '/')
  Say ('  first visit needs the token: https://' + $cfg.app + '/?t=' + $appToken)
  Say ('ChatGPT MCP : https://' + $cfg.mcp)
  Say ('  connector   : https://' + $cfg.mcp + '/mcp/' + $token)
  exit 0
}

if ($Mode -eq 'quick') {
  $exe = Join-Path $tools 'cloudflared.exe'
  if (-not (Test-Path -LiteralPath $exe)) {
    Say 'Downloading cloudflared (portable, one time)...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $exe
  }
  $out = Join-Path $logs 'tunnel-quick.log'
  $err = Join-Path $logs 'tunnel-quick-error.log'
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  $args = 'tunnel --url http://127.0.0.1:' + $Port + ' --no-autoupdate'
  $process = Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  Write-Utf8 $pidFile $process.Id
  $public = ''
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    foreach ($file in @($err, $out)) {
      if (Test-Path -LiteralPath $file) {
        $match = Select-String -LiteralPath $file -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches |
          Select-Object -First 1
        if ($match) { $public = $match.Matches[0].Value; break }
      }
    }
    if ($public) { break }
    if ($process.HasExited) { break }
  }
  if (-not $public) { throw "cloudflared did not report a URL. See $err" }
  $connector = Set-Public $public
  Say ""
  Say "Quick tunnels get a NEW URL every restart. For an always-on connector use:"
  Say "  scripts\tunnel.ps1 -Mode tailscale"
  Say "  scripts\tunnel.ps1 -Mode named -Name $Name -PublicUrl https://gym.example.com"
  exit 0
}

if ($Mode -eq 'named') {
  $exe = Join-Path $tools 'cloudflared.exe'
  if (-not (Test-Path -LiteralPath $exe)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe
  }
  if (-not $PublicUrl) { throw "Named tunnel needs -PublicUrl https://your.domain (the hostname routed to this tunnel)." }
  try { & $exe tunnel list 2>$null | Out-Null } catch {
    throw "Cloudflare is not logged in. Run once: `"$exe`" tunnel login`nThen create the tunnel: `"$exe`" tunnel create $Name`nand route DNS: `"$exe`" tunnel route dns $Name your.domain"
  }
  $out = Join-Path $logs 'tunnel-named.log'
  $err = Join-Path $logs 'tunnel-named-error.log'
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  $args = 'tunnel --url http://127.0.0.1:' + $Port + ' --no-autoupdate run ' + $Name
  $process = Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  Write-Utf8 $pidFile $process.Id
  Start-Sleep -Seconds 3
  if ($process.HasExited) { throw "cloudflared exited. See $err" }
  Set-Public $PublicUrl | Out-Null
  exit 0
}

if ($Mode -eq 'tailscale') {
  $tail = Get-Command tailscale -ErrorAction SilentlyContinue
  if (-not $tail) { throw 'tailscale is not installed. Install it from tailscale.com/download, then rerun.' }
  $tsExe = $tail.Source

  function Get-TsStatus {
    $json = & $tsExe status --json 2>$null
    if (-not $json) { return $null }
    try { return ($json | ConvertFrom-Json) } catch { return $null }
  }
  function Open-Link($url) {
    if (-not $url) { return }
    Write-Utf8 (Join-Path $store 'tailscale-login-url.txt') $url
    try { Set-Clipboard -Value $url -ErrorAction SilentlyContinue } catch { }
    if (-not $Quiet) {
      try { Start-Process explorer.exe -ArgumentList $url; return } catch { }
      try { Start-Process $url; return } catch { }
      Say 'Could not open a browser automatically. Copy the link above into Chrome/Edge.'
    }
  }
  function Wait-Running([int]$seconds, [int]$everySec = 10) {
    $deadline = (Get-Date).AddSeconds($seconds)
    $shown = 0
    while ((Get-Date) -lt $deadline) {
      $s = Get-TsStatus
      if ($s -and $s.BackendState -eq 'Running') { return $s }
      Start-Sleep -Seconds $everySec
      $shown += $everySec
      if (-not $Quiet) { Say ('  still waiting for Tailscale login... ' + $shown + 's') }
    }
    return (Get-TsStatus)
  }

  # The tray app is what makes Tailscale visible on this PC; the CLI alone runs invisibly.
  $ipnExe = Join-Path (Split-Path $tsExe -Parent) 'tailscale-ipn.exe'
  if ((Test-Path -LiteralPath $ipnExe) -and -not (Get-Process tailscale-ipn -ErrorAction SilentlyContinue)) {
    try { Start-Process -FilePath $ipnExe -WindowStyle Minimized } catch { }
  }

  $status = Get-TsStatus
  $backend = if ($status) { [string]$status.BackendState } else { '' }
  if ($backend -and $backend -ne 'Running' -and $backend -ne 'NeedsLogin' -and
      $backend -ne 'NoState' -and $backend -ne 'Stopped') {
    # e.g. Starting - the service is still coming up after boot
    $status = Wait-Running 20 5
    $backend = if ($status) { [string]$status.BackendState } else { '' }
  }
  if ($backend -ne 'Running') {
    Say 'Tailscale is not signed in on this PC. Starting the login flow...'
    Say ''
    $upOut = Join-Path $logs 'tailscale-up.log'
    $upErr = Join-Path $logs 'tailscale-up-error.log'
    Remove-Item $upOut, $upErr -Force -ErrorAction SilentlyContinue
    # No --timeout here on purpose: a timed-out `tailscale up` cancels the login and
    # the link you clicked afterwards did nothing (that is what bit us before).
    # --force-reauth only when explicitly asked, so a normal boot never logs you out.
    $upArgs = @('up', '--accept-dns=false', '--accept-routes=false')
    if ($Reauth) { $upArgs += '--force-reauth' }
    $up = Start-Process -FilePath $tsExe -ArgumentList $upArgs `
      -WindowStyle Hidden -PassThru -RedirectStandardOutput $upOut -RedirectStandardError $upErr
    $auth = ''
    for ($i = 0; $i -lt 120; $i++) {
      Start-Sleep -Milliseconds 500
      $text = (Get-Content $upErr -Raw -ErrorAction SilentlyContinue) + "`n" +
        (Get-Content $upOut -Raw -ErrorAction SilentlyContinue)
      $m = [regex]::Match($text, 'https://login\.tailscale\.com/[a-z]/[A-Za-z0-9]+')
      if ($m.Success) { $auth = $m.Value; break }
      if ($up.HasExited) { break }
    }
    if ($auth) {
      Say 'Open this page and sign in with Google (it has been opened for you):'
      Say ''
      Say ('  ' + $auth)
      Say ''
      Say 'The link is also in  chatgpt\store\tailscale-login-url.txt  and on your clipboard.'
      Open-Link $auth
      Say 'Waiting up to 5 minutes. Finish the login and this window will continue by itself.'
      $status = Wait-Running 300 10
    } else {
      $text = (Get-Content $upErr -Raw -ErrorAction SilentlyContinue) + "`n" +
        (Get-Content $upOut -Raw -ErrorAction SilentlyContinue)
      Say ('tailscale up printed nothing useful:' + "`n" + $text)
      $status = Wait-Running 60 5
    }
  }
  if (-not $status -or $status.BackendState -ne 'Running') {
    $state = if ($status) { [string]$status.BackendState } else { 'unknown' }
    Say ''
    Say ('Tailscale state is still ' + $state + '.')
    Say 'Run this file again after the browser page says "Success" / shows your machine.'
    throw 'Tailscale login was not completed.'
  }
  Say ('Tailscale is up as ' + [string]$status.Self.HostName + '.')

  $dns = [string]$status.Self.DNSName
  if (-not $dns) {
    Say ''
    Say 'No MagicDNS name yet. In the Tailscale admin console (DNS tab) enable:'
    Say '  - MagicDNS'
    Say '  - HTTPS Certificates'
    Say 'Then run this file again.'
    throw 'MagicDNS name missing.'
  }
  $dns = $dns.TrimEnd('.')

  # Enable Funnel: first run usually returns an "enable" link; open it and retry.
  function Start-TsFunnel([string[]]$FunnelArgs, [string]$LogName) {
    $fOut = Join-Path $logs ($LogName + '.log')
    $fErr = Join-Path $logs ($LogName + '-error.log')
    for ($attempt = 1; $attempt -le 6; $attempt++) {
      Remove-Item $fOut, $fErr -Force -ErrorAction SilentlyContinue
      $f = Start-Process -FilePath $tsExe -ArgumentList $FunnelArgs `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $fOut -RedirectStandardError $fErr
      $finished = $f.WaitForExit(20000)
      if (-not $finished) { try { $f.Kill() } catch { } }
      $message = ((Get-Content $fErr -Raw -ErrorAction SilentlyContinue) + "`n" +
        (Get-Content $fOut -Raw -ErrorAction SilentlyContinue)).Trim()
      # `funnel --bg` reports success on stderr and sometimes exits non-zero,
      # so trust the message, not the exit code.
      if ($message -match 'Funnel started|Available on the internet') { return $true }
      if ($finished -and $f.ExitCode -eq 0) { return $true }
      $link = [regex]::Match($message, 'https://login\.tailscale\.com/f/funnel\?node=[^\s]+').Value
      if ($link -and $attempt -eq 1) {
        Say ''
        Say 'Funnel is not enabled on your tailnet yet. Opening the enable page:'
        Say ('  ' + $link)
        Say 'Click "Enable Funnel", then wait - this script retries by itself.'
        Open-Link $link
        Start-Sleep -Seconds 25
        continue
      }
      if ($attempt -lt 6) { Start-Sleep -Seconds 10; continue }
      Say ''
      Say ('tailscale funnel output (' + $LogName + '):')
      Say $message
      if ($message -match 'not enabled') { throw 'Funnel is still disabled for this tailnet. Enable it in the admin console, then rerun.' }
      return $false
    }
    return $false
  }

  if (-not (Start-TsFunnel @('funnel', '--bg', [string]$Port) 'funnel')) {
    throw 'tailscale funnel did not start.'
  }

  Set-Public ("https://" + $dns) | Out-Null

  # The openGym PWA is also published, on :8443, because iPhone cannot run Tailscale
  # and a proxy VPN at the same time - the app has to be reachable with no VPN at all.
  $appPort = 8081
  $appUrlFile = Join-Path $store 'app-url.txt'
  $appUp = $false
  try { $null = Invoke-WebRequest -UseBasicParsing ("http://127.0.0.1:" + $appPort + "/__healthz") -TimeoutSec 3; $appUp = $true } catch { }
  if ($appUp) {
    if (Start-TsFunnel @('funnel', '--bg', '--https=8443', ('http://127.0.0.1:' + $appPort)) 'funnel-app') {
      Write-Utf8 $appUrlFile ("https://" + $dns + ":8443")
      Say ''
      Say ('openGym App (works on 5G, no VPN needed): https://' + $dns + ':8443/')
      Say ('  first visit needs the token: https://' + $dns + ':8443/?t=' + (Read-Text (Join-Path $root 'secrets\app-token')))
      Say '  after that the token is a cookie; "Add to Home Screen" works.'
    } else {
      Say ''
      Say 'App proxy is running but the :8443 funnel did not start; see logs\funnel-app-error.log'
    }
  } else {
    Remove-Item -LiteralPath $appUrlFile -Force -ErrorAction SilentlyContinue
    Say ''
    Say 'App proxy is not running, so openGym itself is not published (run Start.cmd).'
  }

  Say ''
  Say 'Tailscale Funnel is public to the internet, but the URL contains a 64-char secret token.'
  Say 'Disable anytime with: scripts\tunnel.ps1 -Mode stop'
  exit 0
}

if ($Mode -eq 'secure') {
  Write-Utf8 $modeFile 'secure'
  Say 'OpenAI Secure MCP Tunnel keeps this server private (no public URL).'
  Say 'Setup, once:'
  Say '  1. Platform -> Tunnels: create a tunnel, copy tunnel_id and a runtime API key.'
  Say '  2. Download tunnel-client from github.com/openai/tunnel-client/releases'
  Say ('  3. tunnel-client init --tunnel-id <id> --mcp-server-url http://127.0.0.1:' + $Port + '/mcp/<token> --profile opengym')
  Say '     (or --mcp-command "C:\...\node.exe C:\...\chatgpt\src\main.mjs")'
  Say '  4. tunnel-client run --profile opengym'
  Say '  5. ChatGPT -> Plugins -> Add custom MCP server -> Connection: Tunnel -> pick it.'
  Say 'Official guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels'
  exit 0
}
