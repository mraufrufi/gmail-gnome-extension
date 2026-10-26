// Gmail Indicator, created by Invoxity (https://invoxity.com)
// Shared by the shell extension and the preferences window.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

export const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.gmail-indicator',
    Secret.SchemaFlags.NONE,
    {purpose: Secret.SchemaAttributeType.STRING});
const ATTRS = {purpose: 'refresh-token'};

export class AuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthError';
    }
}

export function newSession() {
    return new Soup.Session({timeout: 30, user_agent: 'gmail-indicator-gnome-extension/1'});
}

const encodeForm = obj => Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

export async function http(session, method, url, {token = null, form = null, json = null} = {}) {
    const msg = Soup.Message.new(method, url);
    if (token)
        msg.get_request_headers().append('Authorization', `Bearer ${token}`);
    const enc = new TextEncoder();
    if (form) {
        msg.set_request_body_from_bytes('application/x-www-form-urlencoded',
            new GLib.Bytes(enc.encode(encodeForm(form))));
    } else if (json) {
        msg.set_request_body_from_bytes('application/json',
            new GLib.Bytes(enc.encode(JSON.stringify(json))));
    }
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (_e) {
        // Not JSON; callers use `text`.
    }
    return {status: msg.get_status(), data, text};
}

export const getRefreshToken = () => Secret.password_lookup(SCHEMA, ATTRS, null);
export const clearRefreshToken = () => Secret.password_clear(SCHEMA, ATTRS, null);
const storeRefreshToken = token =>
    Secret.password_store(SCHEMA, ATTRS, Secret.COLLECTION_DEFAULT,
        'Gmail Indicator refresh token', token, null);

export async function refreshAccessToken(session, clientId, clientSecret) {
    if (!clientId || !clientSecret)
        throw new AuthError('Client ID and secret are not set');
    const refresh = await getRefreshToken();
    if (!refresh)
        throw new AuthError('Not signed in');
    const {status, data} = await http(session, 'POST', TOKEN_URL, {
        form: {
            client_id: clientId, client_secret: clientSecret,
            refresh_token: refresh, grant_type: 'refresh_token',
        },
    });
    if (status === 200 && data?.access_token) {
        return {token: data.access_token, expiresAt: Date.now() / 1000 + (data.expires_in ?? 3600)};
    }
    if (status === 400 || status === 401)
        throw new AuthError(data?.error_description ?? 'Sign-in expired');
    throw new Error(`Token refresh failed (HTTP ${status})`);
}

function randomHex(bytes) {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    const data = stream.read_bytes(bytes, null).get_data();
    stream.close(null);
    return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
}

function challengeFor(verifier) {
    const sum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    sum.update(new TextEncoder().encode(verifier));
    const hex = sum.get_string();
    const raw = Uint8Array.from(hex.match(/../g), h => parseInt(h, 16));
    return GLib.base64_encode(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PAGE = msg => `<!doctype html><meta charset="utf-8"><title>Gmail Indicator</title>
<body style="font-family:sans-serif;max-width:32em;margin:4em auto"><h2>${msg}</h2>
<p>You can close this tab.</p></body>`;

// Starts a loopback server, resolves with {code, redirectUri}.
function waitForCode(state, timeoutSeconds, onReady) {
    const server = new Soup.Server();
    let timer = 0;
    const finish = () => {
        if (timer) GLib.source_remove(timer);
        timer = 0;
        server.disconnect();
    };
    const promise = new Promise((resolve, reject) => {
        server.add_handler('/', (_srv, msg, path, query) => {
            if (path !== '/') {
                msg.set_status(404, null);
                return;
            }
            const q = query ?? {};
            const ok = q.code && q.state === state;
            msg.set_status(200, null);
            msg.set_response('text/html', Soup.MemoryUse.COPY,
                new TextEncoder().encode(PAGE(ok ? 'Signed in' : 'Sign-in failed')));
            finish();
            if (ok) resolve(q.code);
            else reject(new Error(q.error ?? 'Sign-in was cancelled'));
        });
        server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
        const port = server.get_uris()[0].get_port();
        timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
            timer = 0;
            finish();
            reject(new Error('Sign-in timed out'));
            return GLib.SOURCE_REMOVE;
        });
        onReady(`http://127.0.0.1:${port}`);
    });
    return promise;
}

// Runs the browser sign-in (PKCE, loopback). Returns the account address.
export async function signIn(session, clientId, clientSecret) {
    const verifier = randomHex(32);
    const state = randomHex(16);
    let redirectUri = '';
    const code = await waitForCode(state, 180, uri => {
        redirectUri = uri;
        const url = `${AUTH_URL}?${encodeForm({
            client_id: clientId, redirect_uri: uri, response_type: 'code',
            scope: SCOPE, code_challenge: challengeFor(verifier),
            code_challenge_method: 'S256', state,
            access_type: 'offline', prompt: 'consent',
        })}`;
        Gio.AppInfo.launch_default_for_uri(url, null);
    });

    const {status, data} = await http(session, 'POST', TOKEN_URL, {
        form: {
            client_id: clientId, client_secret: clientSecret, code,
            code_verifier: verifier, grant_type: 'authorization_code',
            redirect_uri: redirectUri,
        },
    });
    if (status !== 200 || !data?.refresh_token)
        throw new Error(data?.error_description ?? `Token exchange failed (HTTP ${status})`);
    await storeRefreshToken(data.refresh_token);

    const profile = await http(session, 'GET', `${API}/profile`, {token: data.access_token});
    if (profile.status !== 200)
        throw new Error(profile.data?.error?.message ?? 'Could not read the Gmail profile. Is the Gmail API enabled?');
    return profile.data.emailAddress;
}

export async function signOut(session) {
    const token = await getRefreshToken();
    await clearRefreshToken();
    if (token) {
        try {
            await http(session, 'POST', `${REVOKE_URL}?token=${encodeURIComponent(token)}`);
        } catch (_e) {
            // Revocation is best effort.
        }
    }
}
