// modern-bar — Workday % metric
//
// Shows how far through the configured work day we are as a briefcase glyph +
// "nn%". Hidden entirely outside work hours (and when show-workday is off). One
// low-frequency timer — the value only needs to move about once a minute.
//
// Click → a small dropdown: the configured hours, a progress meter, and time
// left. (Reverses the earlier "no dropdown" decision — the popup earns its
// place by adding the ABSOLUTE frame around the panel's bare %: which hours,
// and how much of them is left.)

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {MetricPopup} from './metricPopup.js';

export const WorkdayMetric = GObject.registerClass(
class WorkdayMetric extends St.BoxLayout {
    // popupGroup (optional): shared MetricPopupGroup from extension.js. When
    // given, clicking shows the configured hours + a progress meter.
    _init(settings, iconsPath, popupGroup = null) {
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
        this._state = null;   // {start, end, nowMin, pct} while in-hours
        this._settingsIds = [
            this._settings.connect('changed::work-start', () => this._update()),
            this._settings.connect('changed::work-end', () => this._update()),
            this._settings.connect('changed::show-workday', () => this._update()),
        ];

        if (popupGroup) {
            this._popup = new MetricPopup(this, popupGroup, open => {
                if (open)
                    this._renderPopup();
            });
        }

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
            this._hide();
            return;
        }

        const start = this._minutesOfDay(this._settings.get_string('work-start'), 9 * 60);
        const end = this._minutesOfDay(this._settings.get_string('work-end'), 17 * 60);

        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        // Outside work hours (or a degenerate range): hide entirely.
        if (end <= start || nowMin < start || nowMin >= end) {
            this._hide();
            return;
        }

        const pct = Math.max(0, Math.min(100,
            Math.round(100 * (nowMin - start) / (end - start))));
        this._state = {start, end, nowMin, pct};
        this._label.set_text(`${pct}%`);
        this.visible = true;
        // Keep an open dropdown ticking along with the panel number.
        if (this._popup?.isOpen)
            this._renderPopup();
    }

    // Hide the metric; an open dropdown must go with it, or it would linger
    // pointing at an invisible source (proximity dismissal skips invisible
    // actors, so it would only close once the pointer strayed).
    _hide() {
        this._state = null;
        this.visible = false;
        this._popup?.close();
    }

    // "HH:MM", zero-padded, from minutes-of-day.
    static _hhmm(min) {
        const h = String(Math.floor(min / 60)).padStart(2, '0');
        const m = String(min % 60).padStart(2, '0');
        return `${h}:${m}`;
    }

    // "3h 05m" / "45m" from a minute count.
    static _dur(min) {
        const h = Math.floor(min / 60);
        const m = min % 60;
        return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    }

    // The whole dropdown: hours + meter + time left. Deliberately spare — the
    // metric IS a single number; the popup only adds its absolute frame.
    _renderPopup() {
        if (!this._popup)
            return;
        const p = this._popup;
        p.clear();
        p.header('Workday');

        const s = this._state;
        if (!s) {
            // Rarely reachable (the metric hides outside hours, so there is
            // nothing to click) — but a settings change can race an open popup.
            p.caption('Outside work hours.');
            return;
        }

        p.meterRow(
            `${WorkdayMetric._hhmm(s.start)} – ${WorkdayMetric._hhmm(s.end)}`,
            `${s.pct}%`, s.pct);
        p.caption(`${WorkdayMetric._dur(s.end - s.nowMin)} left`);
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }
        if (this._settingsIds) {
            for (const id of this._settingsIds)
                this._settings.disconnect(id);
            this._settingsIds = null;
        }
        super.destroy();
    }
});
