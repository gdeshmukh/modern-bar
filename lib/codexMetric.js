// SPDX-License-Identifier: GPL-2.0-or-later
// Codex account usage via the OAuth credentials owned by Codex.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import GObject from 'gi://GObject';

import {UsageMetric} from './usageMetric.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CREDENTIALS_PATH = GLib.build_filenamev(
    [GLib.get_home_dir(), '.codex', 'auth.json']);

export const CodexMetric = GObject.registerClass(
class CodexMetric extends UsageMetric {
    _init(settings, iconsPath, popupGroup = null) {
        super._init(settings, iconsPath, popupGroup, {
            id: 'codex',
            name: 'Codex',
            iconName: 'utilities-terminal-symbolic',
            credentialsPath: CREDENTIALS_PATH,
        });
    }

    _decodeCredentials(data) {
        const token = data?.tokens?.access_token;
        const accountId = data?.tokens?.account_id;
        return token && accountId ? {token, accountId} : null;
    }

    _buildMessage({token, accountId}) {
        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('ChatGPT-Account-Id', accountId);
        message.request_headers.append('User-Agent', 'modern-bar');
        return message;
    }

    _parsePayload(data, reason) {
        const windows = CodexMetric._windows(data);
        if (windows.length)
            return windows[0].percent;

        const kind = data?.error?.type ?? data?.error?.code;
        const limited = typeof kind === 'string' && kind.includes('rate_limit');
        const authFailed = reason === 'Unauthorized' || reason === 'Forbidden';
        if (limited)
            return {reason: `rate limited (${reason})`, slow: true};
        if (authFailed) {
            return {
                reason: `auth rejected (${reason}); re-open Codex to refresh login`,
                slow: true,
            };
        }
        return {reason: `no usable payload (${reason})`, slow: false};
    }

    _detailRows(data) {
        return CodexMetric._windows(data).map(window => ({
            label: CodexMetric._windowLabel(window.seconds),
            percent: window.percent,
            resetsAt: window.resetsAt,
        }));
    }

    // Window duration is the contract. OpenAI can return only a weekly window
    // or add a shorter one; the panel always uses the shortest available.
    static _windows(data) {
        const rateLimit = data?.rate_limit;
        const windows = [];
        for (const window of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
            if (!Number.isFinite(window?.used_percent) ||
                !Number.isFinite(window?.limit_window_seconds) ||
                window.limit_window_seconds <= 0) {
                continue;
            }
            windows.push({
                percent: Math.round(window.used_percent),
                seconds: window.limit_window_seconds,
                resetsAt: Number.isFinite(window.reset_at) ? window.reset_at : null,
            });
        }
        return windows.sort((a, b) => a.seconds - b.seconds);
    }

    static _windowLabel(seconds) {
        if (seconds === 5 * 3600)
            return 'Session · 5 hr';
        if (seconds === 7 * 86400)
            return 'Week · all';
        if (seconds % 86400 === 0)
            return `Window · ${seconds / 86400} d`;
        if (seconds % 3600 === 0)
            return `Window · ${seconds / 3600} hr`;
        return `Window · ${Math.round(seconds / 60)} min`;
    }
});
