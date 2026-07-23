// modern-bar — extension.js
//
// Lifecycle + wiring. The panel look lives in stylesheet.css (auto-loaded).
// This file:
//   1. tags #panel with CSS classes so the look can be toggled from here
//   2. hides the app-indicator (tray) area, which is a JS-side concern
//   3. collapses the Activities button (Super key still opens the Overview)
//   4. Phase 2: mounts the metrics cluster (CPU / Workday / Weather) on the
//      LEFT, where Activities was; each reads config from GSettings and tears
//      down its own timers/signals. This file owns their container.
//
// GNOME 45+ ES-module style only. No legacy imports.* patterns.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {CpuMetric} from './lib/cpuMetric.js';
import {WorkdayMetric} from './lib/workdayMetric.js';
import {WeatherMetric} from './lib/weatherMetric.js';

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

export default class ModernBarExtension extends Extension {
    enable() {
        // 1. Tag the panel so stylesheet.css can scope to us and so the
        //    under-glow is toggleable without editing CSS.
        Main.panel.add_style_class_name(PANEL_CLASS);
        if (UNDERGLOW)
            Main.panel.add_style_class_name(UNDERGLOW_CLASS);

        // 2. Hide the tray / app-indicator area.
        //    Ubuntu ships tray icons via the `ubuntu-appindicators` extension,
        //    which injects each icon as an indicator into Main.panel.statusArea.
        //    I only have one (Claude Desktop) and it's slated to become a Phase 3
        //    metric, so hide the lot for now. We hide the actor (reversible)
        //    rather than disabling the other extension (fragile from in here).
        //
        // TODO(share): if modern-bar is ever published, hiding another
        // extension's icons wholesale is antisocial. Proper coexistence would
        // detect only the icons we intend to replace, or expose a GSettings
        // toggle, and leave everyone else's tray icons alone.
        this._hiddenIndicators = new Set();
        this._hideAppIndicators();

        // App-indicators can appear after login (DBus is async), so keep
        // watching the panel's right box for late arrivals. In GNOME 50 the
        // Clutter signal is 'child-added' (not the old 'actor-added').
        this._rightBox = Main.panel._rightBox;
        this._childAddedId = this._rightBox.connect(
            'child-added', () => this._hideAppIndicators());

        // 3. Remove the Activities button from the layout (far left). The Super
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

        // 4. Metrics cluster on the LEFT (where Activities was). One container
        //    holds the three indicators in order: CPU, Workday, Weather. Each
        //    reads config from GSettings and manages its own timers.
        this._settings = this.getSettings();

        this._metricsBox = new St.BoxLayout({
            style_class: 'modern-bar-metrics',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });

        this._metrics = [
            new CpuMetric(this._settings),
            new WorkdayMetric(this._settings),
            new WeatherMetric(this._settings),
        ];
        for (const m of this._metrics)
            this._metricsBox.add_child(m);

        // Insert at the start of the panel's left box (leftmost position).
        Main.panel._leftBox.insert_child_at_index(this._metricsBox, 0);
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
        this._settings = null;

        // Restore every indicator we hid.
        if (this._hiddenIndicators) {
            for (const actor of this._hiddenIndicators) {
                // Actor may already be destroyed if its app quit; guard it.
                if (actor && !actor.is_finalized?.())
                    actor.visible = true;
            }
            this._hiddenIndicators.clear();
            this._hiddenIndicators = null;
        }

        if (this._rightBox && this._childAddedId) {
            this._rightBox.disconnect(this._childAddedId);
        }
        this._childAddedId = null;
        this._rightBox = null;

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

    // Hide any app-indicator icons currently in the status area. Idempotent.
    _hideAppIndicators() {
        for (const [role, indicator] of Object.entries(Main.panel.statusArea)) {
            if (!indicator)
                continue;
            // The appindicators extension registers icons whose constructor is
            // named for the StatusNotifierItem source. Match defensively by
            // constructor name so we don't hard-depend on the other extension's
            // internals or import it.
            const ctorName = indicator.constructor?.name ?? '';
            const isAppIndicator =
                ctorName.includes('IndicatorStatusIcon') ||
                ctorName.includes('AppIndicator') ||
                role.startsWith('appindicator-');
            if (!isAppIndicator)
                continue;

            const actor = indicator.container ?? indicator;
            if (actor && actor.visible) {
                actor.visible = false;
                this._hiddenIndicators.add(actor);
            }
        }
    }
}
