#!/bin/sh
# Installs the extension for the current user.
set -eu
UUID="gmail-indicator@user.local"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

command -v glib-compile-schemas >/dev/null || { echo "Install libglib2.0-bin first."; exit 1; }
glib-compile-schemas "$SRC/schemas"
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/
echo "Installed to $DEST"
echo "GNOME 50 is Wayland-only: log out and back in, then run:"
echo "  gnome-extensions enable $UUID"
