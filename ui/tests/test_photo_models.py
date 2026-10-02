"""Offline checks for the photo D-Bus boundary and disposable transfer models."""
import json
import re
import unittest
from pathlib import Path
from xml.etree import ElementTree
from halyard.models import Photo, PhotoPage, PhotoDownload, PhotoThumbnail, VideoPreview
from mock_daemon import INTROSPECTION, mock_photo, mock_preview


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

    def test_thumbnail_fixture_and_size_bound(self):
        import base64
        self.assertTrue(base64.b64decode(mock_preview(1)).startswith(b"\x89PNG"))
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


if __name__ == "__main__":
    unittest.main()
