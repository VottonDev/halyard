# Continuous integration

Halyard has two account-free GitHub Actions workflows. Neither workflow signs
in to Proton or makes Drive API calls.

## Pull-request checks

`.github/workflows/ci.yml` is the merge gate. It builds the Proton SDK revision
pinned by the `proton-sdk` submodule, then runs Halyard's type checks, both test
runners, the production bundle build and a strict offline environment probe.
It tests the minimum supported Node release and the current Node LTS line.

The probe verifies the bundled SDK entry points, SQLite, D-Bus and an OpenPGP
round trip. A separate bundled Node test exercises the versioned
crypto-material cache with generated keys, closes over no account data, and
confirms that another cache instance can read the encrypted state.

The UI job compiles every Python source file, checks the shell scripts and
ensures that the embedded systemd unit remains byte-identical to the packaging
template.

Configure these jobs as required status checks for `main`:

- `Daemon (Node 22)`
- `Daemon (Node 24)`
- `UI and packaging`

## Proton SDK canary

`.github/workflows/sdk-canary.yml` runs daily and can also be started manually.
It temporarily replaces the SDK submodule checkout with either:

- the newest `js/v*` tag, which represents the next released integration
  candidate;
- upstream `main`, which provides earlier but noisier warning.

The selected SDK is first installed, built and tested exactly as published.
It is then rebuilt with Halyard's pinned crypto version before the complete
daemon suite runs. This separates an upstream packaging failure from a genuine
Halyard compatibility failure. The latest-tag job still fails when either
surface is broken. The upstream-main job is allowed to fail because development
commits may be incomplete, but both results and the exact commit remain visible
in the job summary. The workflow never changes Halyard's committed submodule
pointer.

`js/v0.20.0` removed its lockfile and its `@types/mocha` declaration while
retaining `mocha` in `tsconfig.json`. `scripts/build-proton-sdk.sh` supplies
that missing build-only type package without modifying the submodule. It also
installs and patches Halyard's exact crypto version inside the SDK so the
linked package and runnable daemon use the same crypto ABI. Halyard tracks
crypto 2.1.1 with this SDK release, including its streaming crypto interface,
rather than holding the previous 2.0.0 implementation.

### SDK update notifications

GitHub Dependabot supports git submodules, but follows the latest commit on the
configured branch. Halyard deliberately pins SDK release tags, so enabling the
`gitsubmodule` ecosystem would propose arbitrary upstream `main` commits rather
than new `js/v*` releases.

Instead, the latest-tag canary compares the newest release with the committed
submodule pointer. When they differ, it opens one GitHub issue for that release
with the tag, commit, compatibility result and workflow link. The title makes
the notification idempotent, so daily runs do not create duplicates. Closing
the issue records that the release was reviewed; the next SDK tag receives a
new issue.

## What this can detect

These workflows catch SDK interface changes, dependency and bundling failures,
crypto-object shape changes exercised by Halyard's cache, and regressions in
the pure sync engine. They also verify that the pinned SDK continues to build
from a clean checkout.

Without a dedicated test account they cannot detect a server-only API change,
exercise remote events, or prove compatibility with a cryptographic model that
has not yet appeared in the public SDK. The existing `daemon/scripts/live-test*.mjs`
scripts remain manual for that reason.

## Local equivalent

```bash
git submodule update --init
./scripts/build-proton-sdk.sh
(cd daemon && bun install --frozen-lockfile && bun run check-types && bun run test && bun run build)
```

On Linux with `dbus-run-session` installed, the strict bundle probe is:

```bash
(cd daemon && dbus-run-session -- bun run doctor --strict)
```
