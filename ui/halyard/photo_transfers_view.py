"""Photo transfers are user-requested jobs, separate from folder sync history."""
from gi.repository import Adw, Gio, GLib, Gtk
from .util import format_size, tilde_path


class PhotoTransfersView(Gtk.Box):
    def __init__(self, client, window):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.client, self.window = client, window
        self.downloads, self.uploads = (), ()
        self._cards = {}
        self._loaded = False
        self._request = 0
        self._handlers = [client.connect("photo-downloads-changed", self._downloads_changed),
                          client.connect("photo-uploads-changed", self._uploads_changed)]
        scroll = Gtk.ScrolledWindow(vexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER)
        self._page = Adw.PreferencesPage()
        self._group = Adw.PreferencesGroup(title="Photo Transfers", description=(
            "Transfers continue while the window is closed. Unfinished jobs stop when the service quits; "
            "choose those files again after restarting it."))
        self._page.add(self._group)
        scroll.set_child(self._page)
        self.append(scroll)
        self._empty = Adw.StatusPage(title="No Photo Transfers", icon_name="folder-download-symbolic",
                                    description="Photos you upload or download will appear here.")
        self.append(self._empty)

    def dispose(self):
        self._request += 1
        for handler in self._handlers: self.client.disconnect(handler)

    def activate(self):
        if self._loaded or not self.window.account_logged_in:
            return
        self._loaded = True
        request = self._request
        def downloads(jobs):
            if request == self._request: self._downloads_changed(None, jobs)
        def uploads(jobs):
            if request == self._request: self._uploads_changed(None, jobs)
        def failed(message):
            if request == self._request:
                self._loaded = False
                self.window.toast(message)
        self.client.list_photo_downloads(downloads, failed)
        self.client.list_photo_uploads(uploads, failed)

    def reset(self):
        self._request += 1
        self._loaded = False
        self.downloads, self.uploads = (), ()
        self._render()

    def _downloads_changed(self, _client, jobs):
        self.downloads = jobs
        self._render()

    def _uploads_changed(self, _client, jobs):
        self.uploads = jobs
        self._render()

    def _render(self):
        jobs = [(j, False) for j in self.downloads] + [(j, True) for j in self.uploads]
        jobs.sort(key=lambda entry: entry[0].created_at, reverse=True)
        wanted = {j.id for j, _ in jobs}
        for key in list(self._cards):
            if key not in wanted:
                self._group.remove(self._cards.pop(key)[0])
        self._empty.set_visible(not jobs)
        for job, upload in jobs:
            if job.id not in self._cards:
                row = Adw.ExpanderRow()
                progress = Gtk.ProgressBar(show_text=True)
                progress.set_margin_start(12); progress.set_margin_end(12)
                progress_row = Adw.ActionRow(title="Progress")
                progress_row.add_suffix(progress)
                row.add_row(progress_row)
                actions = Gtk.Box(spacing=6, valign=Gtk.Align.CENTER)
                row.add_suffix(actions)
                details = Adw.ActionRow(title="Files")
                details.set_subtitle_lines(0)
                row.add_row(details)
                self._group.add(row)
                self._cards[job.id] = (row, progress, actions, details)
            row, progress, actions, details = self._cards[job.id]
            done = sum(f.status in ("completed", "skipped") for f in job.files)
            verb = "Upload" if upload else "Download"
            row.set_title(f"{verb} · {len(job.files)} files")
            row.set_subtitle(GLib.markup_escape_text(f"{job.status.capitalize()} · {job.destination if upload else tilde_path(job.destination)}"))
            progress.set_fraction(job.fraction)
            progress.set_text(f"{done} of {len(job.files)} files · {int(job.fraction * 100)}%")
            text = "\n".join(f"{f.name}: {f.error or ('Already in the gallery' if f.status == 'skipped' else f.status)}" for f in job.files)
            details.set_subtitle(GLib.markup_escape_text(text))
            child = actions.get_first_child()
            while child:
                next_child = child.get_next_sibling(); actions.remove(child); child = next_child
            control = self.client.control_photo_upload if upload else self.client.control_photo_download
            def button(label, action):
                b = Gtk.Button(label=label)
                b.connect("clicked", lambda _b, job_id=job.id, operation=action, call=control: call(job_id, operation, lambda _r: None, self.window.toast))
                actions.append(b)
            if job.status in ("queued", "downloading", "uploading"): button("Pause", "pause")
            elif job.status == "paused": button("Resume", "resume")
            if job.active: button("Cancel", "cancel")
            elif job.status in ("failed", "cancelled"): button("Retry", "retry")
            if not upload and any(f.path for f in job.files):
                b = Gtk.Button(icon_name="folder-open-symbolic", tooltip_text="Open download folder")
                b.connect("clicked", lambda _b, folder=job.destination: self._open(folder))
                actions.append(b)
        self.window.update_photo_transfer_status(self.downloads + self.uploads)

    def _open(self, folder):
        launcher = Gtk.FileLauncher.new(Gio.File.new_for_path(folder))
        def done(source, result):
            try: source.launch_finish(result)
            except GLib.Error as error: self.window.toast(error.message)
        launcher.launch(self.window, None, done)
