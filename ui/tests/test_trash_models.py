"""Offline checks for the Trash D-Bus boundary."""

from dataclasses import FrozenInstanceError
import unittest

from halyard.models import TrashItem, TrashPage, TrashRestore, TrashRestoreResult


class TrashModelTests(unittest.TestCase):
    def test_null_unknown_payloads_are_safe(self):
        self.assertEqual(TrashItem.from_json(None), TrashItem())
        self.assertEqual(TrashPage.from_json(None).items, ())
        self.assertEqual(TrashRestore.from_json(None).results, ())
        self.assertEqual(TrashRestoreResult.from_json({}).status, "unknown")
        item = TrashItem.from_json({"size": False, "trashedAt": "yesterday"})
        self.assertIsNone(item.size)
        self.assertIsNone(item.trashed_at)

    def test_page_and_partial_outcomes_remain_immutable(self):
        page = TrashPage.from_json({"items": [{"uid": "photo", "source": "photos", "name": "IMG.jpg",
                                            "type": "photo", "size": 42, "trashedAt": 123}], "nextCursor": "page:50"})
        self.assertEqual(page.items[0].size, 42)
        self.assertEqual(page.next_cursor, "page:50")
        job = TrashRestore.from_json({"id": "restore", "source": "photos", "status": "cancelled", "createdAt": 200,
            "refreshError": "Refresh failed", "results": [{**{"uid": "photo", "name": "IMG.jpg"}, "status": "restored"},
                                                          {"uid": "video", "status": "unknown", "error": "Refresh before retrying"}]})
        self.assertIsInstance(job.results, tuple)
        self.assertEqual(job.results[1].item.error, "Refresh before retrying")
        self.assertEqual(job.results[0].status, "restored")
        self.assertEqual(job.refresh_error, "Refresh failed")
        with self.assertRaises(FrozenInstanceError): job.results[0].status = "failed"


if __name__ == "__main__": unittest.main()
