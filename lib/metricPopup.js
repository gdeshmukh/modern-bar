// modern-bar — shared dropdown scaffolding for the metric widgets
//
// The panel metrics are plain St.BoxLayouts in a single cluster (NOT
// PanelMenu.Buttons — that would break the tight `spacing: 14px` grouping and
// hand each one its own panel slot). So they don't get a menu for free; this
// file gives them one.
//
// DISMISSAL: these popups deliberately do NOT use PopupMenuManager. The manager
// calls Main.pushModal(menu.actor) on open, which takes a MODAL GRAB — that is
// what forces you to click elsewhere to dismiss, and what pulls keyboard focus
// off whatever you were doing. For a read-only readout that's the wrong trade.
// Instead: no grab at all, and the popup closes as soon as the pointer leaves a
// padded region around the metric and the popup itself, so there's a corridor
// wide enough to move from the icon down into the dropdown without it vanishing.
// Consequence to accept: no keyboard navigation or Escape-to-close, because
// there's no grab. These panels contain no controls, so nothing is lost.
//
// LAZY: the menu is not built until the first click. Metrics hook open/close
// through the `onOpenChanged` constructor argument rather than connecting to
// the menu's signal themselves — connecting from outside would have forced the
// menu into existence at enable() time, for all four metrics, whether or not
// anyone ever opened one.
//
// Content is the caller's job: fill `popup.box` with rows. The row builders
// below keep every metric popup reading the same.
//
// Styling hangs off `.modern-bar-popup` — our own class. The dropdown CSS in
// stylesheet.css anchors on GNOME's classes (.quick-settings, .calendar, …), so
// a custom menu inherits NONE of it automatically.

import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

// Width of a meter's trough, in px. The fill is a fraction of this, computed in
// JS — St has no percentage widths, so the bar is drawn by setting the child's
// width directly. Keep in sync with .modern-bar-popup-meter in stylesheet.css.
const METER_WIDTH = 132;

// How far outside the metric/popup the pointer may stray before we close. Needs
// to comfortably span the gap the boxpointer leaves between the panel and the
// popup (its -arrow-rise plus margin), or the popup would close in the gap while
// you were on your way to it.
const SLACK_PX = 52;

// Pointer poll while open. Cheap (one get_pointer + two rect tests) and only
// runs while a popup is actually on screen. Polling beats enter/leave events
// here: leave-event fires spuriously when crossing between the metric, the gap
// and the popup, which are three separate actors in two different parents.
const POLL_MS = 150;

// Don't act on the pointer for a moment after opening: the click that opened the
// popup can land before the popup has been allocated, and a zero-sized rect
// would read as "pointer is far away" and close it instantly.
const GRACE_MS = 400;

// Tracks the open metric popups so only one shows at a time. Replaces the
// one-at-a-time behaviour we lose by not using PopupMenuManager.
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
    // sourceActor: the metric widget the menu hangs under.
    // group: a shared MetricPopupGroup owned by extension.js.
    // onOpenChanged: optional (open) => {} — the metric's hook for filling or
    //   tearing down its content. Callers used to connect to the menu's own
    //   'open-state-changed' from outside, which meant a second connection to a
    //   signal we already handle here AND forced the menu to exist before
    //   anyone had clicked anything.
    constructor(sourceActor, group, onOpenChanged = null) {
        this._source = sourceActor;
        this._group = group;
        this._onOpenChanged = onOpenChanged;

        // Built on FIRST OPEN — see _ensureMenu(). Until then this is null and
        // `box` doesn't exist yet, so every accessor below is null-tolerant.
        this._menu = null;
        this.box = null;

        this._watchId = 0;
        this._openedAt = 0;
        this._stateId = 0;

        group?.add(this);
        this._clickId = sourceActor.connect(
            'button-press-event', () => this.toggle());
    }

    // Construct the real menu. Deferred out of the constructor because a
    // PopupMenu is a BoxPointer plus a section plus our content box — roughly a
    // dozen actors parented into uiGroup — and it was being built for all four
    // metrics inside enable(), including metrics the user has switched off and
    // popups nobody ever opens. Nothing here depends on WHEN it runs, so the
    // cost belongs on the first click, not on every login.
    _ensureMenu() {
        if (this._menu)
            return this._menu;

        // 0.5 = arrow centered on the metric; St.Side.TOP = menu opens downward.
        this._menu = new PopupMenu.PopupMenu(this._source, 0.5, St.Side.TOP);
        this._menu.actor.add_style_class_name('modern-bar-popup');
        this._menu.actor.hide();
        Main.uiGroup.add_child(this._menu.actor);

        // One plain section holding our own layout — we deliberately don't use
        // PopupMenuItems: they're interactive rows with hover/activate states,
        // and these are read-only readouts.
        this._section = new PopupMenu.PopupMenuSection();
        this._menu.addMenuItem(this._section);

        this.box = new St.BoxLayout({
            style_class: 'modern-bar-popup-content',
            vertical: true,
        });
        this._section.actor.add_child(this.box);

        this._stateId = this._menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._group?.closeOthers(this);
                this._openedAt = GLib.get_monotonic_time() / 1000;   // ms
                this._startWatch();
            } else {
                this._stopWatch();
            }
            // After our own bookkeeping, so the metric's renderer always sees a
            // popup that is already registered and being watched.
            this._onOpenChanged?.(open);
        });
        return this._menu;
    }

    // Materializes the menu. Only the probes use this now — metrics go through
    // onOpenChanged and never need the raw menu.
    get menu() {
        return this._ensureMenu();
    }

    // Deliberately does NOT materialize: callers poll this on their refresh tick
    // ("is my popup open? then re-render"), and a never-opened popup must stay
    // unbuilt.
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

    // ── Proximity dismissal ─────────────────────────────────────────────────
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

    // Distance from a point to a rect, 0 when inside.
    static _distTo(px, py, x, y, w, h) {
        const dx = Math.max(x - px, 0, px - (x + w));
        const dy = Math.max(y - py, 0, py - (y + h));
        return Math.hypot(dx, dy);
    }

    // True when the pointer is further than SLACK_PX from BOTH the metric and
    // the popup. Measured against each rect separately rather than their union:
    // the union would include a wide dead zone beside the panel.
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
        // Nothing measurable yet (not allocated) — don't close on a guess.
        if (!Number.isFinite(best))
            return false;
        return best > SLACK_PX;
    }

    // Wipe the content so a refresh can rebuild it. Cheap — these popups hold a
    // handful of labels, and rebuilding avoids stale-row bookkeeping.
    // No-op before the first open, when there is no box yet.
    clear() {
        this.box?.destroy_all_children();
    }

    // ── Row builders ────────────────────────────────────────────────────────
    // Every builder goes through here, so content can be added at ANY time —
    // including before the first open, which is what the probes do. The menu
    // materializes on demand rather than the builders exploding on a null box.
    // Laziness still holds in practice: all four metrics build their rows from
    // inside onOpenChanged, so nothing calls a builder until a real click.
    _content() {
        this._ensureMenu();
        return this.box;
    }

    // A section heading, e.g. "Claude usage".
    header(text) {
        this._content().add_child(new St.Label({
            style_class: 'modern-bar-popup-header',
            text,
        }));
    }

    // A thin horizontal rule.
    separator() {
        this._content().add_child(new St.Widget({
            style_class: 'modern-bar-popup-separator',
        }));
    }

    // Plain caption line (dim, small) — reset times, "updated 8s ago", etc.
    // Returns the label so a caller can keep the reference and retitle it in
    // place (e.g. ticking an age counter) instead of rebuilding the popup.
    caption(text) {
        const label = new St.Label({
            style_class: 'modern-bar-popup-caption',
            text,
        });
        this._content().add_child(label);
        return label;
    }

    // A compact line with an optional leading glyph: [icon] name … value.
    // Used for forecast days and any row where a meter would be meaningless.
    iconRow(iconName, name, value) {
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
        this._content().add_child(row);
        return row;
    }

    // The standard readout: name on the left, value on the right, a thin meter
    // underneath. `percent` may be null, in which case the meter is omitted (so
    // a row can show a value we can't express as a fraction).
    // `alert` draws the fill in the alert colour instead of the accent.
    meterRow(name, value, percent = null, alert = false) {
        const row = new St.BoxLayout({
            style_class: 'modern-bar-popup-row',
            vertical: true,
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
            // The trough MUST be a horizontal BoxLayout, not a BinLayout.
            // BinLayout CENTERS its children, so a partial fill floated to the
            // middle of the trough. Setting x_align: START on the child does NOT
            // fix that — Clutter only consults x_align when the child is given
            // surplus space to align within. BoxLayout packs from the start.
            const trough = new St.BoxLayout({
                style_class: 'modern-bar-popup-meter',
                width: METER_WIDTH,
                vertical: false,
                x_align: Clutter.ActorAlign.START,
            });
            // Clamp: the API can report >100% on overage, and a fill wider than
            // its trough would overdraw the popup.
            const frac = Math.max(0, Math.min(100, percent)) / 100;
            const fill = new St.Widget({
                style_class: alert
                    ? 'modern-bar-popup-meter-fill modern-bar-popup-meter-alert'
                    : 'modern-bar-popup-meter-fill',
                width: Math.max(1, Math.round(METER_WIDTH * frac)),
                // Must not expand, or BoxLayout stretches it to the full trough
                // and every meter reads 100%.
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
        // Null when the popup was never opened — nothing was ever built, so
        // there is nothing to tear down.
        if (this._menu) {
            if (this._stateId) {
                this._menu.disconnect(this._stateId);
                this._stateId = 0;
            }
            this._menu.destroy();       // also removes actor from uiGroup
            this._menu = null;
        }
        this._onOpenChanged = null;
        this._group = null;
        this._source = null;
        this.box = null;
    }
}
