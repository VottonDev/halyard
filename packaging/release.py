#!/usr/bin/env python3
"""Create the release build input and a checksummed Arch binary-package recipe."""
import argparse
import gzip
import hashlib
import io
from pathlib import Path
import tarfile

from stage import ROOT, bundled_packages
from versioning import prepare_metadata


def create_release(output, epoch):
    version = prepare_metadata(ROOT, epoch)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"halyard-{version}.tar.gz"
    sources = {}
    excluded = {"node_modules", "dist", ".git", "__pycache__", ".debhelper"}
    for directory in ("daemon", "ui/halyard", "ui/tests", "packaging", "debian", "scripts", "docs", ".github",
                      "proton-sdk/client/js", "proton-sdk/incubating/account/js"):
        for path in (ROOT / directory).rglob("*"):
            relative = path.relative_to(ROOT)
            if (path.is_file() and not any(part in excluded for part in relative.parts)
                    and path.suffix not in (".pyc", ".tsbuildinfo", ".log")
                    and not (relative.parts[0] == "debian" and relative.parts[1] == "halyard")
                    and not path.name.endswith((".substvars", ".debhelper"))
                    and relative.as_posix() not in ("debian/files", "debian/debhelper-build-stamp")
                    and not (relative.parts[:2] == ("packaging", "arch")
                             and (relative.parts[2] in ("src", "pkg", ".SRCINFO")
                                  or ".pkg.tar." in path.name))):
                sources[relative.as_posix()] = path
    for name in ("LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "proton-sdk/LICENSE.md", "AGENTS.md", ".gitmodules"):
        sources[name] = ROOT / name
    for name in ("halyard-daemon.cjs", "halyard-daemon.cjs.map", "THIRD_PARTY_LICENSES.txt", "package-metafile.json"):
        sources[f"daemon/dist/{name}"] = ROOT / "daemon/dist" / name
    for path in (ROOT / "daemon/dist/licenses").rglob("*"):
        if path.is_file():
            sources[path.relative_to(ROOT).as_posix()] = path
    # Include the exact published dependency inputs alongside the source map
    # and build scripts; recipients can inspect the code in the shipped bundle.
    for origin, (directory, package) in bundled_packages().items():
        if package["name"] in ("@protontech/drive-sdk", "proton-drive-sdk-account"):
            continue
        for path in directory.rglob("*"):
            if path.is_file() and "node_modules" not in path.relative_to(directory).parts:
                sources[f"vendor/{origin}/{path.relative_to(directory).as_posix()}"] = path
    with archive.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=epoch, filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as tar:
            for name, source in sorted(sources.items()):
                data = source.read_bytes()
                entry = tarfile.TarInfo(f"halyard-{version}/{name}")
                entry.size, entry.mtime = len(data), epoch
                entry.mode = 0o755 if source.stat().st_mode & 0o111 else 0o644
                tar.addfile(entry, io.BytesIO(data))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    template = (ROOT / "packaging/arch/PKGBUILD-bin.in").read_text()
    (output / "PKGBUILD").write_text(template.replace("@VERSION@", version).replace("@SHA256@", checksum))
    (output / "SHA256SUMS").write_text(f"{checksum}  {archive.name}\n")
    print(archive)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist/packages")
    parser.add_argument("--epoch", type=int, required=True, help="Release commit's Unix timestamp")
    args = parser.parse_args()
    create_release(args.output.resolve(), args.epoch)
