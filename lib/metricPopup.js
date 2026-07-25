// modern-bar — shared dropdown scaffolding for the metric widgets
//
// The panel metrics are plain St.BoxLayouts in a single cluster (NOT
// PanelMenu.Buttons — that would break the tight `spacing: 14px` grouping and
// hand each one its own panel slot). So they don't get a menu for free; this
// file gives them one.
//
// What MetricPopup does:
//   * builds a PopupMenu anchored under the metric, parented into Main.uiGroup
//     (where all panel menus live — see extension.js's POPUP_CLASS note)
//   * registers it with a shared PopupMenuManager so click-outside closes it and
//     only one metric popup is ever open
//   * toggles on click, and tears everything down in destroy()
//
// Content is the caller's job: fill `popup.box` with rows. `meterRow()` below is
// the standard row (label · percent · thin bar · optional sub-caption) so every
// metric popup reads the same.
//
// Styling hangs off `.modern-bar-popup` — our own class. The dropdown CSS in
// stylesheet.css anchors on GNOME's classes (.quick-settings, .calendar, …), so
// a custom menu inherits NONE of it automatically.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Width of a meter's trough, in px. The fill is a fraction of this, computed in
// JS — St has no percentage widths, so the bar is drawn by setting the child's
// width directly. Keep in sync with .modern-bar-popup-meter in stylesheet.css.
const METER_WIDTH = 132;

export class MetricPopup {
    // sourceActor: the metric widget the menu hangs under.
    // manager: a shared PopupMenu.PopupMenuManager owned by extension.js.
    constructor(sourceActor, manager) {
        this._source = sourceActor;
        this._manager = manager;

        // 0.5 = arrow centered on the metric; St.Side.TOP = menu opens downward.
        this._menu = new PopupMenu.PopupMenu(sourceActor, 0.5, St.Side.TOP);
        this._menu.actor.add_style_class_name('modern-bar-popup');
        this._menu.actor.hide();
        Main.uiGroup.add_child(this._menu.actor);
        manager.addMenu(this._menu);

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

        this._clickId = sourceActor.connect(
            'button-press-event', () => this.toggle());
    }

    get menu() {
        return this._menu;
    }

    get isOpen() {
        return this._menu.isOpen;
    }

    toggle() {
        this._menu.toggle();
        return Clutter.EVENT_STOP;
    }

    close() {
        this._menu.close();
    }

    // Wipe the content so a refresh can rebuild it. Cheap — these popups hold a
    // handful of labels, and rebuilding avoids stale-row bookkeeping.
    clear() {
        this.box.destroy_all_children();
    }

    // ── Row builders ────────────────────────────────────────────────────────
    // A section heading, e.g. "CLAUDE USAGE".
    header(text) {
        this.box.add_child(new St.Label({
            style_class: 'modern-bar-popup-header',
            text,
        }));
    }

    // A thin horizontal rule.
    separator() {
        this.box.add_child(new St.Widget({
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
        this.box.add_child(label);
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
        this.box.add_child(row);
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
            // middle of the trough ("why do these bars start in the middle").
            // Setting x_align: START on the child does NOT fix that — Clutter
            // only consults x_align when the child is given surplus space to
            // align within. BoxLayout packs from the start, which is what a
            // meter needs.
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

        this.box.add_child(row);
        return row;
    }

    destroy() {
        if (this._clickId && this._source) {
            this._source.disconnect(this._clickId);
            this._clickId = 0;
        }
        if (this._menu) {
            // removeMenu before destroy, or the manager keeps a dangling ref.
            this._manager?.removeMenu(this._menu);
            this._menu.destroy();       // also removes actor from uiGroup
            this._menu = null;
        }
        this._manager = null;
        this._source = null;
        this.box = null;
    }
}
