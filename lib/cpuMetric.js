// modern-bar — CPU % metric
//
// Reads total CPU load from /proc/stat deltas between samples. Renders "CPU nn%".
// Flares Clu-orange (alert) at/above the configured warning threshold.
// Async file reads, single GLib timeout, everything torn down in destroy().

import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

export const CpuMetric = GObject.registerClass(
class CpuMetric extends St.BoxLayout {
    _init(settings, iconsPath) {
        super._init({
            style_class: 'modern-bar-metric modern-bar-cpu',
            y_align: Clutter.ActorAlign.CENTER,
            // reactive lets the actor RECEIVE pointer events; track_hover is what
            // actually drives the CSS :hover pseudo-class. Both are required —
            // reactive alone leaves :hover permanently unmatched.
            reactive: true,
            track_hover: true,
        });
        this._settings = settings;

        // Bundled symbolic CPU-chip icon (tints cyan like the other glyphs).
        this._icon = new St.Icon({
            style_class: 'modern-bar-metric-icon',
            gicon: Gio.icon_new_for_string(`${iconsPath}/modernbar-cpu-symbolic.svg`),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'modern-bar-metric-label',
            text: '--%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);
        this.add_child(this._label);

        this._prevTotal = 0;
        this._prevIdle = 0;
        this._timeoutId = 0;

        // React to config changes (interval, warn threshold, visibility).
        this._settingsIds = [
            this._settings.connect('changed::cpu-refresh-seconds', () => this._restart()),
            this._settings.connect('changed::show-cpu', () => this._syncVisible()),
        ];

        this._syncVisible();
    }

    _syncVisible() {
        const show = this._settings.get_boolean('show-cpu');
        this.visible = show;
        if (show)
            this._restart();
        else
            this._stop();
    }

    _restart() {
        this._stop();
        if (!this._settings.get_boolean('show-cpu'))
            return;
        // Prime a first sample immediately, then poll.
        this._sample();
        const secs = this._settings.get_int('cpu-refresh-seconds');
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stop() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _sample() {
        // Async read so we never block the shell on filesystem I/O.
        const file = Gio.File.new_for_path('/proc/stat');
        file.load_contents_async(null, (f, res) => {
            let contents;
            try {
                [, contents] = f.load_contents_finish(res);
            } catch (e) {
                return; // fail-silent; keep last value
            }
            const text = new TextDecoder().decode(contents);
            const line = text.split('\n', 1)[0];               // "cpu  a b c d ..."
            const parts = line.trim().split(/\s+/).slice(1).map(Number);
            if (parts.length < 4)
                return;
            const idle = parts[3] + (parts[4] || 0);           // idle + iowait
            const total = parts.reduce((a, b) => a + b, 0);

            const dTotal = total - this._prevTotal;
            const dIdle = idle - this._prevIdle;
            this._prevTotal = total;
            this._prevIdle = idle;

            if (dTotal <= 0)
                return; // first sample or counter wrap; wait for the next
            const usage = Math.round(100 * (dTotal - dIdle) / dTotal);
            this._render(Math.max(0, Math.min(100, usage)));
        });
    }

    _render(pct) {
        this._label.set_text(`${pct}%`);
        const warn = this._settings.get_int('cpu-warn-percent');
        if (pct >= warn)
            this._label.add_style_class_name('modern-bar-alert');
        else
            this._label.remove_style_class_name('modern-bar-alert');
    }

    destroy() {
        this._stop();
        if (this._settingsIds) {
            for (const id of this._settingsIds)
                this._settings.disconnect(id);
            this._settingsIds = null;
        }
        super.destroy();
    }
});
