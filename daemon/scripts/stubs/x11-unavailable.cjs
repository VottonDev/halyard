// dbus-next optionally uses x11 to discover the bus address from an X11 window
// selection. We only ever reach the bus via DBUS_SESSION_BUS_ADDRESS or the
// filesystem, and that fallback is X11-only anyway, so we stub it out.
//
// dbus-next checks `if (x11 === null)` and throws a descriptive error, so
// exporting null keeps its own error path intact.
module.exports = null;
