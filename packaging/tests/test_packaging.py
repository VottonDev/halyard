"""Offline checks for package staging and the UI's installed-service discovery."""
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import os
import shutil
import subprocess
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("stage", ROOT / "packaging/stage.py")
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
sys.path.insert(0, str(ROOT / "packaging"))
import release
import versioning


class PackageTests(unittest.TestCase):
    def test_one_manifest_generates_versions_for_both_distributions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "daemon").mkdir()
            for name in ("debian/changelog", "packaging/arch/PKGBUILD"):
                template = root / f"{name}.in"
                template.parent.mkdir(parents=True, exist_ok=True)
                template.write_text((ROOT / f"{name}.in").read_text())
            for version in ("7.8.9", "7.8.10"):
                (root / "daemon/package.json").write_text(json.dumps({"version": version}))
                self.assertEqual(versioning.prepare_metadata(root, 1), version)
                changelog = (root / "debian/changelog").read_text()
                recipe = (root / "packaging/arch/PKGBUILD").read_text()
                self.assertTrue(changelog.startswith(f"halyard ({version}-1)"))
                self.assertIn(f"pkgver={version}\n", recipe)
                self.assertNotIn("@VERSION@", recipe + changelog)
                self.assertIn("Thu, 01 Jan 1970 00:00:01 +0000", changelog)

    @unittest.skipUnless(shutil.which("systemctl"), "systemctl is needed for the offline unit migration check")
    def test_enabled_manual_unit_can_be_relinked_to_package_unit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            user_dir = root / "etc/systemd/user"
            package_dir = root / "usr/lib/systemd/user"
            user_dir.mkdir(parents=True)
            package_dir.mkdir(parents=True)
            text = (ROOT / "packaging/halyard-daemon.service.in").read_text()
            (user_dir / "halyard-daemon.service").write_text(text)
            (package_dir / "halyard-daemon.service").write_text(text)
            (package_dir / "default.target").write_text("[Unit]\nDescription=Test target\n")
            def unit_action(verb):
                subprocess.run(["systemctl", f"--root={root}", "--global", verb, "halyard-daemon.service"],
                               check=True, capture_output=True, text=True)
            link = user_dir / "default.target.wants/halyard-daemon.service"
            unit_action("enable")
            self.assertEqual(os.readlink(link), "/etc/systemd/user/halyard-daemon.service")
            unit_action("disable")
            (user_dir / "halyard-daemon.service").unlink()
            unit_action("enable")
            self.assertEqual(os.readlink(link), "/usr/lib/systemd/user/halyard-daemon.service")

    def test_dependency_inventory_keeps_esm_boundaries_and_multiple_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = {}
            for origin, version in (("daemon/node_modules/example", "2.0.0"),
                                    ("proton-sdk/client/js/node_modules/example", "1.0.0")):
                package = root / origin
                (package / "esm").mkdir(parents=True)
                (package / "package.json").write_text(json.dumps({"name": "example", "version": version}))
                (package / "esm/package.json").write_text('{"type":"module"}')
                (package / "esm/index.js").write_text("export default 1")
                inputs[f"../{origin}/esm/index.js"] = {}
            metadata = root / "daemon/dist/package-metafile.json"
            metadata.parent.mkdir(parents=True)
            metadata.write_text(json.dumps({"inputs": inputs}))
            with patch.object(stage, "ROOT", root):
                packages = stage.bundled_packages()
            self.assertEqual({package["version"] for _, package in packages.values()}, {"1.0.0", "2.0.0"})

    def test_release_includes_dependencies_nested_in_sdk(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary) / "source", Path(temporary) / "output"
            files = {
                "daemon/package.json": '{"version":"7.8.9"}',
                "ui/halyard/__init__.py": "fixture",
                "debian/changelog.in": "halyard (@VERSION@-1) unstable; urgency=medium\n@DATE@",
                "packaging/arch/PKGBUILD.in": "pkgver=@VERSION@\n",
                "packaging/arch/.SRCINFO": "pkgver = stale-version\n",
                "packaging/arch/PKGBUILD-bin.in": "@VERSION@ @SHA256@",
                "LICENSE": "fixture", "README.md": "fixture", "THIRD_PARTY_NOTICES.md": "fixture",
                "AGENTS.md": "fixture", ".gitmodules": "fixture",
                "proton-sdk/LICENSE.md": "fixture",
                "proton-sdk/client/js/src/index.ts": "sdk source",
                "proton-sdk/client/js/node_modules/example/package.json": '{"name":"example","version":"1.0.0"}',
                "proton-sdk/client/js/node_modules/example/source.js": "nested dependency source",
            }
            for name in ("halyard-daemon.cjs", "halyard-daemon.cjs.map", "THIRD_PARTY_LICENSES.txt", "package-metafile.json"):
                files[f"daemon/dist/{name}"] = "fixture"
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            origin = "proton-sdk/client/js/node_modules/example"
            packages = {origin: (root / origin, {"name": "example", "version": "1.0.0"})}
            with patch.object(release, "ROOT", root), patch.object(release, "bundled_packages", return_value=packages):
                release.create_release(output, 1)
            with tarfile.open(output / "halyard-7.8.9.tar.gz") as archive:
                self.assertNotIn("halyard-7.8.9/packaging/arch/.SRCINFO", archive.getnames())
                source = archive.extractfile(f"halyard-7.8.9/vendor/{origin}/source.js")
                self.assertEqual(source.read().decode(), "nested dependency source")
                changelog = archive.extractfile("halyard-7.8.9/debian/changelog").read().decode()
                self.assertTrue(changelog.startswith("halyard (7.8.9-1)"))
            self.assertTrue((output / "PKGBUILD").read_text().startswith("7.8.9 "))

    def test_stage_uses_system_paths_and_keeps_user_data_out(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, destination = Path(temporary) / "source", Path(temporary) / "stage"
            for filename in (
                "daemon/dist/halyard-daemon.cjs", "daemon/dist/halyard-daemon.cjs.map",
                "daemon/dist/THIRD_PARTY_LICENSES.txt", "LICENSE", "THIRD_PARTY_NOTICES.md",
                "ui/halyard/__main__.py", "ui/halyard/data/io.github.votton.Halyard.desktop",
                "ui/halyard/data/io.github.votton.Halyard.gschema.xml",
                "ui/halyard/data/icons/hicolor/scalable/apps/io.github.votton.Halyard.svg",
                "ui/halyard/__pycache__/main.cpython-313.pyc",
            ):
                path = source / filename
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture")
            (source / "daemon/package.json").write_text('{"version":"7.8.9"}')
            (source / "ui/halyard/__init__.py").write_text((ROOT / "ui/halyard/__init__.py").read_text())
            for name in ("halyard-daemon.service.in", "io.github.votton.Halyard.Daemon.service.in"):
                path = source / "packaging" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text((ROOT / "packaging" / name).read_text())
            with patch.object(stage, "ROOT", source):
                stage.stage(destination)
            unit = (destination / "usr/lib/systemd/user/halyard-daemon.service").read_text()
            self.assertIn("ExecStart=/usr/bin/node /usr/lib/halyard/halyard-daemon.cjs", unit)
            self.assertIn("ProtectSystem=strict", unit)
            activation = (destination / "usr/share/dbus-1/services/io.github.votton.Halyard.Daemon.service").read_text()
            self.assertIn("SystemdService=halyard-daemon.service", activation)
            self.assertNotIn("@", activation)
            launcher = destination / "usr/bin/halyard"
            self.assertEqual(launcher.stat().st_mode & 0o777, 0o755)
            self.assertIn('"$@"', launcher.read_text())
            self.assertFalse(any(path.name == "__pycache__" for path in destination.rglob("*")))
            self.assertEqual([path.name for path in destination.iterdir()], ["usr"])
            ui = destination / "usr/lib/halyard/ui"
            installed_version = subprocess.run(
                [sys.executable, "-c", "import halyard; print(halyard.__version__)"],
                env={**os.environ, "PYTHONPATH": str(ui)}, cwd=destination,
                check=True, capture_output=True, text=True,
            ).stdout.strip()
            self.assertEqual(installed_version, "7.8.9")

    def test_system_service_and_bundle_are_discovered_without_user_install(self):
        from halyard import daemon_control as control
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            unit, service, bundle = (base / name for name in ("unit", "service", "bundle"))
            with patch.object(control, "SYSTEMD_UNIT_FILE", base / "missing-user-unit"), \
                 patch.object(control, "DBUS_SERVICE_FILE", base / "missing-user-service"), \
                 patch.object(control, "_SYSTEM_UNIT_FILES", (unit,)), \
                 patch.object(control, "_SYSTEM_DBUS_SERVICE_FILES", (service,)), \
                 patch.object(control, "_BUNDLE_CANDIDATES", (bundle,)):
                self.assertFalse(control.unit_installed())
                self.assertFalse(control.service_files_installed())
                self.assertIsNone(control.find_bundle())
                for path in (unit, service, bundle):
                    path.touch()
                self.assertTrue(control.unit_installed())
                self.assertTrue(control.service_files_installed())
                self.assertEqual(control.find_bundle(), bundle)


if __name__ == "__main__":
    unittest.main()
