param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Message = '',
  [switch]$NoPush,
  [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
$chatgpt = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $chatgpt
$node = Join-Path $root 'windows\runtime\node.exe'
$git = Join-Path $chatgpt 'tools\git\cmd\git.exe'
$tokenFile = Join-Path $chatgpt 'tools\gh-token.txt'
$utf8 = New-Object Text.UTF8Encoding($false)

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must look like 1.2.3' }
if (-not (Test-Path $git)) { throw "git not found at $git (tools\git is downloaded by the connector setup)" }

function Set-Text($file, $text) { [IO.File]::WriteAllText($file, $text, $utf8) }

Write-Host "== release $Version =="

# 1. bump package.json and the MCP server version string
# NOTE: always read/write UTF-8 explicitly. Get-Content -Raw decodes as ANSI on
# Windows PowerShell 5.1 and turned the Chinese INSTRUCTIONS into mojibake (1.2.0).
$pkgFile = Join-Path $chatgpt 'package.json'
$pkg = [IO.File]::ReadAllText($pkgFile, [Text.Encoding]::UTF8)
Set-Text $pkgFile ($pkg -replace '"version":\s*"[^"]+"', ('"version": "' + $Version + '"'))
$versionFile = Join-Path $chatgpt 'src\version.mjs'
$versionSrc = [IO.File]::ReadAllText($versionFile, [Text.Encoding]::UTF8)
Set-Text $versionFile ($versionSrc -replace "export const VERSION = '[^']+';", ("export const VERSION = '" + $Version + "';"))
$serverFile = Join-Path $chatgpt 'src\server.mjs'
if (-not ([IO.File]::ReadAllText($versionFile, [Text.Encoding]::UTF8) -match "export const VERSION = '$([regex]::Escape($Version))';")) {
  throw 'version bump did not apply to src/version.mjs'
}
Write-Host '  version bumped in package.json + src/version.mjs'

# 1b. the server must parse before anything is committed (a stray backtick in the
#     INSTRUCTIONS template broke a release once: node --check catches it in 100 ms)
foreach ($file in @($serverFile, $versionFile, (Join-Path $chatgpt 'src\tools.mjs'))) {
  & $node --check $file
  if ($LASTEXITCODE -ne 0) { throw ($file + ' does not parse - release aborted before commit') }
}
Write-Host '  syntax ok'

function Restart-Connector {
  $pidFile = Join-Path $chatgpt 'store\connector.pid'
  if (Test-Path $pidFile) {
    $old = ([IO.File]::ReadAllText($pidFile, [Text.Encoding]::UTF8)).Trim()
    if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'src/main\.mjs' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
  Start-Sleep -Seconds 1
  $p = Start-Process -FilePath $node -ArgumentList '"src/main.mjs"' -WorkingDirectory $chatgpt -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $chatgpt 'logs\connector.log') -RedirectStandardError (Join-Path $chatgpt 'logs\connector-error.log')
  Set-Text $pidFile ([string]$p.Id)
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8787/healthz' -TimeoutSec 2).Content
      Write-Host ('  connector restarted: ' + $health)
      return
    } catch { }
  }
  throw 'connector did not come back after restart'
}

# 1c. restart first, so the smoke suite (which checks the reported version against
#     package.json) runs against the code that was just bumped, not the old process
Restart-Connector

# 2. tests (read-only)
if (-not $SkipTests) {
  Write-Host '  running fields-test.mjs'
  & $node (Join-Path $chatgpt 'scripts\fields-test.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'fields-test failed' }
  try {
    $null = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8787/healthz' -TimeoutSec 3
    Write-Host '  running mcp-smoke.mjs'
    & $node (Join-Path $chatgpt 'scripts\mcp-smoke.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'mcp-smoke failed' }
  } catch [System.Net.WebException] {
    Write-Host '  connector not running, skipping mcp-smoke'
  }
}

# 3. commit + tag
& $git -C $chatgpt add -A
$subject = if ($Message) { $Message } else { "Release $Version" }
& $git -C $chatgpt -c core.pager=cat commit -m ("chore(release): " + $Version + "`n`n" + $subject)
& $git -C $chatgpt tag -a ("v" + $Version) -m ($Version + ' - ' + $subject)

# 4. push
if ($NoPush) { Write-Host '  -NoPush: not pushing'; exit 0 }
if (-not (Test-Path $tokenFile)) { throw "No push token at $tokenFile. Run the GitHub login again (tools\gh-token.txt)." }
$token = (Get-Content $tokenFile -Raw).Trim()
& $git -C $chatgpt remote set-url origin ("https://x-access-token:" + $token + "@github.com/G-Riye/opengym-chatgpt-mcp.git")
& $git -C $chatgpt push origin main --tags
$code = $LASTEXITCODE
# Clash/TUN fake-ip can make github.com unreachable while api.github.com still works,
# so retry once through the local DoH forwarder (tools/github-forward.mjs, gitignored).
$forwarder = Join-Path $chatgpt 'tools\github-forward.mjs'
if ($code -ne 0 -and (Test-Path $forwarder)) {
  Write-Host '  push failed; retrying through the DoH forwarder'
  $fwd = Start-Process -FilePath $node -ArgumentList '"tools/github-forward.mjs" 8899' -WorkingDirectory $chatgpt -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
  & $git -C $chatgpt config http.proxy 'http://127.0.0.1:8899'
  & $git -C $chatgpt push origin main --tags
  $code = $LASTEXITCODE
  & $git -C $chatgpt config --unset http.proxy
  Stop-Process -Id $fwd.Id -Force -ErrorAction SilentlyContinue
}
& $git -C $chatgpt remote set-url origin 'https://github.com/G-Riye/opengym-chatgpt-mcp.git'
if ($code -ne 0) { throw 'git push failed' }
Write-Host "  pushed: https://github.com/G-Riye/opengym-chatgpt-mcp/releases/tag/v$Version"
Write-Host '  done'
exit 0
