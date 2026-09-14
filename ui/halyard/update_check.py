"""One-shot, best-effort check of Halyard's published main-branch version."""

from __future__ import annotations

import json
import re
from threading import Thread
from urllib.request import Request, urlopen

VERSION_URL = "https://raw.githubusercontent.com/VottonDev/halyard/main/daemon/package.json"
UPDATE_URL = "https://github.com/VottonDev/halyard#install"
_MAX_BYTES = 65536


def parse_version(value: object) -> tuple[int, int, int] | None:
    """Accept only Halyard's stable major.minor.patch version format."""
    if not isinstance(value, str) or not re.fullmatch(
        r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value
    ):
        return None
    return tuple(int(part) for part in value.split("."))


def fetch_newer_version(current: str) -> str | None:
    """Return a newer version, or nothing on offline/invalid responses."""
    installed = parse_version(current)
    if installed is None:
        return None
    try:
        request = Request(VERSION_URL, headers={"User-Agent": f"Halyard/{current}"})
        with urlopen(request, timeout=5) as response:
            payload = response.read(_MAX_BYTES + 1)
        if len(payload) > _MAX_BYTES:
            return None
        data = json.loads(payload)
        if not isinstance(data, dict) or data.get("name") != "halyard-daemon":
            return None
        version = data.get("version")
        published = parse_version(version)
        if published is not None and published > installed:
            return version
    except Exception:
        # This optional hint must never turn network or parsing failures into
        # startup errors. No account information is sent or logged.
        pass
    return None


class StartupUpdateCheck:
    """Run at most once, delivering results through the caller's main loop."""

    def __init__(self, current, dispatch, on_update):
        self._current = current
        self._dispatch = dispatch
        self._on_update = on_update
        self._started = False
        self._stopped = False

    def start(self) -> None:
        if self._started or self._stopped:
            return
        self._started = True
        # DNS/network delays must not hold up GTK or keep the process alive.
        Thread(target=self._run, name="halyard-update-check", daemon=True).start()

    def stop(self) -> None:
        self._stopped = True

    def _run(self) -> None:
        version = fetch_newer_version(self._current)
        if version is not None and not self._stopped:
            self._dispatch(self._deliver, version)

    def _deliver(self, version: str) -> bool:
        if not self._stopped:
            self._on_update(version)
        return False
