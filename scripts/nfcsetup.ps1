# NFC Reader Auto-Setup Script
# Deploy via Microsoft Intune as a PowerShell script (run as System, 64-bit)

$ErrorActionPreference = "Stop"
$installPath = "C:\KioskProgram"
$logFile = "C:\KioskProgram-setup.log"
$repoUrl = "https://github.com/smartsenior-saidan/kioskprogram.git"
$nodeVersion = "v20.11.0"
$nodeInstaller = "$env:TEMP\node-installer.msi"
$nodePath = "C:\Program Files\nodejs\node.exe"
$npmPath = "C:\Program Files\nodejs\npm.cmd"
$gitPath = "C:\Program Files\Git\cmd\git.exe"

function Write-Log {
    param($message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "$timestamp - $message"
    Write-Output $line
    $line | Out-File -FilePath $logFile -Append -Encoding UTF8
}

Write-Log "Starting NFC Reader setup..."

# 1. Install Node.js silently if not installed
if (-not (Test-Path $nodePath)) {
    Write-Log "Downloading Node.js $nodeVersion..."
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-x64.msi" -OutFile $nodeInstaller -UseBasicParsing
    Write-Log "Installing Node.js..."
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /qn /norestart" -Wait
    Write-Log "Node.js installed"
} else {
    Write-Log "Node.js already installed"
}

# 2. Install Git silently if not installed
if (-not (Test-Path $gitPath)) {
    Write-Log "Downloading Git..."
    $gitInstaller = "$env:TEMP\git-installer.exe"
    Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.43.0.windows.1/Git-2.43.0-64-bit.exe" -OutFile $gitInstaller -UseBasicParsing
    Write-Log "Installing Git..."
    Start-Process $gitInstaller -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP-" -Wait
    Write-Log "Git installed"
} else {
    Write-Log "Git already installed"
}

# 3. Clone or update repo — remove folder first if it exists but isn't a git repo
if (Test-Path "$installPath\.git") {
    Write-Log "Updating repository..."
    & $gitPath -C $installPath pull 2>&1 | ForEach-Object { Write-Log $_ }
} else {
    if (Test-Path $installPath) {
        Write-Log "Removing existing folder before clone..."
        Remove-Item -Path $installPath -Recurse -Force
    }
    Write-Log "Cloning repository..."
    & $gitPath clone $repoUrl $installPath 2>&1 | ForEach-Object { Write-Log $_ }
}

# 4. Install npm packages
Write-Log "Installing npm packages..."
Push-Location $installPath
& $npmPath install
Pop-Location

# 5. Ensure nfc folder exists then create VBScript to run node silently
$nfcDir = "$installPath\nfc"
if (-not (Test-Path $nfcDir)) {
    New-Item -ItemType Directory -Path $nfcDir -Force | Out-Null
}

$vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\Program Files\nodejs\node.exe"" C:\KioskProgram\nfc\read.js", 0, False
"@
$vbsContent | Out-File -FilePath "$nfcDir\start-nfc.vbs" -Encoding ASCII
Write-Log "Created start-nfc.vbs"

# 6. Register Scheduled Task to run NFC reader at every user login
$taskAction = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument "`"$nfcDir\start-nfc.vbs`""

$taskTrigger = New-ScheduledTaskTrigger -AtLogOn

$taskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit 0 `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$taskPrincipal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -RunLevel Highest

Register-ScheduledTask `
    -TaskName "SmartSenior-NFCReader" `
    -Action $taskAction `
    -Trigger $taskTrigger `
    -Settings $taskSettings `
    -Principal $taskPrincipal `
    -Force

Write-Log "Scheduled task registered"
Write-Log "Setup complete!"
