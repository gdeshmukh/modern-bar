// modern-bar — prefs.js
//
// The preferences window shown by the Extensions app (the gear icon) and by
// `gnome-extensions prefs modernbar@gdesh.com`. Everything here writes to the
// GSettings schema; the running extension reads the same keys live.
//
// GNOME 45+ style: libadwaita, ES modules.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ModernBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Modern Bar',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        this._addWorkdayGroup(page, settings);
        this._addWeatherGroup(page, settings, window);
        this._addCpuGroup(page, settings);
        this._addClaudeGroup(page, settings);
    }

    // ── Workday ─────────────────────────────────────────────────────────────
    _addWorkdayGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Workday',
            description: 'Percent of the work day elapsed. Hidden outside these hours.',
        });
        page.add(group);

        const showRow = new Adw.SwitchRow({title: 'Show Workday %'});
        settings.bind('show-workday', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showRow);

        // Time pickers rendered as HH:MM spin rows (hours + minutes) — simple,
        // dependency-free, and stored as the "HH:MM" strings the schema expects.
        group.add(this._makeTimeRow('Start time', settings, 'work-start'));
        group.add(this._makeTimeRow('End time', settings, 'work-end'));
    }

    // A row with two spinners (hour 0-23, minute 0-59) bound to an "HH:MM" key.
    _makeTimeRow(title, settings, key) {
        const row = new Adw.ActionRow({title});

        const [h0, m0] = this._parseHHMM(settings.get_string(key));

        const hour = Gtk.SpinButton.new_with_range(0, 23, 1);
        hour.set_value(h0);
        hour.set_valign(Gtk.Align.CENTER);
        hour.set_orientation(Gtk.Orientation.VERTICAL);

        const min = Gtk.SpinButton.new_with_range(0, 59, 1);
        min.set_value(m0);
        min.set_valign(Gtk.Align.CENTER);
        min.set_orientation(Gtk.Orientation.VERTICAL);

        const commit = () => {
            const hh = String(hour.get_value_as_int()).padStart(2, '0');
            const mm = String(min.get_value_as_int()).padStart(2, '0');
            settings.set_string(key, `${hh}:${mm}`);
        };
        hour.connect('value-changed', commit);
        min.connect('value-changed', commit);

        const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        box.append(hour);
        box.append(new Gtk.Label({label: ':'}));
        box.append(min);
        row.add_suffix(box);
        return row;
    }

    _parseHHMM(s) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
        if (!m) return [9, 0];
        return [Math.min(23, +m[1]), Math.min(59, +m[2])];
    }

    // ── Weather ─────────────────────────────────────────────────────────────
    _addWeatherGroup(page, settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Weather',
            description: 'Current temperature from Open-Meteo (no API key).',
        });
        page.add(group);

        const showRow = new Adw.SwitchRow({title: 'Show Weather'});
        settings.bind('show-weather', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showRow);

        // Location: type a city name, press Apply to geocode -> lat/lon.
        const locRow = new Adw.EntryRow({title: 'Location'});
        locRow.set_text(settings.get_string('location-label'));
        locRow.set_show_apply_button(true);
        locRow.connect('apply', () => {
            const name = locRow.get_text().trim();
            if (name)
                this._geocode(name, settings, window);
        });
        group.add(locRow);

        // Read-only display of the resolved coordinates, kept in sync.
        const coordRow = new Adw.ActionRow({title: 'Coordinates'});
        const coordLabel = new Gtk.Label({label: this._coordText(settings)});
        coordLabel.add_css_class('dim-label');
        coordRow.add_suffix(coordLabel);
        group.add(coordRow);
        // Refresh the label if lat/lon change (e.g. after geocoding).
        const latId = settings.connect('changed::latitude',
            () => coordLabel.set_label(this._coordText(settings)));
        const lonId = settings.connect('changed::longitude',
            () => coordLabel.set_label(this._coordText(settings)));
        window.connect('close-request', () => {
            settings.disconnect(latId);
            settings.disconnect(lonId);
        });

        // Units.
        const unitRow = new Adw.ComboRow({
            title: 'Temperature unit',
            model: new Gtk.StringList({strings: ['Fahrenheit (°F)', 'Celsius (°C)']}),
        });
        unitRow.set_selected(settings.get_string('temperature-unit') === 'celsius' ? 1 : 0);
        unitRow.connect('notify::selected', () => {
            settings.set_string('temperature-unit',
                unitRow.get_selected() === 1 ? 'celsius' : 'fahrenheit');
        });
        group.add(unitRow);

        // Refresh interval (minutes).
        const refreshRow = new Adw.SpinRow({
            title: 'Refresh interval (minutes)',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 180, step_increment: 5}),
        });
        settings.bind('weather-refresh-minutes', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(refreshRow);
    }

    _coordText(settings) {
        const lat = settings.get_double('latitude').toFixed(4);
        const lon = settings.get_double('longitude').toFixed(4);
        return `${lat}, ${lon}`;
    }

    // Geocode a place name via Open-Meteo's free geocoding API, async.
    _geocode(name, settings, window) {
        const session = new Soup.Session();
        const url = 'https://geocoding-api.open-meteo.com/v1/search?' +
            `name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
        const msg = Soup.Message.new('GET', url);

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                const text = new TextDecoder().decode(bytes.get_data());
                const data = JSON.parse(text);
                const r = data?.results?.[0];
                if (!r) {
                    this._toast(window, `No match for “${name}”.`);
                    return;
                }
                settings.set_string('location-label', r.name);
                settings.set_double('latitude', r.latitude);
                settings.set_double('longitude', r.longitude);
                const where = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
                this._toast(window, `Location set to ${where}.`);
            } catch (e) {
                this._toast(window, 'Could not look up that location.');
            }
        });
    }

    _toast(window, text) {
        if (window.add_toast)
            window.add_toast(new Adw.Toast({title: text, timeout: 3}));
    }

    // ── CPU ─────────────────────────────────────────────────────────────────
    _addCpuGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'CPU',
            description: 'Total CPU load, sampled from /proc/stat.',
        });
        page.add(group);

        const showRow = new Adw.SwitchRow({title: 'Show CPU %'});
        settings.bind('show-cpu', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showRow);

        const sampleRow = new Adw.SpinRow({
            title: 'Sample interval (seconds)',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1}),
        });
        settings.bind('cpu-refresh-seconds', sampleRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(sampleRow);

        const warnRow = new Adw.SpinRow({
            title: 'Warning threshold (%)',
            subtitle: 'At or above this, the value turns orange.',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 5}),
        });
        settings.bind('cpu-warn-percent', warnRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(warnRow);
    }

    // ── Claude usage ────────────────────────────────────────────────────────
    _addClaudeGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Claude usage',
            description: 'Your account 5-hour usage %, read via the token Claude ' +
                'Code already stores (~/.claude). No login needed. Hides if Claude ' +
                'Code is not installed or the endpoint is unreachable.',
        });
        page.add(group);

        const showRow = new Adw.SwitchRow({title: 'Show Claude usage'});
        settings.bind('show-claude', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showRow);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh interval (minutes)',
            subtitle: 'Kept infrequent — the usage endpoint rate-limits aggressively.',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 60, step_increment: 1}),
        });
        settings.bind('claude-refresh-minutes', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(refreshRow);

        const warnRow = new Adw.SpinRow({
            title: 'Warning threshold (%)',
            subtitle: 'At or above this 5-hour utilization, the value turns orange.',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 5}),
        });
        settings.bind('claude-warn-percent', warnRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(warnRow);
    }
}
