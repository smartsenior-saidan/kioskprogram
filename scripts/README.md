# Kiosk Tablet Scripts

PowerShell scripts deployed to the kiosk tablets (Surface Pro 7+) via Intune.
All run as unsigned scripts under SYSTEM (see "Intune upload settings" below).

## nfcsetup.ps1

Installs the NFC/QR scanning setup: a Python daemon (`kiosk_reader.py`,
embedded in this script) that watches for NFC taps and QR scans, and drives
the kiosk browser (Edge, via DevTools Protocol on port 9222) to navigate to
the scanned URL.

### Supported NFC readers

Three readers are supported side by side:

- **ACR122U** — detected by PC/SC name containing `ACR` or `ACS`.
- **Elecom MR-ICA001BK** (chipset reports as `Circle CIR315 CL 0` over
  PC/SC) — detected by name containing `CIR315`.
- **I-O DATA USB-NFC3 「ぴタッチ」** (AB Circle CIR215 chipset, same maker
  as the Elecom's CIR315) — detected by name containing `CIR215`.

Detection logic lives in the `READER_NAMES` tuple above `_detect_reader()`
inside the embedded Python. If a new reader model is ever added, find its
exact PC/SC name from the `Available readers: [...]` line in `reader.log`
and add a matching substring there.

### Elecom MR-ICA001BK driver

The Elecom reader needs its own driver installed on Windows before PC/SC
(and this script) can see it — it does not show up at all until installed.
A factory reset wipes this driver, so it needs reinstalling on every
freshly-provisioned device.

Driver download portal (search by model number):
`https://www2.elecom.co.jp/search/download/search.asp?kataban=`

Direct pages for MR-ICA001BK (confirm your reader's printed model number
matches before using these):
- Windows: https://www.elecom.co.jp/support/download/data-media/ic-rw/ic_card_reader_installer/win_mr-ica001.html
- Windows 11: https://www.elecom.co.jp/support/download/data-media/ic-rw/ic_card_reader_installer/win_mr-ica001_win11.html

After installing, confirm in Device Manager that it shows up under
**Smart card readers** as `CIR315` with no warning icon.

The downloaded package (`drivers/ELECOM_MR-ICA001_CIR315/`) is an MSI
installer (`Package/CIR315DriverInstallerx64.msi`), so it installs silently
via the standard `msiexec /i ... /quiet /norestart` — no vendor-specific
flags needed. `kiosk-launch-install.ps1` runs this automatically as one of
its steps; see that script rather than running the MSI by hand.

### I-O DATA USB-NFC3 「ぴタッチ」 driver

Same situation as the Elecom reader: needs its own driver before PC/SC can
see it at all (I-O DATA explicitly warns the Windows in-box driver does NOT
work), and a factory reset wipes it.

Official download page (「USB-NFC3 サポートソフト」):
`https://www.iodata.jp/lib/software/u/2229.htm`
Direct file (v1.06, driver 2.1.0.0, 2023-04-26):
`https://lib.iodata.jp/lib/soft/u/usbnfc3_106.exe`

The download is a self-extracting exe; extracted, it contains
`Package/ABCDriverInstallerx64.msi` (the "AB Circle CIR215 CCID Driver")
plus its companion `C2152100.cab` — the x64 pair is committed at
`drivers/IODATA_USB-NFC3/Package/`. The vendor's own `SetupSilent.bat` just
runs the installer with `/quiet`, so `kiosk-launch-install.ps1` invokes the
MSI directly via `msiexec /i ... /quiet /norestart`, identical to the
Elecom step.

After installing, confirm in Device Manager that it shows up under
**Smart card readers** as `CIR215` with no warning icon (in Programs and
Features it appears as "AB Circle CIR215 CCID Driver").

### QR scanner driver

The QR/barcode scanner needs its own driver too (DENSO WAVE "Active
USB-COM Port") — without it, the scanner never shows up as a COM port at
all. Same factory-reset caveat as the Elecom driver above.

The downloaded package (`drivers/ActiveUSBCOM_2207_J/`) ships its own
`Install.exe` with a documented silent-install flag (`-S` — see
`ActiveUSBCOM_UsersGuide.pdf` section 2.1.5). `kiosk-launch-install.ps1`
runs this automatically; see that script rather than running `Install.exe`
by hand.

### Troubleshooting

Check `reader.log` on the tablet:
- `Available readers: [...]` — lists every PC/SC reader Windows currently
  sees. If a plugged-in reader isn't in this list, it's a Windows/driver
  problem, not a script problem (reboot / reinstall driver / check Device
  Manager first).
- `NFC reader: <name>` — confirms the script found and is using that reader.
- `Card detected, ATR=...` — confirms a tap was read at the hardware level.
- `NDEF read-binary failed: SW=... data=...` — hardware detected the tag but
  the raw-read command (`0xFF, 0xB0, ...`, the ACS-proprietary pseudo-APDU)
  didn't return valid NDEF data. This command is ACS-specific, not a PC/SC
  standard — a new reader chipset may need a different read command in
  `_read_url()`.

### Version history

- 1.0.0 — initial NFC/QR daemon, ACR122U only.
- 1.1.0 — added diagnostic logging (ATR on card detect, status word on
  failed reads) to help debug new reader chipsets without guessing at
  command bytes.
- 1.2.0 — added Elecom MR-ICA001BK (`CIR315`) detection alongside ACR122U.
- 1.3.0 — added I-O DATA USB-NFC3 (`CIR215`) detection; detection substrings
  moved into a `READER_NAMES` tuple.
- 1.3.1 — QR loop: re-detect the COM port on every retry (hotplug works
  without reboot) and suppress repeated identical errors to one line per
  10 minutes (a kiosk with no QR scanner was logging the same error every
  3 seconds forever).
- 1.4.0 — install Python from a **bundled** installer (`python/`) instead of
  downloading it at first boot, with download as fallback; the flaky SYSTEM-
  context download was the #1 cause of tablets ending up with no NFC. pip now
  retries a slow/unreachable PyPI instead of failing the whole setup.

## kiosk-lockdown.ps1 / kiosk-lockdown-undo.ps1

OS-level lockdown for the Surface Pro tablets, kept in a separate script
from `nfcsetup.ps1` so it can be assigned/unassigned to an Intune device
group independently.

`kiosk-lockdown.ps1` sets:
1. Disables OS edge-swipe gestures (Action Center, Widgets, Task View).
2. Leaves the power/sleep button at its normal "Sleep" action, but sets
   `CONSOLELOCK = 0` so waking (power button or opening the Type Cover)
   skips the Windows lock screen/sign-in prompt and goes straight back to
   the kiosk. This was the actual fix for guests getting dropped on the
   lock screen — not disabling sleep itself.
3. Leaves Connected Standby enabled (Windows default). Surface devices only
   support Modern Standby, not classic S3 sleep, so Connected Standby is
   what lets the power button/Type Cover actually sleep the tablet at all —
   disabling it isn't needed now that `CONSOLELOCK` handles the lock-screen
   problem directly.

**Important:** these are one-time registry writes, not a persistent policy.
Unassigning `kiosk-lockdown.ps1` in Intune does NOT undo the changes — it
only stops the script from running again. To actually restore normal
Windows behavior on a tablet (e.g. for maintenance), assign
`kiosk-lockdown-undo.ps1` to it instead, which explicitly writes each
setting back to its Windows default, then reboot.

## kiosk-launch-install.ps1 (Win32 app)

The NFC daemon, drivers, Edge auto-launch task, and autologin are delivered as a
single Win32 app ("SmartSenior Kiosk Launch"). Unlike the lockdown scripts, this
one ships file payloads (the bundled Python installer and the vendor drivers), so
it must be a Win32 app, not a platform script.

### Packaging

Point `IntuneWinAppUtil` at the **whole `scripts\` folder** so `python\`,
`drivers\`, and every `.ps1` go into the `.intunewin` together (the script loads
them by `$PSScriptRoot`). Missing either folder is what causes silent partial
installs. Verify the package contains `python\python-3.11.9-amd64.exe` and
`drivers\...\*.msi` before uploading.

### Detection rule — use the custom script, not a registry marker

Set the app's detection to **"Use a custom detection script"** and upload
`kiosk-launch-detect.ps1`. **Do not** use the old registry-marker rule
(`HKLM\SOFTWARE\SmartSenior\KioskLaunch`): that marker is written in the
install script's `finally` block no matter what, so a half-failed install still
reported "installed" and Intune never retried — the root cause of tablets ending
up with Edge but no NFC.

The custom script reports "installed" only when the kiosk is actually functional
(Python + deps, reader script, and both scheduled tasks present/enabled). Because
Intune re-evaluates detection on every check-in, this makes the app **self-heal**:

- a tablet where the install silently failed shows "not installed" → Intune
  retries it, and
- a working tablet that later drifts (task disabled, Python wiped by a factory
  reset) flips back to "not installed" → Intune re-runs the install.

With bundled Python + this detection, the app installs reliably from a fresh
tablet and repairs itself. A separate Intune **Remediation** (an hourly health
check that re-runs `nfcsetup.ps1`) is possible as belt-and-suspenders for faster
self-heal, but with the custom detection rule above it is **no longer required** —
Intune's own app engine already retries failures and repairs drift.

### Forcing a re-run on already-enrolled tablets

Devices that already have the old registry marker will be seen as "installed" by
the old rule until you switch the app to the custom detection script above. Once
switched, Intune re-evaluates real health and repairs the half-installed ones on
the next check-in — no marker-version bump needed.

## Intune upload settings

For all scripts in this folder:
- Run this script using the logged on credentials: **No**
- Enforce script signature check: **No**
- Run script in 64 bit PowerShell Host: **Yes**
