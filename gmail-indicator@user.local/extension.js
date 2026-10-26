// Gmail Indicator, created by Invoxity (https://invoxity.com)
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {GmailClient} from './gmail.js';
import {AuthError} from './oauth.js';

const PALETTE = ['#78aeed', '#f9a56e', '#8ff0a4', '#dc8add', '#f8e45c', '#99c1f1'];
const TABS = [['unread', 'Unread'], ['all', 'All mail'], ['starred', 'Starred']];

const COLOR_DEFAULTS = {
    'color-background': '#2b2b2f',
    'color-text': '#f2f2f2',
    'color-accent': '#78aeed',
    'color-badge': '#c01c28',
};
// Every key that changes the generated stylesheet.
const THEME_KEYS = [...Object.keys(COLOR_DEFAULTS), 'background-opacity', 'popup-width',
    'popup-max-height', 'corner-radius', 'font-size', 'compact-rows'];

function colorFor(text) {
    let h = 0;
    for (const c of text) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
}

function makeAvatar(text, small = false) {
    const source = text || '?';
    const label = new St.Label({
        text: source.trim().charAt(0).toUpperCase() || '?',
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        x_expand: true, y_expand: true,
    });
    return new St.Bin({
        style_class: small ? 'gmail-avatar-sm' : 'gmail-avatar',
        style: `background-color: ${colorFor(source)};`,
        y_align: small ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER, child: label,
    });
}

function makeLabel(text, styleClass, {wrap = false} = {}) {
    const label = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
    const ct = label.clutter_text;
    if (wrap) {
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.ellipsize = Pango.EllipsizeMode.NONE;
    } else {
        ct.ellipsize = Pango.EllipsizeMode.END;
    }
    return label;
}

function makeButton(label, styleClass, onClick) {
    const b = new St.Button({label, style_class: styleClass, can_focus: true, x_expand: true});
    b.connect('clicked', onClick);
    return b;
}

function makeIconButton(icon, name, onClick, styleClass = 'gmail-icon-button') {
    const b = new St.Button({
        style_class: styleClass, can_focus: true, accessible_name: name,
        child: new St.Icon({gicon: icon, icon_size: 16}),
    });
    b.connect('clicked', onClick);
    return b;
}

const themed = name => new Gio.ThemedIcon({name});

function readColor(settings, key) {
    const v = settings.get_string(key).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : COLOR_DEFAULTS[key];
}

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const rgba = (hex, a) => `rgba(${rgb(hex).join(',')},${a})`;

// Blend `b` over `a` by fraction t, returned as hex.
function mix(a, b, t) {
    const [ar, ag, ab] = rgb(a);
    const [br, bg, bb] = rgb(b);
    const f = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    return `#${f(ar, br)}${f(ag, bg)}${f(ab, bb)}`;
}

// Black or white, whichever reads better on `hex`.
function onColor(hex) {
    const [r, g, b] = rgb(hex).map(v => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#0b0b0c' : '#ffffff';
}

function buildThemeCss(settings) {
    const bg = readColor(settings, 'color-background');
    const text = readColor(settings, 'color-text');
    const accent = readColor(settings, 'color-accent');
    const badge = readColor(settings, 'color-badge');
    const onAccent = onColor(accent);
    const opacity = settings.get_int('background-opacity') / 100;
    const width = settings.get_int('popup-width');
    const maxH = settings.get_int('popup-max-height');
    const radius = settings.get_int('corner-radius');
    const fs = settings.get_int('font-size');
    const compact = settings.get_boolean('compact-rows');
    const rowPad = compact ? '5px 12px' : '10px 14px';
    const hoverBg = mix(bg, text, 0.08);
    const innerR = Math.max(0, radius - 4);

    const css = `
.gmail-boxpointer { -arrow-background-color: ${rgba(bg, opacity)}; -arrow-border-radius: ${radius}px;
  -arrow-border-width: 1px; -arrow-border-color: ${rgba(text, 0.10)}; }
.gmail-popup { width: ${width}px; color: ${text}; font-size: ${fs}px;
  background-color: ${rgba(bg, opacity)}; border-radius: ${radius}px; }
.gmail-sub, .gmail-time, .gmail-snippet, .gmail-status { color: ${rgba(text, 0.82)}; }
.gmail-title { font-size: ${fs + 2}px; }
.gmail-from, .gmail-subject, .gmail-pill, .gmail-btn { font-size: ${fs}px; }
.gmail-snippet, .gmail-time, .gmail-sub { font-size: ${fs - 1}px; }
.gmail-read-subject { font-size: ${fs + 4}px; }
.gmail-read-text { font-size: ${fs}px; background-color: ${rgba(text, 0.07)}; border-radius: ${innerR}px; }
.gmail-scroll { max-height: ${maxH}px; border-top-color: ${rgba(text, 0.12)}; }
.gmail-read-scroll { height: ${Math.max(160, maxH - 100)}px; }
.gmail-footer { border-top-color: ${rgba(text, 0.12)}; }
.gmail-read-top { border-bottom-color: ${rgba(text, 0.12)}; }
.gmail-row { padding: ${rowPad}; }
.gmail-row:hover, .gmail-row:focus { background-color: ${hoverBg}; }
.gmail-row-actions { background-color: ${hoverBg}; }
.gmail-pill, .gmail-btn { background-color: ${rgba(text, 0.09)}; color: ${text}; }
.gmail-pill:hover, .gmail-pill:focus, .gmail-btn:hover, .gmail-btn:focus { background-color: ${rgba(text, 0.17)}; }
.gmail-icon-button:hover, .gmail-icon-button:focus, .gmail-action:hover, .gmail-action:focus { background-color: ${rgba(text, 0.16)}; }
.gmail-search { background-color: ${rgba(text, 0.08)}; color: ${text}; caret-color: ${text}; }
.gmail-search:focus { background-color: ${rgba(text, 0.14)}; }
.gmail-pill-active, .gmail-pill-active:hover, .gmail-pill-active:focus,
.gmail-btn-primary, .gmail-btn-primary:hover, .gmail-btn-primary:focus { background-color: ${accent}; color: ${onAccent}; }
.gmail-dot { background-color: ${accent}; }
.gmail-badge { background-color: ${badge}; }
.gmail-badge-label { color: ${onColor(badge)}; }
`;
    // Repeat each class (".a" -> ".a.a") so these rules always outrank stylesheet.css.
    return css.replace(/\.gmail-[a-z-]+/g, m => m + m);
}

const GmailIndicator = GObject.registerClass(
class GmailIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Gmail Indicator');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new GmailClient(this._settings);
        this._archiveIcon = Gio.icon_new_for_string(`${extension.path}/icons/archive-symbolic.svg`);

        this._destroyed = false;
        const wanted = this._settings.get_string('default-tab');
        this._tab = TABS.some(([k]) => k === wanted) ? wanted : 'unread';
        this._query = '';
        this._messages = [];
        this._state = {kind: 'loading'};
        this._unread = null;
        this._updatedAt = 0;
        this._loadSeq = 0;
        this._current = null;
        this._timerId = 0;
        this._searchTimer = 0;
        this._settingsIds = [];

        this._buildPanelButton();
        this._buildPopup();
        this._applyLayout();
        this._syncRootStyle();

        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open) return;
            this._showList();
            this._resetSearch();
            const stale = this._state.kind !== 'ok';
            if (stale || this._settings.get_boolean('refresh-on-open')) this._loadList();
            else this._renderList();
            this._refreshCount();
        });

        const on = (keys, fn) => {
            for (const key of keys)
                this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
        };
        on(['account-email', 'client-id', 'client-secret'], () => {
            this._client.resetToken();
            this._updateHeader();
            this._refreshCount();
            if (this.menu.isOpen) this._loadList();
        });
        on(['refresh-interval'], () => this._startTimer());
        on(['show-search', 'show-compose', 'show-open-gmail', 'show-mark-all', 'show-starred-tab'],
            () => this._applyLayout());
        on(['show-snippet', 'show-avatars'], () => this._renderList());
        on(['max-messages', 'time-format', 'exclude-promotions'], () => {
            if (this.menu.isOpen) this._loadList();
        });
        on(['badge-style', 'hide-when-zero'], () => this._updateBadge());
        on(THEME_KEYS, () => this._syncRootStyle());

        this._updateHeader();
        this._startTimer();
        this._refreshCount();
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = 0;
        if (this._searchTimer) GLib.source_remove(this._searchTimer);
        this._searchTimer = 0;
        for (const id of this._settingsIds) this._settings.disconnect(id);
        this._settingsIds = [];
        this._client.destroy();
        this._settings = null;
        super.destroy();
    }

    // ---- panel button -------------------------------------------------
    _buildPanelButton() {
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'mail-read-symbolic', style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._badgeLabel = new St.Label({
            style_class: 'gmail-badge-label',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });
        this._badge = new St.Bin({
            style_class: 'gmail-badge', y_align: Clutter.ActorAlign.CENTER, visible: false,
            child: this._badgeLabel,
        });
        box.add_child(this._icon);
        box.add_child(this._badge);
        this.add_child(box);
    }

    _updateBadge() {
        if (!this._settings) return;
        const n = this._unread;
        const has = n !== null && n > 0;
        const style = this._settings.get_string('badge-style');
        this._badge.visible = has && style !== 'hidden';
        if (style === 'dot') {
            this._badgeLabel.text = '';
            this._badge.add_style_class_name('gmail-badge-dot');
        } else {
            this._badge.remove_style_class_name('gmail-badge-dot');
            if (has) this._badgeLabel.text = n > 99 ? '99+' : String(n);
        }
        this._icon.icon_name = has ? 'mail-unread-symbolic' : 'mail-read-symbolic';
        this.accessible_name = has ? `Gmail, ${n} unread` : 'Gmail';
        this._tabButtons.unread.label = has ? `Unread · ${n}` : 'Unread';
        this.visible = !(this._settings.get_boolean('hide-when-zero') && n === 0);
    }

    // ---- popup --------------------------------------------------------
    _buildPopup() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('gmail-menu-item');
        const root = new St.BoxLayout({vertical: true, style_class: 'gmail-popup', x_expand: true});
        this._root = root;
        item.add_child(root);
        this.menu.addMenuItem(item);
        this.menu.actor?.add_style_class_name('gmail-boxpointer');
        this.menu.box?.add_style_class_name('gmail-menu-content');

        this._listView = new St.BoxLayout({vertical: true});
        this._readView = new St.BoxLayout({vertical: true, visible: false});
        root.add_child(this._listView);
        root.add_child(this._readView);
        this._buildList();
        this._buildRead();
    }

    _buildList() {
        const header = new St.BoxLayout({style_class: 'gmail-header'});
        this._avatarSlot = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        const titles = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        titles.add_child(makeLabel('Inbox', 'gmail-title'));
        this._subtitle = makeLabel('', 'gmail-sub');
        titles.add_child(this._subtitle);
        header.add_child(this._avatarSlot);
        header.add_child(titles);
        header.add_child(makeIconButton(themed('view-refresh-symbolic'), 'Refresh', () => {
            this._loadList();
            this._refreshCount();
        }));
        header.add_child(makeIconButton(themed('emblem-system-symbolic'), 'Settings', () => {
            this.menu.close();
            this._extension.openPreferences();
        }));
        this._listView.add_child(header);

        // search
        this._searchWrap = new St.BoxLayout({style_class: 'gmail-search-wrap'});
        this._searchEntry = new St.Entry({
            style_class: 'gmail-search', hint_text: 'Search mail', can_focus: true, x_expand: true,
        });
        this._searchEntry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic', style_class: 'gmail-search-icon',
        }));
        this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._searchWrap.add_child(this._searchEntry);
        this._listView.add_child(this._searchWrap);

        // tabs
        this._tabsBox = new St.BoxLayout({style_class: 'gmail-tabs'});
        this._tabButtons = {};
        for (const [key, label] of TABS) {
            const b = new St.Button({label, style_class: 'gmail-pill', can_focus: true, x_expand: true});
            b.connect('clicked', () => {
                this._tab = key;
                this._resetSearch();
                this._syncTabs();
                this._loadList();
            });
            this._tabButtons[key] = b;
            this._tabsBox.add_child(b);
        }
        this._listView.add_child(this._tabsBox);
        this._syncTabs();

        this._scroll = new St.ScrollView({
            style_class: 'gmail-scroll', overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._listBox = new St.BoxLayout({vertical: true});
        this._scroll.set_child(this._listBox);
        this._listView.add_child(this._scroll);

        this._footer = new St.BoxLayout({style_class: 'gmail-footer'});
        this._btnCompose = makeButton('Compose', 'gmail-btn gmail-btn-primary',
            () => this._openUrl(`${this._baseUrl()}&view=cm&fs=1`));
        this._btnOpen = makeButton('Open Gmail', 'gmail-btn', () => this._openUrl(this._baseUrl()));
        this._btnMarkAll = makeButton('Mark all read', 'gmail-btn', () => this._markAllRead());
        this._footer.add_child(this._btnCompose);
        this._footer.add_child(this._btnOpen);
        this._footer.add_child(this._btnMarkAll);
        this._listView.add_child(this._footer);
    }

    _buildRead() {
        const top = new St.BoxLayout({style_class: 'gmail-read-top'});
        top.add_child(makeIconButton(themed('go-previous-symbolic'), 'Back to inbox', () => {
            this._showList();
            this._renderList();
        }));
        top.add_child(new St.Label({
            text: 'Message', style_class: 'gmail-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        }));
        top.add_child(makeIconButton(this._archiveIcon, 'Archive', () => this._act(c => c.modify(this._current.id, {remove: ['INBOX']}))));
        top.add_child(this._deleteButton(() => this._act(c => c.trash(this._current.id))));
        top.add_child(makeIconButton(themed('mail-unread-symbolic'), 'Mark as unread', () => this._act(c => c.modify(this._current.id, {add: ['UNREAD']}))));
        this._readView.add_child(top);

        const body = new St.BoxLayout({vertical: true, style_class: 'gmail-read-body'});
        this._rSubject = makeLabel('', 'gmail-read-subject', {wrap: true});
        const who = new St.BoxLayout({style: 'spacing: 10px;'});
        this._rAvatarSlot = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        const names = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._rFrom = makeLabel('', 'gmail-from gmail-bold');
        this._rAddr = makeLabel('', 'gmail-sub');
        names.add_child(this._rFrom);
        names.add_child(this._rAddr);
        this._rTime = makeLabel('', 'gmail-sub');
        who.add_child(this._rAvatarSlot);
        who.add_child(names);
        who.add_child(this._rTime);

        const scroll = new St.ScrollView({
            style_class: 'gmail-read-scroll', overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._rBody = makeLabel('', 'gmail-read-text', {wrap: true});
        this._rBody.y_align = Clutter.ActorAlign.START;
        const holder = new St.BoxLayout({vertical: true});
        holder.add_child(this._rBody);
        scroll.set_child(holder);

        body.add_child(this._rSubject);
        body.add_child(who);
        body.add_child(scroll);
        this._readView.add_child(body);

        const footer = new St.BoxLayout({style_class: 'gmail-footer', style: 'border-top-width: 0;'});
        footer.add_child(makeButton('Reply', 'gmail-btn gmail-btn-primary', () => this._openThread()));
        footer.add_child(makeButton('Open in Gmail', 'gmail-btn', () => this._openThread()));
        this._readView.add_child(footer);
    }

    // Inline styles beat every stylesheet, so the main colours always apply even if theme.css is late.
    _syncRootStyle() {
        const s = this._settings;
        if (!s || !this._root) return;
        const bg = readColor(s, 'color-background');
        const text = readColor(s, 'color-text');
        const op = s.get_int('background-opacity') / 100;
        const radius = s.get_int('corner-radius');
        this._root.set_style(
            `background-color: ${rgba(bg, op)}; color: ${text}; border-radius: ${radius}px; ` +
            `width: ${s.get_int('popup-width')}px; font-size: ${s.get_int('font-size')}px;`);
        this.menu.actor?.set_style(
            `-arrow-background-color: ${rgba(bg, op)}; -arrow-border-radius: ${radius}px;`);
    }

    // Show/hide optional parts of the popup according to settings.
    _applyLayout() {
        const s = this._settings;
        if (!s) return;
        this._searchWrap.visible = s.get_boolean('show-search');
        if (!s.get_boolean('show-search')) this._resetSearch();

        const showStarred = s.get_boolean('show-starred-tab');
        this._tabButtons.starred.visible = showStarred;
        if (!showStarred && this._tab === 'starred') {
            this._tab = 'unread';
            this._syncTabs();
            if (this.menu.isOpen) this._loadList();
        }

        this._btnCompose.visible = s.get_boolean('show-compose');
        this._btnOpen.visible = s.get_boolean('show-open-gmail');
        this._btnMarkAll.visible = s.get_boolean('show-mark-all');
        this._footer.visible = this._btnCompose.visible || this._btnOpen.visible || this._btnMarkAll.visible;
    }

    _syncTabs() {
        for (const [key] of TABS) {
            if (key === this._tab && !this._query) this._tabButtons[key].add_style_class_name('gmail-pill-active');
            else this._tabButtons[key].remove_style_class_name('gmail-pill-active');
        }
    }

    // ---- search -------------------------------------------------------
    _onSearchChanged() {
        const text = this._searchEntry.get_text().trim();
        if (text === this._query) return;
        if (this._searchTimer) GLib.source_remove(this._searchTimer);
        this._searchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
            this._searchTimer = 0;
            this._query = text;
            this._syncTabs();
            this._loadList();
            return GLib.SOURCE_REMOVE;
        });
    }

    _resetSearch() {
        if (this._searchTimer) GLib.source_remove(this._searchTimer);
        this._searchTimer = 0;
        this._query = '';
        if (this._searchEntry.get_text() !== '') this._searchEntry.set_text('');
        this._syncTabs();
    }

    _showList() {
        this._readView.visible = false;
        this._listView.visible = true;
    }

    _showRead() {
        this._listView.visible = false;
        this._readView.visible = true;
    }

    _email() {
        return this._settings?.get_string('account-email') ?? '';
    }

    _updateHeader() {
        const email = this._email();
        this._avatarSlot.set_child(makeAvatar(email));
        let when = '';
        if (this._updatedAt) {
            const mins = Math.floor((GLib.get_monotonic_time() / 1e6 - this._updatedAt) / 60);
            when = mins < 1 ? ' · just now' : ` · ${mins} min ago`;
        }
        this._subtitle.text = email ? `${email}${when}` : 'Not signed in';
    }

    // ---- list ---------------------------------------------------------
    _renderList() {
        this._listBox.destroy_all_children();
        const s = this._state;
        if (s.kind !== 'ok' || this._messages.length === 0) {
            const box = new St.BoxLayout({vertical: true, style_class: 'gmail-status', x_align: Clutter.ActorAlign.FILL});
            let text = s.text;
            if (s.kind === 'ok') {
                box.add_child(new St.Icon({
                    icon_name: this._query ? 'edit-find-symbolic' : 'mail-read-symbolic',
                    style_class: 'gmail-empty-icon', x_align: Clutter.ActorAlign.CENTER,
                }));
                if (this._query) text = `No results for “${this._query}”`;
                else text = this._tab === 'unread' ? 'You’re all caught up' : 'No messages here';
            }
            box.add_child(new St.Label({text: text ?? '', x_align: Clutter.ActorAlign.CENTER}));
            if (s.kind === 'signedout') {
                box.add_child(makeButton('Sign in…', 'gmail-btn gmail-btn-primary', () => {
                    this.menu.close();
                    this._extension.openPreferences();
                }));
            } else if (s.kind === 'error') {
                box.add_child(makeButton('Try again', 'gmail-btn', () => this._loadList()));
            }
            this._listBox.add_child(box);
            return;
        }
        for (const m of this._messages) this._listBox.add_child(this._buildRow(m));
    }

    _buildRow(m) {
        const showAvatar = this._settings.get_boolean('show-avatars');
        const showSnippet = this._settings.get_boolean('show-snippet');

        const wrap = new St.Widget({
            layout_manager: new Clutter.BinLayout(), reactive: true, track_hover: true, x_expand: true,
        });
        const row = new St.Button({
            style_class: 'gmail-row', can_focus: true, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL,
        });
        const box = new St.BoxLayout({
            style_class: 'gmail-row-box', x_expand: true, x_align: Clutter.ActorAlign.FILL,
        });
        box.add_child(new St.Widget({
            style_class: m.unread ? 'gmail-dot' : 'gmail-dot-empty',
            y_align: showAvatar ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            y_expand: false,
        }));
        if (showAvatar) box.add_child(makeAvatar(m.fromName, true));
        const col = new St.BoxLayout({vertical: true, x_expand: true});
        const top = new St.BoxLayout();
        const from = makeLabel(m.fromName, m.unread ? 'gmail-from gmail-bold' : 'gmail-from');
        from.x_expand = true;
        top.add_child(from);
        top.add_child(makeLabel(m.time, 'gmail-time'));
        col.add_child(top);
        col.add_child(makeLabel(m.subject, m.unread ? 'gmail-subject gmail-bold' : 'gmail-subject'));
        if (showSnippet) col.add_child(makeLabel(m.snippet, 'gmail-snippet'));
        box.add_child(col);
        row.set_child(box);
        row.connect('clicked', () => this._openMessage(m));

        // Quick actions float over the top-right corner while the row is hovered or focused.
        const actions = new St.BoxLayout({
            style_class: 'gmail-row-actions', x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true, visible: false,
        });
        actions.add_child(makeIconButton(
            themed(m.unread ? 'mail-read-symbolic' : 'mail-unread-symbolic'),
            m.unread ? 'Mark as read' : 'Mark as unread',
            () => this._toggleRead(m), 'gmail-action'));
        actions.add_child(makeIconButton(this._archiveIcon, 'Archive', () => this._archiveRow(m), 'gmail-action'));
        const del = this._deleteButton(() => this._trashRow(m), 'gmail-action');
        actions.add_child(del);

        const sync = () => {
            actions.visible = wrap.hover || row.has_key_focus() || del.has_key_focus() ||
                del.has_style_class_name('gmail-delete-armed');
        };
        wrap.connect('notify::hover', sync);
        row.connect('key-focus-in', sync);
        row.connect('key-focus-out', sync);
        del.connect('key-focus-in', sync);
        del.connect('key-focus-out', sync);

        wrap.add_child(row);
        wrap.add_child(actions);
        return wrap;
    }

    async _loadList() {
        const seq = ++this._loadSeq;
        if (this._messages.length === 0) {
            this._state = {kind: 'loading', text: 'Loading…'};
            this._renderList();
        }
        try {
            const max = this._settings.get_int('max-messages');
            const msgs = await this._client.listMessages(this._tab, max, {query: this._query});
            if (this._destroyed || seq !== this._loadSeq) return;
            this._messages = msgs;
            this._state = {kind: 'ok'};
            this._updatedAt = GLib.get_monotonic_time() / 1e6;
        } catch (e) {
            if (this._destroyed || seq !== this._loadSeq) return;
            this._messages = [];
            this._state = e instanceof AuthError
                ? {kind: 'signedout', text: 'Sign in to see your mail.'}
                : {kind: 'error', text: `Couldn’t reach Gmail.\n${e.message}`};
        }
        this._renderList();
        this._updateHeader();
    }

    async _refreshCount() {
        try {
            const n = await this._client.unreadCount();
            if (this._destroyed) return;
            const prev = this._unread;
            this._unread = n;
            if (prev !== null && n > prev) this._notifyNew(n - prev);
        } catch (_e) {
            if (this._destroyed) return;
            this._unread = null;
        }
        this._updateBadge();
    }

    _startTimer() {
        if (this._timerId) GLib.source_remove(this._timerId);
        const minutes = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._refreshCount();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---- notifications ------------------------------------------------
    _inQuietHours() {
        const s = this._settings;
        if (!s.get_boolean('quiet-hours-enabled')) return false;
        const start = s.get_int('quiet-start');
        const end = s.get_int('quiet-end');
        const h = GLib.DateTime.new_now_local().get_hour();
        if (start === end) return false;
        return start < end ? h >= start && h < end : h >= start || h < end;
    }

    async _notifyNew(delta) {
        const s = this._settings;
        if (!s.get_boolean('notify-new-mail') || this._inQuietHours()) return;
        let title = 'Gmail';
        let body = delta === 1 ? '1 new unread message' : `${delta} new unread messages`;
        if (s.get_boolean('notify-preview')) {
            try {
                const [latest] = await this._client.listMessages('unread', 1);
                if (latest) {
                    title = `Gmail · ${latest.fromName}`;
                    body = delta > 1 ? `${latest.subject}\n+${delta - 1} more` : latest.subject;
                }
            } catch (_e) {
                // fall back to the plain count
            }
        }
        if (this._destroyed) return;
        Main.notify(title, body);
        if (this._settings.get_boolean('notify-sound')) {
            try {
                global.display.get_sound_player().play_from_theme('message-new-instant', 'New mail', null);
            } catch (_e) {
                // no sound theme available
            }
        }
    }

    // ---- reading ------------------------------------------------------
    async _openMessage(m) {
        this._current = m;
        this._rSubject.text = m.subject;
        this._rAvatarSlot.set_child(makeAvatar(m.fromName));
        this._rFrom.text = m.fromName;
        this._rAddr.text = `${m.fromAddr} · to me`;
        this._rTime.text = m.time;
        this._rBody.text = 'Loading…';
        this._showRead();
        try {
            const text = await this._client.getBody(m.id);
            if (this._destroyed || this._current !== m) return;
            this._rBody.text = text || '(no text content, use Open in Gmail)';
        } catch (e) {
            if (this._destroyed || this._current !== m) return;
            this._rBody.text = `Couldn’t load this message.\n${e.message}`;
        }
        if (m.unread && this._settings.get_boolean('mark-read-on-open')) {
            try {
                await this._client.modify(m.id, {remove: ['UNREAD']});
                if (this._destroyed) return;
                m.unread = false;
                this._refreshCount();
            } catch (_e) {
                // Leave it unread; not worth interrupting reading.
            }
        }
    }

    async _act(fn) {
        const m = this._current;
        if (!m) return;
        try {
            await fn(this._client);
        } catch (e) {
            if (!this._destroyed) Main.notify('Gmail', `Action failed: ${e.message}`);
            return;
        }
        if (this._destroyed) return;
        this._showList();
        this._loadList();
        this._refreshCount();
    }

    async _markAllRead() {
        try {
            await this._client.markAllRead();
        } catch (e) {
            if (!this._destroyed) Main.notify('Gmail', `Action failed: ${e.message}`);
            return;
        }
        if (this._destroyed) return;
        this._loadList();
        this._refreshCount();
    }

    // ---- row actions --------------------------------------------------
    async _toggleRead(m) {
        const wasUnread = m.unread;
        try {
            await this._client.modify(m.id, wasUnread ? {remove: ['UNREAD']} : {add: ['UNREAD']});
        } catch (e) {
            if (!this._destroyed) Main.notify('Gmail', `Action failed: ${e.message}`);
            return;
        }
        if (this._destroyed) return;
        m.unread = !wasUnread;
        this._renderList();
        this._refreshCount();
    }

    async _archiveRow(m) {
        try {
            await this._client.modify(m.id, {remove: ['INBOX']});
        } catch (e) {
            if (!this._destroyed) Main.notify('Gmail', `Archive failed: ${e.message}`);
            return;
        }
        if (this._destroyed) return;
        this._messages = this._messages.filter(x => x.id !== m.id);
        this._renderList();
        this._refreshCount();
    }

    // Trash button; with "confirm-delete" on, the first click arms it ("Delete?"), the second deletes.
    _deleteButton(onDelete, styleClass = 'gmail-icon-button') {
        const icon = new St.Icon({gicon: themed('user-trash-symbolic'), icon_size: 16});
        const ask = new St.Label({text: 'Delete?', y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER});
        const btn = new St.Button({
            style_class: styleClass, can_focus: true, accessible_name: 'Delete', child: icon,
        });
        let timer = 0;
        const disarm = () => {
            if (timer) GLib.source_remove(timer);
            timer = 0;
            btn.remove_style_class_name('gmail-delete-armed');
            btn.accessible_name = 'Delete';
            btn.set_child(icon);
        };
        btn.connect('clicked', () => {
            const armed = btn.has_style_class_name('gmail-delete-armed');
            if (armed || !this._settings.get_boolean('confirm-delete')) {
                disarm();
                onDelete();
                return;
            }
            btn.add_style_class_name('gmail-delete-armed');
            btn.accessible_name = 'Click again to delete';
            btn.set_child(ask);
            timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                timer = 0;
                disarm();
                return GLib.SOURCE_REMOVE;
            });
        });
        btn.connect('destroy', () => {
            if (timer) GLib.source_remove(timer);
            timer = 0;
        });
        return btn;
    }

    async _trashRow(m) {
        try {
            await this._client.trash(m.id);
        } catch (e) {
            if (!this._destroyed) Main.notify('Gmail', `Delete failed: ${e.message}`);
            return;
        }
        if (this._destroyed) return;
        this._messages = this._messages.filter(x => x.id !== m.id);
        this._renderList();
        this._refreshCount();
    }

    // ---- links --------------------------------------------------------
    _baseUrl() {
        const email = this._email();
        return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email || '0')}`;
    }

    _openThread() {
        if (!this._current) return;
        this._openUrl(`${this._baseUrl()}#all/${this._current.threadId}`);
    }

    _openUrl(url) {
        this.menu.close();
        Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
    }
});

export default class GmailIndicatorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._themeFile = null;
        this._themeIds = THEME_KEYS.map(
            key => this._settings.connect(`changed::${key}`, () => this._applyTheme()));
        this._posId = this._settings.connect('changed::panel-position', () => this._createIndicator());
        this._applyTheme();
        this._createIndicator();
    }

    disable() {
        this._destroyIndicator();
        for (const id of this._themeIds ?? []) this._settings.disconnect(id);
        this._themeIds = null;
        if (this._posId) this._settings.disconnect(this._posId);
        this._posId = 0;
        this._removeTheme();
        this._settings = null;
    }

    _destroyIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
    }

    _createIndicator() {
        this._destroyIndicator();
        const box = this._settings.get_string('panel-position');
        this._indicator = new GmailIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, box);
    }

    _removeTheme() {
        if (!this._themeFile) return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._themeFile);
        this._themeFile = null;
    }

    // Settings-dependent rules live in a generated stylesheet layered over stylesheet.css.
    _applyTheme() {
        this._removeTheme();
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gmail-indicator']);
        GLib.mkdir_with_parents(dir, 0o755);
        const path = GLib.build_filenamev([dir, 'theme.css']);
        GLib.file_set_contents(path, buildThemeCss(this._settings));
        this._themeFile = Gio.File.new_for_path(path);
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._themeFile);
    }
}
