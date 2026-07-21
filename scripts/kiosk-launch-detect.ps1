# Kiosk Launch — Win32 app CUSTOM DETECTION script.
# Use this as the detection rule for the "SmartSenior Kiosk Launch" Win32 app
# (Intune: Detection rules -> Rules format -> "Use a custom detection script").
#
# This REPLACES the old registry-marker detection rule
# (HKLM\SOFTWARE\SmartSenior\KioskLaunch Version = 1.0.0). That marker was
# written in a finally block no matter what, so a half-failed install still
# reported "installed" and Intune never retried it — the root cause of tablets
# ending up with Edge but no NFC. This script reports "installed" only when the
# kiosk is ACTUALLY functional, so Intune:
#   * retries the install on any tablet where it silently failed, and
#   * re-runs it automatically if a working tablet later drifts (task disabled,
#     Python removed by a factory reset, etc.).
# i.e. the app self-heals through Intune's normal app engine — no separate
# Remediation required.
#
# Win32 custom-detection exit semantics (NOTE: opposite of a Remediation script):
#   exit 0 + text on STDOUT  = DETECTED     (installed / healthy -> do nothing)
#   exit 1 (or empty STDOUT) = NOT DETECTED (Intune (re)runs the install)
#
# Deploy the app as: install context = System, 64-bit.

$python   = "C:\Program Files\Python311\python.exe"
$reader   = "C:\KioskProgram\nfc\kiosk_reader.py"
$nfcTask  = "SmartSenior-NFCReader"
$edgeTask = "SmartSenior-EdgeKiosk"

$problems = @()

# --- NFC half ---------------------------------------------------------------
if (-not (Test-Path $python)) { $problems += "Python missing" }
if (-not (Test-Path $reader)) { $problems += "reader script missing" }

$t = Get-ScheduledTask -TaskName $nfcTask -ErrorAction SilentlyContinue
if (-not $t)                       { $problems += "$nfcTask not registered" }
elseif ($t.State -eq "Disabled")   { $problems += "$nfcTask disabled" }

# Deep check: the daemon's key deps actually import (catches a half-broken pip
# install that a file-existence check would miss). Only if Python is present.
if (Test-Path $python) {
    $probe = & $python -c "import smartcard, ndef, websocket, requests, serial, pynput" 2>&1
    if ($LASTEXITCODE -ne 0) { $problems += "python deps not importable" }
}

# --- Edge auto-launch half --------------------------------------------------
$e = Get-ScheduledTask -TaskName $edgeTask -ErrorAction SilentlyContinue
if (-not $e)                       { $problems += "$edgeTask not registered" }
elseif ($e.State -eq "Disabled")   { $problems += "$edgeTask disabled" }

if ($problems.Count -gt 0) {
    # NOT DETECTED — Intune will (re)run the install command to repair.
    # (Write nothing to STDOUT; the non-zero exit is what signals not-detected.)
    exit 1
}

# DETECTED — text on STDOUT + exit 0 tells Intune the app is installed/healthy.
Write-Output "Kiosk Launch healthy: NFC daemon + Edge task present and functional"
exit 0
