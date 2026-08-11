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

The selected SDK is first installed, built and tested exactly as published,
with the untouched output retained in the workflow log. If that fails because
the package requests Mocha types without declaring `@types/mocha`, the workflow
reports the known packaging defect and adds only that missing build dependency
before continuing the upstream build and tests. This exposes any failure that
the first TypeScript error would otherwise hide.

The SDK is then rebuilt with Halyard's pinned crypto version before the complete
daemon suite runs. This keeps three separate signals visible: the published
package health, the upstream result after the minimal diagnostic repair, and
Halyard compatibility. An unrecognised packaging failure, a failure after the
minimal repair, or a Halyard compatibility failure makes the latest-tag job
fail. The upstream-main job is allowed to fail because development commits may
be incomplete, but all results and the exact commit remain visible in the job
summary. The workflow never changes Halyard's committed submodule pointer.

Starting with `js/v0.20.0`, upstream releases omit their lockfile and
`@types/mocha` declaration while
retaining `mocha` in `tsconfig.json`. `scripts/build-proton-sdk.sh` supplies
that missing build-only type package without modifying the submodule. It also
installs and patches Halyard's exact crypto version inside the SDK so the
linked package and runnable daemon use the same crypto ABI. Halyard tracks
crypto 2.1.1 with this SDK release, including its streaming crypto interface,
rather than holding the previous 2.0.0 implementation. The daily canary keeps
the original missing-types failure visible as a warning, but does not remain
red solely for that accepted defect.

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
