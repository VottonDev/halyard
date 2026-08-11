"""Halyard — an unofficial two-way sync client for Proton Drive.

Halyard is an independent open-source project. It is not made, endorsed, or
supported by Proton AG.
"""

import gi

# Pinned here rather than in main.py so that importing any module of this
# package in any order is safe — including from tests.
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

__version__ = "0.1.2"
APP_ID = "io.github.votton.Halyard"
