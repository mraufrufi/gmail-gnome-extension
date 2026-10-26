# Gmail Indicator (GNOME Shell 50)

Created by [Invoxity](https://invoxity.com).

Top-bar unread badge with a popup to search, read, archive, delete (to Trash) and mark Gmail messages.
Reply, Compose and Open in Gmail open the web interface.

## What's in the preferences

- **Account**: OAuth client ID/secret and sign in/out.
- **Mailbox**: check interval, messages shown, default tab, Starred tab on/off, hide Promotions/Social, reload on open, mark-read-on-open, delete confirmation, 12/24h time.
- **Appearance**: top-bar position (left/centre/right), badge as number/dot/none, hide when zero; popup width, list height, font size, corner radius, compact rows, avatars, previews; toggle search box and footer buttons; colour presets (Dark, Light, Nord, Dracula, Gruvbox, Catppuccin, Solarized) plus custom colours and background opacity.
- **Notifications**: on/off, sender+subject preview, sound, quiet hours.
- **About**: reset all settings.

In the popup, hover a message for quick actions (mark read/unread, archive, delete).

## 1. Dependencies (Ubuntu 26.04)

    sudo apt install gir1.2-secret-1 gir1.2-soup-3.0 libglib2.0-bin

## 2. Install

    ./install.sh

Log out and back in (GNOME 50 has no X11, so the shell cannot be restarted in place), then:

    gnome-extensions enable gmail-indicator@user.local

## 3. Google setup (one time)

1. Open https://console.cloud.google.com and create a project.
2. APIs & Services > Library > enable **Gmail API**.
3. Google Auth Platform (OAuth consent screen): choose External, fill in the basics, and add your own address under **Test users**.
4. Clients > Create client > Application type **Desktop app**. Copy the client ID and secret.
5. `gnome-extensions prefs gmail-indicator@user.local`, paste both, click **Sign in**.

The scope requested is `gmail.modify` (read, label, archive, trash; no permanent delete, no sending).
The refresh token is kept in your keyring (libsecret). The client ID/secret are stored in dconf.

Note: while the Google project is in "Testing" status, Google expires the refresh token after 7 days, so you will
need to sign in again weekly. A Google Workspace account with the app set to Internal avoids this.

## Debugging

    journalctl -f -o cat /usr/bin/gnome-shell

## Credits

Created by Invoxity — https://invoxity.com
