# Bundled Python installer

`python-3.11.9-amd64.exe` is the official Windows x64 installer, downloaded from:

    https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe

    SHA-256: 5ee42c4eee1e6b4464bb23722f90b45303f79442df63083f05322f1785f5fdde

## Why it's here

`nfcsetup.ps1` installs Python from this local copy instead of downloading it at
install time. Fetching a 25 MB installer from python.org under Intune's SYSTEM
account at first boot was the #1 cause of tablets ending up with no NFC — the
download would stall before the network was ready. Bundling it removes that
dependency entirely, so the install works on a fresh, just-imaged tablet.

`nfcsetup.ps1` falls back to downloading only if this file isn't next to it
(e.g. when the script runs standalone as an Intune Remediation, which carries no
file payload).

## Packaging note

**This file must be included when you build the `.intunewin`** for the Kiosk
Launch app (point `IntuneWinAppUtil` at the whole `scripts\` folder so `python\`,
`drivers\`, and the `.ps1` files all go in). It's a 25 MB binary committed to the
repo on purpose so the package is self-contained and reproducible.

To update the Python version later: drop the new installer here, update the
filename/URL/hash in `nfcsetup.ps1` (the `$bundledPython` path) and in this file.
