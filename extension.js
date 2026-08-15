// SPDX-License-Identifier: GPL-2.0-or-later
// GNOME Shell lifecycle and wiring for panel styling and metrics.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {CpuMetric} from './lib/cpuMetric.js';
import {WorkdayMetric} from './lib/workdayMetric.js';
import {WeatherMetric} from './lib/weatherMetric.js';
import {ClaudeMetric} from './lib/claudeMetric.js';
import {CodexMetric} from './lib/codexMetric.js';
import {MetricPopupGroup} from './lib/metricPopup.js';
import {MenuProximityDismiss} from './lib/menuProximity.js';

// The stock theme may overdraw a panel-wide border, so underglow stays opt-in.
const UNDERGLOW = false;

const PANEL_CLASS = 'modern-bar';
const UNDERGLOW_CLASS = 'modern-bar-underglow';

// Panel menus are reparented under uiGroup, outside #panel's selector scope.
const POPUP_CLASS = 'modern-bar-popups';

export default class ModernBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        Main.panel.add_style_class_name(PANEL_CLASS);
        if (UNDERGLOW)
            Main.panel.add_style_class_name(UNDERGLOW_CLASS);

        // Missing compiled keys make get_key() fatal, so stale schemas degrade.
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

            // Preserve night-mode users who have never selected a palette.
            if (this._settings.get_user_value('palette') === null &&
                this._settings.get_boolean('night-mode'))
                this._settings.set_string('palette', 'clu');

            this._syncPaletteClass();
            this._syncPopupClass();
            // Equal writes to unset GSettings keys still emit changed::.
            this._lastNightMode = this._settings.get_boolean('night-mode');
            this._settingsIds = [
                this._settings.connect('changed::palette', () => this._syncPaletteClass()),
                // Keep the legacy theme-switching key usable.
                this._settings.connect('changed::night-mode', () => {
                    const night = this._settings.get_boolean('night-mode');
                    if (night === this._lastNightMode)
                        return;
                    this._lastNightMode = night;
                    const mapped = night ? 'clu' : 'tron';
                    // Avoid recreating a user value after reset.
                    if (this._settings.get_string('palette') !== mapped)
                        this._settings.set_string('palette', mapped);
                }),
                this._settings.connect('changed::theme-popups', () => this._syncPopupClass()),
            ];
        }

        // Other shell code retains references, so hide and collapse instead.
        const activities = Main.panel.statusArea.activities;
        this._activitiesActor = activities?.container ?? activities;
        if (this._activitiesActor) {
            this._activitiesActor.hide();
            this._activitiesActor.width = 0;
            // Shell paths may show the actor again while the extension is active.
            this._activitiesShownId = this._activitiesActor.connect(
                'show', () => {
                    this._activitiesActor.hide();
                    this._activitiesActor.width = 0;
                });
            this._activitiesHidden = true;
        }

        this._metricsBox = new St.BoxLayout({
            style_class: 'modern-bar-metrics',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });

        this._popupGroup = new MetricPopupGroup();

        const iconsPath = `${this.path}/icons`;
        this._metrics = [
            new CpuMetric(this._settings, iconsPath, this._popupGroup),
            new WorkdayMetric(this._settings, iconsPath, this._popupGroup),
            new WeatherMetric(this._settings, iconsPath, this._popupGroup),
            new ClaudeMetric(this._settings, iconsPath, this._popupGroup),
            new CodexMetric(this._settings, iconsPath, this._popupGroup),
        ];
        for (const m of this._metrics)
            this._metricsBox.add_child(m);

        // _leftBox is private shell API and must be rechecked on shell upgrades.
        Main.panel._leftBox.insert_child_at_index(this._metricsBox, 0);

        // Stale compiled schemas make missing-key access fatal.
        if (this._settings.settings_schema.has_key('dismiss-on-leave'))
            this._menuDismiss = new MenuProximityDismiss(this._settings);
    }

    _schemaChoices(key) {
        const [type, values] =
            this._settings.settings_schema.get_key(key).get_range().recursiveUnpack();
        if (type !== 'enum')
            throw new Error(`Schema key ${key} has no <choices>`);
        return values;
    }

    // Panel and menus are siblings, so both require palette classes.
    _syncPaletteClass() {
        let current = this._settings.get_string('palette');
        if (!this._paletteNames.includes(current))
            current = 'tron';
        for (const actor of [Main.panel, Main.uiGroup]) {
            for (const name of this._paletteNames) {
                if (name !== current)
                    actor.remove_style_class_name(`modern-bar-${name}`);
            }
            actor.add_style_class_name(`modern-bar-${current}`);
        }
    }

    // Popup theming must be independently reversible after shell changes.
    _syncPopupClass() {
        if (this._settings.get_boolean('theme-popups'))
            Main.uiGroup.add_style_class_name(POPUP_CLASS);
        else
            Main.uiGroup.remove_style_class_name(POPUP_CLASS);
    }

    disable() {
        if (this._menuDismiss) {
            this._menuDismiss.destroy();
            this._menuDismiss = null;
        }

        if (this._metrics) {
            for (const m of this._metrics)
                m.destroy();
            this._metrics = null;
        }
        if (this._metricsBox) {
            this._metricsBox.destroy();
            this._metricsBox = null;
        }
        this._popupGroup = null;

        if (this._settings && this._settingsIds) {
            for (const id of this._settingsIds)
                this._settings.disconnect(id);
        }
        this._settingsIds = null;
        // uiGroup outlives this extension.
        for (const name of this._paletteNames ?? []) {
            Main.panel.remove_style_class_name(`modern-bar-${name}`);
            Main.uiGroup.remove_style_class_name(`modern-bar-${name}`);
        }
        this._paletteNames = null;
        Main.uiGroup.remove_style_class_name(POPUP_CLASS);
        this._settings = null;

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

        Main.panel.remove_style_class_name(UNDERGLOW_CLASS);
        Main.panel.remove_style_class_name(PANEL_CLASS);
    }
}
