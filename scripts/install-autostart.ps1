param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'Start-Gym-AI.ps1'
$taskName = 'openGym ChatGPT Connector'
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'openGym-ChatGPT.vbs'

if ($Remove) {
  try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop; Write-Host 'Removed scheduled task.' } catch { }
  if (Test-Path -LiteralPath $vbs) { Remove-Item -LiteralPath $vbs -Force; Write-Host 'Removed Startup shortcut.' }
  exit 0
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $startScript + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Start openGym and the local ChatGPT MCP connector at sign-in.' -Force | Out-Null
  Write-Host 'Installed scheduled task:' $taskName
  Write-Host 'It starts openGym, the connector and the saved tunnel at every sign-in.'
  exit 0
} catch {
  Write-Host ('Scheduled task failed: ' + $_.Exception.Message)
  Write-Host 'Falling back to the Startup folder launcher.'
  $content = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$startScript""", 0, False
"@
  [IO.File]::WriteAllText($vbs, $content, (New-Object Text.UTF8Encoding($false)))
  Write-Host ('Created ' + $vbs)
  exit 0
}
