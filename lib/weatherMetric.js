// modern-bar — Weather metric
//
// Current temperature from Open-Meteo (free, no key), "68°F" with a symbolic
// weather glyph. Refreshes on the configured interval, caches the last value,
// and FAILS SILENT — on any error it keeps the last reading, or hides if it has
// never had one. Never blocks the shell (async Soup HTTP).

import St from 'gi://St';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

// Map Open-Meteo WMO weather codes to the nearest GNOME symbolic icon name.
// Symbolic icons are monochrome and tint via CSS. Day/night chosen by is_day.
function iconFor(code, isDay) {
    const clearDay = 'weather-clear-symbolic';
    const clearNight = 'weather-clear-night-symbolic';
    const fewDay = 'weather-few-clouds-symbolic';
    const fewNight = 'weather-few-clouds-night-symbolic';
    switch (true) {
        case code === 0:                       return isDay ? clearDay : clearNight;
        case code >= 1 && code <= 2:           return isDay ? fewDay : fewNight;
        case code === 3:                       return 'weather-overcast-symbolic';
        case code === 45 || code === 48:       return 'weather-fog-symbolic';
        case code >= 51 && code <= 57:         return 'weather-showers-scattered-symbolic';
        case code >= 61 && code <= 67:         return 'weather-showers-symbolic';
        case code >= 71 && code <= 77:         return 'weather-snow-symbolic';
        case code >= 80 && code <= 82:         return 'weather-showers-symbolic';
        case code >= 85 && code <= 86:         return 'weather-snow-symbolic';
        case code >= 95:                       return 'weather-storm-symbolic';
        default:                               return 'weather-severe-alert-symbolic';
    }
}

export const WeatherMetric = GObject.registerClass(
class WeatherMetric extends St.BoxLayout {
    _init(settings) {
        super._init({
            style_class: 'modern-bar-metric modern-bar-weather',
            y_align: Clutter.ActorAlign.CENTER,
            // reactive receives events; track_hover drives the CSS :hover state.
            // Both required (see cpuMetric.js).
            reactive: true,
            track_hover: true,
        });
        this._settings = settings;
        this._session = new Soup.Session({timeout: 15});
        this._hasValue = false;

        this._icon = new St.Icon({
            style_class: 'modern-bar-weather-icon',
            icon_name: 'weather-clear-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'modern-bar-metric-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);
        this.add_child(this._label);

        this._timeoutId = 0;
        this._retryId = 0;
        this._settingsIds = [
            this._settings.connect('changed::latitude', () => this._refreshNow()),
            this._settings.connect('changed::longitude', () => this._refreshNow()),
            this._settings.connect('changed::temperature-unit', () => this._refreshNow()),
            this._settings.connect('changed::weather-refresh-minutes', () => this._restart()),
            this._settings.connect('changed::show-weather', () => this._syncVisible()),
        ];

        this._syncVisible();
    }

    _syncVisible() {
        const show = this._settings.get_boolean('show-weather');
        // Only actually show once we have a value (fail-silent until then).
        this.visible = show && this._hasValue;
        if (show)
            this._restart();
        else
            this._stop();
    }

    _restart() {
        this._stop();
        if (!this._settings.get_boolean('show-weather'))
            return;
        this._fetch();
        const mins = this._settings.get_int('weather-refresh-minutes');
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, mins * 60, () => {
            this._fetch();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refreshNow() {
        if (this._settings.get_boolean('show-weather'))
            this._fetch();
    }

    _stop() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._clearRetry();
    }

    _clearRetry() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
    }

    // A fetch failed (offline, sleep/resume, server hiccup). Don't wait the full
    // refresh interval to try again — schedule a short one-shot retry so the
    // metric self-heals within ~45s of the network returning. The regular
    // interval timer keeps running underneath; this just adds a fast catch-up.
    _scheduleRetry() {
        if (this._retryId || !this._settings.get_boolean('show-weather'))
            return;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 45, () => {
            this._retryId = 0;
            this._fetch();
            return GLib.SOURCE_REMOVE;   // one-shot
        });
    }

    _fetch() {
        const lat = this._settings.get_double('latitude');
        const lon = this._settings.get_double('longitude');
        const unit = this._settings.get_string('temperature-unit'); // fahrenheit|celsius
        const url = 'https://api.open-meteo.com/v1/forecast?' +
            `latitude=${lat}&longitude=${lon}` +
            `&current=temperature_2m,weather_code,is_day` +
            `&temperature_unit=${unit}`;

        const msg = Soup.Message.new('GET', url);
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) {
                    this._scheduleRetry();   // keep last value, retry soon
                    return;
                }
                const text = new TextDecoder().decode(bytes.get_data());
                const cur = JSON.parse(text)?.current;
                if (!cur || typeof cur.temperature_2m !== 'number') {
                    this._scheduleRetry();
                    return;
                }
                this._clearRetry();   // success — cancel any pending fast-retry
                this._render(cur);
            } catch (e) {
                this._scheduleRetry();   // network error mid-request — retry soon
            }
        });
    }

    _render(cur) {
        const temp = Math.round(cur.temperature_2m);
        const glyph = this._settings.get_string('temperature-unit') === 'celsius' ? '°C' : '°F';
        this._label.set_text(`${temp}${glyph}`);
        this._icon.set_icon_name(iconFor(cur.weather_code, cur.is_day === 1));
        this._hasValue = true;
        if (this._settings.get_boolean('show-weather'))
            this.visible = true;
    }

    destroy() {
        this._stop();
        if (this._settingsIds) {
            for (const id of this._settingsIds)
                this._settings.disconnect(id);
            this._settingsIds = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        super.destroy();
    }
});
