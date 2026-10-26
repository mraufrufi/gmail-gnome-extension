// Gmail Indicator, created by Invoxity (https://invoxity.com)
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import * as OAuth from './oauth.js';

const PRESETS = {
    dark: ['Dark (default)', '#2b2b2f', '#f2f2f2', '#78aeed', '#c01c28'],
    light: ['Light', '#fafafa', '#202124', '#1a73e8', '#d93025'],
    nord: ['Nord', '#2e3440', '#eceff4', '#88c0d0', '#bf616a'],
    dracula: ['Dracula', '#282a36', '#f8f8f2', '#bd93f9', '#ff5555'],
    gruvbox: ['Gruvbox', '#282828', '#ebdbb2', '#fabd2f', '#cc241d'],
    mocha: ['Catppuccin Mocha', '#1e1e2e', '#cdd6f4', '#89b4fa', '#f38ba8'],
    solarized: ['Solarized Dark', '#002b36', '#eee8d5', '#268bd2', '#dc322f'],
};
const COLOR_KEYS = ['color-background', 'color-text', 'color-accent', 'color-badge'];
const KEEP_ON_RESET = ['client-id', 'client-secret', 'account-email'];

function switchRow(group, settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function spinRow(group, settings, key, title, lower, upper, {step = 1, subtitle = ''} = {}) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function comboRow(group, settings, key, title, options, subtitle = '') {
    const row = new Adw.ComboRow({
        title, subtitle,
        model: Gtk.StringList.new(options.map(o => o[1])),
    });
    const sync = () => {
        const i = options.findIndex(o => o[0] === settings.get_string(key));
        if (i >= 0 && row.selected !== i) row.selected = i;
    };
    sync();
    row.connect('notify::selected', () => {
        const v = options[row.selected]?.[0];
        if (v && v !== settings.get_string(key)) settings.set_string(key, v);
    });
    settings.connect(`changed::${key}`, sync);
    group.add(row);
    return row;
}

export default class GmailIndicatorPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive for the window's lifetime
        const session = OAuth.newSession();
        window.connect('close-request', () => session.abort());
        window.set_default_size(640, 760);

        this._accountPage(window, settings, session);
        this._mailboxPage(window, settings);
        this._appearancePage(window, settings);
        this._notificationsPage(window, settings);
        this._aboutPage(window, settings);
    }

    // ---- Account ------------------------------------------------------
    _accountPage(window, settings, session) {
        const page = new Adw.PreferencesPage({title: 'Account', icon_name: 'avatar-default-symbolic'});
        window.add(page);

        const account = new Adw.PreferencesGroup({
            title: 'Google account',
            description: 'Create an OAuth client of type “Desktop app” in Google Cloud Console, ' +
                'enable the Gmail API, then paste its ID and secret here. See README.md.',
        });
        page.add(account);

        const idRow = new Adw.EntryRow({title: 'Client ID'});
        settings.bind('client-id', idRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        account.add(idRow);

        const secretRow = new Adw.PasswordEntryRow({title: 'Client secret'});
        settings.bind('client-secret', secretRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        account.add(secretRow);

        const statusRow = new Adw.ActionRow({title: 'Status'});
        const button = new Gtk.Button({valign: Gtk.Align.CENTER});
        statusRow.add_suffix(button);
        account.add(statusRow);

        const toast = title => window.add_toast(new Adw.Toast({title, timeout: 6}));
        const refresh = () => {
            const email = settings.get_string('account-email');
            statusRow.subtitle = email || 'Not signed in';
            button.label = email ? 'Sign out' : 'Sign in';
            button.remove_css_class(email ? 'suggested-action' : 'destructive-action');
            button.add_css_class(email ? 'destructive-action' : 'suggested-action');
            button.sensitive = true;
        };
        refresh();

        button.connect('clicked', async () => {
            button.sensitive = false;
            try {
                if (settings.get_string('account-email')) {
                    await OAuth.signOut(session);
                    settings.set_string('account-email', '');
                } else {
                    const id = settings.get_string('client-id').trim();
                    const secret = settings.get_string('client-secret').trim();
                    if (!id || !secret) {
                        toast('Enter the client ID and secret first.');
                        return;
                    }
                    statusRow.subtitle = 'Waiting for the browser…';
                    const email = await OAuth.signIn(session, id, secret);
                    settings.set_string('account-email', email);
                    toast(`Signed in as ${email}`);
                }
            } catch (e) {
                toast(`Failed: ${e.message}`);
            } finally {
                refresh();
            }
        });
    }

    // ---- Mailbox ------------------------------------------------------
    _mailboxPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Mailbox', icon_name: 'mail-unread-symbolic'});
        window.add(page);

        const fetch = new Adw.PreferencesGroup({title: 'Fetching'});
        page.add(fetch);
        spinRow(fetch, settings, 'refresh-interval', 'Check for new mail every (minutes)', 1, 60);
        spinRow(fetch, settings, 'max-messages', 'Messages shown in the popup', 3, 30);
        switchRow(fetch, settings, 'refresh-on-open', 'Reload when the popup opens',
            'Turn off to save API calls; use the refresh button instead');
        switchRow(fetch, settings, 'exclude-promotions', 'Hide Promotions and Social',
            'Filters those categories out of the list (the unread badge still counts all inbox mail)');

        const tabs = new Adw.PreferencesGroup({title: 'Tabs'});
        page.add(tabs);
        comboRow(tabs, settings, 'default-tab', 'Default tab', [
            ['unread', 'Unread'], ['all', 'All mail'], ['starred', 'Starred'],
        ]);
        switchRow(tabs, settings, 'show-starred-tab', 'Show the Starred tab');

        const actions = new Adw.PreferencesGroup({title: 'Actions'});
        page.add(actions);
        switchRow(actions, settings, 'mark-read-on-open', 'Mark as read when opened',
            'Messages are marked read as soon as you open them in the popup');
        switchRow(actions, settings, 'confirm-delete', 'Ask before deleting',
            'Deleting moves a message to Trash; the first click asks, the second confirms');
        comboRow(actions, settings, 'time-format', 'Time format', [['24h', '24-hour'], ['12h', '12-hour']]);
    }

    // ---- Appearance ---------------------------------------------------
    _appearancePage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});
        window.add(page);

        // Top bar
        const panel = new Adw.PreferencesGroup({title: 'Top bar button'});
        page.add(panel);
        comboRow(panel, settings, 'panel-position', 'Position', [
            ['left', 'Left'], ['center', 'Centre'], ['right', 'Right'],
        ]);
        comboRow(panel, settings, 'badge-style', 'Unread indicator', [
            ['count', 'Number'], ['dot', 'Dot'], ['hidden', 'None'],
        ]);
        switchRow(panel, settings, 'hide-when-zero', 'Hide when there is no unread mail',
            'The button disappears from the top bar until new mail arrives');

        // Layout
        const layout = new Adw.PreferencesGroup({title: 'Popup layout'});
        page.add(layout);
        spinRow(layout, settings, 'popup-width', 'Width (px)', 320, 600, {step: 10});
        spinRow(layout, settings, 'popup-max-height', 'List height (px)', 200, 700, {step: 10});
        spinRow(layout, settings, 'font-size', 'Font size (px)', 10, 18);
        spinRow(layout, settings, 'corner-radius', 'Corner radius (px)', 0, 28);
        switchRow(layout, settings, 'compact-rows', 'Compact rows', 'Tighter spacing, fits more messages');
        switchRow(layout, settings, 'show-avatars', 'Show sender avatars');
        switchRow(layout, settings, 'show-snippet', 'Show message preview');

        const parts = new Adw.PreferencesGroup({title: 'Popup elements'});
        page.add(parts);
        switchRow(parts, settings, 'show-search', 'Search box');
        switchRow(parts, settings, 'show-compose', 'Compose button');
        switchRow(parts, settings, 'show-open-gmail', 'Open Gmail button');
        switchRow(parts, settings, 'show-mark-all', 'Mark all read button');

        // Colours
        const colors = new Adw.PreferencesGroup({title: 'Colours'});
        page.add(colors);

        const presetKeys = Object.keys(PRESETS);
        const presetRow = new Adw.ComboRow({
            title: 'Preset',
            model: Gtk.StringList.new([...presetKeys.map(k => PRESETS[k][0]), 'Custom']),
        });
        colors.add(presetRow);

        const pickers = {};
        const toHex = c => '#' + [c.red, c.green, c.blue]
            .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        let applying = false;

        const detectPreset = () => {
            const cur = COLOR_KEYS.map(k => settings.get_string(k).toLowerCase());
            const found = presetKeys.findIndex(k => PRESETS[k].slice(1).every((c, i) => c === cur[i]));
            return found >= 0 ? found : presetKeys.length;
        };

        for (const [key, title] of [
            ['color-background', 'Background'],
            ['color-text', 'Text'],
            ['color-accent', 'Accent (active tab, buttons, unread dot)'],
            ['color-badge', 'Unread badge'],
        ]) {
            const row = new Adw.ActionRow({title});
            const picker = new Gtk.ColorDialogButton({
                valign: Gtk.Align.CENTER,
                dialog: new Gtk.ColorDialog({title, with_alpha: false}),
            });
            const load = () => {
                const rgba = new Gdk.RGBA();
                if (rgba.parse(settings.get_string(key)) && toHex(picker.rgba) !== toHex(rgba))
                    picker.rgba = rgba;
            };
            load();
            picker.connect('notify::rgba', () => {
                const hex = toHex(picker.rgba);
                if (hex !== settings.get_string(key)) settings.set_string(key, hex);
            });
            settings.connect(`changed::${key}`, () => {
                load();
                if (!applying) presetRow.selected = detectPreset();
            });
            row.add_suffix(picker);
            row.activatable_widget = picker;
            colors.add(row);
            pickers[key] = picker;
        }

        presetRow.selected = detectPreset();
        presetRow.connect('notify::selected', () => {
            const key = presetKeys[presetRow.selected];
            if (!key) return; // "Custom"
            applying = true;
            PRESETS[key].slice(1).forEach((c, i) => settings.set_string(COLOR_KEYS[i], c));
            settings.set_string('color-preset', key);
            applying = false;
        });

        spinRow(colors, settings, 'background-opacity', 'Background opacity (%)', 50, 100, {step: 5});

        const resetRow = new Adw.ActionRow({title: 'Default colours'});
        const reset = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        reset.connect('clicked', () => {
            COLOR_KEYS.forEach(k => settings.reset(k));
            settings.reset('background-opacity');
            settings.reset('color-preset');
        });
        resetRow.add_suffix(reset);
        colors.add(resetRow);
    }

    // ---- Notifications ------------------------------------------------
    _notificationsPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Notifications', icon_name: 'preferences-system-notifications-symbolic'});
        window.add(page);

        const group = new Adw.PreferencesGroup({title: 'New mail'});
        page.add(group);
        const master = switchRow(group, settings, 'notify-new-mail', 'Notify when new mail arrives');
        const preview = switchRow(group, settings, 'notify-preview', 'Show sender and subject',
            'Fetches the newest unread message to use in the notification');
        const sound = switchRow(group, settings, 'notify-sound', 'Play a sound');
        for (const r of [preview, sound])
            master.bind_property('active', r, 'sensitive', GObject.BindingFlags.SYNC_CREATE);

        const quiet = new Adw.PreferencesGroup({
            title: 'Quiet hours',
            description: 'No notifications during this period. The badge keeps updating.',
        });
        page.add(quiet);
        const enable = switchRow(quiet, settings, 'quiet-hours-enabled', 'Enable quiet hours');
        for (const [key, title] of [['quiet-start', 'From (hour)'], ['quiet-end', 'Until (hour)']]) {
            const row = spinRow(quiet, settings, key, title, 0, 23);
            enable.bind_property('active', row, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        }
    }

    // ---- About --------------------------------------------------------
    _aboutPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});
        window.add(page);

        const brand = new Adw.PreferencesGroup();
        page.add(brand);
        const made = new Adw.ActionRow({
            title: 'Created by Invoxity',
            subtitle: 'invoxity.com',
            activatable: true,
        });
        made.add_prefix(new Gtk.Image({icon_name: 'mail-unread-symbolic', pixel_size: 32}));
        made.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        made.connect('activated', () => {
            try {
                Gio.AppInfo.launch_default_for_uri('https://invoxity.com', null);
            } catch (e) {
                window.add_toast(new Adw.Toast({title: `Couldn’t open the browser: ${e.message}`}));
            }
        });
        brand.add(made);

        const info = new Adw.PreferencesGroup({title: 'Gmail Indicator'});
        page.add(info);
        const ver = new Adw.ActionRow({title: 'Version', subtitle: String(this.metadata.version ?? '')});
        info.add(ver);
        const scope = new Adw.ActionRow({
            title: 'Permissions',
            subtitle: 'gmail.modify: read, label, archive and trash. No permanent delete, no sending.',
        });
        info.add(scope);

        const reset = new Adw.PreferencesGroup({title: 'Reset'});
        page.add(reset);
        const row = new Adw.ActionRow({
            title: 'Reset all settings',
            subtitle: 'Restores every option except your account and OAuth credentials',
        });
        const btn = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        btn.add_css_class('destructive-action');
        btn.connect('clicked', () => {
            for (const key of settings.settings_schema.list_keys()) {
                if (!KEEP_ON_RESET.includes(key)) settings.reset(key);
            }
            window.add_toast(new Adw.Toast({title: 'Settings reset', timeout: 4}));
        });
        row.add_suffix(btn);
        reset.add(row);
    }
}
