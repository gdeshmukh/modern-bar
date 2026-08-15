// SPDX-License-Identifier: GPL-2.0-or-later
// Lazy, read-only metric popups with pointer-away dismissal. PopupMenuManager
// is avoided because its modal grab would steal focus for noninteractive data.

import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

// St has no percentage widths; keep this synchronized with stylesheet.css.
const METER_WIDTH = 132;

// This must bridge the gap between the panel actor and its boxpointer.
const SLACK_PX = 52;

// Separate actor trees make crossing events unreliable across popup surfaces.
const POLL_MS = 150;

// Allocation can briefly leave the new popup with a zero-sized rect.
const GRACE_MS = 400;

export class MetricPopupGroup {
    constructor() {
        this._popups = [];
    }

    add(popup) {
        if (!this._popups.includes(popup))
            this._popups.push(popup);
    }

    remove(popup) {
        const i = this._popups.indexOf(popup);
        if (i >= 0)
            this._popups.splice(i, 1);
    }

    closeOthers(except) {
        for (const p of this._popups) {
            if (p !== except)
                p.close();
        }
    }

    destroy() {
        this._popups = [];
    }
}

export class MetricPopup {
    constructor(sourceActor, group, onOpenChanged = null) {
        this._source = sourceActor;
        this._group = group;
        this._onOpenChanged = onOpenChanged;

        // Keep unused metric popups actor-free.
        this._menu = null;
        this.box = null;

        this._watchId = 0;
        this._openedAt = 0;
        this._stateId = 0;

        group?.add(this);
        this._clickId = sourceActor.connect(
            'button-press-event', () => this.toggle());
    }

    _ensureMenu() {
        if (this._menu)
            return this._menu;

        // Center the arrow and open below the panel.
        this._menu = new PopupMenu.PopupMenu(this._source, 0.5, St.Side.TOP);
        this._menu.actor.add_style_class_name('modern-bar-popup');
        this._menu.actor.hide();
        Main.uiGroup.add_child(this._menu.actor);

        // PopupMenuItems would add interaction states to read-only rows.
        const section = new PopupMenu.PopupMenuSection();
        this._menu.addMenuItem(section);

        this.box = new St.BoxLayout({
            style_class: 'modern-bar-popup-content',
            orientation: Clutter.Orientation.VERTICAL,
        });
        section.actor.add_child(this.box);

        this._stateId = this._menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._group?.closeOthers(this);
                this._openedAt = GLib.get_monotonic_time() / 1000;   // ms
                this._startWatch();
            } else {
                this._stopWatch();
            }
            this._onOpenChanged?.(open);
        });
        return this._menu;
    }

    get menu() {
        return this._ensureMenu();
    }

    // Status checks must not defeat lazy construction.
    get isOpen() {
        return this._menu?.isOpen ?? false;
    }

    toggle() {
        this._ensureMenu().toggle();
        return Clutter.EVENT_STOP;
    }

    close() {
        if (this._menu?.isOpen)
            this._menu.close(BoxPointer.PopupAnimation.FULL);
    }

    _startWatch() {
        this._stopWatch();
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            if (!this._menu?.isOpen) {
                this._watchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const now = GLib.get_monotonic_time() / 1000;
            if (now - this._openedAt < GRACE_MS)
                return GLib.SOURCE_CONTINUE;

            if (this._pointerIsFar()) {
                this._watchId = 0;
                this.close();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWatch() {
        if (this._watchId) {
            GLib.source_remove(this._watchId);
            this._watchId = 0;
        }
    }

    static _distTo(px, py, x, y, w, h) {
        const dx = Math.max(x - px, 0, px - (x + w));
        const dy = Math.max(y - py, 0, py - (y + h));
        return Math.hypot(dx, dy);
    }

    // A union would cover empty space beside the panel and popup.
    _pointerIsFar() {
        const [px, py] = global.get_pointer();
        let best = Infinity;
        for (const actor of [this._source, this._menu?.actor]) {
            if (!actor || !actor.visible)
                continue;
            let x, y, w, h;
            try {
                [x, y] = actor.get_transformed_position();
                [w, h] = actor.get_transformed_size();
            } catch (e) {
                continue;
            }
            if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0)
                continue;
            best = Math.min(best, MetricPopup._distTo(px, py, x, y, w, h));
        }
        // Allocation may not have produced measurable actors yet.
        if (!Number.isFinite(best))
            return false;
        return best > SLACK_PX;
    }

    clear() {
        this.box?.destroy_all_children();
    }

    // Builders also support callers that populate content before opening.
    _content() {
        this._ensureMenu();
        return this.box;
    }

    header(text) {
        this._content().add_child(new St.Label({
            style_class: 'modern-bar-popup-header',
            text,
        }));
    }

    separator() {
        this._content().add_child(new St.Widget({
            style_class: 'modern-bar-popup-separator',
        }));
    }

    // Return the label for callers that update captions in place.
    caption(text) {
        const label = new St.Label({
            style_class: 'modern-bar-popup-caption',
            text,
        });
        this._content().add_child(label);
        return label;
    }

    // A marked {gicon, text} tail disambiguates a second value from the first.
    iconRow(iconName, name, value, tail = null) {
        const row = new St.BoxLayout({style_class: 'modern-bar-popup-rowtop'});
        if (iconName) {
            row.add_child(new St.Icon({
                style_class: 'modern-bar-popup-icon',
                icon_name: iconName,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        row.add_child(new St.Label({
            style_class: 'modern-bar-popup-name',
            text: name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(new St.Label({
            style_class: 'modern-bar-popup-value',
            text: value,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (tail?.gicon) {
            row.add_child(new St.Icon({
                style_class: 'modern-bar-popup-tail-icon',
                gicon: tail.gicon,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        if (tail?.text) {
            row.add_child(new St.Label({
                style_class: 'modern-bar-popup-tail',
                text: tail.text,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        this._content().add_child(row);
        return row;
    }

    // A null percentage omits the meter; alert selects its warning style.
    meterRow(name, value, percent = null, alert = false) {
        const row = new St.BoxLayout({
            style_class: 'modern-bar-popup-row',
            orientation: Clutter.Orientation.VERTICAL,
        });

        const top = new St.BoxLayout({style_class: 'modern-bar-popup-rowtop'});
        top.add_child(new St.Label({
            style_class: 'modern-bar-popup-name',
            text: name,
            x_expand: true,
        }));
        top.add_child(new St.Label({
            style_class: alert
                ? 'modern-bar-popup-value modern-bar-alert'
                : 'modern-bar-popup-value',
            text: value,
        }));
        row.add_child(top);

        if (percent !== null) {
            // BinLayout centers partial fills; BoxLayout anchors them at the start.
            const trough = new St.BoxLayout({
                style_class: 'modern-bar-popup-meter',
                width: METER_WIDTH,
                x_align: Clutter.ActorAlign.START,
            });
            // Usage APIs may report overage above 100%.
            const frac = Math.max(0, Math.min(100, percent)) / 100;
            const fill = new St.Widget({
                style_class: alert
                    ? 'modern-bar-popup-meter-fill modern-bar-popup-meter-alert'
                    : 'modern-bar-popup-meter-fill',
                width: Math.max(1, Math.round(METER_WIDTH * frac)),
                // Expansion would stretch every fill to 100%.
                x_expand: false,
            });
            trough.add_child(fill);
            row.add_child(trough);
        }

        this._content().add_child(row);
        return row;
    }

    destroy() {
        this._stopWatch();
        if (this._clickId && this._source) {
            this._source.disconnect(this._clickId);
            this._clickId = 0;
        }
        this._group?.remove(this);
        if (this._menu) {
            if (this._stateId) {
                this._menu.disconnect(this._stateId);
                this._stateId = 0;
            }
            this._menu.destroy();
            this._menu = null;
        }
        this._onOpenChanged = null;
        this._group = null;
        this._source = null;
        this.box = null;
    }
}
