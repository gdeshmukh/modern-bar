// modern-bar — Claude usage metric
//
// Shows your real ACCOUNT-side 5-hour usage as "CL 36%", the same number the
// Claude Desktop app and `claude /usage` show. Source: Anthropic's undocumented
// OAuth usage endpoint, authenticated with the token Claude Code already stores
// in ~/.claude/.credentials.json — no new login, no API key.
//
//   GET https://api.anthropic.com/api/oauth/usage
//     -> { five_hour: { utilization, resets_at }, seven_day: {...}, limits: [...] }
//
// IMPORTANT CAVEATS (why this is built the way it is):
//   * UNOFFICIAL endpoint — it can change or disappear; treat every failure as
//     "keep last value / hide", never as an error the user sees.
//   * It rate-limits HARD (429) unless the request carries a
//     `User-Agent: claude-code/<version>` header. With that header ~1/min is
//     tolerated (default 60 s); any failure keeps the last value and retries,
//     so an over-aggressive interval degrades gracefully instead of breaking.
//   * The OAuth token is sensitive: we read it fresh per request straight from
//     disk, never store it on the object, never log it.
//
// Fail-silent, async (Soup), single timer, all torn down in destroy().

import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {MetricPopup} from './metricPopup.js';

// eslint note: Gio is used for both the credentials read and the bundled icon.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = GLib.build_filenamev(
    [GLib.get_home_dir(), '.claude', '.credentials.json']);

export const ClaudeMetric = GObject.registerClass(
class ClaudeMetric extends St.BoxLayout {
    // menuManager (optional): shared PopupMenuManager from extension.js. When
    // given, clicking the metric opens a detail dropdown. Everything it shows
    // comes from the SAME response the panel number uses — no extra requests,
    // which matters because this endpoint rate-limits easily (see header).
    _init(settings, iconsPath, menuManager = null) {
        super._init({
            style_class: 'modern-bar-metric modern-bar-claude',
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            track_hover: true,
        });
        this._settings = settings;
        this._session = new Soup.Session({timeout: 15});
        this._hasValue = false;

        // Bundled symbolic Claude mark (tints cyan like the other glyphs).
        this._icon = new St.Icon({
            style_class: 'modern-bar-metric-icon',
            gicon: Gio.icon_new_for_string(`${iconsPath}/modernbar-claude-symbolic.svg`),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'modern-bar-metric-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);
        this.add_child(this._label);

        // Cache the claude-code version once for the User-Agent (best effort).
        this._userAgent = `claude-code/${this._detectClaudeVersion()}`;

        this._timeoutId = 0;
        this._retryId = 0;
        this._retryDelay = 0;   // current backoff step (seconds); 0 = not retrying
        this._settingsIds = [
            this._settings.connect('changed::claude-refresh-seconds', () => this._restart()),
            this._settings.connect('changed::claude-warn-percent', () => this._reRender()),
            this._settings.connect('changed::show-claude', () => this._syncVisible()),
        ];

        this._lastPercent = null;
        // Extra detail for the dropdown, all from the same payload.
        this._detail = null;
        this._lastFetchOk = 0;   // epoch secs of the last SUCCESSFUL fetch

        if (menuManager) {
            this._popup = new MetricPopup(this, menuManager);
            // Rebuild on open so "updated Ns ago" is honest at read time rather
            // than whenever the last poll happened to land.
            this._popupOpenId = this._popup.menu.connect('open-state-changed',
                (_m, open) => {
                    if (open) {
                        this._renderPopup();
                        this._startAgeTicker();
                    } else {
                        this._stopAgeTicker();
                        this._ageLabel = null;   // destroyed by the next clear()
                    }
                });
        }

        this._syncVisible();
    }

    _syncVisible() {
        const show = this._settings.get_boolean('show-claude');
        this.visible = show && this._hasValue;
        if (show)
            this._restart();
        else
            this._stop();
    }

    _restart() {
        this._stop();
        if (!this._settings.get_boolean('show-claude'))
            return;
        this._fetch();
        const secs = this._settings.get_int('claude-refresh-seconds');
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
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
    }

    // A fetch failed (offline, 429, sleep/resume, cold boot, etc.). Don't wait
    // the full refresh interval to try again — retry on a short escalating
    // backoff and KEEP retrying until the first success, then _clearRetry()
    // (called on success) hands control back to the normal interval timer.
    //
    // This is what makes the metric appear reliably on a cold start: right
    // after login the network/DNS/credentials may not be ready, so the first
    // few fetches fail silently. A single one-shot retry could miss that window
    // and leave the widget hidden until the user toggled the setting; a
    // persistent backoff self-heals within seconds once things come up.
    //
    // Backoff: 5 → 10 → 20 → 30s, capped at 30 (well under the max interval).
    // The regular interval timer keeps running underneath; this just adds a
    // fast catch-up that stops itself the moment a fetch succeeds.
    _scheduleRetry() {
        if (this._retryId || !this._settings.get_boolean('show-claude'))
            return;
        this._retryDelay = this._retryDelay ? Math.min(this._retryDelay * 2, 30) : 5;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._retryDelay, () => {
            this._retryId = 0;
            this._fetch();   // on failure this re-schedules with a longer delay
            return GLib.SOURCE_REMOVE;   // one-shot; _fetch re-arms if it fails
        });
    }

    // Read the OAuth access token straight from disk, fresh, every call. Never
    // stored on the object. Returns null on any problem (fail-silent).
    _readToken() {
        try {
            const file = Gio.File.new_for_path(CREDENTIALS_PATH);
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                return null;
            const data = JSON.parse(new TextDecoder().decode(contents));
            const oauth = data?.claudeAiOauth ?? {};
            return oauth.accessToken ?? oauth.access_token ?? null;
        } catch (e) {
            return null;
        }
    }

    // Best-effort claude-code version for the required User-Agent. If we can't
    // find it, a plausible fallback still beats sending none (which 429s hard).
    _detectClaudeVersion() {
        try {
            const [ok, out] = GLib.spawn_command_line_sync('claude --version');
            if (ok && out) {
                const m = /(\d+\.\d+\.\d+)/.exec(new TextDecoder().decode(out));
                if (m)
                    return m[1];
            }
        } catch (e) {
            // ignore
        }
        return '2.0.0';
    }

    _fetch() {
        const token = this._readToken();
        if (!token) {
            this._scheduleRetry();   // e.g. not logged in yet, or disk hiccup
            return;
        }

        const msg = Soup.Message.new('GET', USAGE_URL);
        const headers = msg.get_request_headers();
        headers.append('Authorization', `Bearer ${token}`);
        headers.append('User-Agent', this._userAgent);   // REQUIRED or 429s hard
        headers.append('Content-Type', 'application/json');

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) {
                    this._scheduleRetry();   // 429 / 401 / etc — keep last value, retry soon
                    return;
                }
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const util = data?.five_hour?.utilization;
                if (typeof util !== 'number') {
                    this._scheduleRetry();
                    return;
                }
                this._clearRetry();   // success — cancel any pending fast-retry
                this._lastPercent = Math.round(util);
                this._captureDetail(data);
                this._lastFetchOk = Math.floor(Date.now() / 1000);
                this._reRender();
                this._hasValue = true;
                if (this._settings.get_boolean('show-claude'))
                    this.visible = true;
            } catch (e) {
                this._scheduleRetry();   // network error mid-request — retry soon
            }
        });
    }

    // Pull the dropdown's numbers out of the usage payload.
    //
    // Only fields that look like stable public shape are read. The response also
    // carries `tangelo`, `iguana_necktie`, `nimbus_quill`, `cinder_cove`,
    // `amber_ladder`, `seven_day_omelette`, … — all null here and clearly
    // internal codenames. Do NOT start depending on those; they'll churn.
    //
    // Per-model usage comes from `limits[]`, not a top-level key: entries have
    // {kind, percent, resets_at, scope}. `kind: 'weekly_scoped'` carries
    // `scope.model.display_name` (e.g. "Fable"). `seven_day_opus`/`_sonnet` exist
    // as top-level keys but are null on this plan, so limits[] is the reliable
    // route. Everything is defensive: any shape change degrades to "hide the row".
    _captureDetail(data) {
        const num = v => (typeof v === 'number' ? Math.round(v) : null);
        const limits = Array.isArray(data?.limits) ? data.limits : [];

        // Per-model rows, newest API shape. Skip any without a usable percent.
        const scoped = limits
            .filter(l => l?.kind === 'weekly_scoped' &&
                         typeof l?.percent === 'number' &&
                         l?.scope?.model?.display_name)
            .map(l => ({
                name: l.scope.model.display_name,
                percent: Math.round(l.percent),
                resetsAt: l.resets_at ?? null,
                severity: l.severity ?? null,
            }));

        this._detail = {
            session: {
                percent: num(data?.five_hour?.utilization),
                resetsAt: data?.five_hour?.resets_at ?? null,
            },
            weekly: {
                percent: num(data?.seven_day?.utilization),
                resetsAt: data?.seven_day?.resets_at ?? null,
            },
            scoped,
            // Only shown when the account actually has credits enabled.
            extra: data?.extra_usage?.is_enabled
                ? {percent: num(data.extra_usage.utilization)}
                : null,
        };
    }

    // "3h 22m" / "18m" / "Wed" — how long until a window resets. Beyond a day we
    // switch to a weekday name, which is what you actually want for the weekly
    // limit ("resets Wed" beats "resets in 4d 9h").
    _untilText(iso) {
        if (!iso)
            return null;
        const then = Date.parse(iso);
        if (Number.isNaN(then))
            return null;
        const secs = Math.round((then - Date.now()) / 1000);
        if (secs <= 0)
            return 'resets now';
        if (secs < 3600)
            return `resets in ${Math.max(1, Math.round(secs / 60))}m`;
        if (secs < 86400) {
            const h = Math.floor(secs / 3600);
            const m = Math.round((secs % 3600) / 60);
            return m ? `resets in ${h}h ${m}m` : `resets in ${h}h`;
        }
        // Weekday name via Intl. GJS ships ECMA-402, but this is the only call
        // here that depends on it — fall back to whole days rather than let a
        // throw take the whole popup down.
        try {
            const day = new Date(then).toLocaleDateString(undefined, {weekday: 'short'});
            if (day)
                return `resets ${day}`;
        } catch (e) {
            // fall through
        }
        return `resets in ${Math.round(secs / 86400)}d`;
    }

    _agoText() {
        if (!this._lastFetchOk)
            return 'no data yet';
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
        p.header('Claude usage');

        if (!this._detail) {
            p.caption('No data yet.');
            return;
        }

        const warn = this._settings.get_int('claude-warn-percent');
        const d = this._detail;
        const row = (name, o) => {
            if (o?.percent === null || o?.percent === undefined)
                return;
            p.meterRow(name, `${o.percent}%`, o.percent, o.percent >= warn);
            const until = this._untilText(o.resetsAt);
            if (until)
                p.caption(until);
        };

        row('Session · 5 hr', d.session);
        row('Week · all', d.weekly);
        for (const s of d.scoped)
            row(`Week · ${s.name}`, s);
        if (d.extra)
            row('Extra credits', d.extra);

        p.separator();
        // Deliberate: this endpoint rate-limits, and the metric is otherwise
        // fail-silent (keeps its last value on 429). Surfacing the age is the
        // only way to tell a live number from a stale one — so it has to TICK
        // while you're watching it, not freeze at the moment the popup opened.
        this._ageLabel = p.caption(this._agoText());
    }

    // Tick the "updated Ns ago" line once a second, but ONLY while the popup is
    // open — no timer runs when nobody's looking. Retitles the existing label
    // rather than rebuilding the popup, so nothing relayouts or flickers.
    _startAgeTicker() {
        this._stopAgeTicker();
        this._ageTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._ageLabel) {
                this._ageTickId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._ageLabel.set_text(this._agoText());
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopAgeTicker() {
        if (this._ageTickId) {
            GLib.source_remove(this._ageTickId);
            this._ageTickId = 0;
        }
    }

    _reRender() {
        if (this._lastPercent === null)
            return;
        const pct = this._lastPercent;
        this._label.set_text(`${pct}%`);
        const warn = this._settings.get_int('claude-warn-percent');
        if (pct >= warn)
            this._label.add_style_class_name('modern-bar-alert');
        else
            this._label.remove_style_class_name('modern-bar-alert');
    }

    destroy() {
        this._stop();
        this._stopAgeTicker();
        this._ageLabel = null;
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
