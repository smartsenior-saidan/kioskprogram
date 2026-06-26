# NFC Reader Auto-Setup Script
# Deploy via Microsoft Intune as a PowerShell script (run as System, 64-bit).
# Timeout: 3600 seconds
# Self-contained: embeds the Python reader script, no GitHub download needed.

$ErrorActionPreference = "Stop"
$installPath = "C:\KioskProgram"
$logFile     = "C:\KioskProgram-setup.log"
$pythonExe   = "C:\Program Files\Python311\python.exe"
$pythonwExe  = "C:\Program Files\Python311\pythonw.exe"
$pipExe      = "C:\Program Files\Python311\Scripts\pip.exe"
$nfcDir      = "$installPath\nfc"
$scriptPy    = "$nfcDir\kiosk_reader.py"
$scriptVbs   = "$nfcDir\start-nfc.vbs"

function Write-Log {
    param($message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $message"
    Write-Output $line
    $line | Out-File -FilePath $logFile -Append -Encoding UTF8
}

Write-Log "Starting NFC Reader setup..."

# 1. Stop any existing reader
Stop-ScheduledTask -TaskName "SmartSenior-NFCReader" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*kiosk_reader*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 2. Create install folder
if (-not (Test-Path $nfcDir)) {
    New-Item -ItemType Directory -Path $nfcDir -Force | Out-Null
}

# 3. Write the Python reader script to disk (embedded - no GitHub needed)
Write-Log "Writing kiosk_reader.py..."
@'
#!/usr/bin/env python3
import os, sys, time, json, logging, threading
from pathlib import Path
import requests, websocket
from smartcard.System import readers
import ndef
from pynput import keyboard

__version__ = "1.0.0"

DEBUG_PORT        = "9222"
CONFIG_PATH       = Path(r"C:\ProgramData\SmartSenior\config.json")
FALLBACK_HOME     = "https://kiosk.saidans.org"
CARD_REMOVE_DELAY = 5
QR_TIMEOUT        = 60

LOG_DIR = Path(r"C:\KioskProgram\nfc")
try:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    LOG_PATH = LOG_DIR / "reader.log"
except Exception:
    LOG_PATH = Path("reader.log")

logging.basicConfig(
    filename=str(LOG_PATH), level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)

def log(msg):
    print(msg); logging.info(msg)

def log_err(msg):
    print(msg, file=sys.stderr); logging.error(msg)

def get_home_url():
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return cfg.get("homeUrl", FALLBACK_HOME)
    except Exception:
        return FALLBACK_HOME

ws_conn = None

def _get_ws_url():
    for _ in range(60):
        try:
            targets = requests.get(f"http://127.0.0.1:{DEBUG_PORT}/json", timeout=1).json()
            for t in targets:
                if t.get("type") == "page" and "webSocketDebuggerUrl" in t:
                    return t["webSocketDebuggerUrl"].replace("://localhost:", "://127.0.0.1:")
        except Exception:
            pass
        time.sleep(0.5)
    return None

def _connect():
    global ws_conn
    url = _get_ws_url()
    if not url:
        log_err("Cannot reach Edge debug port - is Edge running with --remote-debugging-port=9222?")
        return
    try:
        ws_conn = websocket.create_connection(url, timeout=3)
        log("Connected to Edge")
    except Exception as e:
        log_err(f"WebSocket connect failed: {e}")
        ws_conn = None

def _ws_send(payload):
    global ws_conn
    for attempt in range(2):
        if not ws_conn:
            _connect()
        if not ws_conn:
            continue
        try:
            ws_conn.send(json.dumps(payload))
            ws_conn.recv()
            return True
        except Exception as e:
            log_err(f"WS send failed: {e}")
            ws_conn = None
    return False

def navigate(url):
    if _ws_send({"id": 1, "method": "Page.navigate", "params": {"url": url}}):
        log(f"Navigated -> {url}")
    else:
        log_err(f"Navigation failed for {url}")

def _close_extra_tabs():
    try:
        home = get_home_url().rstrip("/").split("?")[0]
        targets = requests.get(f"http://127.0.0.1:{DEBUG_PORT}/json", timeout=1).json()
        pages = [t for t in targets if t.get("type") == "page"]
        for p in pages[1:]:
            url = p.get("url", "")
            if home in url:
                continue
            if p.get("id"):
                requests.get(f"http://127.0.0.1:{DEBUG_PORT}/json/close/{p['id']}", timeout=1)
                log(f"Closed extra tab: {url[:60]}")
    except Exception:
        pass

def _tab_guard_loop():
    while True:
        time.sleep(3)
        _close_extra_tabs()

def _detect_reader():
    try:
        rdrs = readers()
        for r in rdrs:
            if "ACR" in str(r) or "ACS" in str(r):
                log(f"NFC reader: {r}")
                return r
        log(f"ACR122U not found. Available readers: {[str(r) for r in rdrs]}")
        return None
    except Exception as e:
        log_err(f"NFC detect error: {e}")
        return None

def _read_url(conn):
    try:
        header, sw1, _ = conn.transmit([0xFF, 0xB0, 0x00, 0x04, 0x10])
        if sw1 != 0x90 or header[0] != 0x03:
            return None
        ndef_len = header[1]
        pages = min(((ndef_len + 2 + 3) // 4), 100)
        raw = b""
        for page in range(4, 4 + pages):
            block, sw1, _ = conn.transmit([0xFF, 0xB0, 0x00, page, 0x04])
            if sw1 == 0x90:
                raw += bytes(block)
            else:
                break
        if len(raw) < 2 + ndef_len:
            return None
        for record in ndef.message_decoder(raw[2:2 + ndef_len]):
            if record.type == "urn:nfc:wkt:U":
                return record.iri
        return None
    except Exception as e:
        log_err(f"NDEF read error: {e}")
        return None

def _wait_card(reader):
    conn = reader.createConnection()
    last_ping = time.time()
    while True:
        try:
            conn.connect()
            return conn
        except Exception:
            if time.time() - last_ping > 15:
                _ws_send({"id": 9, "method": "Runtime.evaluate", "params": {"expression": "1"}})
                last_ping = time.time()
            time.sleep(0.01)

def _wait_removal(reader):
    stable = 0
    while True:
        try:
            c = reader.createConnection(); c.connect(); stable = 0; time.sleep(0.1)
        except Exception:
            stable += 1
            if stable >= 5:
                return

def run_nfc_loop(reader):
    remove_timer = None
    log("Waiting for NFC cards...")
    while True:
        try:
            conn = _wait_card(reader)
            log("Card detected")
            if remove_timer:
                remove_timer.cancel(); remove_timer = None
            url = _read_url(conn)
            conn.disconnect()
            if url:
                navigate(url)
            else:
                log("No NDEF URL on card")
            _wait_removal(reader)
            log(f"Card removed - going home in {CARD_REMOVE_DELAY}s")
            home = get_home_url()
            remove_timer = threading.Timer(CARD_REMOVE_DELAY, lambda h=home: navigate(h))
            remove_timer.daemon = True
            remove_timer.start()
        except KeyboardInterrupt:
            raise
        except Exception as e:
            log_err(f"NFC loop error: {e}"); time.sleep(1)

qr_buffer = []; qr_last_key_time = 0.0; qr_timer = None

def _on_key(key):
    global qr_buffer, qr_last_key_time, qr_timer
    now = time.time()
    if now - qr_last_key_time > 0.5:
        qr_buffer = []
    qr_last_key_time = now
    try:
        if key == keyboard.Key.enter:
            scanned = "".join(qr_buffer); qr_buffer = []
            if scanned.startswith("http://") or scanned.startswith("https://"):
                log(f"QR scanned: {scanned}"); navigate(scanned)
                if qr_timer: qr_timer.cancel()
                home = get_home_url()
                qr_timer = threading.Timer(QR_TIMEOUT, lambda h=home: navigate(h))
                qr_timer.daemon = True; qr_timer.start()
        elif hasattr(key, "char") and key.char:
            qr_buffer.append(key.char)
    except Exception:
        pass

def _exit():
    log("Exit hotkey pressed"); os._exit(0)

def main():
    log(f"SmartSenior NFC Reader v{__version__} starting")
    log(f"Home URL: {get_home_url()}")
    _connect()
    threading.Thread(target=_tab_guard_loop, daemon=True).start()
    keyboard.Listener(on_press=_on_key, daemon=True).start()
    log("QR listener started")
    keyboard.GlobalHotKeys({"<ctrl>+<shift>+q": _exit}, daemon=True).start()
    log("Exit hotkey: Ctrl+Shift+Q")
    nfc_reader = _detect_reader()
    try:
        if nfc_reader:
            run_nfc_loop(nfc_reader)
        else:
            log("No NFC reader - QR-only mode")
            while True:
                time.sleep(30)
                _ws_send({"id": 9, "method": "Runtime.evaluate", "params": {"expression": "1"}})
    except KeyboardInterrupt:
        log("Stopped")

if __name__ == "__main__":
    main()
'@ | Out-File -FilePath $scriptPy -Encoding UTF8
Write-Log "kiosk_reader.py written"

# 4. Install Python 3.11 system-wide
if (-not (Test-Path $pythonExe)) {
    Write-Log "Downloading Python 3.11..."
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe" `
        -OutFile "$env:TEMP\python311.exe" -UseBasicParsing
    Write-Log "Installing Python..."
    Start-Process "$env:TEMP\python311.exe" `
        -ArgumentList "/quiet InstallAllUsers=1 PrependPath=1 Include_test=0" -Wait
    Write-Log "Python installed"
} else {
    Write-Log "Python already installed"
}

# 5. Install Python packages (all have pre-built Windows wheels, no compiling needed)
Write-Log "Installing Python packages..."
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + $env:PATH
& $pipExe install --quiet --upgrade requests websocket-client pyscard ndeflib pynput pyserial
Write-Log "Python packages installed"

# 6. Ensure Smart Card service is running
Set-Service -Name SCardSvr -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service -Name SCardSvr -ErrorAction SilentlyContinue

# 7. Create VBScript launcher (runs Python silently, no terminal window)
@"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$pythonwExe"" ""$scriptPy""", 0, False
"@ | Out-File -FilePath $scriptVbs -Encoding ASCII
Write-Log "Created start-nfc.vbs"

# 8. Register scheduled task — runs at every user login
$action    = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$scriptVbs`""
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -RunLevel Highest

Register-ScheduledTask `
    -TaskName "SmartSenior-NFCReader" `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force

Write-Log "Scheduled task registered"
Write-Log "Setup complete!"
