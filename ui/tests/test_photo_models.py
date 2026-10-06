"""Offline checks for the photo D-Bus boundary and disposable transfer models."""
import re
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path
from xml.etree import ElementTree
from halyard.models import Photo, PhotoAlbum, PhotoPage, PhotoDownload, PhotoThumbnail, VideoPreview, PhotoManagementResult
from mock_daemon import INTROSPECTION, mock_photo


class PhotoModelTests(unittest.TestCase):
    def test_pages_and_related_assets_are_immutable(self):
        page = PhotoPage.from_json({"photos": [mock_photo(1)], "nextCursor": "4:60", "revision": 4})
        self.assertEqual(page.next_cursor, "4:60")
        self.assertIsInstance(page.photos, tuple)
        self.assertEqual(page.photos[0].related_uids, ("photo-related",))
        self.assertTrue(Photo.from_json(mock_photo(0)).is_video)
        self.assertEqual(PhotoPage.from_json(None).photos, ())

    def test_progress_and_upload_states(self):
        job = PhotoDownload.from_json({"id": "one", "status": "uploading", "files": [
            {"name": "one.jpg", "size": 10, "bytesDone": 30}, {"name": "two.jpg", "size": 10, "bytesDone": 0}]})
        self.assertTrue(job.active)
        self.assertEqual(job.fraction, 1)
        self.assertIsInstance(job.files, tuple)
        self.assertEqual(PhotoDownload.from_json({"status": "completed"}).fraction, 0)

    def test_playback_uri_is_local(self):
        self.assertIsNone(VideoPreview.from_json({"uri": "https://example.com/movie"}).uri)
        self.assertEqual(VideoPreview.from_json({"uri": "http://127.0.0.1:8000/video/token"}).uri, "http://127.0.0.1:8000/video/token")

    def test_thumbnail_size_bound(self):
        content = "x" * (4 * 1024 * 1024)
        self.assertEqual(PhotoThumbnail.from_json({"data": content}).data, content)
        self.assertIsNone(PhotoThumbnail.from_json({"data": "x" * (4 * 1024 * 1024 + 1)}).data)

    def test_mock_matches_daemon_photo_signatures(self):
        source = (Path(__file__).parents[2] / "daemon/src/ipc/dbus.ts").read_text()
        interface = ElementTree.fromstring(INTROSPECTION).find("interface")
        for method in interface.findall("method"):
            name = method.attrib["name"]
            if "Photo" not in name and "Video" not in name: continue
            signature = re.search(rf"{name}: \{{ inSignature: '([^']*)', outSignature: '([^']*)'", source)
            self.assertIsNotNone(signature, name)
            self.assertEqual(signature.groups(), tuple("".join(a.attrib["type"] for a in method.findall("arg") if a.attrib["direction"] == d) for d in ("in", "out")))
        for name in ("PhotosChanged", "PhotoDownloadsChanged", "PhotoUploadsChanged", "VideoPreviewChanged"):
            self.assertIsNotNone(interface.find(f"signal[@name='{name}']"))

    def test_permissions_default_to_disabled_and_require_booleans(self):
        self.assertFalse(Photo.from_json({}).can_favourite)
        self.assertFalse(Photo.from_json({"canTrash": "true"}).can_trash)
        self.assertFalse(PhotoAlbum.from_json({}).can_write)
        album = PhotoAlbum.from_json({"sharedWithMe": True, "canWrite": True, "canDelete": False})
        self.assertTrue(album.shared_with_me and album.can_write)
        self.assertFalse(album.can_delete)
        with self.assertRaises(FrozenInstanceError):
            album.can_write = False

    def test_management_results_are_immutable_and_do_not_invent_success(self):
        result = PhotoManagementResult.from_json({"results": [
            {"uid": "a", "ok": True}, {"uid": "b", "ok": False, "error": "Permission denied"},
            {"uid": "c", "ok": "true"}], "cancelled": True, "revision": 7})
        self.assertIsInstance(result.results, tuple)
        self.assertEqual(tuple(r.ok for r in result.results), (True, False, False))
        self.assertEqual(result.results[1].error, "Permission denied")
        self.assertTrue(result.cancelled)
        self.assertEqual(result.revision, 7)
        self.assertEqual(PhotoManagementResult.from_json(None).results, ())


if __name__ == "__main__":
    unittest.main()
