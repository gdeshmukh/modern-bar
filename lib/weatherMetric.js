// SPDX-License-Identifier: GPL-2.0-or-later
// Open-Meteo weather readout with visible degraded-state recovery.

import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {MetricPopup} from './metricPopup.js';

// Suppress trace probabilities that make dry forecasts look wet.
const PRECIP_MIN_PCT = 20;

// Older readings remain visible, but cannot look current.
const STALE_MAX_AGE = 3600;

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

// Keep descriptions short enough for the popup value column.
function describe(code, isDay) {
    switch (true) {
        case code === 0:                       return isDay ? 'Sunny' : 'Clear';
        case code === 1:                       return isDay ? 'Mostly sunny' : 'Mostly clear';
        case code === 2:                       return 'Partly cloudy';
        case code === 3:                       return 'Overcast';
        case code === 45 || code === 48:       return 'Fog';
        case code >= 51 && code <= 55:         return 'Drizzle';
        case code === 56 || code === 57:       return 'Freezing drizzle';
        case code >= 61 && code <= 65:         return 'Rain';
        case code === 66 || code === 67:       return 'Freezing rain';
        case code >= 71 && code <= 75:         return 'Snow';
        case code === 77:                      return 'Snow grains';
        case code >= 80 && code <= 82:         return 'Showers';
        case code >= 85 && code <= 86:         return 'Snow showers';
        case code === 95:                      return 'Thunderstorm';
        case code >= 96:                       return 'Thunderstorm, hail';
        default:                               return null;
    }
}

export const WeatherMetric = GObject.registerClass(
class WeatherMetric extends St.BoxLayout {
    _init(settings, iconsPath, popupGroup = null) {
        super._init({
            style_class: 'modern-bar-metric modern-bar-weather',
            y_align: Clutter.ActorAlign.CENTER,
            // Clutter only updates :hover when both properties are enabled.
            reactive: true,
            track_hover: true,
        });
        this._settings = settings;
        this._session = new Soup.Session({timeout: 15});
        this._hasValue = false;
        this._precipIcon = Gio.icon_new_for_string(
            `${iconsPath}/modernbar-precip-symbolic.svg`);

        this._icon = new St.Icon({
            style_class: 'modern-bar-weather-icon',
            icon_name: 'weather-clear-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'modern-bar-metric-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._staleIcon = new St.Icon({
            style_class: 'modern-bar-stale-icon',
            icon_name: 'network-offline-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.add_child(this._icon);
        this.add_child(this._label);
        this.add_child(this._staleIcon);

        this._timeoutId = 0;
        this._retryId = 0;
        this._failing = false;
        this._lastFetchOk = 0;

        this._settingsIds = [
            this._settings.connect('changed::latitude', () => this._fetch()),
            this._settings.connect('changed::longitude', () => this._fetch()),
            this._settings.connect('changed::temperature-unit', () => this._fetch()),
            this._settings.connect('changed::weather-refresh-minutes', () => this._restart()),
            this._settings.connect('changed::show-weather', () => this._syncVisible()),
        ];

        this._detail = null;
        if (popupGroup)
            this._popup = new MetricPopup(this, popupGroup,
                open => this._onPopupOpenChanged(open));

        this._syncVisible();
    }

    // Degraded opens refresh; healthy opens must remain request-free.
    _onPopupOpenChanged(open) {
        if (!open)
            return;
        if (this._failing || this._isStale())
            this._fetch();
        this._renderPopup();
    }

    // Preserve diagnostics without flooding the journal during an outage.
    _logFailure(reason) {
        const now = Math.floor(Date.now() / 1000);
        if (this._loggedReason === reason && now - (this._loggedAt ?? 0) < 300)
            return;
        this._loggedReason = reason;
        this._loggedAt = now;
        console.warn(`modern-bar: weather fetch failed (${reason}); ` +
            'keeping last value and retrying');
    }

    _dayName(iso, index) {
        if (index === 0)
            return 'Today';
        try {
            // Parsing YYYY-MM-DD as UTC can select the previous local weekday.
            const [y, m, d] = iso.split('-').map(Number);
            return new Date(y, m - 1, d)
                .toLocaleDateString(undefined, {weekday: 'short'});
        } catch (e) {
            return iso ?? '';
        }
    }

    _agoText() {
        if (!this._lastFetchOk)
            return null;
        const secs = Math.max(0, Math.floor(Date.now() / 1000) - this._lastFetchOk);
        if (secs < 60)
            return `updated ${secs}s ago`;
        if (secs < 3600)
            return `updated ${Math.floor(secs / 60)}m ago`;
        return `updated ${Math.floor(secs / 3600)}h ago`;
    }

    _renderPopup() {
        if (!this._popup)
            return;
        const p = this._popup;
        p.clear();
        p.header(this._settings.get_string('location-label') || 'Weather');

        if (this._failing || this._isStale()) {
            const ago = this._agoText();
            p.caption(ago ? `connection lost — ${ago}` : 'connection lost');
        }

        const d = this._detail;
        if (!d) {
            if (!this._failing)
                p.caption('No data yet.');
            return;
        }

        const metric = this._settings.get_string('temperature-unit') === 'celsius';
        const deg = metric ? '°C' : '°F';
        const windUnit = metric ? 'km/h' : 'mph';

        if (d.condition)
            p.iconRow(null, 'Condition', d.condition);
        if (d.feelsLike !== null)
            p.iconRow(null, 'Feels like', `${d.feelsLike}${deg}`);
        if (d.wind !== null)
            p.iconRow(null, 'Wind', `${d.wind} ${windUnit}`);

        if (d.days.length) {
            p.separator();
            for (let i = 0; i < d.days.length; i++) {
                const day = d.days[i];
                // Day glyphs and a marked tail keep precipitation unambiguous.
                const wet = day.pop !== null && day.pop >= PRECIP_MIN_PCT;
                p.iconRow(iconFor(day.code, true),
                    this._dayName(day.date, i),
                    `${day.lo}° / ${day.hi}°`,
                    wet ? {gicon: this._precipIcon, text: `${day.pop}%`} : null);
            }
        }
    }

    _syncVisible() {
        if (this._settings.get_boolean('show-weather')) {
            this._syncState();
            this._restart();
        } else {
            this._stop();
            this.visible = false;
        }
    }

    _isStale() {
        if (!this._hasValue || !this._lastFetchOk)
            return false;
        return Math.floor(Date.now() / 1000) - this._lastFetchOk > STALE_MAX_AGE;
    }

    // Degraded readings remain reachable but cannot look current.
    _syncState() {
        const degraded = this._isStale() || (this._failing && !this._hasValue);
        if (this._settings.get_boolean('show-weather'))
            this.visible = this._hasValue || this._failing;
        if (!this._hasValue)
            this._label.set_text('');
        if (degraded)
            this.add_style_class_name('modern-bar-stale');
        else
            this.remove_style_class_name('modern-bar-stale');
        this._staleIcon.visible = degraded;
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

    // Retry transient failures well before the normal weather interval.
    _scheduleRetry() {
        this._failing = true;
        this._syncState();
        if (this._retryId || !this._settings.get_boolean('show-weather'))
            return;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 45, () => {
            this._retryId = 0;
            this._fetch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fetch() {
        if (!this._settings.get_boolean('show-weather'))
            return;
        const lat = this._settings.get_double('latitude');
        const lon = this._settings.get_double('longitude');
        const unit = this._settings.get_string('temperature-unit');
        // A single response supplies both panel and popup data.
        const url = 'https://api.open-meteo.com/v1/forecast?' +
            `latitude=${lat}&longitude=${lon}` +
            '&current=temperature_2m,weather_code,is_day,' +
                'apparent_temperature,wind_speed_10m' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,' +
                'precipitation_probability_max' +
            '&forecast_days=7&timezone=auto' +
            `&temperature_unit=${unit}` +
            // Match weather units without another setting.
            `&wind_speed_unit=${unit === 'celsius' ? 'kmh' : 'mph'}`;

        const msg = Soup.Message.new('GET', url);
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            // abort() completes outstanding callbacks asynchronously.
            if (this._destroyed)
                return;
            try {
                const bytes = sess.send_and_read_finish(res);

                // Soup.Status rejects unlisted codes such as 429 in GJS.
                let data = null;
                try {
                    data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                } catch (e) {
                    // Invalid and incomplete payloads share the same retry path.
                }
                const cur = data?.current;
                if (!cur || typeof cur.temperature_2m !== 'number') {
                    this._logFailure('no usable payload');
                    this._scheduleRetry();
                    return;
                }
                this._clearRetry();
                this._failing = false;
                this._lastFetchOk = Math.floor(Date.now() / 1000);
                this._render(cur);
                // Forecast shape changes must not discard a valid temperature.
                try {
                    this._captureDetail(data);
                } catch (e) {
                    this._detail = null;
                }
            } catch (e) {
                this._logFailure(`exception: ${e.message}`);
                this._scheduleRetry();
            }
        });
    }

    _captureDetail(data) {
        const d = data?.daily;
        const days = [];
        if (Array.isArray(d?.time)) {
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
        const isDay = c.is_day === 1;
        this._detail = {
            condition: typeof c.weather_code === 'number'
                ? describe(c.weather_code, isDay) : null,
            feelsLike: typeof c.apparent_temperature === 'number'
                ? Math.round(c.apparent_temperature) : null,
            wind: typeof c.wind_speed_10m === 'number'
                ? Math.round(c.wind_speed_10m) : null,
            days,
        };
        if (this._popup?.isOpen)
            this._renderPopup();
    }

    _render(cur) {
        const temp = Math.round(cur.temperature_2m);
        const glyph = this._settings.get_string('temperature-unit') === 'celsius'
            ? '°C' : '°F';
        this._label.set_text(`${temp}${glyph}`);
        this._icon.set_icon_name(iconFor(cur.weather_code, cur.is_day === 1));
        this._hasValue = true;
        this._syncState();
    }

    destroy() {
        // abort() may complete callbacks after destroy returns.
        this._destroyed = true;
        this._stop();
        if (this._popup) {
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
