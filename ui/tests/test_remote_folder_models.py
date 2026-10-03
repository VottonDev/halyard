"""Offline checks for the shared-folder D-Bus boundary."""

from dataclasses import FrozenInstanceError
import unittest

from halyard.models import RemoteFolder


class RemoteFolderModelTests(unittest.TestCase):
    def test_older_payloads_default_to_owned_writable_folders(self):
        folder = RemoteFolder.from_json({
            "uid": "volume~folder", "name": "Notes", "path": "/Notes",
            "hasChildren": True,
        })
        self.assertFalse(folder.shared_with_me)
        self.assertTrue(folder.can_write)
        self.assertTrue(folder.has_children)
        self.assertEqual(RemoteFolder.from_json(None), RemoteFolder())

    def test_shared_folder_metadata_and_path_are_retained(self):
        for can_write in (True, False):
            with self.subTest(can_write=can_write):
                folder = RemoteFolder.from_json({
                    "uid": "volume~summer", "name": "Summer",
                    "path": "/Shared with me/Trips/Summer", "sharedWithMe": True,
                    "canWrite": can_write,
                })
                self.assertTrue(folder.shared_with_me)
                self.assertEqual(folder.can_write, can_write)
                self.assertEqual(folder.path, "/Shared with me/Trips/Summer")

    def test_remote_folders_remain_immutable(self):
        folder = RemoteFolder.from_json({"sharedWithMe": True, "canWrite": False})
        with self.assertRaises(FrozenInstanceError):
            folder.can_write = True


if __name__ == "__main__":
    unittest.main()
