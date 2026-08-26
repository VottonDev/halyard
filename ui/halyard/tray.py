"""StatusNotifierItem tray icon, spoken directly over D-Bus.

GNOME has no built-in tray, but many users run an AppIndicator extension,
which provides ``org.kde.StatusNotifierWatcher``. The usual client library
for this is AppIndicator3, which is GTK3 — and GTK3 cannot be loaded into a
GTK4 process. So both halves of the protocol are implemented here with Gio:

* ``org.kde.StatusNotifierItem`` at /StatusNotifierItem — the icon itself
* ``com.canonical.dbusmenu`` at /MenuBar — its menu

The watcher is watched rather than assumed: an extension can be enabled or
disabled at any time, and the tray has to appear and disappear with it.
"""

from __future__ import annotations

from typing import Callable

from gi.repository import Gdk, Gio, GLib, GObject, Gtk

from .models import (
    STATUS_ERROR,
    STATUS_SCANNING,
    STATUS_SETUP,
    STATUS_SYNCING,
    Status,
)

WATCHER_BUS = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"
WATCHER_IFACE = "org.kde.StatusNotifierWatcher"

ITEM_PATH = "/StatusNotifierItem"
ITEM_IFACE = "org.kde.StatusNotifierItem"

MENU_PATH = "/MenuBar"
MENU_IFACE = "com.canonical.dbusmenu"

#: Menu item ids. 0 is the root, as the dbusmenu spec requires.
ID_OPEN = 1
ID_SYNC = 2
ID_SEP1 = 3
ID_PAUSE = 4
ID_SEP2 = 5
ID_QUIT = 6

ITEM_XML = f"""
<node>
  <interface name="{ITEM_IFACE}">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionMovieName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <method name="Activate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="SecondaryActivate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="ContextMenu">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="Scroll">
      <arg name="delta" type="i" direction="in"/>
      <arg name="orientation" type="s" direction="in"/>
    </method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewAttentionIcon"/>
    <signal name="NewOverlayIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus">
      <arg name="status" type="s"/>
    </signal>
  </interface>
</node>
"""

MENU_XML = f"""
<node>
  <interface name="{MENU_IFACE}">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg name="parentId" type="i" direction="in"/>
      <arg name="recursionDepth" type="i" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="revision" type="u" direction="out"/>
      <arg name="layout" type="(ia{{sv}}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="properties" type="a(ia{{sv}})" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg name="id" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="Event">
      <arg name="id" type="i" direction="in"/>
      <arg name="eventId" type="s" direction="in"/>
      <arg name="data" type="v" direction="in"/>
      <arg name="timestamp" type="u" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg name="events" type="a(isvu)" direction="in"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg name="id" type="i" direction="in"/>
      <arg name="needUpdate" type="b" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="updatesNeeded" type="ai" direction="out"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated">
      <arg name="updatedProps" type="a(ia{{sv}})"/>
      <arg name="removedProps" type="a(ias)"/>
    </signal>
    <signal name="LayoutUpdated">
      <arg name="revision" type="u"/>
      <arg name="parent" type="i"/>
    </signal>
    <signal name="ItemActivationRequested">
      <arg name="id" type="i"/>
      <arg name="timestamp" type="u"/>
    </signal>
  </interface>
</node>
"""


def first_available_icon(*names: str) -> str:
    """First icon name the current theme actually has.

    Icon names drift between icon-theme releases, and a name the theme lacks
    renders as a broken image in the panel, so every choice is checked.
    """
    display = Gdk.Display.get_default()
    if display is not None:
        theme = Gtk.IconTheme.get_for_display(display)
        for name in names:
            if name and theme.has_icon(name):
                return name
    return names[-1] if names else "application-x-executable"


class TrayIcon(GObject.Object):
    """A StatusNotifierItem reflecting sync state, with a small menu."""

    __gsignals__ = {
        # The user asked for the window: left click, or "Open Halyard".
        "activate-requested": (GObject.SIGNAL_RUN_FIRST, None, ()),
        # One of: sync, pause, resume, quit
        "menu-action": (GObject.SIGNAL_RUN_FIRST, None, (str,)),
        # Whether a tray host is currently available to show us.
        "availability-changed": (GObject.SIGNAL_RUN_FIRST, None, (bool,)),
    }

    def __init__(self, connection: Gio.DBusConnection) -> None:
        super().__init__()
        self._bus = connection
        self._watch_id = 0
        self._item_reg = 0
        self._menu_reg = 0
        self._available = False
        self._registered = False

        self._revision = 1
        self._last_items: list[dict] | None = None

        # Rendered state
        self._icon_name = "network-offline-symbolic"
        self._status = "Active"
        self._tooltip_title = "Halyard"
        self._tooltip_body = "Starting…"
        self._paused = False
        self._can_sync = False

        self._item_info = Gio.DBusNodeInfo.new_for_xml(ITEM_XML).interfaces[0]
        self._menu_info = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]

    # -- lifecycle -------------------------------------------------------

    @property
    def available(self) -> bool:
        return self._available

    def start(self) -> None:
        if self._watch_id:
            return
        self._export()
        self._watch_id = Gio.bus_watch_name_on_connection(
            self._bus,
            WATCHER_BUS,
            Gio.BusNameWatcherFlags.NONE,
            self._on_watcher_appeared,
            self._on_watcher_vanished,
        )

    def stop(self) -> None:
        if self._watch_id:
            Gio.bus_unwatch_name(self._watch_id)
            self._watch_id = 0
        self._unexport()
        self._available = False
        self._registered = False

    def _register(self, closure, path, info) -> int:
        register = (
            getattr(self._bus, "register_object_with_closures2", None)
            or getattr(self._bus, "register_object_with_closures", None)
            or self._bus.register_object
        )
        return register(path, info, closure[0], closure[1], None)

    def _export(self) -> None:
        if not self._item_reg:
            self._item_reg = self._register(
                (self._on_item_method, self._on_item_get_property),
                ITEM_PATH, self._item_info,
            )
        if not self._menu_reg:
            self._menu_reg = self._register(
                (self._on_menu_method, self._on_menu_get_property),
                MENU_PATH, self._menu_info,
            )

    def _unexport(self) -> None:
        for reg in (self._item_reg, self._menu_reg):
            if reg:
                try:
                    self._bus.unregister_object(reg)
                except Exception:
                    pass
        self._item_reg = 0
        self._menu_reg = 0

    def _on_watcher_appeared(self, connection, name, owner) -> None:
        self._export()
        unique = self._bus.get_unique_name()

        def done(source, result) -> None:
            try:
                source.call_finish(result)
            except GLib.Error:
                # A watcher that refuses us is the same as having none.
                self._registered = False
                self._set_available(False)
                return
            self._registered = True
            self._set_available(True)

        # Registering by unique bus name is what the other items on this bus
        # do, and every current host accepts it.
        self._bus.call(
            WATCHER_BUS, WATCHER_PATH, WATCHER_IFACE,
            "RegisterStatusNotifierItem",
            GLib.Variant("(s)", [unique]),
            None, Gio.DBusCallFlags.NONE, 10_000, None, done,
        )

    def _on_watcher_vanished(self, connection, name) -> None:
        self._registered = False
        self._set_available(False)

    def _set_available(self, available: bool) -> None:
        if available == self._available:
            return
        self._available = available
        self.emit("availability-changed", available)

    # -- state -----------------------------------------------------------

    def update(self, status: Status, logged_in: bool,
               daemon_available: bool) -> None:
        """Recompute icon, tooltip and menu from the latest status."""
        icon, title, body, sni_status = self._describe(
            status, logged_in, daemon_available
        )
        self._paused = status.paused
        self._can_sync = daemon_available and logged_in and not status.paused

        if icon != self._icon_name:
            self._icon_name = icon
            self._emit_item_signal("NewIcon")
        if sni_status != self._status:
            self._status = sni_status
            self._emit_item_signal(
                "NewStatus", GLib.Variant("(s)", [sni_status])
            )
        if (title, body) != (self._tooltip_title, self._tooltip_body):
            self._tooltip_title = title
            self._tooltip_body = body
            self._emit_item_signal("NewToolTip")

        self._refresh_menu()

    def _describe(self, status: Status, logged_in: bool,
                  daemon_available: bool):
        if not daemon_available:
            return (
                first_available_icon("network-offline-symbolic",
                                     "folder-symbolic"),
                "Halyard", "Sync service not running", "Active",
            )
        if not logged_in:
            return (
                first_available_icon("avatar-default-symbolic",
                                     "network-offline-symbolic",
                                     "folder-symbolic"),
                "Halyard", "Not signed in", "Active",
            )
        # Same precedence as the window's status line, so the two surfaces
        # never disagree about what the app is doing.
        if status.paused:
            return (
                first_available_icon("media-playback-pause-symbolic",
                                     "folder-symbolic"),
                "Halyard", "Syncing paused", "Active",
            )
        if not status.online:
            return (
                first_available_icon("network-offline-symbolic",
                                     "folder-symbolic"),
                "Halyard", "Waiting for Proton Drive", "Active",
            )
        errored = [p for p in status.pairs if p.status == STATUS_ERROR]
        if errored:
            phrase = ("1 folder needs" if len(errored) == 1
                      else f"{len(errored)} folders need")
            return (
                first_available_icon("dialog-warning-symbolic",
                                     "folder-symbolic"),
                "Halyard", f"{phrase} attention", "NeedsAttention",
            )
        busy = any(
            p.enabled and p.status in (STATUS_SYNCING, STATUS_SCANNING,
                                       STATUS_SETUP)
            for p in status.pairs
        )
        if busy:
            activity = status.activity
            if activity is not None and activity.bytes_total:
                verb = "Uploading" if activity.is_upload else "Downloading"
                body = f"{verb} · {int(activity.fraction * 100)}%"
            else:
                body = "Syncing…"
            return (
                first_available_icon("view-refresh-symbolic",
                                     "folder-symbolic"),
                "Halyard", body, "Active",
            )
        if not status.pairs:
            return (
                first_available_icon("folder-symbolic"),
                "Halyard", "No folders synced", "Active",
            )
        return (
            first_available_icon("object-select-symbolic", "folder-symbolic"),
            "Halyard", "All folders up to date", "Active",
        )

    # -- the menu --------------------------------------------------------

    def _menu_items(self) -> list[dict]:
        return [
            {"id": ID_OPEN, "label": "Open Halyard", "enabled": True},
            {"id": ID_SYNC, "label": "Sync Now", "enabled": self._can_sync},
            {"id": ID_SEP1, "separator": True},
            {
                "id": ID_PAUSE,
                "label": "Resume Syncing" if self._paused else "Pause Syncing",
                "enabled": True,
            },
            {"id": ID_SEP2, "separator": True},
            # Says plainly that the daemon lives on; otherwise "Quit" reads as
            # "stop syncing", which is not what it does.
            {"id": ID_QUIT, "label": "Quit Halyard (Syncing Continues)",
             "enabled": True},
        ]

    def _refresh_menu(self) -> None:
        items = self._menu_items()
        if items == self._last_items:
            return
        # The layout genuinely changed, so bump the revision. Hosts cache by
        # revision and will not re-read the menu if it does not move.
        self._last_items = items
        self._revision += 1
        self._emit_menu_signal(
            "LayoutUpdated", GLib.Variant("(ui)", [self._revision, 0])
        )

    @staticmethod
    def _item_props(item: dict) -> dict:
        if item.get("separator"):
            return {"type": GLib.Variant("s", "separator"),
                    "visible": GLib.Variant("b", True)}
        return {
            "label": GLib.Variant("s", item["label"]),
            "enabled": GLib.Variant("b", bool(item.get("enabled", True))),
            "visible": GLib.Variant("b", True),
        }

    def _layout_tuple(self) -> tuple:
        """The root node as plain data.

        Deliberately not a GLib.Variant: a pre-built variant cannot be nested
        where a struct is expected. Only the `av` children and the `a{sv}`
        property values have to be variants themselves.
        """
        children = [
            GLib.Variant("(ia{sv}av)", (item["id"], self._item_props(item), []))
            for item in self._menu_items()
        ]
        return (0, {"children-display": GLib.Variant("s", "submenu")}, children)

    # -- exported methods ------------------------------------------------

    def _on_item_method(self, connection, sender, path, iface, method,
                        params, invocation) -> None:
        if method in ("Activate", "SecondaryActivate"):
            self.emit("activate-requested")
            invocation.return_value(None)
        elif method == "ContextMenu":
            # The host draws the menu from com.canonical.dbusmenu itself.
            invocation.return_value(None)
        elif method == "Scroll":
            invocation.return_value(None)
        else:
            invocation.return_dbus_error(
                "org.freedesktop.DBus.Error.UnknownMethod", method
            )

    def _on_item_get_property(self, connection, sender, path, iface,
                              prop) -> GLib.Variant:
        if prop == "Category":
            return GLib.Variant("s", "ApplicationStatus")
        if prop == "Id":
            return GLib.Variant("s", "io.github.votton.Halyard")
        if prop == "Title":
            return GLib.Variant("s", "Halyard")
        if prop == "Status":
            return GLib.Variant("s", self._status)
        if prop == "WindowId":
            return GLib.Variant("i", 0)
        if prop == "IconName":
            return GLib.Variant("s", self._icon_name)
        if prop == "AttentionIconName":
            return GLib.Variant(
                "s",
                self._icon_name if self._status == "NeedsAttention" else "",
            )
        if prop in ("OverlayIconName", "AttentionMovieName", "IconThemePath"):
            return GLib.Variant("s", "")
        if prop == "IconPixmap":
            return GLib.Variant("a(iiay)", [])
        if prop == "ToolTip":
            return GLib.Variant(
                "(sa(iiay)ss)",
                (self._icon_name, [], self._tooltip_title, self._tooltip_body),
            )
        if prop == "Menu":
            return GLib.Variant("o", MENU_PATH)
        if prop == "ItemIsMenu":
            # False: a left click should raise the window, not open the menu.
            return GLib.Variant("b", False)
        return None

    def _on_menu_method(self, connection, sender, path, iface, method,
                        params, invocation) -> None:
        if method == "GetLayout":
            invocation.return_value(
                GLib.Variant("(u(ia{sv}av))",
                             (self._revision, self._layout_tuple()))
            )
        elif method == "GetGroupProperties":
            ids, _names = params.unpack()
            wanted = set(ids)
            result = [
                (item["id"], self._item_props(item))
                for item in self._menu_items()
                if not wanted or item["id"] in wanted
            ]
            invocation.return_value(GLib.Variant("(a(ia{sv}))", (result,)))
        elif method == "GetProperty":
            item_id, name = params.unpack()
            value = None
            for item in self._menu_items():
                if item["id"] == item_id:
                    value = self._item_props(item).get(name)
                    break
            invocation.return_value(
                GLib.Variant("(v)", (value or GLib.Variant("s", ""),))
            )
        elif method == "Event":
            item_id, event_id, _data, _ts = params.unpack()
            if event_id == "clicked":
                self._on_menu_clicked(item_id)
            invocation.return_value(None)
        elif method == "EventGroup":
            events, = params.unpack()
            for item_id, event_id, _data, _ts in events:
                if event_id == "clicked":
                    self._on_menu_clicked(item_id)
            invocation.return_value(GLib.Variant("(ai)", ([],)))
        elif method == "AboutToShow":
            invocation.return_value(GLib.Variant("(b)", (False,)))
        elif method == "AboutToShowGroup":
            invocation.return_value(GLib.Variant("(aiai)", ([], [])))
        else:
            invocation.return_dbus_error(
                "org.freedesktop.DBus.Error.UnknownMethod", method
            )

    def _on_menu_get_property(self, connection, sender, path, iface,
                              prop) -> GLib.Variant:
        if prop == "Version":
            return GLib.Variant("u", 3)
        if prop == "TextDirection":
            return GLib.Variant(
                "s",
                "rtl" if Gtk.Widget.get_default_direction()
                == Gtk.TextDirection.RTL else "ltr",
            )
        if prop == "Status":
            return GLib.Variant("s", "normal")
        if prop == "IconThemePath":
            return GLib.Variant("as", [])
        return None

    def _on_menu_clicked(self, item_id: int) -> None:
        if item_id == ID_OPEN:
            self.emit("activate-requested")
        elif item_id == ID_SYNC:
            self.emit("menu-action", "sync")
        elif item_id == ID_PAUSE:
            self.emit("menu-action", "resume" if self._paused else "pause")
        elif item_id == ID_QUIT:
            self.emit("menu-action", "quit")

    # -- signal helpers --------------------------------------------------

    def _emit_item_signal(self, name: str,
                          body: GLib.Variant | None = None) -> None:
        if not self._item_reg:
            return
        try:
            self._bus.emit_signal(None, ITEM_PATH, ITEM_IFACE, name, body)
        except GLib.Error:
            pass

    def _emit_menu_signal(self, name: str,
                          body: GLib.Variant | None = None) -> None:
        if not self._menu_reg:
            return
        try:
            self._bus.emit_signal(None, MENU_PATH, MENU_IFACE, name, body)
        except GLib.Error:
            pass
