#!/usr/bin/env python3
"""Stage package-owned files. Never touches a user's service or sync state."""
import argparse
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parent.parent
LIB_DIR = Path("usr/lib/halyard")


def bundled_packages():
    """Use esbuild's inputs to identify the dependencies actually shipped."""
    metadata = json.loads((ROOT / "daemon/dist/package-metafile.json").read_text())
    packages = {}
    for filename in metadata["inputs"]:
        source = (ROOT / "daemon" / filename).resolve()
        for directory in source.parents:
            manifest = directory / "package.json"
            if not manifest.is_file():
                continue
            package = json.loads(manifest.read_text())
            # ESM boundaries often contain only {"type": "module"}; keep
            # walking to the actual package manifest rather than losing the
            # dependency. Distinct install locations may contain different
            # versions or patches of the same package, so retain each origin.
            if "name" not in package:
                continue
            if directory != ROOT / "daemon":
                packages[directory.relative_to(ROOT).as_posix()] = (directory, package)
            break
    return packages


def write_licenses():
    sections = ["Licences for dependencies included in halyard-daemon.cjs\n"]
    license_root = ROOT / "daemon/dist/licenses"
    if license_root.exists():
        shutil.rmtree(license_root)
    for origin, (directory, package) in sorted(bundled_packages().items()):
        name = package["name"]
        sections.append(f"\n{'=' * 72}\n{name} {package.get('version', '')}\n"
                        f"Build source: {origin}\n"
                        f"Declared licence: {package.get('license', 'see upstream')}\n")
        notices = sorted(path for path in directory.iterdir() if path.is_file()
                         and re.match(r"^(licen[cs]e|copying|notice)([.-]|$)", path.name, re.I))
        if name in ("@protontech/drive-sdk", "proton-drive-sdk-account"):
            notices = [ROOT / "proton-sdk/LICENSE.md"]
        if not notices:
            raise SystemExit(f"Missing licence text for bundled dependency: {name} ({directory})")
        for notice in notices:
            sections.append(f"\n--- {notice.name} ---\n{notice.read_text()}\n")
            # Preserve each origin, including differently patched installations
            # of the same dependency. Arch requires these texts in its licence
            # directory, independently of the human-readable aggregate notice.
            target = license_root / origin / notice.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(notice, target)
    (ROOT / "daemon/dist/THIRD_PARTY_LICENSES.txt").write_text("".join(sections))


def stage(destination, package_name="halyard"):
    if not re.fullmatch(r"[a-z0-9][a-z0-9@._+-]*", package_name):
        raise SystemExit("Invalid distribution package name")
    license_root = ROOT / "daemon/dist/licenses"
    if not license_root.is_dir() or not any(path.is_file() for path in license_root.rglob("*")):
        raise SystemExit("Missing bundled dependency licence files; run packaging/build.sh first")
    destination = Path(destination).resolve()
    license_target = Path("usr/share/licenses") / package_name

    def install(source, target, mode=0o644):
        target = destination / target
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(mode)

    def write(target, value, mode=0o644):
        target = destination / target
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)
        target.chmod(mode)

    install(ROOT / "daemon/dist/halyard-daemon.cjs", LIB_DIR / "halyard-daemon.cjs")
    # The source map also makes the bundled third-party code inspectable.
    install(ROOT / "daemon/dist/halyard-daemon.cjs.map", LIB_DIR / "halyard-daemon.cjs.map")
    for source in sorted((ROOT / "ui/halyard").rglob("*")):
        if source.is_file() and "__pycache__" not in source.parts and source.suffix != ".pyc":
            install(source, LIB_DIR / "ui/halyard" / source.relative_to(ROOT / "ui/halyard"))
    version = json.loads((ROOT / "daemon/package.json").read_text())["version"]
    write(LIB_DIR / "ui/halyard/data/version.json", json.dumps({"version": version}) + "\n")
    write("usr/bin/halyard", '#!/bin/sh\nexport PYTHONPATH="/usr/lib/halyard/ui${PYTHONPATH:+:$PYTHONPATH}"\n'
          'exec /usr/bin/python3 -m halyard "$@"\n', 0o755)
    for template, target in (
        ("halyard-daemon.service.in", "usr/lib/systemd/user/halyard-daemon.service"),
        ("io.github.votton.Halyard.Daemon.service.in",
         "usr/share/dbus-1/services/io.github.votton.Halyard.Daemon.service"),
    ):
        value = (ROOT / "packaging" / template).read_text()
        write(target, value.replace("@NODE@", "/usr/bin/node")
              .replace("@DAEMON@", "/usr/lib/halyard/halyard-daemon.cjs"))
    for source, target in (
        ("ui/halyard/data/io.github.votton.Halyard.desktop", "usr/share/applications/io.github.votton.Halyard.desktop"),
        ("ui/halyard/data/io.github.votton.Halyard.gschema.xml", "usr/share/glib-2.0/schemas/io.github.votton.Halyard.gschema.xml"),
        ("ui/halyard/data/icons/hicolor/scalable/apps/io.github.votton.Halyard.svg", "usr/share/icons/hicolor/scalable/apps/io.github.votton.Halyard.svg"),
        ("THIRD_PARTY_NOTICES.md", "usr/share/doc/halyard/THIRD_PARTY_NOTICES.md"),
        ("daemon/dist/THIRD_PARTY_LICENSES.txt", "usr/share/doc/halyard/THIRD_PARTY_LICENSES.txt"),
    ):
        install(ROOT / source, target)
    install(ROOT / "LICENSE", license_target / "LICENSE")
    for notice in sorted(license_root.rglob("*")):
        if notice.is_file():
            install(notice, license_target / "bundled" / notice.relative_to(license_root))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destdir")
    parser.add_argument("--package-name", default="halyard", help="Name used for the distribution licence directory")
    parser.add_argument("--licenses-only", action="store_true")
    args = parser.parse_args()
    if args.licenses_only:
        write_licenses()
    elif args.destdir:
        stage(args.destdir, args.package_name)
    else:
        parser.error("--destdir or --licenses-only is required")
