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

import {MetricPopup} from './metricPopup.js';

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
    // menuManager (optional): shared PopupMenuManager from extension.js. When
    // given, clicking shows current conditions + a 7-day outlook — all from the
    // same single Open-Meteo call the panel temperature already uses.
    _init(settings, menuManager = null) {
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

        this._detail = null;
        if (menuManager) {
            this._popup = new MetricPopup(this, menuManager);
            this._popupOpenId = this._popup.menu.connect('open-state-changed',
                (_m, open) => {
                    if (open)
                        this._renderPopup();
                });
        }

        this._syncVisible();
    }

    // "Today" / "Sat" — weekday name, with today called out.
    _dayName(iso, index) {
        if (index === 0)
            return 'Today';
        try {
            // Parse as local midnight; Open-Meteo returns plain YYYY-MM-DD with
            // timezone=auto, and `new Date('YYYY-MM-DD')` would be UTC and can
            // land on the previous day west of Greenwich.
            const [y, m, d] = iso.split('-').map(Number);
            return new Date(y, m - 1, d)
                .toLocaleDateString(undefined, {weekday: 'short'});
        } catch (e) {
            return iso ?? '';
        }
    }

    _renderPopup() {
        if (!this._popup)
            return;
        const p = this._popup;
        p.clear();
        p.header(this._settings.get_string('location-label') || 'Weather');

        const d = this._detail;
        if (!d) {
            p.caption('No data yet.');
            return;
        }

        const metric = this._settings.get_string('temperature-unit') === 'celsius';
        const deg = metric ? '°C' : '°F';
        const windUnit = metric ? 'km/h' : 'mph';
        const precipUnit = metric ? 'mm' : 'in';
        if (d.feelsLike !== null)
            p.iconRow(null, 'Feels like', `${d.feelsLike}${deg}`);
        if (d.humidity !== null)
            p.iconRow(null, 'Humidity', `${d.humidity}%`);
        if (d.wind !== null)
            p.iconRow(null, 'Wind', `${d.wind} ${windUnit}`);
        if (d.precip !== null && d.precip > 0)
            p.iconRow(null, 'Precipitation', `${d.precip} ${precipUnit}`);

        if (d.days.length) {
            p.separator();
            for (let i = 0; i < d.days.length; i++) {
                const day = d.days[i];
                // Forecast glyphs always use the DAY variant — a week-ahead row
                // isn't "night" just because you opened the popup after dark.
                const pop = day.pop !== null && day.pop > 0 ? `  ${day.pop}%` : '';
                p.iconRow(iconFor(day.code, true),
                    this._dayName(day.date, i),
                    `${day.hi}° / ${day.lo}°${pop}`);
            }
        }
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
        // One request serves both the panel number and the dropdown. `daily` and
        // the extra `current` fields cost nothing extra — same call, same quota.
        const url = 'https://api.open-meteo.com/v1/forecast?' +
            `latitude=${lat}&longitude=${lon}` +
            `&current=temperature_2m,weather_code,is_day,relative_humidity_2m,` +
                'apparent_temperature,precipitation,wind_speed_10m' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,' +
                'precipitation_probability_max' +
            '&forecast_days=7&timezone=auto' +
            `&temperature_unit=${unit}` +
            // Follow the temperature unit for the others rather than adding more
            // settings: °F implies US customary, °C implies metric.
            `&wind_speed_unit=${unit === 'celsius' ? 'kmh' : 'mph'}` +
            `&precipitation_unit=${unit === 'celsius' ? 'mm' : 'inch'}`;

        const msg = Soup.Message.new('GET', url);
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);

                // NEVER call msg.get_status(): Soup.Status is a GObject enum
                // missing real codes (429 among them) and GJS THROWS on an
                // unlisted value — "429 is not a valid value for enumeration
                // Status". That threw before the status check and cost us the
                // reading entirely. Open-Meteo rate-limits free use, so this is
                // reachable. The payload is the success test instead.
                let data = null;
                try {
                    data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                } catch (e) {
                    // leave null — handled below
                }
                const cur = data?.current;
                if (!cur || typeof cur.temperature_2m !== 'number') {
                    this._scheduleRetry();
                    return;
                }
                this._clearRetry();   // success — cancel any pending fast-retry
                this._render(cur);
                // Dropdown detail is best-effort and LAST, so a shape change in
                // the forecast can never cost us the panel temperature.
                try {
                    this._captureDetail(data);
                } catch (e) {
                    this._detail = null;
                }
            } catch (e) {
                this._scheduleRetry();   // network error mid-request — retry soon
            }
        });
    }

    // Keep the current conditions and a 7-day outlook for the dropdown.
    _captureDetail(data) {
        const d = data?.daily;
        const days = [];
        if (d && Array.isArray(d.time)) {
            for (let i = 0; i < d.time.length; i++) {
                const hi = d.temperature_2m_max?.[i];
                const lo = d.temperature_2m_min?.[i];
                if (typeof hi !== 'number' || typeof lo !== 'number')
                    continue;
                days.push({
                    date: d.time[i],
                    hi: Math.round(hi),
                    lo: Math.round(lo),
                    code: d.weather_code?.[i] ?? 0,
                    pop: typeof d.precipitation_probability_max?.[i] === 'number'
                        ? Math.round(d.precipitation_probability_max[i]) : null,
                });
            }
        }
        const c = data?.current ?? {};
        this._detail = {
            feelsLike: typeof c.apparent_temperature === 'number'
                ? Math.round(c.apparent_temperature) : null,
            humidity: typeof c.relative_humidity_2m === 'number'
                ? Math.round(c.relative_humidity_2m) : null,
            precip: typeof c.precipitation === 'number' ? c.precipitation : null,
            wind: typeof c.wind_speed_10m === 'number'
                ? Math.round(c.wind_speed_10m) : null,
            isDay: c.is_day === 1,
            days,
        };
        if (this._popup?.isOpen)
            this._renderPopup();
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
        if (this._popup) {
            if (this._popupOpenId) {
                this._popup.menu.disconnect(this._popupOpenId);
                this._popupOpenId = 0;
            }
            this._popup.destroy();
            this._popup = null;
        }
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
