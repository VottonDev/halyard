#!/usr/bin/env bash
# Launch the mock sync daemon and the Halyard UI together.
#
# The real daemon does not have to exist for this: tests/mock_daemon.py owns
# the same bus name and implements the same contract with fake data.
#
# The mock owns io.github.votton.Halyard.MockDaemon rather than the real
# daemon's name, so the two can run side by side. This script points the UI at
# the mock via HALYARD_BUS_NAME.
#
# Usage:
#   ./run-dev.sh                 # signed out, so the login flow runs
#   ./run-dev.sh --logged-in     # skip straight to the folder pair list
#   ./run-dev.sh --no-mock       # run the UI against the REAL daemon
#
# Any other argument is passed through to the mock daemon, e.g.
#   ./run-dev.sh --logged-in --offline
#   ./run-dev.sh --login-fails
#
# WARNING: --no-mock points the UI at the real daemon, which is connected to a
# live Proton Drive account. Do mutation testing against the mock.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PYTHON="${PYTHON:-python3}"
USE_MOCK=1
MOCK_ARGS=()

for arg in "$@"; do
  if [[ "$arg" == "--no-mock" ]]; then
    USE_MOCK=0
  else
    MOCK_ARGS+=("$arg")
  fi
done

# Compile the GSettings schema into a scratch directory so preferences and
# window geometry persist without installing anything system-wide.
SCHEMA_DIR="${TMPDIR:-/tmp}/halyard-schemas-$UID"
mkdir -p "$SCHEMA_DIR"
cp halyard/data/io.github.votton.Halyard.gschema.xml "$SCHEMA_DIR/"
if command -v glib-compile-schemas >/dev/null 2>&1; then
  glib-compile-schemas "$SCHEMA_DIR" 2>/dev/null || true
  export GSETTINGS_SCHEMA_DIR="$SCHEMA_DIR"
else
  echo "run-dev: glib-compile-schemas not found; settings will not persist" >&2
fi

MOCK_PID=""
cleanup() {
  if [[ -n "$MOCK_PID" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

MOCK_BUS_NAME="io.github.votton.Halyard.MockDaemon"

if [[ "$USE_MOCK" == "1" ]]; then
  echo "run-dev: starting mock daemon on $MOCK_BUS_NAME ${MOCK_ARGS[*]:-}" >&2
  "$PYTHON" tests/mock_daemon.py --bus-name "$MOCK_BUS_NAME" \
    ${MOCK_ARGS[@]+"${MOCK_ARGS[@]}"} &
  MOCK_PID=$!
  # Give it a moment to take the bus name; the UI copes either way.
  sleep 0.6
  if ! kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "run-dev: mock daemon exited early (bus name already taken?)" >&2
    exit 1
  fi
  export HALYARD_BUS_NAME="$MOCK_BUS_NAME"
else
  echo "run-dev: using the REAL daemon (io.github.votton.Halyard.Daemon)" >&2
fi

# The arguments above are for the mock daemon, not the UI, so they are not
# forwarded here.
echo "run-dev: starting Halyard UI" >&2
PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}" "$PYTHON" -m halyard.main || true
