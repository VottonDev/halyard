"""Generate distro metadata from the application's one version manifest."""
from datetime import datetime, timezone
from email.utils import format_datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent


def application_version(root=ROOT):
    version = json.loads((root / "daemon/package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit("Package releases require a stable three-component version")
    return version


def prepare_metadata(root=ROOT, epoch=None):
    version = application_version(root)
    if epoch is None:
        if "SOURCE_DATE_EPOCH" in os.environ:
            epoch = int(os.environ["SOURCE_DATE_EPOCH"])
        else:
            result = subprocess.run(["git", "-C", str(root), "log", "-1", "--format=%ct"],
                                    capture_output=True, text=True)
            epoch = int(result.stdout.strip()) if result.returncode == 0 else int(time.time())
    date = format_datetime(datetime.fromtimestamp(epoch, timezone.utc))
    for name in ("debian/changelog", "packaging/arch/PKGBUILD"):
        template = (root / f"{name}.in").read_text()
        (root / name).write_text(template.replace("@VERSION@", version).replace("@DATE@", date))
    return version


if __name__ == "__main__":
    print(prepare_metadata())
