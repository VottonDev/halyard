# Continuous integration

Halyard has three account-free GitHub Actions workflows. None signs in to
Proton or makes Drive API calls.

## Pull-request checks

`.github/workflows/ci.yml` is the merge gate.
It builds the Proton SDK revision pinned by the `proton-sdk` submodule.
It then runs Halyard's type checks, both test runners and the production bundle build.
It also runs a strict offline environment probe.
It tests the minimum supported Node release and the current Node LTS line.

The probe verifies the bundled SDK entry points, SQLite, D-Bus and an OpenPGP
round trip. A separate bundled Node test exercises the versioned
crypto-material cache with generated keys. It uses no account data.
The test checks that another cache instance can read the encrypted state.

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

- the newest `js/v*` tag, to test the next released SDK candidate
- upstream `main`, to warn about changes before an SDK release

The workflow first installs, builds and tests the selected SDK exactly as published.
It retains the untouched output in the workflow log.
The package can request Mocha types without declaring `@types/mocha`.
If this causes a failure, the workflow reports the known packaging defect.
It adds only that missing build dependency, then continues the upstream build and tests.
This exposes failures that the first TypeScript error would otherwise hide.

The SDK is then rebuilt with Halyard's pinned crypto version before the complete
daemon suite runs. This keeps three separate signals visible: the published
package health, the upstream result after the minimal diagnostic repair, and
Halyard compatibility. An unrecognised packaging failure, a failure after the
minimal repair, or a Halyard compatibility failure makes the latest-tag job
fail. The upstream-main job is allowed to fail because development commits may
be incomplete. All results and the exact commit remain visible in the job summary.
The workflow never changes Halyard's committed submodule pointer.

SDK releases from `js/v0.20.0` to `js/v0.23.0` omitted their lockfile and
`@types/mocha` declaration while retaining `mocha` in `tsconfig.json`.
`js/v0.24.0` includes a lockfile and no longer requests Mocha types.
`scripts/build-proton-sdk.sh` retains the missing-types workaround for older
releases. It also installs and patches Halyard's exact crypto version inside
the SDK so the linked package and runnable daemon use the same crypto ABI.
Halyard pins crypto 2.2.0 to satisfy the Drive and account SDKs' peer dependency.
Its patch matches the pinned SDK's crypto patch, including the full OpenPGP
entry point and stream type declarations. The daily canary keeps any original
missing-types failure visible as a warning, but does not remain red solely
for that accepted defect.

When upgrading the SDK, refresh its `file:` package metadata in `daemon/bun.lock`
as well as the submodule pointer. A normal Bun install can retain older dependency
declarations. Test a clean frozen install.
Check that the emitted daemon has one active crypto server clock.

### SDK update notifications

GitHub Dependabot supports git submodules, but follows the latest commit on the
configured branch. Halyard deliberately pins SDK release tags, so enabling the
`gitsubmodule` ecosystem would propose arbitrary upstream `main` commits rather
than new `js/v*` releases.

Instead, the latest-tag canary compares the newest release with the committed
submodule pointer. When they differ, it opens one GitHub issue for that release
with the tag, commit, compatibility result and workflow link. The title makes
the notification idempotent, so daily runs do not create duplicates. Closing
the issue records that the release was reviewed. The next SDK tag receives a
new issue.

## What this can detect

These workflows catch SDK interface changes, dependency and bundling failures,
crypto-object shape changes exercised by Halyard's cache, and regressions in
the pure sync engine. They also check that the pinned SDK continues to build
from a clean checkout.

Without a dedicated test account, these workflows cannot:

- Detect an API change made only on the server.
- Exercise remote events.
- Prove compatibility with a cryptographic model absent from the public SDK.

The existing `daemon/scripts/live-test*.mjs` scripts remain manual for that reason.

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
