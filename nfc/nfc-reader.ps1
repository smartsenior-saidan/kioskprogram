# SmartSenior NFC Reader (pure PowerShell, no dependencies)
# Talks to the ACR122U directly through the built-in Windows PC/SC API (winscard.dll).
# No Node.js, no Python, no native modules, no compiling.
#
# Behaviour:
#   - Tap an NFC card holding an NDEF URI  -> opens that URL in the default browser
#   - Remove the card                      -> after 5s, opens the tenant home page
#   - Home URL read from C:\ProgramData\SmartSenior\config.json ("homeUrl")

$ErrorActionPreference = "Stop"

$RedirectDelaySeconds = 5
$ConfigPath           = "C:\ProgramData\SmartSenior\config.json"
$FallbackHome         = "https://kiosk.saidans.org"
$LogPath              = "C:\KioskProgram\nfc\reader.log"

function Write-Log {
    param($message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $message"
    Write-Host $line
    try { $line | Out-File -FilePath $LogPath -Append -Encoding UTF8 } catch {}
}

function Get-HomeUrl {
    try {
        $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ($cfg.homeUrl) { return $cfg.homeUrl }
    } catch {}
    return $FallbackHome
}

function Open-Url {
    param($url)
    try { Start-Process $url } catch { Write-Log "Failed to open $url : $_" }
}

# --- PC/SC interop (winscard.dll) -------------------------------------------
Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;

public class PCSC {
    [StructLayout(LayoutKind.Sequential)]
    public struct SCARD_IO_REQUEST {
        public uint dwProtocol;
        public int  cbPciLength;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SCARD_READERSTATE {
        public string szReader;
        public IntPtr pvUserData;
        public uint   dwCurrentState;
        public uint   dwEventState;
        public uint   cbAtr;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 36)]
        public byte[] rgbAtr;
    }

    [DllImport("winscard.dll")]
    public static extern int SCardEstablishContext(uint dwScope, IntPtr r1, IntPtr r2, out IntPtr phContext);

    [DllImport("winscard.dll")]
    public static extern int SCardReleaseContext(IntPtr hContext);

    [DllImport("winscard.dll", CharSet = CharSet.Unicode, EntryPoint = "SCardListReadersW")]
    public static extern int SCardListReaders(IntPtr hContext, string mszGroups, char[] mszReaders, ref int pcchReaders);

    [DllImport("winscard.dll", CharSet = CharSet.Unicode, EntryPoint = "SCardConnectW")]
    public static extern int SCardConnect(IntPtr hContext, string szReader, uint dwShareMode, uint dwPreferredProtocols, out IntPtr phCard, out uint pdwActiveProtocol);

    [DllImport("winscard.dll")]
    public static extern int SCardDisconnect(IntPtr hCard, uint dwDisposition);

    [DllImport("winscard.dll")]
    public static extern int SCardTransmit(IntPtr hCard, ref SCARD_IO_REQUEST pioSendPci, byte[] pbSendBuffer, int cbSendLength, IntPtr pioRecvPci, byte[] pbRecvBuffer, ref int pcbRecvLength);

    [DllImport("winscard.dll", CharSet = CharSet.Unicode, EntryPoint = "SCardGetStatusChangeW")]
    public static extern int SCardGetStatusChange(IntPtr hContext, int dwTimeout, [In, Out] SCARD_READERSTATE[] rgReaderStates, int cReaders);
}
"@

# PC/SC constants
$SCARD_SCOPE_SYSTEM    = 2
$SCARD_SHARE_SHARED    = 2
$SCARD_PROTOCOL_T0T1   = 3
$SCARD_LEAVE_CARD      = 0
$SCARD_STATE_PRESENT   = 0x20
$SCARD_S_SUCCESS       = 0
$SCARD_E_TIMEOUT       = [int]0x8010000A

function Get-ReaderName {
    param([IntPtr]$ctx)
    $len = 0
    $r = [PCSC]::SCardListReaders($ctx, $null, $null, [ref]$len)
    if ($r -ne 0 -or $len -le 0) { return $null }
    $buf = New-Object char[] $len
    $r = [PCSC]::SCardListReaders($ctx, $null, $buf, [ref]$len)
    if ($r -ne 0) { return $null }
    $names = (-join $buf) -split "`0" | Where-Object { $_ -ne "" }
    if ($names.Count -gt 0) { return $names[0] } else { return $null }
}

function Read-CardUrl {
    param([IntPtr]$ctx, [string]$readerName)

    $hCard = [IntPtr]::Zero
    $proto = 0
    $r = [PCSC]::SCardConnect($ctx, $readerName, $SCARD_SHARE_SHARED, $SCARD_PROTOCOL_T0T1, [ref]$hCard, [ref]$proto)
    if ($r -ne 0) { return $null }

    try {
        $send = New-Object PCSC+SCARD_IO_REQUEST
        $send.dwProtocol  = $proto
        $send.cbPciLength = 8

        $data = New-Object System.Collections.Generic.List[byte]
        # Read 128 bytes from the card starting at page 4 (16 bytes per read).
        for ($i = 0; $i -lt 8; $i++) {
            $page = [byte](4 + $i * 4)
            $apdu = [byte[]](0xFF, 0xB0, 0x00, $page, 0x10)  # ACR122U read-binary pseudo-APDU
            $recv = New-Object byte[] 258
            $recvLen = $recv.Length
            $t = [PCSC]::SCardTransmit($hCard, [ref]$send, $apdu, $apdu.Length, [IntPtr]::Zero, $recv, [ref]$recvLen)
            if ($t -ne 0 -or $recvLen -lt 2) { break }
            $dataLen = $recvLen - 2
            if ($dataLen -gt 0) { for ($j = 0; $j -lt $dataLen; $j++) { $data.Add($recv[$j]) } }
            if ($recv[$recvLen - 2] -ne 0x90) { break }  # SW1 != 0x90 -> stop
        }
        return (ConvertFrom-Ndef $data.ToArray())
    } finally {
        [PCSC]::SCardDisconnect($hCard, $SCARD_LEAVE_CARD) | Out-Null
    }
}

function ConvertFrom-Ndef {
    param([byte[]]$bytes)
    if ($bytes.Length -lt 2)        { return $null }
    if ($bytes[0] -ne 0x03)         { return $null }   # not an NDEF Message TLV
    $ndefLen = [int]$bytes[1]
    if ($ndefLen -lt 5)             { return $null }
    if ($bytes.Length -lt 2 + $ndefLen) { $ndefLen = $bytes.Length - 2 }
    $rec = $bytes[2..(2 + $ndefLen - 1)]
    if ($rec.Length -lt 5)          { return $null }
    if ($rec[3] -ne 0x55)           { return $null }   # type 'U' = URI record

    $prefixes = @('', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:')
    $code = [int]$rec[4]
    $prefix = if ($code -lt $prefixes.Length) { $prefixes[$code] } else { '' }
    $urlBytes = $rec[5..($rec.Length - 1)]
    # Build the URL byte-by-byte, stopping at a null or NDEF terminator (0xFE).
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $urlBytes) {
        if ($b -eq 0x00 -or $b -eq 0xFE) { break }
        [void]$sb.Append([char]$b)
    }
    $urlPart = $sb.ToString().Trim()
    if ($urlPart -eq '') { return $null }
    return $prefix + $urlPart
}

# --- Main loop ---------------------------------------------------------------
Write-Log "NFC reader starting..."

$ctx = [IntPtr]::Zero
$r = [PCSC]::SCardEstablishContext($SCARD_SCOPE_SYSTEM, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$ctx)
if ($r -ne 0) {
    Write-Log "SCardEstablishContext failed ($r). Is the Smart Card service running?"
    exit 1
}

# Wait for the reader to appear (USB driver may take a moment after login).
$readerName = $null
while (-not $readerName) {
    $readerName = Get-ReaderName $ctx
    if (-not $readerName) { Start-Sleep -Seconds 2 }
}
Write-Log "Using reader: $readerName"

# Reader-state array for SCardGetStatusChange
$st = New-Object PCSC+SCARD_READERSTATE
$st.szReader        = $readerName
$st.dwCurrentState  = 0
$st.rgbAtr          = New-Object byte[] 36
$states = New-Object 'PCSC+SCARD_READERSTATE[]' 1
$states[0] = $st

$cardPresent = $false
$removeTime  = $null

while ($true) {
    $ret = [PCSC]::SCardGetStatusChange($ctx, 400, $states, 1)

    if ($ret -eq $SCARD_S_SUCCESS) {
        $event   = $states[0].dwEventState
        $present = ($event -band $SCARD_STATE_PRESENT) -ne 0

        if ($present -and -not $cardPresent) {
            $cardPresent = $true
            $removeTime  = $null
            Start-Sleep -Milliseconds 50   # let the card settle on the reader
            $url = Read-CardUrl $ctx $readerName
            if ($url) {
                Write-Log "Card tapped -> $url"
                Open-Url $url
            } else {
                Write-Log "Card tapped but no NDEF URL found"
            }
        }
        elseif (-not $present -and $cardPresent) {
            $cardPresent = $false
            $removeTime  = Get-Date
            Write-Log "Card removed -> home in $RedirectDelaySeconds s"
        }

        # Copy event state into current state for the next comparison
        $s = $states[0]; $s.dwCurrentState = $event; $states[0] = $s
    }
    elseif ($ret -eq $SCARD_E_TIMEOUT) {
        # No change within the timeout window — normal.
    }
    else {
        # Reader likely unplugged/changed — try to re-acquire it.
        Start-Sleep -Seconds 2
        $newName = Get-ReaderName $ctx
        if ($newName) {
            $readerName = $newName
            $s = $states[0]; $s.szReader = $readerName; $s.dwCurrentState = 0; $states[0] = $s
        }
    }

    # Pending home redirect after card removal
    if ($null -ne $removeTime) {
        if (((Get-Date) - $removeTime).TotalSeconds -ge $RedirectDelaySeconds) {
            $homeUrl = Get-HomeUrl
            Write-Log "Redirecting to home -> $homeUrl"
            Open-Url $homeUrl
            $removeTime = $null
        }
    }
}
