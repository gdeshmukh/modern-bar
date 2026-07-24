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
        this._syncNightClass();
        this._nightModeId = this._settings.connect(
            'changed::night-mode', () => this._syncNightClass());

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

        // Custom symbolic icons (briefcase, Claude mark) are bundled in icons/;
        // pass the dir so those metrics can build Gio.FileIcons from it.
        const iconsPath = `${this.path}/icons`;
        this._metrics = [
            new CpuMetric(this._settings, iconsPath),
            new WorkdayMetric(this._settings, iconsPath),
            new WeatherMetric(this._settings),
            new ClaudeMetric(this._settings, iconsPath),
        ];
        for (const m of this._metrics)
            this._metricsBox.add_child(m);

        // Insert at the start of the panel's left box (leftmost position).
        Main.panel._leftBox.insert_child_at_index(this._metricsBox, 0);
    }

    // Add/remove NIGHT_CLASS on #panel to match the night-mode GSettings key.
    // Purely a CSS class swap — see stylesheet.css's .modern-bar-night rules.
    _syncNightClass() {
        if (this._settings.get_boolean('night-mode'))
            Main.panel.add_style_class_name(NIGHT_CLASS);
        else
            Main.panel.remove_style_class_name(NIGHT_CLASS);
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

        if (this._settings && this._nightModeId) {
            this._settings.disconnect(this._nightModeId);
        }
        this._nightModeId = 0;
        Main.panel.remove_style_class_name(NIGHT_CLASS);
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
