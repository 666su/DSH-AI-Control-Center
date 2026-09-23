# ===================================================================
#  Enable CPU / GPU temperature monitoring for DSH Control Center
#    1) configure LibreHardwareMonitor web server on 127.0.0.1:8085
#    2) register it as an auto-start scheduled task (highest privilege)
#    3) restart the DSHControlCenter service so new code takes effect
#    4) verify LHM -> backend -> database end to end
#
#  Just double-click scripts\enable-temp-monitor.bat (it self-elevates).
# ===================================================================

$ErrorActionPreference = "Continue"

# ---- self-elevate ----
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "Requesting administrator rights..." -ForegroundColor Yellow
  try {
    Start-Process powershell -Verb RunAs -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-NoExit", "-File", "`"$PSCommandPath`""
    )
  } catch {
    Write-Host "[ERROR] Elevation was cancelled." -ForegroundColor Red
    Read-Host "Press Enter to close"
  }
  exit
}

$Root    = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LhmDir  = "E:\app\LibreHardwareMonitor"
$LhmExe  = Join-Path $LhmDir "LibreHardwareMonitor.exe"
$LhmCfg  = Join-Path $LhmDir "LibreHardwareMonitor.config"
$TaskName = "LibreHardwareMonitor"
$Hosts   = "$env:SystemRoot\System32\drivers\etc\hosts"

function Step($n, $msg) { Write-Host ""; Write-Host ("[{0}/5] {1}" -f $n, $msg) -ForegroundColor Cyan }
function Ok($msg)       { Write-Host ("      " + $msg) -ForegroundColor Green }
function Warn($msg)     { Write-Host ("      " + $msg) -ForegroundColor Yellow }
function Bad($msg)      { Write-Host ("      " + $msg) -ForegroundColor Red }

Write-Host ""
Write-Host "=== DSH Control Center : enable temperature monitoring ===" -ForegroundColor White

if (-not (Test-Path $LhmExe)) {
  Bad "Not found: $LhmExe"
  Bad "Install the LibreHardwareMonitor release build there first."
  Read-Host "Press Enter to close"
  exit 1
}

# ---- 1) LHM config ----
Step 1 "Writing LibreHardwareMonitor config (auto web server, loopback only)"
try {
  $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="runWebServerMenuItem" value="true" />
    <add key="listenerIp" value="127.0.0.1" />
    <add key="listenerPort" value="8085" />
    <add key="authenticationEnabled" value="false" />
  </appSettings>
</configuration>
"@
  [System.IO.File]::WriteAllText($LhmCfg, $xml, (New-Object System.Text.UTF8Encoding($false)))
  Ok "written: $LhmCfg"
} catch { Bad "failed: $($_.Exception.Message)" }

# ---- 2) hosts entry ----
Step 2 "Ensuring hosts entry 127.0.0.1 $env:COMPUTERNAME (lets LHM bind to loopback)"
try {
  $hostsText = Get-Content $Hosts -Raw -ErrorAction SilentlyContinue
  $hn = [regex]::Escape($env:COMPUTERNAME)
  if ($hostsText -notmatch "(?m)^\s*127\.0\.0\.1\s+" + $hn + "\s*$") {
    Add-Content -Path $Hosts -Value ("127.0.0.1 " + $env:COMPUTERNAME) -Encoding ASCII
    Ok "added"
  } else {
    Ok "already present"
  }
} catch { Bad "failed: $($_.Exception.Message)" }

# ---- 3) scheduled task ----
Step 3 "Registering scheduled task (AtLogOn, highest privilege)"
try {
  $action    = New-ScheduledTaskAction -Execute $LhmExe -WorkingDirectory $LhmDir
  $trigger   = New-ScheduledTaskTrigger -AtLogOn
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  $userId    = "$env:USERDOMAIN\$env:USERNAME"
  $principal2 = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal2 -Force | Out-Null
  Ok "task registered for $userId"
  Start-ScheduledTask -TaskName $TaskName
  Ok "task started"
} catch { Bad "failed: $($_.Exception.Message)" }

# ---- 4) restart backend ----
Step 4 "Restarting DSHControlCenter service (loads new temperature code)"
try {
  Restart-Service -Name DSHControlCenter -Force -ErrorAction Stop
  Ok "service restarted"
} catch { Bad "failed: $($_.Exception.Message)" }

# ---- 5) verify ----
Step 5 "Verifying (waiting 12s for services to settle)"
Start-Sleep -Seconds 12

function Show($label, $ok, $detail) {
  $tag = if ($ok) { "OK  " } else { "FAIL" }
  $color = if ($ok) { "Green" } else { "Red" }
  Write-Host ("      {0} {1,-15} {2}" -f $tag, $label, $detail) -ForegroundColor $color
}

try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8085/data.json" -UseBasicParsing -TimeoutSec 10
  Show "LHM web server" $true ("HTTP " + $r.StatusCode + ", bytes=" + $r.RawContentLength)
} catch {
  Show "LHM web server" $false $_.Exception.Message
}

try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:3081/api/health" -TimeoutSec 10
  Show "backend" $true ("uptime=" + $h.uptimeSec + "s")
} catch {
  Show "backend" $false $_.Exception.Message
}

try {
  $tok = (Get-Content (Join-Path $Root "config\access-token.txt") -Raw).Trim()
  $s = Invoke-RestMethod -Uri "http://127.0.0.1:3081/api/system/last" -Headers @{ "X-Access-Token" = $tok } -TimeoutSec 10
  if ($null -eq $s.temps) {
    Show "temperature API" $false "field .temps missing - backend still running old code"
  } else {
    $g = $s.temps.gpuC
    $c = $s.temps.cpuC
    $gTxt = if ($null -ne $g) { "$g C" } else { "null" }
    $cTxt = if ($null -ne $c) { "$c C  $($s.cpu.tempLabel)" } else { "null" }
    Show "GPU temp" ($null -ne $g) $gTxt
    Show "CPU temp" ($null -ne $c) $cTxt
    if ($null -eq $c) {
      Warn ""
      Warn "CPU temp is still null. Give LHM ~10 more seconds and refresh the dashboard;"
      Warn "if it stays null, LHM could not read the CPU sensor."
    }
  }
} catch {
  Show "temperature API" $false $_.Exception.Message
}

Write-Host ""
Write-Host "Done. Refresh the control center page to see the new cards and chart." -ForegroundColor White
Write-Host ""
Read-Host "Press Enter to close"