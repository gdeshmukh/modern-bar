// SPDX-License-Identifier: GPL-2.0-or-later
// Shared account-usage widget. Providers supply credential, request and
// payload adapters; panel state, recovery and popup behavior stay identical.

import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {MetricPopup} from './metricPopup.js';

const CACHE_MAX_AGE_SECONDS = 3600;

export const UsageMetric = GObject.registerClass(
class UsageMetric extends St.BoxLayout {
    _init(settings, iconsPath, popupGroup, spec) {
        super._init({
            style_class: `modern-bar-metric modern-bar-${spec.id}`,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            track_hover: true,
        });
        this._settings = settings;
        this._name = spec.name;
        this._showKey = `show-${spec.id}`;
        this._refreshKey = `${spec.id}-refresh-seconds`;
        this._warnKey = `${spec.id}-warn-percent`;
        this._cachePercentKey = `${spec.id}-cache-percent`;
        this._cacheTimeKey = `${spec.id}-cache-time`;
        this._credentialsPath = spec.credentialsPath;
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;

        const icon = spec.iconFile
            ? {gicon: Gio.icon_new_for_string(`${iconsPath}/${spec.iconFile}`)}
            : {icon_name: spec.iconName};
        this.add_child(new St.Icon({
            ...icon,
            style_class: 'modern-bar-metric-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
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
        this.add_child(this._label);
        this.add_child(this._staleIcon);

        this._timeoutId = 0;
        this._retryId = 0;
        this._retryDelay = 0;
        this._quietUntil = 0;
        this._failing = false;
        this._hasValue = false;
        this._lastPercent = null;
        this._lastFetchOk = 0;
        this._detail = null;

        this._settingsIds = [
            this._settings.connect(`changed::${this._refreshKey}`, () => this._restart()),
            this._settings.connect(`changed::${this._warnKey}`, () => this._renderPanel()),
            this._settings.connect(`changed::${this._showKey}`, () => this._syncVisible()),
        ];

        this._loadCache();
        if (popupGroup) {
            this._popup = new MetricPopup(this, popupGroup,
                open => this._onPopupOpenChanged(open));
        }
        this._syncVisible();
    }

    _syncVisible() {
        if (this._settings.get_boolean(this._showKey)) {
            this._syncState();
            this._restart();
        } else {
            this._stop();
            this.visible = false;
        }
    }

    _onPopupOpenChanged(open) {
        if (!open) {
            this._stopAgeTicker();
            this._ageLabel = null;
            return;
        }
        if (this._failing || this._isStale())
            this._fetch(true);
        this._renderPopup();
        this._startAgeTicker();
    }

    _restart() {
        this._stop();
        if (!this._settings.get_boolean(this._showKey))
            return;
        this._fetch(true);
        const seconds = this._settings.get_int(this._refreshKey);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
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
        this._retryDelay = 0;
        this._quietUntil = 0;
    }

    // Short retries make startup races self-healing. A 429 or rejected token
    // backs off harder once a cached value keeps the widget useful.
    _scheduleRetry(slow = false) {
        this._failing = true;
        this._syncState();
        if (!this._settings.get_boolean(this._showKey))
            return;

        const polite = slow && this._hasValue;
        const base = polite ? 60 : 5;
        const cap = polite ? 600 : 30;
        const next = this._retryDelay ? this._retryDelay * 2 : base;
        this._retryDelay = Math.max(base, Math.min(next, cap));
        if (polite)
            this._quietUntil = Math.floor(Date.now() / 1000) + this._retryDelay;
        if (this._retryId)
            return;

        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._retryDelay, () => {
                this._retryId = 0;
                this._fetch();
                return GLib.SOURCE_REMOVE;
            });
    }

    _readCredentials(done) {
        Gio.File.new_for_path(this._credentialsPath).load_contents_async(
            this._cancellable, (file, result) => {
                if (this._destroyed)
                    return;
                let credentials = null;
                try {
                    const [, contents] = file.load_contents_finish(result);
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    credentials = this._decodeCredentials(data);
                } catch (e) {
                    credentials = null;
                }
                done(credentials);
            });
    }

    _isStale() {
        if (!this._hasValue || !this._lastFetchOk)
            return false;
        return Math.floor(Date.now() / 1000) - this._lastFetchOk >
            CACHE_MAX_AGE_SECONDS;
    }

    // A stale or unavailable reading remains reachable but cannot look live.
    _syncState() {
        const degraded = this._isStale() || (this._failing && !this._hasValue);
        if (this._settings.get_boolean(this._showKey))
            this.visible = this._hasValue || this._failing;
        if (!this._hasValue)
            this._label.set_text('');
        if (degraded)
            this.add_style_class_name('modern-bar-stale');
        else
            this.remove_style_class_name('modern-bar-stale');
        this._staleIcon.visible = degraded;
    }

    _fetch(force = false) {
        if (!this._settings.get_boolean(this._showKey))
            return;
        this._syncState();
        const now = Math.floor(Date.now() / 1000);
        if (!force && this._quietUntil && now < this._quietUntil) {
            // Keep the retry chain alive if an older timer fires inside a hold.
            if (!this._retryId) {
                this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                    Math.max(1, this._quietUntil - now), () => {
                        this._retryId = 0;
                        this._fetch();
                        return GLib.SOURCE_REMOVE;
                    });
            }
            return;
        }

        this._readCredentials(credentials => {
            if (!this._settings.get_boolean(this._showKey))
                return;
            if (!credentials) {
                this._logFailure(`no ${this._name} credentials readable`);
                this._scheduleRetry();
                return;
            }
            this._send(credentials);
        });
    }

    _send(credentials) {
        let message;
        try {
            message = this._buildMessage(credentials);
        } catch (e) {
            this._logFailure(`request setup: ${e.message}`);
            this._scheduleRetry();
            return;
        }

        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null,
            (session, result) => {
                if (this._destroyed)
                    return;
                try {
                    const bytes = session.send_and_read_finish(result);
                    // Soup.Status omits real codes such as 429 in GJS and can
                    // throw during enum conversion. The payload is authoritative.
                    let reason = 'unknown';
                    try {
                        reason = message.get_reason_phrase() ?? 'unknown';
                    } catch (e) {
                        // The reason is diagnostic only.
                    }

                    let data = null;
                    try {
                        data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    } catch (e) {
                        // The provider adapter classifies a missing payload.
                    }

                    const parsed = this._parsePayload(data, reason);
                    if (typeof parsed !== 'number') {
                        this._logFailure(parsed?.reason ?? `no usable payload (${reason})`);
                        this._scheduleRetry(parsed?.slow ?? false);
                        return;
                    }

                    this._clearRetry();
                    this._failing = false;
                    this._lastPercent = Math.round(parsed);
                    this._lastFetchOk = Math.floor(Date.now() / 1000);
                    this._renderPanel();
                    this._hasValue = true;
                    this._syncState();
                    this._saveCache();

                    try {
                        this._detail = this._detailRows(data);
                    } catch (e) {
                        this._logFailure(`detail parse: ${e.message}`);
                    }
                    if (this._popup?.isOpen)
                        this._renderPopup();
                } catch (e) {
                    this._logFailure(`exception: ${e.message}`);
                    this._scheduleRetry();
                }
            });
    }

    _logFailure(reason) {
        const now = Math.floor(Date.now() / 1000);
        if (this._loggedReason === reason && now - (this._loggedAt ?? 0) < 300)
            return;
        this._loggedReason = reason;
        this._loggedAt = now;
        console.warn(`modern-bar: ${this._name} usage fetch failed (${reason}); ` +
            'keeping last value and retrying');
    }

    _loadCache() {
        try {
            const percent = this._settings.get_int(this._cachePercentKey);
            const at = Number(this._settings.get_int64(this._cacheTimeKey));
            if (percent < 0 || !at || at > Math.floor(Date.now() / 1000))
                return;
            this._lastPercent = percent;
            this._lastFetchOk = at;
            this._hasValue = true;
            this._renderPanel();
        } catch (e) {
            // Cache failure must not disable live data.
        }
    }

    _saveCache() {
        try {
            this._settings.set_int(this._cachePercentKey, this._lastPercent ?? -1);
            this._settings.set_int64(this._cacheTimeKey, this._lastFetchOk);
        } catch (e) {
            // The cache is optional.
        }
    }

    _untilText(epochSeconds) {
        if (!Number.isFinite(epochSeconds))
            return null;
        const seconds = Math.round(epochSeconds - Date.now() / 1000);
        if (seconds <= 0)
            return 'resets now';
        const minutes = Math.max(1, Math.round(seconds / 60));
        if (minutes < 60)
            return `resets in ${minutes}m`;
        if (minutes < 1440) {
            const hours = Math.floor(minutes / 60);
            const remainder = minutes % 60;
            return remainder
                ? `resets in ${hours}h ${remainder}m`
                : `resets in ${hours}h`;
        }
        try {
            const day = new Date(epochSeconds * 1000)
                .toLocaleDateString(undefined, {weekday: 'short'});
            if (day)
                return `resets ${day}`;
        } catch (e) {
            // Fall back to a duration on incomplete Intl builds.
        }
        return `resets in ${Math.round(seconds / 86400)}d`;
    }

    _agoText() {
        if (!this._lastFetchOk)
            return 'no data yet';
        const seconds = Math.max(0,
            Math.floor(Date.now() / 1000) - this._lastFetchOk);
        if (seconds < 60)
            return `updated ${seconds}s ago`;
        if (seconds < 3600)
            return `updated ${Math.floor(seconds / 60)}m ago`;
        return `updated ${Math.floor(seconds / 3600)}h ago`;
    }

    _renderPopup() {
        if (!this._popup)
            return;
        const popup = this._popup;
        popup.clear();
        popup.header(`${this._name} usage`);

        if (this._detail?.length) {
            const warn = this._settings.get_int(this._warnKey);
            for (const row of this._detail) {
                if (typeof row.percent !== 'number')
                    continue;
                popup.meterRow(row.label, `${row.percent}%`, row.percent,
                    row.percent >= warn);
                const until = this._untilText(row.resetsAt);
                if (until)
                    popup.caption(until);
            }
        } else {
            popup.caption('No data yet.');
        }

        popup.separator();
        this._ageLabel = popup.caption(this._agoText());
    }

    _startAgeTicker() {
        this._stopAgeTicker();
        this._ageShown = null;
        this._ageTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._ageLabel) {
                this._ageTickId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const text = this._agoText();
            if (text !== this._ageShown) {
                this._ageShown = text;
                this._ageLabel.set_text(text);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopAgeTicker() {
        if (this._ageTickId) {
            GLib.source_remove(this._ageTickId);
            this._ageTickId = 0;
        }
    }

    _renderPanel() {
        if (this._lastPercent === null)
            return;
        this._label.set_text(`${this._lastPercent}%`);
        if (this._lastPercent >= this._settings.get_int(this._warnKey))
            this._label.add_style_class_name('modern-bar-alert');
        else
            this._label.remove_style_class_name('modern-bar-alert');
    }

    destroy() {
        this._destroyed = true;
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._stop();
        this._stopAgeTicker();
        this._ageLabel = null;
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
