# Set Tenant Config Script
# Deploy via Intune per tenant device group.
# Duplicate this file and change SITE_NAME for each tenant.
#
# This script does two things:
#   1. Writes C:\ProgramData\SmartSenior\config.json  (used by the NFC reader for home redirect)
#   2. Registers a login task that starts Edge fullscreen on the correct tenant URL
#      (so the kiosk website loads the right background + database)

$siteName   = "kodaira_memorial"   # <-- CHANGE THIS PER TENANT
$homeUrl    = "https://kiosk.saidans.org?site=$siteName"
$edgePath   = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# ── 1. Write config.json ───────────────────────────────────────────────────────

$configDir  = "C:\ProgramData\SmartSenior"
$configFile = "$configDir\config.json"

if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

@{
    site    = $siteName
    homeUrl = $homeUrl
} | ConvertTo-Json | Out-File -FilePath $configFile -Encoding UTF8

Write-Output "Config written: $configFile"

# ── 2. Register Edge startup task ─────────────────────────────────────────────
# Starts Edge fullscreen on the tenant home page at every user login.
# --remote-debugging-port=9222 lets the NFC reader navigate the existing window
# instead of opening new windows on every card tap.
# --user-data-dir is required when using the remote debugging port.

$edgeArgs = "--remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222 --user-data-dir=`"C:\EdgeKiosk`" --start-fullscreen `"$homeUrl`""

$action = New-ScheduledTaskAction -Execute $edgePath -Argument $edgeArgs

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit 0

$principal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -RunLevel Highest

Register-ScheduledTask `
    -TaskName "SmartSenior-EdgeKiosk" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force

Write-Output "Edge kiosk task registered for tenant: $siteName"
Write-Output "Edge will open: $homeUrl"
