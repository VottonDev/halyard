"""Offline tests; no daemon, session bus, or real HTTP requests."""
import json
import threading
import unittest
from unittest.mock import MagicMock, patch

from halyard.update_check import StartupUpdateCheck, fetch_newer_version


class UpdateCheckTests(unittest.TestCase):
    def response(self, value):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = value
        return response

    def test_versions(self):
        for published, expected in [
            ("0.1.4", None), ("0.1.3", None), ("0.1.5", "0.1.5"),
            ("0.1.10", "0.1.10"), ("0.2.0", "0.2.0"),
            ("0.1.5-beta", None), ("garbage", None), (None, None),
        ]:
            with self.subTest(published=published), patch(
                "halyard.update_check.urlopen",
                return_value=self.response(json.dumps({
                    "name": "halyard-daemon", "version": published,
                }).encode()),
            ) as opened:
                self.assertEqual(fetch_newer_version("0.1.4"), expected)
                self.assertEqual(opened.call_args.kwargs["timeout"], 5)

    def test_bad_responses_are_quiet(self):
        for payload in [b"not json", b"[]", b"null", b"\xff", b"x" * 65537,
                        b'{"name":"other", "version":"9.0.0"}']:
            with self.subTest(payload=payload[:40]), patch(
                "halyard.update_check.urlopen", return_value=self.response(payload)
            ):
                self.assertIsNone(fetch_newer_version("0.1.4"))
        with patch("halyard.update_check.urlopen", side_effect=TimeoutError):
            self.assertIsNone(fetch_newer_version("0.1.4"))

    def test_once_async_main_loop_delivery_and_shutdown(self):
        entered, release, dispatched = (threading.Event() for _ in range(3))
        pending = []
        def fetch(_current):
            entered.set()
            release.wait(2)
            return "0.1.5"
        def dispatch(callback, version):
            pending.append((callback, version))
            dispatched.set()
        callback = MagicMock()
        with patch("halyard.update_check.fetch_newer_version", side_effect=fetch) as fetcher:
            check = StartupUpdateCheck("0.1.4", dispatch, callback)
            check.start()
            self.assertTrue(entered.wait(1))
            check.start()
            callback.assert_not_called()
            release.set()
            self.assertTrue(dispatched.wait(1))
            fetcher.assert_called_once()
            callback.assert_not_called()
            deliver, version = pending[0]
            self.assertFalse(deliver(version))
            callback.assert_called_once_with("0.1.5")
            check.stop()
            callback.reset_mock()
            self.assertFalse(deliver(version))
            callback.assert_not_called()


if __name__ == "__main__":
    unittest.main()
