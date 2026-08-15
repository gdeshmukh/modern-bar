// SPDX-License-Identifier: GPL-2.0-or-later
// Workday progress within the configured start and end times.

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {MetricPopup} from './metricPopup.js';

export const WorkdayMetric = GObject.registerClass(
class WorkdayMetric extends St.BoxLayout {
    _init(settings, iconsPath, popupGroup = null) {
        super._init({
            style_class: 'modern-bar-metric modern-bar-workday',
            y_align: Clutter.ActorAlign.CENTER,
            // Clutter only updates :hover when both properties are enabled.
            reactive: true,
            track_hover: true,
        });
        this._settings = settings;

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
        this._state = null;
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
        // Whole-percent progress does not need a sub-minute refresh.
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

        if (end <= start || nowMin < start || nowMin >= end) {
            this._hide();
            return;
        }

        const pct = Math.max(0, Math.min(100,
            Math.round(100 * (nowMin - start) / (end - start))));
        this._state = {start, end, nowMin, pct};
        this._label.set_text(`${pct}%`);
        this.visible = true;
        if (this._popup?.isOpen)
            this._renderPopup();
    }

    _hide() {
        this._state = null;
        this.visible = false;
        this._popup?.close();
    }

    static _hhmm(min) {
        const h = String(Math.floor(min / 60)).padStart(2, '0');
        const m = String(min % 60).padStart(2, '0');
        return `${h}:${m}`;
    }

    static _dur(min) {
        const h = Math.floor(min / 60);
        const m = min % 60;
        return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    }

    _renderPopup() {
        if (!this._popup)
            return;
        const p = this._popup;
        p.clear();
        p.header('Workday');

        const s = this._state;
        if (!s) {
            // Settings can invalidate the range while the popup is open.
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
