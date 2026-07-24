// modern-bar — palette watcher
//
// Keeps the bar's day/night (Tron/Clu) palette in sync with the user's kitty
// tron-theme switch, one-way: the TERMINAL drives the BAR, never the reverse.
// Flipping the bar's own prefs toggle only changes the bar — it must never
// reach out and change kitty's theme.
//
// Mechanism, deliberately mirroring tron-theme itself (see ~/.local/bin/tron-theme):
//   ~/.config/kitty/themes/theme-active.conf is a symlink to either
//   theme-day.conf or theme-night.conf. tron-theme swaps that symlink target.
//   We watch the symlink (a Gio.FileMonitor — event-driven, no polling) and,
//   whenever it changes, read which file it now points at and set the
//   'night-mode' GSettings key to match. CSS reacts to that key instantly
//   (see extension.js / stylesheet.css's .modern-bar-night rules).
//
// tron-theme was ALSO updated to set 'night-mode' directly via `gsettings set`
// on day/night/toggle, so the flip is instant and doesn't wait on inotify
// latency — this file monitor is the fallback/complement for when the symlink
// changes some other way (manual edit, a different script, etc.).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const ACTIVE_THEME_PATH = GLib.build_filenamev(
    [GLib.get_home_dir(), '.config', 'kitty', 'themes', 'theme-active.conf']);

export class PaletteWatcher {
    constructor(settings) {
        this._settings = settings;
        this._monitor = null;
        this._changedId = 0;
    }

    // Sync once immediately (covers "bar enabled after a switch happened while
    // it was off"), then start watching for further changes.
    start() {
        this._syncFromKittyTheme();

        const file = Gio.File.new_for_path(ACTIVE_THEME_PATH);
        try {
            // NOFOLLOW: we want to know when the SYMLINK TARGET changes, which
            // Gio reports as a change on the link path itself.
            this._monitor = file.monitor(Gio.FileMonitorFlags.NONE, null);
            this._changedId = this._monitor.connect('changed', () => {
                this._syncFromKittyTheme();
            });
        } catch (e) {
            // fail-silent: no kitty config, or unreadable — the bar just keeps
            // whatever night-mode value it already has (prefs toggle still works).
        }
    }

    stop() {
        if (this._monitor && this._changedId) {
            this._monitor.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._monitor = null;
    }

    // Resolve the symlink target's basename ("theme-day.conf" /
    // "theme-night.conf") and set night-mode accordingly. Fail-silent.
    _syncFromKittyTheme() {
        try {
            const link = Gio.File.new_for_path(ACTIVE_THEME_PATH);
            const info = link.query_info(
                Gio.FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            const target = info.get_symlink_target();
            if (!target)
                return;
            const isNight = GLib.path_get_basename(target).includes('night');
            // Only write if it actually differs, so we don't spam GSettings
            // (and don't fight a user who set night-mode by hand to something
            // that doesn't match their kitty theme, more than once per change).
            if (this._settings.get_boolean('night-mode') !== isNight)
                this._settings.set_boolean('night-mode', isNight);
        } catch (e) {
            // fail-silent
        }
    }
}
