// SPDX-License-Identifier: GPL-2.0-or-later
// Claude account usage via the OAuth credentials owned by Claude Code.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import GObject from 'gi://GObject';

import {UsageMetric} from './usageMetric.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = GLib.build_filenamev(
    [GLib.get_home_dir(), '.claude', '.credentials.json']);
const UA_FALLBACK = '2.0.0';
const CLAUDE_LAUNCHERS = [
    GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude']),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
];

export const ClaudeMetric = GObject.registerClass(
class ClaudeMetric extends UsageMetric {
    _init(settings, iconsPath, popupGroup = null) {
        super._init(settings, iconsPath, popupGroup, {
            id: 'claude',
            name: 'Claude',
            iconFile: 'modernbar-claude-symbolic.svg',
            credentialsPath: CREDENTIALS_PATH,
        });
        this._userAgent = null;
    }

    _decodeCredentials(data) {
        const oauth = data?.claudeAiOauth ?? {};
        const token = oauth.accessToken ?? oauth.access_token;
        return token ? {token} : null;
    }

    _buildMessage({token}) {
        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('User-Agent', this._userAgentString());
        return message;
    }

    _parsePayload(data, reason) {
        const utilization = data?.five_hour?.utilization;
        if (typeof utilization === 'number')
            return utilization;

        const kind = data?.error?.type;
        const limited = kind === 'rate_limit_error';
        const authFailed = kind === 'authentication_error' ||
            kind === 'permission_error' ||
            reason === 'Unauthorized' || reason === 'Forbidden';
        if (limited)
            return {reason: `rate limited (${reason})`, slow: true};
        if (authFailed) {
            return {
                reason: `auth rejected (${reason}); re-login in Claude Code`,
                slow: true,
            };
        }
        return {reason: `no usable payload (${reason})`, slow: false};
    }

    _detailRows(data) {
        const rows = [];
        const add = (label, percent, resetsAt = null) => {
            if (typeof percent !== 'number')
                return;
            rows.push({
                label,
                percent: Math.round(percent),
                resetsAt: ClaudeMetric._epoch(resetsAt),
            });
        };

        add('Session · 5 hr', data?.five_hour?.utilization,
            data?.five_hour?.resets_at);
        add('Week · all', data?.seven_day?.utilization,
            data?.seven_day?.resets_at);

        const limits = Array.isArray(data?.limits) ? data.limits : [];
        for (const limit of limits) {
            if (limit?.kind !== 'weekly_scoped' ||
                !limit?.scope?.model?.display_name) {
                continue;
            }
            add(`Week · ${limit.scope.model.display_name}`,
                limit.percent, limit.resets_at);
        }
        if (data?.extra_usage?.is_enabled)
            add('Extra credits', data.extra_usage.utilization);
        return rows;
    }

    static _epoch(iso) {
        if (!iso)
            return null;
        const milliseconds = Date.parse(iso);
        return Number.isFinite(milliseconds) ? milliseconds / 1000 : null;
    }

    // Claude rejects a generic User-Agent. Resolve the installed version from
    // its launcher symlink without starting the CLI on the shell's main loop.
    _userAgentString() {
        if (!this._userAgent)
            this._userAgent = `claude-code/${this._detectClaudeVersion()}`;
        return this._userAgent;
    }

    _detectClaudeVersion() {
        const paths = [...CLAUDE_LAUNCHERS];
        const onPath = GLib.find_program_in_path('claude');
        if (onPath && !paths.includes(onPath))
            paths.push(onPath);

        for (const path of paths) {
            const match = /^(\d+\.\d+\.\d+)/.exec(
                GLib.path_get_basename(ClaudeMetric._resolveLink(path)));
            if (match)
                return match[1];
        }
        return UA_FALLBACK;
    }

    static _resolveLink(path) {
        let current = path;
        for (let i = 0; i < 8; i++) {
            let target;
            try {
                target = GLib.file_read_link(current);
            } catch (e) {
                return current;
            }
            if (!target)
                return current;
            current = GLib.path_is_absolute(target)
                ? target
                : GLib.build_filenamev([GLib.path_get_dirname(current), target]);
        }
        return current;
    }
});
