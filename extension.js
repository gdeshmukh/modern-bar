// modern-bar — extension.js
//
// Lifecycle + wiring. The panel look lives in stylesheet.css (auto-loaded).
// This file:
//   1. tags #panel with CSS classes so the look can be toggled from here,
//      including the day/night (Tron/Clu) palette (night-mode in prefs)
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
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {CpuMetric} from './lib/cpuMetric.js';
import {WorkdayMetric} from './lib/workdayMetric.js';
import {WeatherMetric} from './lib/weatherMetric.js';
import {ClaudeMetric} from './lib/claudeMetric.js';

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
const NIGHT_CLASS = 'modern-bar-night';

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

        // 1b. Day/night (Tron/Clu) palette. `night-mode` is a plain GSettings
        //     boolean exposed in prefs (Palette group) — the only outward-facing
        //     toggle. Flipping it just adds/removes a CSS class; see
        //     stylesheet.css's .modern-bar-night rules for the actual colors.
        //     No file-watching here — that's a personal convenience some users
        //     may wire up themselves (e.g. a shell script that also runs
        //     `gsettings set org.gnome.shell.extensions.modernbar night-mode ...`),
        //     not something the extension does on anyone's behalf.
        //     The night class is applied to BOTH #panel and uiGroup — see
        //     POPUP_CLASS above for why one node can't cover both.
        this._syncNightClass();
        this._syncPopupClass();
        this._settingsIds = [
            this._settings.connect('changed::night-mode', () => this._syncNightClass()),
            this._settings.connect('changed::theme-popups', () => this._syncPopupClass()),
        ];

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

        // One manager shared by every metric dropdown: it gives click-outside-to-
        // close and guarantees only one metric popup is open at a time. Metrics
        // that don't take it simply have no dropdown.
        this._menuManager = new PopupMenu.PopupMenuManager(Main.panel);

        // Custom symbolic icons (briefcase, Claude mark) are bundled in icons/;
        // pass the dir so those metrics can build Gio.FileIcons from it.
        const iconsPath = `${this.path}/icons`;
        // Workday has no dropdown: a percentage of the way through the day has
        // no detail worth a second line.
        this._metrics = [
            new CpuMetric(this._settings, iconsPath, this._menuManager),
            new WorkdayMetric(this._settings, iconsPath),
            new WeatherMetric(this._settings, this._menuManager),
            new ClaudeMetric(this._settings, iconsPath, this._menuManager),
        ];
        for (const m of this._metrics)
            this._metricsBox.add_child(m);

        // Insert at the start of the panel's left box (leftmost position).
        Main.panel._leftBox.insert_child_at_index(this._metricsBox, 0);
    }

    // Add/remove NIGHT_CLASS to match the night-mode GSettings key. Purely a CSS
    // class swap — see stylesheet.css's .modern-bar-night rules.
    //
    // Applied to BOTH nodes: #panel styles the bar, uiGroup styles the dropdowns.
    // They are siblings, so neither one alone covers both (see POPUP_CLASS).
    _syncNightClass() {
        const night = this._settings.get_boolean('night-mode');
        for (const actor of [Main.panel, Main.uiGroup]) {
            if (night)
                actor.add_style_class_name(NIGHT_CLASS);
            else
                actor.remove_style_class_name(NIGHT_CLASS);
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
        this._menuManager = null;

        if (this._settings && this._settingsIds) {
            for (const id of this._settingsIds)
                this._settings.disconnect(id);
        }
        this._settingsIds = null;
        Main.panel.remove_style_class_name(NIGHT_CLASS);
        // uiGroup outlives the extension, so both of our classes must come off
        // it here or they'd linger (and keep restyling popups) after disable().
        Main.uiGroup.remove_style_class_name(NIGHT_CLASS);
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
