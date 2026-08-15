// SPDX-License-Identifier: GPL-2.0-or-later
// CPU usage from /proc/stat, with memory and load details on demand.

import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {MetricPopup} from './metricPopup.js';

export const CpuMetric = GObject.registerClass(
class CpuMetric extends St.BoxLayout {
    _init(settings, iconsPath, popupGroup = null) {
        super._init({
            style_class: 'modern-bar-metric modern-bar-cpu',
            y_align: Clutter.ActorAlign.CENTER,
            // Clutter only updates :hover when both properties are enabled.
            reactive: true,
            track_hover: true,
        });
        this._settings = settings;

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

        this._settingsIds = [
            this._settings.connect('changed::cpu-refresh-seconds', () => this._restart()),
            this._settings.connect('changed::show-cpu', () => this._syncVisible()),
        ];

        this._lastPct = null;
        this._mem = null;
        this._load = null;
        if (popupGroup) {
            this._popup = new MetricPopup(this, popupGroup, open => {
                if (!open)
                    return;
                // Popup-only values should reflect the time the popup opened.
                this._readExtras(() => this._renderPopup());
                this._renderPopup();
            });
        }

        this._syncVisible();
    }

    _readExtras(done) {
        let pending = 2;
        const finish = () => {
            if (--pending === 0 && done)
                done();
        };

        Gio.File.new_for_path('/proc/meminfo').load_contents_async(null, (f, res) => {
            if (this._destroyed)
                return;
            try {
                const [, contents] = f.load_contents_finish(res);
                const text = new TextDecoder().decode(contents);
                const kb = key => {
                    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
                    return m ? Number(m[1]) : null;
                };
                const total = kb('MemTotal');
                // MemAvailable includes memory the kernel can reclaim.
                const avail = kb('MemAvailable');
                const swapTotal = kb('SwapTotal');
                const swapFree = kb('SwapFree');
                if (total && avail !== null) {
                    this._mem = {
                        usedKb: total - avail,
                        totalKb: total,
                        pct: Math.round(100 * (total - avail) / total),
                        swapUsedKb: swapTotal && swapFree !== null ? swapTotal - swapFree : null,
                        swapTotalKb: swapTotal || null,
                    };
                }
            } catch (e) {
                // Retain the last successful value.
            }
            finish();
        });

        Gio.File.new_for_path('/proc/loadavg').load_contents_async(null, (f, res) => {
            if (this._destroyed)
                return;
            try {
                const [, contents] = f.load_contents_finish(res);
                const parts = new TextDecoder().decode(contents).trim().split(/\s+/);
                if (parts.length >= 3)
                    this._load = parts.slice(0, 3);
            } catch (e) {
                // Retain the last successful value.
            }
            finish();
        });
    }

    _renderPopup() {
        if (!this._popup)
            return;
        const p = this._popup;
        p.clear();
        p.header('System');

        const gib = kb => (kb / 1048576).toFixed(1);

        if (this._lastPct !== null) {
            const warn = this._settings.get_int('cpu-warn-percent');
            p.meterRow('CPU', `${this._lastPct}%`, this._lastPct,
                this._lastPct >= warn);
        }

        if (this._mem) {
            const m = this._mem;
            // Memory has no setting; 90% is the fixed pressure warning.
            p.meterRow('Memory', `${m.pct}%`, m.pct, m.pct >= 90);
            p.caption(`${gib(m.usedKb)} / ${gib(m.totalKb)} GiB`);
            if (m.swapTotalKb && m.swapUsedKb > 0) {
                p.caption(`swap ${gib(m.swapUsedKb)} / ${gib(m.swapTotalKb)} GiB`);
            }
        }

        if (this._load) {
            p.separator();
            p.iconRow(null, 'Load  1 / 5 / 15 min', this._load.join('  '));
        }
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
        const file = Gio.File.new_for_path('/proc/stat');
        file.load_contents_async(null, (f, res) => {
            // Reads may complete after the actor is destroyed.
            if (this._destroyed)
                return;
            let contents;
            try {
                [, contents] = f.load_contents_finish(res);
            } catch (e) {
                return;
            }
            const text = new TextDecoder().decode(contents);
            const line = text.split('\n', 1)[0];
            const parts = line.trim().split(/\s+/).slice(1).map(Number);
            if (parts.length < 4)
                return;
            const idle = parts[3] + (parts[4] || 0);
            const total = parts.reduce((a, b) => a + b, 0);

            const dTotal = total - this._prevTotal;
            const dIdle = idle - this._prevIdle;
            this._prevTotal = total;
            this._prevIdle = idle;

            if (dTotal <= 0)
                return;
            const usage = Math.round(100 * (dTotal - dIdle) / dTotal);
            this._render(Math.max(0, Math.min(100, usage)));
        });
    }

    _render(pct) {
        this._lastPct = pct;
        this._label.set_text(`${pct}%`);
        const warn = this._settings.get_int('cpu-warn-percent');
        if (pct >= warn)
            this._label.add_style_class_name('modern-bar-alert');
        else
            this._label.remove_style_class_name('modern-bar-alert');
    }

    destroy() {
        this._destroyed = true;
        this._stop();
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
