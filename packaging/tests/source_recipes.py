#!/usr/bin/env python3
"""Exercise Arch's actual submodule prepare hook offline, using the pinned SDK."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packaging"))
from versioning import prepare_metadata

prepare_metadata()


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


with tempfile.TemporaryDirectory(prefix="halyard-source-recipe-") as temporary:
    srcdir = Path(temporary)
    main = srcdir / "halyard"
    main.mkdir()
    run("git", "init", "-q", str(main))
    shutil.copyfile(ROOT / ".gitmodules", main / ".gitmodules")
    revision = run("git", "-C", str(ROOT / "proton-sdk"), "rev-parse", "HEAD", capture_output=True).stdout.strip()
    run("git", "-C", str(main), "add", ".gitmodules")
    run("git", "-C", str(main), "update-index", "--add", "--cacheinfo", "160000", revision, "proton-sdk")
    run("git", "-C", str(main), "-c", "user.name=Halyard package test",
        "-c", "user.email=package-test@example.invalid", "commit", "-qm", "Offline submodule fixture")
    run("git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT / "proton-sdk"), str(srcdir / "proton-sdk"))
    # Sourcing the real recipe only declares its metadata and functions. The
    # prepare hook uses the local SDK mirror, so this makes no network calls.
    run("bash", "-c", 'source "$1"; srcdir="$2"; prepare', "prepare-test",
        str(ROOT / "packaging/arch/PKGBUILD"), str(srcdir))
    actual = run("git", "-C", str(main / "proton-sdk"), "rev-parse", "HEAD", capture_output=True).stdout.strip()
    assert actual == revision
    assert (main / "proton-sdk/client/js/package.json").is_file()
    print(f"Arch source recipe prepared the pinned SDK ({revision}) offline")
