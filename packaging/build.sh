#!/usr/bin/env bash
# Build once for either distribution. Bun applies the required crypto patch.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
python3 packaging/versioning.py
command -v bun >/dev/null || { echo 'Bun is required to build Halyard.' >&2; exit 1; }
node -e 'const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 15)) {
        console.error("Node 22.15 or newer is required to build and test Halyard.");
        process.exit(1);
    }'
if [ ! -f proton-sdk/client/js/package.json ]; then
    git submodule update --init proton-sdk
fi
./scripts/build-proton-sdk.sh
cd daemon
bun install --frozen-lockfile
node scripts/build.mjs --metafile=dist/package-metafile.json
cd "$REPO_ROOT"
python3 packaging/stage.py --licenses-only
