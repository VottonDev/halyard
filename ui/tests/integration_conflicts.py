#!/usr/bin/env python3
"""Check GTK conflict choices without starting a daemon or using an account."""

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import halyard  # Pins the GTK and libadwaita API versions before importing widgets.
from gi.repository import Adw, Gtk
from halyard.conflicts_view import ConflictRow
from halyard.models import (
    Conflict,
    KIND_BOTH_MODIFIED,
    KIND_LOCAL_DELETED,
    KIND_REMOTE_DELETED,
    RESOLVE_DISMISS,
    RESOLVE_KEEP_LOCAL,
    RESOLVE_KEEP_REMOTE,
)


class ConflictActionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not Gtk.init_check():
            raise unittest.SkipTest("A usable GTK display is required")
        Adw.init()

    def make_row(self, kind, kept_path):
        resolutions = []

        def resolve(conflict, resolution, on_failure):
            resolutions.append(resolution)
            on_failure()

        row = ConflictRow(Conflict(
            id="conflict", path="notes.txt", kind=kind,
            kept_copy_path=kept_path,
        ), None, resolve)
        return row, resolutions

    def test_separate_versions_offer_all_resolutions(self):
        row, resolutions = self.make_row(
            KIND_BOTH_MODIFIED, "notes (conflict 2026-10-02).txt"
        )
        buttons = [button for button in row._buttons if button.get_visible()]
        self.assertEqual(len(buttons), 3)
        for button in buttons:
            button.emit("clicked")
        self.assertEqual(resolutions, [
            RESOLVE_DISMISS, RESOLVE_KEEP_LOCAL, RESOLVE_KEEP_REMOTE,
        ])
        self.assertTrue(all(button.get_sensitive() for button in buttons))

    def test_deletion_conflicts_cannot_choose_a_missing_version(self):
        for kind in (KIND_LOCAL_DELETED, KIND_REMOTE_DELETED):
            for kept_path in ("notes.txt", "legacy-restored-notes.txt", None):
                with self.subTest(kind=kind, kept_path=kept_path):
                    row, resolutions = self.make_row(kind, kept_path)
                    buttons = [button for button in row._buttons if button.get_visible()]
                    self.assertEqual(len(buttons), 1)
                    buttons[0].emit("clicked")
                    self.assertEqual(resolutions, [RESOLVE_DISMISS])
                    self.assertTrue(buttons[0].get_sensitive())

    def test_missing_copy_does_not_offer_replacement(self):
        row, resolutions = self.make_row(KIND_BOTH_MODIFIED, None)
        buttons = [button for button in row._buttons if button.get_visible()]
        self.assertEqual(len(buttons), 1)
        buttons[0].emit("clicked")
        self.assertEqual(resolutions, [RESOLVE_DISMISS])


if __name__ == "__main__":
    unittest.main()
