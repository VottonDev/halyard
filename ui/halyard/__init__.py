"""Halyard, an unofficial two-way sync client for Proton Drive.

Halyard is an independent open-source project. It is not made, endorsed, or
supported by Proton AG.
"""

import gi
import json
from pathlib import Path

# Pinned here rather than in main.py so that importing any module of this
# package in any order is safe, including from tests.
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

_VERSION_PATHS = (
    Path(__file__).resolve().parent / "data/version.json",  # installed metadata
    Path(__file__).resolve().parents[2] / "daemon/package.json",  # checkout
)
for _version_path in _VERSION_PATHS:
    if _version_path.is_file():
        __version__ = json.loads(_version_path.read_text())["version"]
        break
else:
    raise RuntimeError("Halyard's version metadata is missing; reinstall the application.")
APP_ID = "io.github.votton.Halyard"
