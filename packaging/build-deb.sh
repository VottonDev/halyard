#!/usr/bin/env bash
# Prepare conventional Debian metadata, then use the standard build driver.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
python3 packaging/versioning.py
exec dpkg-buildpackage --build=binary --no-sign "$@"
