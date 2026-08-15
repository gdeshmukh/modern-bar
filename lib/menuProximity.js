// SPDX-License-Identifier: GPL-2.0-or-later
// Pointer-away dismissal for shell-owned panel menus. It preserves shell
// grabs, waits for pointer entry, and ignores movement during button holds.

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

// Interactive menus need more tolerance than read-only metric popups.
const SLACK_PX = 64;

// Separate actor trees make crossing events unreliable across menu surfaces.
const POLL_MS = 150;

const BUTTON_MASK =
    Clutter.ModifierType.BUTTON1_MASK |
    Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;

function distTo(px, py, x, y, w, h) {
    const dx = Math.max(x - px, 0, px - (x + w));
    const dy = Math.max(y - py, 0, py - (y + h));
    return Math.hypot(dx, dy);
}

function rectOf(actor) {
    if (!actor || !actor.visible)
        return null;
    try {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0)
            return null;
        return [x, y, w, h];
    } catch (e) {
        return null;
    }
}

export class MenuWatch {
    constructor(button) {
        this._button = button;
        this._menu = button.menu;
        this._watchId = 0;
        this._armed = false;

        this._stateId = this._menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._start();
            else
                this._stop();
        });

        if (this._menu.isOpen)
            this._start();
    }

    _start() {
        this._stop();
        // Keyboard-opened menus must wait for pointer entry each time.
        this._armed = false;
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            if (!this._menu.isOpen) {
                this._watchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._evaluate(...global.get_pointer())) {
                this._watchId = 0;
                this._menu.close(BoxPointer.PopupAnimation.FULL);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stop() {
        if (this._watchId) {
            GLib.source_remove(this._watchId);
            this._watchId = 0;
        }
        this._armed = false;
    }

    _evaluate(px, py, mods) {
        // Closing during a drag would cancel interaction with menu controls.
        if (mods & BUTTON_MASK)
            return false;

        let best = Infinity;
        for (const rect of this._rects()) {
            best = Math.min(best, distTo(px, py, ...rect));
            if (best === 0)
                break;
        }

        // Allocation may not have produced measurable actors yet.
        if (!Number.isFinite(best))
            return false;

        if (!this._armed) {
            if (best === 0)
                this._armed = true;
            return false;
        }

        return best > SLACK_PX;
    }

    // Quick Settings exposes a zero-sized menu.actor and parents submenus in an
    // overlay. Keep viable surfaces separate so their union does not cover gaps.
    _rects() {
        const menu = this._menu;
        const actors = [this._button, menu._boxPointer, menu.actor, menu.box];

        // A missing private submenu handle must degrade without breaking menus.
        const sub = menu._activeMenu;
        if (sub)
            actors.push(sub._boxPointer, sub.actor, sub.box);

        return actors.map(rectOf).filter(Boolean);
    }

    destroy() {
        this._stop();
        if (this._stateId) {
            this._menu.disconnect(this._stateId);
            this._stateId = 0;
        }
        this._menu = null;
        this._button = null;
    }
}

export class MenuProximityDismiss {
    constructor(settings) {
        this._settings = settings;
        this._watches = [];
        this._changedId =
            settings.connect('changed::dismiss-on-leave', () => this._sync());
        this._sync();
    }

    _sync() {
        if (this._settings.get_boolean('dismiss-on-leave'))
            this._attach();
        else
            this._detach();
    }

    _attach() {
        if (this._watches.length)
            return;
        // Session modes and other extensions may omit these actors.
        for (const name of ['quickSettings', 'dateMenu']) {
            const button = Main.panel.statusArea[name];
            if (button?.menu)
                this._watches.push(new MenuWatch(button));
        }
    }

    _detach() {
        for (const w of this._watches)
            w.destroy();
        this._watches = [];
    }

    destroy() {
        this._detach();
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._settings = null;
    }
}
