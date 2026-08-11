#!/usr/bin/env bash
# Build the pinned Drive SDK with the dependency versions Halyard actually
# bundles. Upstream SDK releases since js/v0.20.0 have omitted their lockfile and
# @types/mocha declaration, so a plain install is neither reproducible nor
# currently buildable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="$REPO_ROOT/proton-sdk/client/js"
DAEMON_PACKAGE="$REPO_ROOT/daemon/package.json"
RUN_TESTS=false

if [ "${1:-}" = "--test" ]; then
    RUN_TESTS=true
elif [ "$#" -ne 0 ]; then
    printf 'usage: %s [--test]\n' "$0" >&2
    exit 2
fi

cd "$SDK_DIR"
# Upstream does not ship a lockfile for this release. Do not create or update
# one in the submodule: a locally generated lock can become stale and makes a
# later --frozen-lockfile install fail before we can apply Halyard's pins.
bun install --no-save

CRYPTO_VERSION="$(
    node -e 'process.stdout.write(require(process.argv[1]).dependencies["@protontech/crypto"])' \
        "$DAEMON_PACKAGE"
)"
CRYPTO_PATCH="$REPO_ROOT/daemon/patches/@protontech%2Fcrypto@$CRYPTO_VERSION.patch"

EXTRA_DEPENDENCIES=("@protontech/crypto@$CRYPTO_VERSION")
if node -e '
    const fs = require("node:fs");
    const pkg = require("./package.json");
    const types = fs.readFileSync("tsconfig.json", "utf8");
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    process.exit(types.includes("\"mocha\"") && !dependencies["@types/mocha"] ? 0 : 1);
'; then
    EXTRA_DEPENDENCIES+=("@types/mocha@10.0.10")
fi

# --no-save leaves the upstream submodule untouched. Pinning crypto here also
# prevents Bun from nesting a floating crypto ABI inside the file dependency.
bun add --dev --no-save "${EXTRA_DEPENDENCIES[@]}"

SDK_CRYPTO_REL="client/js/node_modules/@protontech/crypto"
if ! git -C "$REPO_ROOT/proton-sdk" apply --reverse --check \
    --directory="$SDK_CRYPTO_REL" "$CRYPTO_PATCH" >/dev/null 2>&1; then
    git -C "$REPO_ROOT/proton-sdk" apply --check --directory="$SDK_CRYPTO_REL" "$CRYPTO_PATCH"
    git -C "$REPO_ROOT/proton-sdk" apply --directory="$SDK_CRYPTO_REL" "$CRYPTO_PATCH"
fi

bun run build:ci

if [ "$RUN_TESTS" = true ]; then
    bun run test:ci
fi
