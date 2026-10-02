#!/usr/bin/env python3
"""Export reviewable AUR-compatible package sources without publishing them."""
import argparse
import gzip
import io
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]


def export_recipe(pkgbuild, output, license_file, archive_dir=None, epoch=0):
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(pkgbuild, output / "PKGBUILD")
    shutil.copyfile(license_file, output / "LICENSE")
    metadata = subprocess.run(["makepkg", "--printsrcinfo"], cwd=output,
                              check=True, capture_output=True, text=True).stdout
    (output / ".SRCINFO").write_text(metadata)
    if archive_dir is not None:
        fields = {}
        for key in ("pkgbase", "pkgver", "pkgrel"):
            values = re.findall(rf"^\s*{key} = (\S+)$", metadata, re.M)
            if len(values) != 1 or not re.fullmatch(r"[a-zA-Z0-9@._+-]+", values[0]):
                raise SystemExit(f"Unsupported {key} in generated .SRCINFO")
            fields[key] = values[0]
        archive_dir.mkdir(parents=True, exist_ok=True)
        archive = archive_dir / f"{fields['pkgbase']}-aur-{fields['pkgver']}-{fields['pkgrel']}.tar.gz"
        with archive.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=epoch, filename="") as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as tar:
                # Only package sources belong in an AUR repository, even if the
                # export directory has also been used for a local makepkg build.
                for name in ("PKGBUILD", ".SRCINFO", "LICENSE"):
                    data = (output / name).read_bytes()
                    entry = tarfile.TarInfo(f"{fields['pkgbase']}/{name}")
                    entry.size, entry.mtime, entry.mode = len(data), epoch, 0o644
                    tar.addfile(entry, io.BytesIO(data))
        return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pkgbuild", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--license", type=Path, default=ROOT / "LICENSE")
    parser.add_argument("--archive-dir", type=Path)
    parser.add_argument("--epoch", type=int, default=0, help="Release commit's Unix timestamp")
    args = parser.parse_args()
    archive = export_recipe(args.pkgbuild.resolve(), args.output.resolve(), args.license.resolve(),
                            args.archive_dir.resolve() if args.archive_dir else None, args.epoch)
    print(archive or args.output.resolve())
