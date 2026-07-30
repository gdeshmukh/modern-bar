// SPDX-License-Identifier: GPL-2.0-or-later
// modern-bar — prefs.js
//
// The preferences window shown by the Extensions app (the gear icon) and by
// `gnome-extensions prefs modernbar@gdesh.com`. Everything here writes to the
// GSettings schema; the running extension reads the same keys live.
//
// GNOME 45+ style: libadwaita, ES modules. Production rules this file holds
// itself to (the extension is headed for extensions.gnome.org):
//
//  - Spin ranges are DERIVED from the schema (`_schemaRange`), never restated.
//    A hand-copied range already bit us once: the UI clamped 15→30 and, being a
//    two-way binding, wrote the clamp back over the user's real value.
//  - Every user-visible string goes through gettext (`_`), so the window is
//    translatable the moment a locale/ dir exists.
//  - Every settings signal connected here is disconnected on close-request —
//    prefs windows come and go; the Gio.Settings they watch does not.
//  - Per-metric rows grey out while that metric's master switch (in the group
//    header) is off, so the window itself shows what is inert.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ModernBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // One list of undo-thunks per window; run once when it closes.
        const cleanup = [];
        const track = (id) => cleanup.push(() => settings.disconnect(id));
        window.connect('close-request', () => {
            cleanup.forEach(f => f());
            cleanup.length = 0;
            return false;   // let the window close normally
        });

        window.search_enabled = true;
        window.add(this._buildAppearancePage(settings, track));
        window.add(this._buildMetricsPage(settings, window, track));
        window.add(this._buildAboutPage(settings, window));
    }

    // ── Shared builders ─────────────────────────────────────────────────────

    // [lower, upper] from the schema's own <range>. The schema stays the single
    // source of truth; a missing range is a programming error we want loud.
    _schemaRange(settings, key) {
        // get_range() returns ('range', <(lo, hi)>); recursiveUnpack (a GJS
        // add-on, so camelCase — deep_unpack would leave the inner variant
        // wrapped) unwraps to a plain [lo, hi].
        const [type, value] = settings.settings_schema.get_key(key).get_range().recursiveUnpack();
        if (type !== 'range')
            throw new Error(`Schema key ${key} declares no <range>`);
        return value;
    }

    // SpinRow bound two-way to an int/double key, range read from the schema.
    _spinRow(settings, key, {title, subtitle = null, step = 1, digits = 0}) {
        const [lower, upper] = this._schemaRange(settings, key);
        const row = new Adw.SpinRow({
            title, subtitle, digits,
            adjustment: new Gtk.Adjustment({
                lower, upper,
                step_increment: step,
                page_increment: step * 10,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    // A PreferencesGroup whose header carries the metric's master switch.
    // Rows added through `addRow` grey out while the switch is off.
    _metricGroup(settings, showKey, props) {
        const group = new Adw.PreferencesGroup(props);
        const toggle = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Show this metric in the panel'),
        });
        toggle.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [`${props.title} — ${_('Show this metric in the panel')}`]);
        settings.bind(showKey, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.header_suffix = toggle;
        const addRow = row => {
            settings.bind(showKey, row, 'sensitive', Gio.SettingsBindFlags.GET);
            group.add(row);
        };
        return [group, addRow];
    }

    // Valid values of an enum-ish string key, from the schema's own <choices>
    // (same single-source-of-truth rule as the spin ranges).
    _schemaChoices(settings, key) {
        const [type, values] =
            settings.settings_schema.get_key(key).get_range().recursiveUnpack();
        if (type !== 'enum')
            throw new Error(`Schema key ${key} declares no <choices>`);
        return values;
    }

    // ── Page 1: Appearance ──────────────────────────────────────────────────
    _buildAppearancePage(settings, track) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Palette'),
            description: _('One shared deep-black grid; choose the circuit ' +
                'color that glows on it. Colors follow the Program lore.'),
        });
        page.add(group);

        // Display name + lore per schema value. Anything the schema adds that
        // this table doesn't know yet still shows (as its raw name) rather
        // than breaking the row.
        const info = {
            tron: [_('Tron'), _('Blue — fights for the Users')],
            iso: [_('ISO'), _('White — the ISOs and the Users')],
            clu: [_('Clu'), _('Gold — the system administrator')],
            rinzler: [_('Rinzler'), _('Orange — repurposed to serve Clu')],
            sark: [_('Sark'), _('Red — loyal to the MCP')],
            military: [_('Military'), _('Teal green — the tank drivers of ’82')],
            utility: [_('Utility'), _('Violet — data pushers and system utilities')],
        };
        const values = this._schemaChoices(settings, 'palette');

        const paletteRow = new Adw.ComboRow({
            title: _('Circuit color'),
            model: new Gtk.StringList({
                strings: values.map(v => info[v]?.[0] ?? v),
            }),
        });
        const syncLore = () =>
            paletteRow.set_subtitle(info[values[paletteRow.selected]]?.[1] ?? '');
        const syncFromKey = () => {
            const want = Math.max(0, values.indexOf(settings.get_string('palette')));
            if (paletteRow.selected !== want)
                paletteRow.selected = want;
            syncLore();
        };
        syncFromKey();
        paletteRow.connect('notify::selected', () => {
            // Equality guard on every widget→key write in this file: a write
            // of the CURRENT value is not always a no-op — on a freshly reset
            // (unset) key it re-creates a user value and emits changed::, so
            // an unguarded echo here would quietly dirty "Reset all".
            if (settings.get_string('palette') !== values[paletteRow.selected])
                settings.set_string('palette', values[paletteRow.selected]);
            syncLore();
        });
        track(settings.connect('changed::palette', syncFromKey));
        group.add(paletteRow);

        // Popups are styled from stock GNOME selectors that can shift between
        // shell releases, so they get their own switch — turn this off and the
        // dropdowns fall back to stock Adwaita without touching the panel.
        const popupRow = new Adw.SwitchRow({
            title: _('Theme the dropdowns'),
            subtitle: _('Apply the palette to Quick Settings and the ' +
                'clock/calendar menu. Off leaves them stock.'),
        });
        settings.bind('theme-popups', popupRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(popupRow);

        // Behaviour, not colour, so it says plainly what it does NOT change —
        // the worry with any dismissal tweak is losing click-outside or Escape.
        const leaveRow = new Adw.SwitchRow({
            title: _('Close dropdowns on mouse away'),
            subtitle: _('Quick Settings and the clock/calendar menu close when ' +
                'the pointer leaves, like the metric dropdowns. Clicking away, ' +
                'Escape and keyboard navigation still work as usual.'),
        });
        settings.bind('dismiss-on-leave', leaveRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(leaveRow);

        return page;
    }

    // ── Page 2: Metrics ─────────────────────────────────────────────────────
    _buildMetricsPage(settings, window, track) {
        const page = new Adw.PreferencesPage({
            title: _('Metrics'),
            icon_name: 'utilities-system-monitor-symbolic',
        });
        this._addCpuGroup(page, settings);
        this._addWorkdayGroup(page, settings, track);
        this._addWeatherGroup(page, settings, window, track);
        this._addClaudeGroup(page, settings);
        return page;
    }

    _addCpuGroup(page, settings) {
        const [group, addRow] = this._metricGroup(settings, 'show-cpu', {
            title: _('CPU'),
            description: _('Total CPU load. Click the metric for memory and ' +
                'load average.'),
        });
        page.add(group);

        addRow(this._spinRow(settings, 'cpu-refresh-seconds', {
            title: _('Sample interval (seconds)'),
        }));
        addRow(this._spinRow(settings, 'cpu-warn-percent', {
            title: _('Warning threshold (%)'),
            subtitle: _('At or above this, the value shows in the alert color.'),
            step: 5,
        }));
    }

    _addWorkdayGroup(page, settings, track) {
        const [group, addRow] = this._metricGroup(settings, 'show-workday', {
            title: _('Workday'),
            description: _('Percent of the work day elapsed. Hidden outside ' +
                'these hours.'),
        });
        page.add(group);

        addRow(this._timeRow(settings, 'work-start', _('Start time'), track));
        const endRow = this._timeRow(settings, 'work-end', _('End time'), track);
        addRow(endRow);

        // A start ≥ end range is stored faithfully but renders nothing (the
        // metric hides) — say so where the mistake is being made.
        const validate = () => {
            const [sh, sm] = this._parseHHMM(settings.get_string('work-start'));
            const [eh, em] = this._parseHHMM(settings.get_string('work-end'));
            endRow.subtitle = eh * 60 + em <= sh * 60 + sm
                ? _('End is not after start — the metric will stay hidden.')
                : '';
        };
        validate();
        track(settings.connect('changed::work-start', validate));
        track(settings.connect('changed::work-end', validate));
    }

    // A row with two spinners (hour 0–23, minute 0–59) bound to an "HH:MM"
    // key. Syncs BOTH ways: spinning writes the key; an external write (dconf,
    // scripts) moves the spinners.
    _timeRow(settings, key, title, track) {
        const row = new Adw.ActionRow({title});

        const hour = Gtk.SpinButton.new_with_range(0, 23, 1);
        const min = Gtk.SpinButton.new_with_range(0, 59, 1);
        for (const sb of [hour, min]) {
            sb.set_orientation(Gtk.Orientation.VERTICAL);
            sb.set_valign(Gtk.Align.CENTER);
            sb.set_wrap(true);
            sb.set_width_chars(2);
        }

        const sync = () => {
            const [h, m] = this._parseHHMM(settings.get_string(key));
            hour.set_value(h);
            min.set_value(m);
        };
        sync();

        // Equality-guarded (see the palette row): a same-value write only
        // no-ops when a user value exists; on an unset key it would re-create
        // one and re-fire changed::.
        const commit = () => {
            const hh = String(hour.get_value_as_int()).padStart(2, '0');
            const mm = String(min.get_value_as_int()).padStart(2, '0');
            if (settings.get_string(key) !== `${hh}:${mm}`)
                settings.set_string(key, `${hh}:${mm}`);
        };
        hour.connect('value-changed', commit);
        min.connect('value-changed', commit);
        track(settings.connect(`changed::${key}`, sync));

        const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        box.append(hour);
        box.append(new Gtk.Label({label: ':'}));
        box.append(min);
        row.add_suffix(box);
        return row;
    }

    _parseHHMM(s) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
        if (!m)
            return [9, 0];
        return [Math.min(23, +m[1]), Math.min(59, +m[2])];
    }

    _addWeatherGroup(page, settings, window, track) {
        const [group, addRow] = this._metricGroup(settings, 'show-weather', {
            title: _('Weather'),
            description: _('Current temperature from Open-Meteo (no API key). ' +
                'Click the metric for details and a 7-day outlook.'),
        });
        page.add(group);

        // Location: type a name, press Apply (⏎) to geocode → lat/lon.
        const locRow = new Adw.EntryRow({
            title: _('Location'),
            show_apply_button: true,
        });
        locRow.set_text(settings.get_string('location-label'));
        locRow.connect('apply', () => {
            const name = locRow.get_text().trim();
            if (name)
                this._geocode(name, settings, window);
        });
        track(settings.connect('changed::location-label', () => {
            const t = settings.get_string('location-label');
            if (locRow.get_text() !== t)
                locRow.set_text(t);
        }));
        addRow(locRow);

        // Coordinates: normally geocode output, but directly editable so the
        // metric can be configured with the geocoding service unreachable (or
        // without sending a place name anywhere at all).
        const coordRow = new Adw.ExpanderRow({
            title: _('Coordinates'),
            subtitle: this._coordText(settings),
        });
        coordRow.add_row(this._spinRow(settings, 'latitude', {
            title: _('Latitude'), step: 0.05, digits: 4,
        }));
        coordRow.add_row(this._spinRow(settings, 'longitude', {
            title: _('Longitude'), step: 0.05, digits: 4,
        }));
        const syncCoords = () => coordRow.set_subtitle(this._coordText(settings));
        track(settings.connect('changed::latitude', syncCoords));
        track(settings.connect('changed::longitude', syncCoords));
        addRow(coordRow);

        // Unit. Wind/precip units in the dropdown follow this too (°F ⇒
        // mph/inch, °C ⇒ km/h/mm) — deliberately not more settings.
        const unitRow = new Adw.ComboRow({
            title: _('Temperature unit'),
            model: new Gtk.StringList({
                strings: [_('Fahrenheit (°F)'), _('Celsius (°C)')],
            }),
        });
        const syncUnit = () => {
            const want = settings.get_string('temperature-unit') === 'celsius' ? 1 : 0;
            if (unitRow.selected !== want)
                unitRow.selected = want;
        };
        syncUnit();
        unitRow.connect('notify::selected', () => {
            const want = unitRow.selected === 1 ? 'celsius' : 'fahrenheit';
            if (settings.get_string('temperature-unit') !== want)
                settings.set_string('temperature-unit', want);
        });
        track(settings.connect('changed::temperature-unit', syncUnit));
        addRow(unitRow);

        addRow(this._spinRow(settings, 'weather-refresh-minutes', {
            title: _('Refresh interval (minutes)'),
            step: 5,
        }));
    }

    _coordText(settings) {
        const lat = settings.get_double('latitude').toFixed(4);
        const lon = settings.get_double('longitude').toFixed(4);
        return `${lat}, ${lon}`;
    }

    // Geocode a place name via Open-Meteo's free geocoding API, async.
    _geocode(name, settings, window) {
        const session = new Soup.Session({timeout: 10});
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
                    this._toast(window, _('No match for “%s”.').format(name));
                    return;
                }
                settings.set_string('location-label', r.name);
                settings.set_double('latitude', r.latitude);
                settings.set_double('longitude', r.longitude);
                const where = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
                this._toast(window, _('Location set to %s.').format(where));
            } catch (e) {
                this._toast(window, _('Could not look up that location.'));
            }
        });
    }

    _toast(window, text) {
        try {
            window.add_toast(new Adw.Toast({title: text, timeout: 3}));
        } catch (e) {
            // window already closed — nothing to tell anyone
        }
    }

    _addClaudeGroup(page, settings) {
        const creds = GLib.build_filenamev(
            [GLib.get_home_dir(), '.claude', '.credentials.json']);
        // Existence check only — the file itself is never read from prefs.
        const haveCreds = GLib.file_test(creds, GLib.FileTest.EXISTS);

        let description = _('Your account 5-hour usage %, read via the OAuth ' +
            'token Claude Code already stores locally (~/.claude). No login or ' +
            'API key; the token is only ever sent to Anthropic. Off by ' +
            'default — nothing is read and no request is made until you ' +
            'turn it on.');
        if (!haveCreds) {
            description += ' ' + _('Claude Code credentials were not found on ' +
                'this machine, so the metric will stay hidden.');
        }

        const [group, addRow] = this._metricGroup(settings, 'show-claude', {
            title: _('Claude usage'),
            description,
        });
        page.add(group);

        addRow(this._spinRow(settings, 'claude-refresh-seconds', {
            title: _('Refresh interval (seconds)'),
            subtitle: _('Below ~30s the endpoint starts rate-limiting; the ' +
                'last value is kept and retried, so the number goes stale ' +
                'rather than away.'),
            step: 5,
        }));
        addRow(this._spinRow(settings, 'claude-warn-percent', {
            title: _('Warning threshold (%)'),
            subtitle: _('At or above this 5-hour utilization, the value shows ' +
                'in the alert color.'),
            step: 5,
        }));
    }

    // ── Page 3: About ───────────────────────────────────────────────────────
    _buildAboutPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });

        const info = new Adw.PreferencesGroup();
        page.add(info);

        info.add(new Adw.ActionRow({
            title: _('Modern Bar'),
            subtitle: _('Version %s · GNOME Shell %s').format(
                this.metadata['version-name'] ?? '—',
                this.metadata['shell-version'].join(', ')),
        }));

        const url = this.metadata.url;
        if (url) {
            info.add(this._linkRow(window, _('Homepage'), url));
            info.add(this._linkRow(window, _('Report an issue'), `${url}/issues`));
        }

        const maint = new Adw.PreferencesGroup();
        page.add(maint);
        const reset = new Adw.ButtonRow({title: _('Reset all settings…')});
        reset.add_css_class('destructive-action');
        reset.connect('activated', () => this._confirmReset(settings, window));
        maint.add(reset);

        const legal = new Adw.PreferencesGroup({
            description: _('Claude and the Claude logo are trademarks of ' +
                'Anthropic, PBC. This extension is an independent project ' +
                'and is not affiliated with or endorsed by Anthropic. ' +
                'Weather data by Open-Meteo.com.'),
        });
        page.add(legal);

        return page;
    }

    _linkRow(window, title, uri) {
        const row = new Adw.ActionRow({title, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () => {
            new Gtk.UriLauncher({uri}).launch(window, null, (launcher, res) => {
                try {
                    launcher.launch_finish(res);
                } catch (e) {
                    // portal refused / no handler — not worth a dialog
                }
            });
        });
        return row;
    }

    _confirmReset(settings, window) {
        const dialog = new Adw.AlertDialog({
            heading: _('Reset all settings?'),
            body: _('Every Modern Bar option returns to its default.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('reset', _('Reset'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response === 'reset')
                this._resetAll(settings);
        });
        dialog.present(window);
    }

    _resetAll(settings) {
        // night-mode first, deterministically: resetting it can fire the
        // extension's alias handler, and doing that BEFORE palette resets
        // means any write it makes is cleared by the palette reset below —
        // rather than depending on list_keys() hash order.
        settings.reset('night-mode');
        for (const key of settings.settings_schema.list_keys()) {
            // The usage cache is state, not preference — wiping it would blank
            // the panel number for no user benefit.
            if (key.startsWith('claude-cache-') || key === 'night-mode')
                continue;
            settings.reset(key);
        }
    }
}
