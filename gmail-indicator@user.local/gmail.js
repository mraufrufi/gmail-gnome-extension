// Gmail Indicator, created by Invoxity (https://invoxity.com)
import GLib from 'gi://GLib';
import * as OAuth from './oauth.js';

const TAB_LABELS = {unread: ['INBOX', 'UNREAD'], all: ['INBOX'], starred: ['STARRED']};

function b64Bytes(s) {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return GLib.base64_decode(t);
}

function decodeBytes(bytes, charset = 'utf-8') {
    try {
        return new TextDecoder(charset).decode(bytes);
    } catch (_e) {
        return new TextDecoder('utf-8').decode(bytes);
    }
}

export function decodeEntities(s) {
    const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : m;
        }
        return named[e.toLowerCase()] ?? m;
    });
}

// RFC 2047 encoded words in headers, e.g. =?UTF-8?B?...?=
export function decodeMimeWords(s = '') {
    return s.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(
        /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs, enc, txt) => {
            let bytes;
            if (enc.toLowerCase() === 'b') {
                bytes = GLib.base64_decode(txt);
            } else {
                const q = txt.replace(/_/g, ' ');
                const out = [];
                for (let i = 0; i < q.length; i++) {
                    if (q[i] === '=' && /^[0-9a-f]{2}$/i.test(q.substr(i + 1, 2))) {
                        out.push(parseInt(q.substr(i + 1, 2), 16));
                        i += 2;
                    } else {
                        out.push(q.charCodeAt(i));
                    }
                }
                bytes = Uint8Array.from(out);
            }
            return decodeBytes(bytes, cs.toLowerCase());
        });
}

export function parseFrom(raw = '') {
    const decoded = decodeMimeWords(raw);
    const m = decoded.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return {name: m[1].trim() || m[2], address: m[2]};
    return {name: decoded.trim(), address: decoded.trim()};
}

function formatTime(ms, h12 = false) {
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    const same = (a, b) => a.get_year() === b.get_year() && a.get_day_of_year() === b.get_day_of_year();
    if (same(dt, now)) return dt.format(h12 ? '%-I:%M %p' : '%R');
    if (same(dt, now.add_days(-1))) return 'Yesterday';
    return dt.format('%b %-d');
}

function htmlToText(html) {
    const t = html
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    return decodeEntities(t).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractBody(payload) {
    let plain = null;
    let html = null;
    const walk = p => {
        if (p.mimeType === 'text/plain' && p.body?.data && plain === null)
            plain = decodeBytes(b64Bytes(p.body.data));
        else if (p.mimeType === 'text/html' && p.body?.data && html === null)
            html = decodeBytes(b64Bytes(p.body.data));
        (p.parts ?? []).forEach(walk);
    };
    walk(payload ?? {});
    const text = plain !== null ? plain.trim() : htmlToText(html ?? '');
    return text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text;
}

const header = (msg, name) =>
    msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function normalize(msg, h12 = false) {
    const from = parseFrom(header(msg, 'From'));
    return {
        id: msg.id,
        threadId: msg.threadId,
        unread: msg.labelIds?.includes('UNREAD') ?? false,
        starred: msg.labelIds?.includes('STARRED') ?? false,
        fromName: from.name,
        fromAddr: from.address,
        subject: decodeMimeWords(header(msg, 'Subject')) || '(no subject)',
        snippet: decodeEntities(msg.snippet ?? ''),
        time: formatTime(Number(msg.internalDate), h12),
    };
}

export class GmailClient {
    constructor(settings) {
        this._settings = settings;
        this._session = OAuth.newSession();
        this._access = null;
    }

    resetToken() {
        this._access = null;
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }

    async _token(force = false) {
        if (!force && this._access && this._access.expiresAt - 60 > Date.now() / 1000)
            return this._access.token;
        this._access = await OAuth.refreshAccessToken(this._session,
            this._settings.get_string('client-id'),
            this._settings.get_string('client-secret'));
        return this._access.token;
    }

    async _api(method, path, json = null) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this._token(attempt > 0);
            const res = await OAuth.http(this._session, method, `${OAuth.API}/${path}`, {token, json});
            if (res.status === 401 && attempt === 0) continue;
            if (res.status === 401) throw new OAuth.AuthError('Sign-in expired');
            if (res.status < 200 || res.status >= 300)
                throw new Error(res.data?.error?.message ?? `Gmail returned HTTP ${res.status}`);
            return res.data;
        }
        throw new Error('Unreachable');
    }

    async unreadCount() {
        const label = await this._api('GET', 'labels/INBOX');
        return label.threadsUnread ?? 0;
    }

    // `query` is a Gmail search string; when set it searches the whole mailbox instead of one tab.
    async listMessages(tab, max, {query = ''} = {}) {
        const params = [`maxResults=${max}`];
        let q = query.trim();
        if (!q) {
            for (const l of TAB_LABELS[tab] ?? ['INBOX']) params.push(`labelIds=${l}`);
            if (this._settings.get_boolean('exclude-promotions') && tab !== 'starred')
                q = '-category:promotions -category:social';
        }
        if (q) params.push(`q=${encodeURIComponent(q)}`);
        const h12 = this._settings.get_string('time-format') === '12h';
        const list = await this._api('GET', `messages?${params.join('&')}`);
        const ids = (list.messages ?? []).map(m => m.id);
        const meta = await Promise.all(ids.map(id => this._api('GET',
            `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)));
        return meta.map(m => normalize(m, h12));
    }

    async getBody(id) {
        const msg = await this._api('GET', `messages/${id}?format=full`);
        return extractBody(msg.payload);
    }

    modify(id, {add = [], remove = []}) {
        return this._api('POST', `messages/${id}/modify`, {addLabelIds: add, removeLabelIds: remove});
    }

    trash(id) {
        return this._api('POST', `messages/${id}/trash`);
    }

    async markAllRead() {
        const list = await this._api('GET', 'messages?labelIds=INBOX&labelIds=UNREAD&maxResults=500');
        const ids = (list.messages ?? []).map(m => m.id);
        if (ids.length)
            await this._api('POST', 'messages/batchModify', {ids, removeLabelIds: ['UNREAD']});
    }
}
