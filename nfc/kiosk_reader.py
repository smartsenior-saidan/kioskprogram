#!/usr/bin/env python3
"""
SmartSenior Kiosk - NFC/QR Reader
Connects to the already-open Edge window and navigates it when a card is tapped.
Does NOT launch Edge - your existing auto-execute script handles that.
"""

import os
import sys
import time
import json
import logging
import threading
from pathlib import Path

import requests
import websocket
from smartcard.System import readers
import ndef
from pynput import keyboard

__version__ = "1.0.0"

# ── Settings ─────────────────────────────────────────────────────────────────

DEBUG_PORT   = "9222"
CONFIG_PATH  = Path(r"C:\ProgramData\SmartSenior\config.json")
FALLBACK_HOME = "https://kiosk.saidans.org"
CARD_REMOVE_DELAY = 5   # seconds before home redirect after card removed
QR_TIMEOUT        = 60  # seconds before home redirect after QR scan

# ── Logging ───────────────────────────────────────────────────────────────────

LOG_DIR = Path(r"C:\KioskProgram\nfc")
try:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    LOG_PATH = LOG_DIR / "reader.log"
except Exception:
    LOG_PATH = Path("reader.log")

logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)

def log(msg):
    print(msg)
    logging.info(msg)

def log_err(msg):
    print(msg, file=sys.stderr)
    logging.error(msg)

# ── Config ────────────────────────────────────────────────────────────────────

def get_home_url():
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return cfg.get("homeUrl", FALLBACK_HOME)
    except Exception:
        return FALLBACK_HOME

# ── Edge DevTools (navigate the existing window) ──────────────────────────────

ws_conn = None

def _get_ws_url():
    """Wait up to 30s for Edge to expose its debug port, then return the WS URL."""
    for _ in range(60):
        try:
            targets = requests.get(
                f"http://127.0.0.1:{DEBUG_PORT}/json", timeout=1
            ).json()
            for t in targets:
                if t.get("type") == "page" and "webSocketDebuggerUrl" in t:
                    return t["webSocketDebuggerUrl"].replace(
                        "://localhost:", "://127.0.0.1:"
                    )
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
        targets = requests.get(
            f"http://127.0.0.1:{DEBUG_PORT}/json", timeout=1
        ).json()
        pages = [t for t in targets if t.get("type") == "page"]
        for p in pages[1:]:
            url = p.get("url", "")
            if home in url:
                continue
            if p.get("id"):
                requests.get(
                    f"http://127.0.0.1:{DEBUG_PORT}/json/close/{p['id']}", timeout=1
                )
                log(f"Closed extra tab: {url[:60]}")
    except Exception:
        pass

def _tab_guard_loop():
    while True:
        time.sleep(3)
        _close_extra_tabs()

# ── NFC reader ────────────────────────────────────────────────────────────────

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
                _ws_send({"id": 9, "method": "Runtime.evaluate",
                          "params": {"expression": "1"}})
                last_ping = time.time()
            time.sleep(0.01)

def _wait_removal(reader):
    stable = 0
    while True:
        try:
            c = reader.createConnection()
            c.connect()
            stable = 0
            time.sleep(0.1)
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
                remove_timer.cancel()
                remove_timer = None

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
            log_err(f"NFC loop error: {e}")
            time.sleep(1)

# ── QR scanner (HID keyboard mode) ───────────────────────────────────────────

qr_buffer         = []
qr_last_key_time  = 0.0
qr_timer          = None

def _on_key(key):
    global qr_buffer, qr_last_key_time, qr_timer
    now = time.time()
    if now - qr_last_key_time > 0.5:
        qr_buffer = []
    qr_last_key_time = now
    try:
        if key == keyboard.Key.enter:
            scanned = "".join(qr_buffer)
            qr_buffer = []
            if scanned.startswith("http://") or scanned.startswith("https://"):
                log(f"QR scanned: {scanned}")
                navigate(scanned)
                if qr_timer:
                    qr_timer.cancel()
                home = get_home_url()
                qr_timer = threading.Timer(
                    QR_TIMEOUT, lambda h=home: navigate(h)
                )
                qr_timer.daemon = True
                qr_timer.start()
        elif hasattr(key, "char") and key.char:
            qr_buffer.append(key.char)
    except Exception:
        pass

# ── Exit hotkey Ctrl+Shift+Q ──────────────────────────────────────────────────

def _exit():
    log("Exit hotkey pressed")
    os._exit(0)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    log(f"SmartSenior NFC Reader v{__version__} starting")
    log(f"Home URL: {get_home_url()}")

    # Connect to already-open Edge
    _connect()

    # Tab guard: close any extra tabs that open
    threading.Thread(target=_tab_guard_loop, daemon=True).start()

    # QR scanner (HID keyboard emulation)
    keyboard.Listener(on_press=_on_key, daemon=True).start()
    log("QR listener started")

    # Exit hotkey
    keyboard.GlobalHotKeys({"<ctrl>+<shift>+q": _exit}, daemon=True).start()
    log("Exit hotkey: Ctrl+Shift+Q")

    # NFC loop (or QR-only if no reader)
    nfc_reader = _detect_reader()
    try:
        if nfc_reader:
            run_nfc_loop(nfc_reader)
        else:
            log("No NFC reader - QR-only mode")
            while True:
                time.sleep(30)
                _ws_send({"id": 9, "method": "Runtime.evaluate",
                          "params": {"expression": "1"}})
    except KeyboardInterrupt:
        log("Stopped")

if __name__ == "__main__":
    main()
