"""Add or edit a folder pair.

A dialog with its own navigation stack: the form is the root page, and
browsing Proton Drive pushes one page per folder level. Folder listings are
fetched lazily, only when a level is actually opened.
"""

from __future__ import annotations

import os

from gi.repository import Adw, Gio, GLib, GObject, Gtk

from .models import Pair, RemoteFolder
from .util import paths_overlap, tilde_path

ROOT_LABEL = "My Files"


class RemoteFolderPage(Adw.NavigationPage):
    """One level of the Proton Drive folder tree."""

    def __init__(self, dialog: "PairDialog", uid: str, title: str,
                 path: str) -> None:
        super().__init__(title=title)
        self._dialog = dialog
        self._uid = uid
        self._path = path
        self._loaded = False

        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()

        new_folder = Gtk.Button(
            icon_name="folder-new-symbolic",
            tooltip_text="Create folder here",
        )
        new_folder.connect("clicked", self._on_new_folder)
        header.pack_end(new_folder)
        toolbar.add_top_bar(header)

        self._banner = Adw.Banner(revealed=False)
        toolbar.add_top_bar(self._banner)

        self._stack = Gtk.Stack(vexpand=True)

        loading = Adw.StatusPage(title="Loading…")
        loading.set_child(self._spinner_box())
        self._stack.add_named(loading, "loading")

        empty = Adw.StatusPage(
            icon_name="folder-symbolic",
            title="No Folders Here",
            description="Create a folder, or sync with this one.",
        )
        self._stack.add_named(empty, "empty")

        scrolled = Gtk.ScrolledWindow(
            hscrollbar_policy=Gtk.PolicyType.NEVER, vexpand=True
        )
        page = Adw.PreferencesPage()
        self._group = Adw.PreferencesGroup()
        page.add(self._group)
        scrolled.set_child(page)
        self._stack.add_named(scrolled, "list")

        error = Adw.StatusPage(
            icon_name="dialog-warning-symbolic",
            title="Could Not Load Folders",
        )
        self._error_page = error
        retry = Gtk.Button(label="Try Again", halign=Gtk.Align.CENTER)
        retry.add_css_class("pill")
        retry.connect("clicked", lambda *_: self.load(force=True))
        error.set_child(retry)
        self._stack.add_named(error, "error")

        toolbar.set_content(self._stack)

        bottom = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL,
            spacing=12,
        )
        bottom.set_margin_top(12)
        bottom.set_margin_bottom(12)
        bottom.set_margin_start(12)
        bottom.set_margin_end(12)
        select = Gtk.Button(label=f"Sync With “{title}”", hexpand=True)
        select.add_css_class("suggested-action")
        select.add_css_class("pill")
        select.connect("clicked", self._on_select)
        bottom.append(select)
        toolbar.add_bottom_bar(bottom)

        self._rows: list[Adw.ActionRow] = []
        self.set_child(toolbar)
        self._stack.set_visible_child_name("loading")

    @staticmethod
    def _spinner_box() -> Gtk.Widget:
        box = Gtk.Box(halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        spinner = Adw.Spinner()
        spinner.set_size_request(32, 32)
        box.append(spinner)
        return box

    def load(self, force: bool = False) -> None:
        if self._loaded and not force:
            return
        self._loaded = True
        self._stack.set_visible_child_name("loading")

        def on_ok(folders: list[RemoteFolder]) -> None:
            for row in self._rows:
                self._group.remove(row)
            self._rows.clear()
            for folder in folders:
                self._group.add(self._make_row(folder))
            self._stack.set_visible_child_name(
                "list" if folders else "empty"
            )

        def on_err(message: str) -> None:
            self._error_page.set_description(message)
            self._stack.set_visible_child_name("error")

        self._dialog.client.list_remote_folders(self._uid, on_ok, on_err)

    def _make_row(self, folder: RemoteFolder) -> Adw.ActionRow:
        row = Adw.ActionRow(
            title=GLib.markup_escape_text(folder.name),
            activatable=True,
        )
        row.add_prefix(Gtk.Image.new_from_icon_name("folder-symbolic"))
        # Only promise a deeper level when the daemon says there is one.
        if folder.has_children:
            row.add_suffix(Gtk.Image.new_from_icon_name("go-next-symbolic"))
        row.set_tooltip_text(folder.path or folder.name)
        row.connect("activated", lambda *_: self._dialog.push_folder(folder))
        self._rows.append(row)
        return row

    def add_created(self, folder: RemoteFolder) -> None:
        if self._stack.get_visible_child_name() in ("empty", "loading"):
            self._stack.set_visible_child_name("list")
        self._group.add(self._make_row(folder))

    def _on_select(self, _button) -> None:
        self._dialog.choose_remote(self._uid, self._path or "/")

    # -- creating a folder ------------------------------------------------

    def _on_new_folder(self, _button) -> None:
        dialog = Adw.AlertDialog(
            heading="New Folder",
            body=f"Create a folder inside “{self.get_title()}”.",
        )
        entry = Adw.EntryRow(title="Folder name")
        group = Adw.PreferencesGroup()
        group.add(entry)
        dialog.set_extra_child(group)
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("create", "Create")
        dialog.set_response_appearance(
            "create", Adw.ResponseAppearance.SUGGESTED
        )
        dialog.set_default_response("create")
        dialog.set_close_response("cancel")

        def on_response(_dialog, response: str) -> None:
            if response != "create":
                return
            name = entry.get_text().strip()
            if not name:
                return
            self._banner.set_revealed(False)

            def on_ok(folder: RemoteFolder) -> None:
                self.add_created(folder)
                self._dialog.toast(f"Created “{folder.name}”")

            def on_err(message: str) -> None:
                self._banner.set_title(message)
                self._banner.set_revealed(True)

            self._dialog.client.create_remote_folder(self._uid, name,
                                                     on_ok, on_err)

        dialog.connect("response", on_response)
        dialog.present(self)


class PairDialog(Adw.Dialog):
    """Create a new folder pair, or edit an existing one."""

    __gsignals__ = {
        "saved": (GObject.SIGNAL_RUN_FIRST, None, ()),
    }

    def __init__(self, client, window, existing_pairs: list[Pair],
                 pair: Pair | None = None) -> None:
        super().__init__()
        self.client = client
        self._window = window
        self._existing = [p for p in existing_pairs
                          if pair is None or p.id != pair.id]
        self._pair = pair
        self._local_path = pair.local_path if pair else ""
        self._remote_uid = pair.remote_uid if pair else ""
        self._remote_path = pair.remote_path if pair else ""

        editing = pair is not None
        self.set_title("Edit Folder Pair" if editing else "Add Folder Pair")
        self.set_content_width(500)
        self.set_content_height(520)

        self._nav = Adw.NavigationView()
        self.set_child(self._nav)
        self._nav.add(self._build_root_page(editing))
        self._revalidate()

    # -- the form ---------------------------------------------------------

    def _build_root_page(self, editing: bool) -> Adw.NavigationPage:
        page = Adw.NavigationPage(
            title="Edit Folder Pair" if editing else "Add Folder Pair"
        )
        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar(show_end_title_buttons=False,
                               show_start_title_buttons=False)

        cancel = Gtk.Button(label="Cancel")
        cancel.connect("clicked", lambda *_: self.close())
        header.pack_start(cancel)

        self._save_button = Gtk.Button(label="Save" if editing else "Add")
        self._save_button.add_css_class("suggested-action")
        self._save_button.connect("clicked", self._on_save)
        header.pack_end(self._save_button)
        toolbar.add_top_bar(header)

        self._banner = Adw.Banner(revealed=False)
        toolbar.add_top_bar(self._banner)

        content = Adw.PreferencesPage()

        local_group = Adw.PreferencesGroup(
            title="On This Computer",
            description="The folder to keep in sync.",
        )
        self._local_row = Adw.ActionRow(
            title="Folder",
            subtitle="Choose a folder…",
            activatable=True,
        )
        self._local_row.add_prefix(
            Gtk.Image.new_from_icon_name("folder-symbolic")
        )
        choose = Gtk.Button(label="Choose…", valign=Gtk.Align.CENTER)
        choose.connect("clicked", self._on_choose_local)
        self._local_row.add_suffix(choose)
        self._local_row.connect("activated", self._on_choose_local)
        local_group.add(self._local_row)
        content.add(local_group)

        remote_group = Adw.PreferencesGroup(
            title="In Proton Drive",
            description="The folder it syncs with.",
        )
        self._remote_row = Adw.ActionRow(
            title="Folder",
            subtitle="Choose a folder…",
            activatable=True,
        )
        self._remote_row.add_prefix(
            Gtk.Image.new_from_icon_name("folder-remote-symbolic")
        )
        browse = Gtk.Button(label="Browse…", valign=Gtk.Align.CENTER)
        browse.connect("clicked", self._on_browse_remote)
        self._remote_row.add_suffix(browse)
        self._remote_row.connect("activated", self._on_browse_remote)
        remote_group.add(self._remote_row)
        content.add(remote_group)

        note_group = Adw.PreferencesGroup()
        note = Gtk.Label(
            label=("Files already in both folders are merged, not replaced. "
                   "Nothing is deleted when a pair is set up."),
            wrap=True,
            xalign=0.0,
        )
        note.add_css_class("dim-label")
        note.add_css_class("caption")
        note_group.add(note)
        content.add(note_group)

        toolbar.set_content(content)
        page.set_child(toolbar)
        self._refresh_rows()
        return page

    def _refresh_rows(self) -> None:
        if self._local_path:
            self._local_row.set_subtitle(
                GLib.markup_escape_text(tilde_path(self._local_path))
            )
        if self._remote_path:
            self._remote_row.set_subtitle(
                GLib.markup_escape_text(self._remote_path)
            )

    # -- local folder -----------------------------------------------------

    def _on_choose_local(self, *_args) -> None:
        dialog = Gtk.FileDialog(
            title="Select a Folder to Sync",
            modal=True,
        )
        if self._local_path and os.path.isdir(self._local_path):
            dialog.set_initial_folder(Gio.File.new_for_path(self._local_path))

        def done(source, result) -> None:
            try:
                folder = source.select_folder_finish(result)
            except GLib.Error as error:
                if not error.matches(Gtk.dialog_error_quark(),
                                     Gtk.DialogError.DISMISSED):
                    self._warn(error.message or "Could not open that folder.")
                return
            if folder is None:
                return
            path = folder.get_path()
            if not path:
                self._warn("That location is not a folder on this computer.")
                return
            self._local_path = path
            self._refresh_rows()
            self._revalidate()

        dialog.select_folder(self._window, None, done)

    # -- remote folder ----------------------------------------------------

    def _on_browse_remote(self, *_args) -> None:
        page = RemoteFolderPage(self, "", ROOT_LABEL, "/")
        self._nav.push(page)
        page.load()

    def push_folder(self, folder: RemoteFolder) -> None:
        page = RemoteFolderPage(self, folder.uid, folder.name, folder.path)
        self._nav.push(page)
        page.load()

    def choose_remote(self, uid: str, path: str) -> None:
        self._remote_uid = uid
        self._remote_path = path
        self._refresh_rows()
        self._revalidate()
        # Unwind the browser and return to the form.
        while self._nav.get_navigation_stack().get_n_items() > 1:
            self._nav.pop()

    # -- validation -------------------------------------------------------

    def _revalidate(self) -> None:
        problem, blocking = self._validate()
        if problem:
            self._banner.set_title(problem)
            self._banner.set_revealed(True)
        else:
            self._banner.set_revealed(False)
        ready = bool(self._local_path and self._remote_uid is not None
                     and self._remote_path)
        self._save_button.set_sensitive(ready and not blocking)

    def _validate(self) -> tuple[str, bool]:
        """Returns (message, blocking).

        Every rule is evaluated rather than returning on the first hit, so a
        mere warning can never hide a blocking problem found later.
        """
        blocking: list[str] = []
        warnings: list[str] = []

        path = self._local_path
        if path:
            if not os.path.exists(path):
                blocking.append(f"{tilde_path(path)} no longer exists.")
            elif not os.path.isdir(path):
                blocking.append(f"{tilde_path(path)} is not a folder.")
            elif not os.access(path, os.R_OK):
                blocking.append(f"{tilde_path(path)} cannot be read.")
            else:
                for other in self._existing:
                    if (os.path.normpath(other.local_path)
                            == os.path.normpath(path)):
                        blocking.append(
                            f"{tilde_path(path)} is already synced with "
                            f"{other.remote_path}."
                        )
                        break
                else:
                    for other in self._existing:
                        if paths_overlap(other.local_path, path):
                            warnings.append(
                                "This folder overlaps "
                                f"{tilde_path(other.local_path)}, which is "
                                "already synced. Nested pairs can copy files "
                                "back and forth."
                            )
                            break

        if self._remote_uid:
            for other in self._existing:
                if other.remote_uid == self._remote_uid:
                    blocking.append(
                        f"{other.remote_path} is already synced with "
                        f"{tilde_path(other.local_path)}."
                    )
                    break

        if blocking:
            return (blocking[0], True)
        if warnings:
            return (warnings[0], False)
        return ("", False)

    def _warn(self, message: str) -> None:
        self._banner.set_title(message)
        self._banner.set_revealed(True)

    # -- saving -----------------------------------------------------------

    def _on_save(self, _button) -> None:
        self._save_button.set_sensitive(False)
        spinner = Adw.Spinner()
        self._save_button.set_child(spinner)

        def on_ok(_pair: Pair) -> None:
            self.emit("saved")
            self.close()

        def on_err(message: str) -> None:
            self._save_button.set_child(None)
            self._save_button.set_label(
                "Save" if self._pair else "Add"
            )
            self._save_button.set_sensitive(True)
            self._warn(message)

        if self._pair is not None:
            self.client.update_pair(
                self._pair.id,
                {
                    "localPath": self._local_path,
                    "remoteUid": self._remote_uid,
                    "remotePath": self._remote_path,
                },
                on_ok, on_err,
            )
        else:
            self.client.add_pair(
                self._local_path, self._remote_uid, self._remote_path,
                on_ok, on_err,
            )

    def toast(self, message: str) -> None:
        window = self._window
        if hasattr(window, "toast"):
            window.toast(message)
