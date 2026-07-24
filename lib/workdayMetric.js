// modern-bar — Workday % metric
//
// Shows how far through the configured work day we are as a briefcase glyph +
// "nn%". Hidden entirely outside work hours (and when show-workday is off). One
// low-frequency timer — the value only needs to move about once a minute.

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

export const WorkdayMetric = GObject.registerClass(
class WorkdayMetric extends St.BoxLayout {
    _init(settings, iconsPath) {
        super._init({
            style_class: 'modern-bar-metric modern-bar-workday',
            y_align: Clutter.ActorAlign.CENTER,
            // reactive receives events; track_hover drives the CSS :hover state.
            // Both required (see cpuMetric.js).
            reactive: true,
            track_hover: true,
        });
        this._settings = settings;

        // Bundled symbolic briefcase icon (tints cyan like the weather glyph).
        this._icon = new St.Icon({
            style_class: 'modern-bar-metric-icon',
            gicon: Gio.icon_new_for_string(`${iconsPath}/modernbar-workday-symbolic.svg`),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'modern-bar-metric-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);
        this.add_child(this._label);

        this._timeoutId = 0;
        this._settingsIds = [
            this._settings.connect('changed::work-start', () => this._update()),
            this._settings.connect('changed::work-end', () => this._update()),
            this._settings.connect('changed::show-workday', () => this._update()),
        ];

        this._start();
    }

    _start() {
        this._update();
        // Once a minute is plenty for a whole-percent workday readout.
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _minutesOfDay(str, fallback) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(str ?? '');
        if (!m)
            return fallback;
        return (+m[1]) * 60 + (+m[2]);
    }

    _update() {
        if (!this._settings.get_boolean('show-workday')) {
            this.visible = false;
            return;
        }

        const start = this._minutesOfDay(this._settings.get_string('work-start'), 9 * 60);
        const end = this._minutesOfDay(this._settings.get_string('work-end'), 17 * 60);

        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        // Outside work hours (or a degenerate range): hide entirely.
        if (end <= start || nowMin < start || nowMin >= end) {
            this.visible = false;
            return;
        }

        const pct = Math.round(100 * (nowMin - start) / (end - start));
        this._label.set_text(`${Math.max(0, Math.min(100, pct))}%`);
        this.visible = true;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._settingsIds) {
            for (const id of this._settingsIds)
                this._settings.disconnect(id);
            this._settingsIds = null;
        }
        super.destroy();
    }
});
