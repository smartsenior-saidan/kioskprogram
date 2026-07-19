# Kiosk Launch Install Script
# Install command for the "SmartSenior Kiosk Launch" Win32 app: sets up the
# NFC/QR reader daemon and registers the Edge kiosk auto-launch task. This
# script is identical across every tenant device — it reads the tenant's home
# URL from C:\ProgramData\SmartSenior\config.json rather than hardcoding it,
# so only that small per-tenant config script needs to differ per site.
#
# Autologin signs in the shared kiosk account (kiosk@smartsenior.onmicrosoft.com)
# automatically on every boot. The password is stored via the LSA secret store
# (see lib-lsa-secret.ps1) rather than the plaintext Winlogon registry value.
#
# DESIGN NOTE — why nothing here is allowed to throw:
# This runs under Intune's SYSTEM account. If any step throws (a missing driver
# file, a vendor installer that hangs in session 0, an LSA hiccup) the whole
# script would die before writing the detection marker in the finally block, and
# Intune reports "not detected" (0x87D1041C) even though the important work ran.
# So every step is best-effort: it logs a WARNING and continues instead of
# aborting. The detection marker is written in a finally block so it is reached
# no matter what happens above. Individual failures are recoverable — the reader
# daemon re-runs from its own scheduled task, and drivers can be reinstalled.

$ErrorActionPreference = "Stop"
$logFile = "C:\KioskProgram-launch-install.log"

function Write-Log {
    param($message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $message"
    Write-Output $line
    $line | Out-File -FilePath $logFile -Append -Encoding UTF8
}

# Runs a driver installer as a best-effort step: verifies the payload exists,
# launches it, and enforces a timeout so a vendor installer that hangs under the
# SYSTEM account (no interactive desktop) can't block the whole install forever.
# Never throws — logs a WARNING and returns on any problem.
function Invoke-DriverInstall {
    param(
        [string]  $Name,        # friendly name for the log
        [string]  $Exe,         # executable to launch (e.g. the .exe or msiexec.exe)
        # NOTE: never name this $Args — that collides with PowerShell's reserved
        # automatic $args variable, which silently arrives EMPTY here, so
        # Start-Process throws "ArgumentList is null or empty" and every driver
        # install is skipped. Use $ArgList.
        [string[]]$ArgList,     # arguments for that executable
        [string]  $VerifyPath,  # file whose presence gates the install (the driver payload)
        [int]     $TimeoutSec = 180
    )
    try {
        if ($VerifyPath -and -not (Test-Path $VerifyPath)) {
            Write-Log "WARNING: $Name payload not found at $VerifyPath — skipping (was the drivers folder included in the package?)"
            return
        }
        $proc = Start-Process -FilePath $Exe -ArgumentList $ArgList -PassThru
        Wait-Process -Id $proc.Id -Timeout $TimeoutSec -ErrorAction SilentlyContinue
        if (-not $proc.HasExited) {
            Write-Log "WARNING: $Name install still running after ${TimeoutSec}s — killing and continuing"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            return
        }
        if ($proc.ExitCode -ne 0) {
            Write-Log "WARNING: $Name install exited with code $($proc.ExitCode)"
        } else {
            Write-Log "$Name installed"
        }
    } catch {
        Write-Log "WARNING: $Name install failed: $($_.Exception.Message)"
    }
}

Write-Log "Starting Kiosk Launch install..."

try {
    # 1. Install the QR scanner's USB-COM driver (DENSO WAVE Active USB-COM
    # Port). A factory reset wipes this, and without it the scanner never shows
    # up as a COM port at all, so the reader daemon has nothing to read from.
    # -S runs it fully silently — documented vendor option, see
    # drivers\ActiveUSBCOM_2207_J\ActiveUSBCOM_UsersGuide.pdf section 2.1.5.
    Invoke-DriverInstall -Name "QR scanner driver" `
        -Exe "$PSScriptRoot\drivers\ActiveUSBCOM_2207_J\Install.exe" `
        -ArgList @("-S") `
        -VerifyPath "$PSScriptRoot\drivers\ActiveUSBCOM_2207_J\Install.exe"

    # 2. Install the Elecom MR-ICA001BK (CIR315) NFC reader driver. Same
    # situation as the QR driver — a factory reset wipes it, and without it the
    # reader never shows up over PC/SC at all. MSI packages have a standard
    # silent-install flag (/quiet) — no vendor-specific guessing needed here.
    $elecomMsi = "$PSScriptRoot\drivers\ELECOM_MR-ICA001_CIR315\Package\CIR315DriverInstallerx64.msi"
    Invoke-DriverInstall -Name "Elecom NFC reader driver" `
        -Exe "msiexec.exe" `
        -ArgList @("/i", "`"$elecomMsi`"", "/quiet", "/norestart") `
        -VerifyPath $elecomMsi

    # 3. Install the I-O DATA USB-NFC3 "ぴタッチ" NFC reader driver (AB Circle
    # CIR215 chipset — same maker as the Elecom's CIR315, same MSI layout). The
    # vendor's own SetupSilent.bat just runs its installer with /quiet, so
    # invoking the x64 MSI directly matches their supported silent path.
    $nfc3Msi = "$PSScriptRoot\drivers\IODATA_USB-NFC3\Package\ABCDriverInstallerx64.msi"
    Invoke-DriverInstall -Name "USB-NFC3 reader driver" `
        -Exe "msiexec.exe" `
        -ArgList @("/i", "`"$nfc3Msi`"", "/quiet", "/norestart") `
        -VerifyPath $nfc3Msi

    # 4. NFC/QR reader daemon setup — delegates to the existing, already-tested
    # script rather than duplicating its embedded Python payload here. This step
    # does the most failure-prone work (Python download, pip, process control)
    # and runs differently under Intune's SYSTEM context than when run by hand.
    # nfcsetup.ps1 logs the full error to C:\KioskProgram-setup.log for diagnosis.
    try {
        & "$PSScriptRoot\nfcsetup.ps1"
        Write-Log "NFC/QR setup complete"
    } catch {
        Write-Log "WARNING: nfcsetup.ps1 failed: $($_.Exception.Message) — see C:\KioskProgram-setup.log"
    }

    # 5. Register the Edge kiosk auto-launch scheduled task. Reads homeUrl from
    # config.json (written separately by the per-tenant config script) instead of
    # a hardcoded site name, so this script stays the same for every tenant. If
    # the config isn't present yet we log and skip rather than throwing.
    $configFile = "C:\ProgramData\SmartSenior\config.json"
    $homeUrl = $null
    if (Test-Path $configFile) {
        $homeUrl = (Get-Content $configFile -Raw | ConvertFrom-Json).homeUrl
    }

    if ($homeUrl) {
        try {
            $edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
            # --remote-debugging-port lets the NFC/QR reader navigate the existing window
            # instead of opening a new one on every tap/scan (same convention as before).
            $edgeArgs = "--remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222 --user-data-dir=`"C:\EdgeKiosk`" --start-fullscreen `"$homeUrl`""

            $action    = New-ScheduledTaskAction -Execute $edgePath -Argument $edgeArgs
            $trigger   = New-ScheduledTaskTrigger -AtLogOn
            $settings  = New-ScheduledTaskSettingsSet `
                -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
            $principal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -RunLevel Highest

            Register-ScheduledTask `
                -TaskName "SmartSenior-EdgeKiosk" `
                -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force

            Write-Log "Edge kiosk task registered, will open: $homeUrl"
        } catch {
            Write-Log "WARNING: Edge kiosk task registration failed: $($_.Exception.Message)"
        }
    } else {
        Write-Log "WARNING: config.json/homeUrl not found at $configFile — skipped Edge kiosk task (run the per-tenant config script, then reinstall)"
    }

    # 6. Configure autologin for the shared kiosk account.
    try {
        . "$PSScriptRoot\lib-lsa-secret.ps1"

        $kioskUser = "kiosk@smartsenior.onmicrosoft.com"
        $kioskPass = "Nokotsudo2525"

        [LsaSecret]::SetSecret("DefaultPassword", $kioskPass)

        $winlogonPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
        New-ItemProperty -Path $winlogonPath -Name "AutoAdminLogon"    -Value "1" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $winlogonPath -Name "DefaultUserName"   -Value $kioskUser -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $winlogonPath -Name "DefaultDomainName" -Value "" -PropertyType String -Force | Out-Null
        # Deliberately not setting DefaultPassword here — Windows falls back to the
        # LSA secret above when this value is absent, avoiding a plaintext password
        # sitting in the registry.
        Remove-ItemProperty -Path $winlogonPath -Name "DefaultPassword" -ErrorAction SilentlyContinue

        Write-Log "Autologin configured for $kioskUser"
    } catch {
        Write-Log "WARNING: autologin configuration failed: $($_.Exception.Message)"
    }
}
finally {
    # 7. Write the Intune detection marker so this app shows as installed. This
    # lives in a finally block so it is ALWAYS reached, even if something above
    # threw unexpectedly — that guarantees Intune never reports "not detected"
    # (0x87D1041C) on an install whose script actually ran.
    #
    # Use reg.exe with /reg:64 rather than the PowerShell registry provider: the
    # Intune install command can run as 32-bit PowerShell, which silently
    # redirects HKLM\SOFTWARE writes into WOW6432Node — where the 64-bit detection
    # rule can't see them. /reg:64 forces the 64-bit hive regardless of bitness.
    & reg.exe add "HKLM\SOFTWARE\SmartSenior\KioskLaunch" /v Version /t REG_SZ /d "1.0.0" /f /reg:64 | Out-Null

    Write-Log "Kiosk Launch install complete!"
}