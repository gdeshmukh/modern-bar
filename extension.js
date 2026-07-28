// modern-bar — extension.js
//
// Lifecycle + wiring. The panel look lives in stylesheet.css (auto-loaded).
// This file:
//   1. tags #panel with CSS classes so the look can be toggled from here,
//      including the circuit palette (`palette` enum in prefs; `night-mode`
//      survives only as a deprecated scripting alias)
//   2. collapses the Activities button (Super key still opens the Overview)
//   3. mounts the metrics cluster (CPU / Workday / Weather) on the LEFT, where
//      Activities was; each reads config from GSettings and tears down its own
//      timers/signals. This file owns their container.
//
// GNOME 45+ ES-module style only. No legacy imports.* patterns.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {CpuMetric} from './lib/cpuMetric.js';
import {WorkdayMetric} from './lib/workdayMetric.js';
import {WeatherMetric} from './lib/weatherMetric.js';
import {ClaudeMetric} from './lib/claudeMetric.js';
import {MetricPopupGroup} from './lib/metricPopup.js';

// ── Look toggles ────────────────────────────────────────────────────────────
// Flip this and re-toggle the extension to compare the panel with/without the
// under-line. It just adds/removes a CSS class on #panel; the line itself is
// defined in stylesheet.css (.modern-bar-underglow).
//
// Off by default: the "glow" is carried by the cyan text/icons instead, which
// costs nothing. The stock GNOME theme also tends to overdraw a panel-width
// border, so the line was unreliable anyway.
const UNDERGLOW = false;

const PANEL_CLASS = 'modern-bar';
const UNDERGLOW_CLASS = 'modern-bar-underglow';

// Scope class for the panel DROPDOWNS (Quick Settings + clock/calendar).
//
// It goes on Main.uiGroup, NOT on #panel, and that is not a style preference —
// it's forced by the actor tree. PanelMenu.Button.setMenu() reparents a panel
// menu with `Main.uiGroup.add_child(this.menu.actor)`, so the popup is a SIBLING
// of panelBox, never a descendant of #panel:
//
//   uiGroup
//   ├─ panelBox → #panel          ← .modern-bar / .modern-bar-underglow live here
//   └─ menu.actor (boxpointer)    ← the QS + calendar popups live HERE
//
// So no `#panel ...` selector can reach popup content, and the night palette
// could never have applied to them from #panel alone. uiGroup is the nearest
// common ancestor, is a plain St.Widget (it takes style classes), and lives for
// the whole session, so tagging it is stable across enable/disable.
const POPUP_CLASS = 'modern-bar-popups';

export default class ModernBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // 1. Tag the panel so stylesheet.css can scope to us and so the
        //    under-glow is toggleable without editing CSS.
        Main.panel.add_style_class_name(PANEL_CLASS);
        if (UNDERGLOW)
            Main.panel.add_style_class_name(UNDERGLOW_CLASS);

        // 1b. Circuit palette. `palette` is a GSettings enum (tron/iso/clu/…,
        //     see the schema for the canon meanings); switching it just swaps a
        //     `.modern-bar-<name>` CSS class — every palette shares the same
        //     background, only the circuit color changes (stylesheet.css is
        //     GENERATED per palette by build/gen-stylesheet.js).
        //     The class is applied to BOTH #panel and uiGroup — see POPUP_CLASS
        //     above for why one node can't cover both.
        //
        //     The valid names come from the schema's own <choices> — one source
        //     of truth shared with prefs and the generator's roster.
        //
        //     Guarded: with the symlink dev setup, a pulled/edited schema XML
        //     whose gschemas.compiled wasn't refreshed (`make schemas`) would
        //     make get_key('palette') a FATAL g_error — aborting gnome-shell,
        //     i.e. the whole Wayland session, at login. Degrade to "no palette
        //     classes" instead; the bar just loses its circuit color until the
        //     schema is recompiled.
        if (!this._settings.settings_schema.has_key('palette')) {
            console.error('modern-bar: compiled schema is stale (no "palette" ' +
                'key) — run `make schemas`; palette theming disabled');
            this._paletteNames = [];
            this._settingsIds = [
                this._settings.connect('changed::theme-popups', () => this._syncPopupClass()),
            ];
            this._syncPopupClass();
        } else {
            this._paletteNames = this._schemaChoices('palette');

            // One-time migration: a pre-palette setup that had night-mode on
            // gets its gold successor instead of silently resetting to tron.
            // Only when `palette` has never been explicitly written
            // (get_user_value == null).
            if (this._settings.get_user_value('palette') === null &&
                this._settings.get_boolean('night-mode'))
                this._settings.set_string('palette', 'clu');

            this._syncPaletteClass();
            this._syncPopupClass();
            // The alias must act only on a real FLIP (the schema's "when this
            // key CHANGES" contract). changed:: alone isn't that: GSettings
            // only suppresses equal-value writes when a user value already
            // exists — writing the default to an UNSET key is a real write
            // that emits changed::, and without this guard a first-ever
            // `tron-theme day` would stomp a hand-picked palette with 'tron'.
            this._lastNightMode = this._settings.get_boolean('night-mode');
            this._settingsIds = [
                this._settings.connect('changed::palette', () => this._syncPaletteClass()),
                // Deprecated alias, kept so existing scripts (e.g. a kitty
                // theme switcher running `gsettings set … night-mode …`) keep
                // flipping the bar: a FLIP maps onto the two classic palettes.
                this._settings.connect('changed::night-mode', () => {
                    const night = this._settings.get_boolean('night-mode');
                    if (night === this._lastNightMode)
                        return;
                    this._lastNightMode = night;
                    const mapped = night ? 'clu' : 'tron';
                    // Equality guard: skip the no-op write so e.g. "Reset all"
                    // can't re-create a user value equal to the default.
                    if (this._settings.get_string('palette') !== mapped)
                        this._settings.set_string('palette', mapped);
                }),
                this._settings.connect('changed::theme-popups', () => this._syncPopupClass()),
            ];
        }

        // NOTE: Tray / app-indicators are left VISIBLE. They sit on the right
        // near Quick Settings (the traditional spot) and balance the left-side
        // metrics cluster.
        // TODO(Phase 3): the Claude usage metric was planned to REPLACE the
        // Claude Desktop tray icon. Now that the tray is back, decide there
        // whether the metric replaces that one icon (hide just it) or coexists.

        // 2. Remove the Activities button from the layout (far left). The Super
        //    key still opens the Overview (mutter overlay-key = 'Super'), so
        //    nothing is lost. Phase 2's metrics cluster takes this left space.
        //
        //    We don't destroy() it — the shell owns that widget and other code
        //    references it; destroying core panel widgets is fragile and gets
        //    extensions rejected from e.g.o. Instead we fully collapse it: hide
        //    AND zero its width so there is no leftover slot/gap under the
        //    metrics. Fully reversed in disable().
        const activities = Main.panel.statusArea.activities;
        this._activitiesActor = activities?.container ?? activities;
        if (this._activitiesActor) {
            this._activitiesActor.hide();
            this._activitiesActor.width = 0;
            // Belt-and-suspenders: keep it collapsed even if something re-shows
            // it (some shell paths toggle visibility on the Activities button).
            this._activitiesShownId = this._activitiesActor.connect(
                'show', () => {
                    this._activitiesActor.hide();
                    this._activitiesActor.width = 0;
                });
            this._activitiesHidden = true;
        }

        // 3. Metrics cluster on the LEFT (where Activities was). One container
        //    holds the three indicators in order: CPU, Workday, Weather. Each
        //    reads config from GSettings and manages its own timers.
        this._metricsBox = new St.BoxLayout({
            style_class: 'modern-bar-metrics',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });

        // Shared registry for the metric dropdowns: guarantees only one is open
        // at a time. Deliberately NOT a PopupMenuManager — that takes a modal
        // grab (Main.pushModal), which steals keyboard focus and forces a click
        // elsewhere to dismiss. These popups close on pointer proximity instead;
        // see lib/metricPopup.js. Metrics not given it simply have no dropdown.
        this._popupGroup = new MetricPopupGroup();

        // Custom symbolic icons (briefcase, Claude mark) are bundled in icons/;
        // pass the dir so those metrics can build Gio.FileIcons from it.
        const iconsPath = `${this.path}/icons`;
        this._metrics = [
            new CpuMetric(this._settings, iconsPath, this._popupGroup),
            new WorkdayMetric(this._settings, iconsPath, this._popupGroup),
            new WeatherMetric(this._settings, this._popupGroup),
            new ClaudeMetric(this._settings, iconsPath, this._popupGroup),
        ];
        for (const m of this._metrics)
            this._metricsBox.add_child(m);

        // Insert at the start of the panel's left box (leftmost position).
        Main.panel._leftBox.insert_child_at_index(this._metricsBox, 0);
    }

    // The palette key's valid values, straight from the schema's <choices>
    // (get_range() on an enum-ish string key returns ('enum', [values…])).
    _schemaChoices(key) {
        const [type, values] =
            this._settings.settings_schema.get_key(key).get_range().recursiveUnpack();
        if (type !== 'enum')
            throw new Error(`Schema key ${key} has no <choices>`);
        return values;
    }

    // Swap `.modern-bar-<palette>` to match the palette GSettings key. Purely a
    // CSS class swap — the color blocks live in the generated stylesheet.css.
    //
    // Applied to BOTH nodes: #panel styles the bar, uiGroup styles the dropdowns.
    // They are siblings, so neither one alone covers both (see POPUP_CLASS).
    _syncPaletteClass() {
        let current = this._settings.get_string('palette');
        if (!this._paletteNames.includes(current))
            current = 'tron';   // schema choices make this unreachable; belt+braces
        for (const actor of [Main.panel, Main.uiGroup]) {
            for (const name of this._paletteNames) {
                if (name !== current)
                    actor.remove_style_class_name(`modern-bar-${name}`);
            }
            actor.add_style_class_name(`modern-bar-${current}`);
        }
    }

    // Gate the dropdown theming on `theme-popups`. Removing the class reverts
    // Quick Settings and the calendar to stock Adwaita instantly, with the panel
    // itself left themed — the escape hatch if a shell upgrade breaks the popups.
    _syncPopupClass() {
        if (this._settings.get_boolean('theme-popups'))
            Main.uiGroup.add_style_class_name(POPUP_CLASS);
        else
            Main.uiGroup.remove_style_class_name(POPUP_CLASS);
    }

    disable() {
        // Tear down the metrics cluster first (each metric stops its own timers
        // and disconnects its own settings signals in destroy()).
        if (this._metrics) {
            for (const m of this._metrics)
                m.destroy();
            this._metrics = null;
        }
        if (this._metricsBox) {
            this._metricsBox.destroy();
            this._metricsBox = null;
        }
        // After the metrics: each one removes its own menu from the manager in
        // destroy(), so by here the manager is empty and safe to drop.
        this._popupGroup = null;

        if (this._settings && this._settingsIds) {
            for (const id of this._settingsIds)
                this._settings.disconnect(id);
        }
        this._settingsIds = null;
        // uiGroup outlives the extension, so every class we put on it must come
        // off here or it would linger (and keep restyling popups) after disable().
        for (const name of this._paletteNames ?? []) {
            Main.panel.remove_style_class_name(`modern-bar-${name}`);
            Main.uiGroup.remove_style_class_name(`modern-bar-${name}`);
        }
        this._paletteNames = null;
        Main.uiGroup.remove_style_class_name(POPUP_CLASS);
        this._settings = null;

        // Restore the Activities button fully: drop our 'show' guard, clear the
        // forced width (-1 = natural), and show it again.
        if (this._activitiesHidden && this._activitiesActor &&
            !this._activitiesActor.is_finalized?.()) {
            if (this._activitiesShownId)
                this._activitiesActor.disconnect(this._activitiesShownId);
            this._activitiesActor.width = -1;
            this._activitiesActor.show();
        }
        this._activitiesShownId = null;
        this._activitiesActor = null;
        this._activitiesHidden = false;

        // Remove our panel classes.
        Main.panel.remove_style_class_name(UNDERGLOW_CLASS);
        Main.panel.remove_style_class_name(PANEL_CLASS);
    }
}
