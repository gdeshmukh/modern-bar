// modern-bar — mouse-away dismissal for the SHELL's own panel dropdowns
//
// The metric popups already close when the pointer leaves them; that logic
// lives in lib/metricPopup.js and applies to menus WE build. This file extends
// the same feel to Quick Settings and the calendar, which we do not own.
//
// It is purely ADDITIVE. We never take a grab, never replace the menu's own
// dismissal, and never touch its contents: the shell's PopupMenuManager still
// owns click-outside, Escape and keyboard navigation exactly as it does on a
// stock install. All this adds is one more reason to close, so disabling the
// extension restores stock behaviour with nothing to undo.
//
// Stock menus differ from ours in three ways that each became a rule here:
//
// 1. THEY CONTAIN CONTROLS. Our popups are read-only readouts; these hold
//    sliders. Dragging the volume slider past the pane edge is easy and
//    completely normal, and closing mid-drag would cancel the interaction. So
//    a held pointer button suppresses dismissal entirely.
//
// 2. THEY OPEN WITHOUT THE POINTER. Super+V and the panel keybindings open
//    these wherever the pointer happens to be — usually far away, which would
//    slam the menu shut the instant it appeared. So the watch ARMS only after
//    the pointer has been inside the region at least once. Keyboard-driven use
//    therefore behaves exactly like stock until you actually reach for the
//    mouse, which is the only time this feature is wanted anyway.
//
// 3. QS SUB-MENUS ARE NOT DESCENDANTS. A sub-menu is parented to an `_overlay`
//    rather than living inside the boxpointer, so measuring `menu.actor` alone
//    would read "moved into the Wi-Fi sub-menu" as "left the menu". The open
//    sub-menu is measured separately, via the shell's own `_activeMenu`
//    bookkeeping.

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

// How far outside the menu the pointer may stray before we close. Larger than
// the metric popups' 52px: these panes are much bigger targets, people sweep
// past their edges while aiming for a tile, and an over-eager close on a menu
// that holds real controls is far more annoying than one on a readout.
const SLACK_PX = 64;

// Pointer poll while a menu is open. Cheap — one get_pointer plus a few rect
// tests — and only ever runs while a dropdown is actually on screen. Polling
// beats enter/leave events for the same reason it does in metricPopup.js: the
// menu, its gap and its sub-menus are separate actors in different parents, so
// crossing events fire spuriously between them.
const POLL_MS = 150;

// Any of these held means the user is mid-interaction (slider drag, scrollbar,
// text selection) and the pointer's position is not a dismissal signal.
const BUTTON_MASK =
    Clutter.ModifierType.BUTTON1_MASK |
    Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;

// Distance from a point to a rect; 0 when inside.
function distTo(px, py, x, y, w, h) {
    const dx = Math.max(x - px, 0, px - (x + w));
    const dy = Math.max(y - py, 0, py - (y + h));
    return Math.hypot(dx, dy);
}

// Transformed rect of an actor, or null when it isn't measurable yet.
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

// Watches one panel menu. One instance per dropdown; extension.js owns them.
// Exported for tools/menuawayprobe.js, which drives _evaluate() directly —
// headless sessions have no way to warp the pointer or synthesise a drag.
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

        // Already open when we attached (enable() while the user had a menu
        // down, or the setting flipped on mid-session).
        if (this._menu.isOpen)
            this._start();
    }

    _start() {
        this._stop();
        // Never inherit "armed" from a previous opening: a menu reopened by
        // keyboard must re-earn arming with the pointer.
        this._armed = false;
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            if (!this._menu.isOpen) {
                this._watchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._tick()) {
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

    // Returns true when the menu should close now. Split from _evaluate so the
    // decision can be tested with a synthetic pointer — see the export note.
    _tick() {
        return this._evaluate(...global.get_pointer());
    }

    _evaluate(px, py, mods) {
        // Mid-drag: position means nothing. Also re-arms nothing, so releasing
        // outside the menu closes it on the next tick, which is what you want.
        if (mods & BUTTON_MASK)
            return false;

        let best = Infinity;
        for (const rect of this._rects()) {
            best = Math.min(best, distTo(px, py, ...rect));
            if (best === 0)
                break;
        }

        // Nothing measurable yet (menu still being allocated) — never close on
        // a guess; the same trap the metric popups needed a grace period for.
        if (!Number.isFinite(best))
            return false;

        // Arm on first contact. Until then this menu behaves exactly like
        // stock, which is what keeps keyboard-opened menus usable.
        if (!this._armed) {
            if (best === 0)
                this._armed = true;
            return false;
        }

        return best > SLACK_PX;
    }

    // Every surface that counts as "still on the menu": the panel button (so
    // moving back up to it doesn't close), the menu itself, and any open QS
    // sub-menu, which is NOT inside the menu actor.
    //
    // Measured per-rect rather than as a union — a union would span the whole
    // gap between the panel button and the pane and leave a dead zone beside
    // it, the same reason metricPopup.js measures separately.
    _rects() {
        const actors = [this._button, this._menu.actor];

        // Private API, hence the optional chaining: `_activeMenu` is how
        // QuickSettingsMenu tracks the sub-menu it has open. If a shell
        // upgrade renames it we simply lose sub-menu tolerance rather than
        // breaking — and the sub-menu's own boxpointer usually overlaps the
        // parent pane enough that SLACK_PX covers the difference anyway.
        const sub = this._menu._activeMenu?.actor;
        if (sub)
            actors.push(sub);

        const out = [];
        for (const a of actors) {
            const r = rectOf(a);
            if (r)
                out.push(r);
        }
        return out;
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

// Attaches mouse-away dismissal to the shell's panel dropdowns, gated on the
// `dismiss-on-leave` GSettings key so it can be turned off without disabling
// the rest of the extension.
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
        // statusArea entries can be missing: a session mode may not create
        // them, and other extensions replace them outright.
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
