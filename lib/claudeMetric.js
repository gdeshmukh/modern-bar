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
//     `User-Agent: claude-code/<version>` header. So we send that, and poll
//     infrequently (default 5 min) with a cache.
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

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = GLib.build_filenamev(
    [GLib.get_home_dir(), '.claude', '.credentials.json']);

export const ClaudeMetric = GObject.registerClass(
class ClaudeMetric extends St.BoxLayout {
    _init(settings) {
        super._init({
            style_class: 'modern-bar-metric modern-bar-claude',
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            track_hover: true,
        });
        this._settings = settings;
        this._session = new Soup.Session({timeout: 15});
        this._hasValue = false;

        this._label = new St.Label({
            style_class: 'modern-bar-metric-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        // Cache the claude-code version once for the User-Agent (best effort).
        this._userAgent = `claude-code/${this._detectClaudeVersion()}`;

        this._timeoutId = 0;
        this._settingsIds = [
            this._settings.connect('changed::claude-refresh-minutes', () => this._restart()),
            this._settings.connect('changed::claude-warn-percent', () => this._reRender()),
            this._settings.connect('changed::show-claude', () => this._syncVisible()),
        ];

        this._lastPercent = null;
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
        const mins = this._settings.get_int('claude-refresh-minutes');
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
        if (!token)
            return; // not logged in / unreadable — fail-silent

        const msg = Soup.Message.new('GET', USAGE_URL);
        const headers = msg.get_request_headers();
        headers.append('Authorization', `Bearer ${token}`);
        headers.append('User-Agent', this._userAgent);   // REQUIRED or 429s hard
        headers.append('Content-Type', 'application/json');

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK)
                    return; // 429 / 401 / etc — keep last value, stay silent
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const util = data?.five_hour?.utilization;
                if (typeof util !== 'number')
                    return;
                this._lastPercent = Math.round(util);
                this._reRender();
                this._hasValue = true;
                if (this._settings.get_boolean('show-claude'))
                    this.visible = true;
            } catch (e) {
                // fail-silent
            }
        });
    }

    _reRender() {
        if (this._lastPercent === null)
            return;
        const pct = this._lastPercent;
        this._label.set_text(`CL ${pct}%`);
        const warn = this._settings.get_int('claude-warn-percent');
        if (pct >= warn)
            this._label.add_style_class_name('modern-bar-alert');
        else
            this._label.remove_style_class_name('modern-bar-alert');
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
