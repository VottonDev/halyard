# Halyard — desktop user interface

The GTK4 / libadwaita front end for Halyard, an **unofficial** two-way sync
client for Proton Drive.

> Halyard is an independent open-source project. It is not made, endorsed, or
> supported by Proton AG. "Proton" and "Proton Drive" are trademarks of
> Proton AG, used here only to describe what this application connects to.

The UI holds no sync logic of its own. It is a thin, fully asynchronous client
for the sync daemon over the session bus; the contract between them is frozen
in [`../docs/dbus-api.md`](../docs/dbus-api.md).

## Requirements

- Python 3.11+
- GTK 4.12+ and libadwaita 1.5+ (developed against GTK 4.22 / libadwaita 1.9)
- PyGObject
- A session D-Bus

No Python packages need installing; everything comes from the system GObject
introspection bindings.

## Running it

The sync daemon does not have to exist. `tests/mock_daemon.py` implements the
whole contract with believable fake data, and `run-dev.sh` starts it together
with the UI:

```sh
./run-dev.sh                  # signed out, so the sign-in flow runs
./run-dev.sh --logged-in      # straight to the folder pair list
./run-dev.sh --logged-in --offline
./run-dev.sh --login-fails    # exercise the sign-in failure path
./run-dev.sh --logged-in --no-pairs   # the empty state
```

Arguments are passed through to the mock daemon; see `--help` for the full set.

### Bus names

The mock owns **`io.github.votton.Halyard.MockDaemon`**, deliberately *not* the
real daemon's `io.github.votton.Halyard.Daemon`, so both can run on the same
session bus without fighting over the name. The UI picks its target from the
`HALYARD_BUS_NAME` environment variable and defaults to the real daemon:

```sh
# against the mock
HALYARD_BUS_NAME=io.github.votton.Halyard.MockDaemon python3 -m halyard.main

# against the real daemon (the default)
python3 -m halyard.main
```

`run-dev.sh --no-mock` points the UI at the real daemon.

> **Careful:** a real daemon is connected to a live Proton Drive account.
> `AddPair`, `RemovePair`, `SyncNow`, `CreateRemoteFolder`, `ResolveConflict`,
> `BeginLogin` and `Logout` all write to it. Do mutation testing against the
> mock. As a safeguard, the mock refuses to claim the production bus name.

### Running the UI on its own

```sh
PYTHONPATH=. python3 -m halyard.main
```

With no daemon on the bus the UI shows a "Sync Service Not Running" state and
recovers by itself the moment one appears — it watches the bus name rather
than polling.

## Layout

```
halyard/
  main.py           Adw.Application: styles, actions, desktop notifications
  dbus_client.py    async D-Bus client; bus-name watching; error mapping
  models.py         tolerant parsers for the JSON payloads in the contract
  window.py         main window, header bar, navigation, global state
  login_view.py     signed-out screen and the browser sign-in hand-off
  pairs_view.py     folder pair list, per-row status and actions
  pair_dialog.py    add/edit a pair; lazy Proton Drive folder browser
  conflicts_view.py conflict list and resolution
  preferences.py    preferences dialog, autostart via the XDG portal
  util.py           formatting helpers; Background portal client
  data/             .desktop file, GSettings schema, CSS, icon
tests/
  mock_daemon.py    standalone fake daemon implementing the full contract
run-dev.sh          mock daemon + UI, in one command
```

## Design notes

**Every D-Bus call is asynchronous.** Nothing blocks the main loop; the mock
deliberately answers some calls slowly (folder listings take ~750 ms) so that
an accidental synchronous call would show up immediately as a frozen window.

**Closing the window does not stop syncing.** That is the point of a sync
client, but it is also surprising, so Halyard says so once in a dialog the
first time the window is closed, and permanently in a footer line and in
Preferences. GNOME has no system tray, so there is no tray icon; status lives
in the window and in notifications.

**Notifications** go through `Gio.Application.send_notification`, so there is
no libnotify dependency. For the desktop to display them, the shipped
`data/io.github.votton.Halyard.desktop` must be installed somewhere in
`XDG_DATA_DIRS` with a name matching the application ID.

**Start on login** goes through the XDG Background portal
(`org.freedesktop.portal.Background.RequestBackground` with `autostart`),
never by writing `~/.config/autostart` directly, so the user is the one who
grants it and it behaves the same inside and outside a sandbox.

**Theming.** No colour is hardcoded. The stylesheet uses libadwaita's named
colours only, so light, dark, and custom accent colours all work.

**Settings.** Window geometry and a couple of one-time flags live in GSettings
(`data/io.github.votton.Halyard.gschema.xml`). `run-dev.sh` compiles the schema
into a temporary directory. If the schema is not installed the app still runs;
it falls back to in-memory defaults and simply does not persist them.

## Mock daemon

`tests/mock_daemon.py` is a standalone script — it needs only PyGObject:

```sh
python3 tests/mock_daemon.py --help
```

It serves five folder pairs in different states (syncing, up to date, error,
scanning, disabled), three conflicts of all three kinds, a browsable remote
folder tree that supports creating folders, an animated transfer that drives
`StatusChanged` roughly four times a second, and a sign-in flow that completes
a few seconds after `BeginLogin`.
