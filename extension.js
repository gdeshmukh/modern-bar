// modern-bar — extension.js
//
// Phase 1: theme only. The real visual work lives in stylesheet.css, which
// GNOME loads automatically for any enabled extension. This file only:
//   1. tags #panel with CSS classes so the look can be toggled from here
//   2. hides the app-indicator (tray) area, which is a JS-side concern
//
// GNOME 45+ ES-module style only. No legacy imports.* patterns.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ── Look toggles ────────────────────────────────────────────────────────────
// Flip this and re-toggle the extension to compare the faint 1px cyan
// under-glow with/without. It just adds/removes a CSS class on #panel; the
// glow itself is defined in stylesheet.css (.modern-bar-underglow).
const UNDERGLOW = true;

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
    }

    disable() {
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
