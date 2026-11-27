#!/usr/bin/env bash
# Run on the server, as root, with the file made by deploy/make-release.sh and the SHA-256 it printed:
#   sudo bash install-release.sh onnhr-abc1234.tar.gz <sha256>
# It checks the file, unpacks it next to the running version, installs the libraries, runs the settings check,
# then switches /srv/onnhr/app to the new version and restarts. If anything fails before the switch, the running
# version is untouched. The previous version is kept so you can switch back (see the last lines it prints); older
# versions, and older uploaded release files next to this one, are removed after a successful start.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run this with sudo." >&2; exit 1; fi
file="${1:?the release file}"; want="${2:?the SHA-256 printed by make-release.sh}"
got="$(sha256sum "$file" | cut -d' ' -f1)"
if [ "$got" != "$want" ]; then echo "The file does not match its SHA-256. Upload it again." >&2; exit 1; fi

name="$(basename "$file" .tar.gz)"
dest="/srv/onnhr/releases/$name"
install -d -o onnhr -g onnhr -m 750 /srv/onnhr/releases
rm -rf "$dest"
tar -xzf "$file" -C /srv/onnhr/releases
chown -R onnhr:onnhr "$dest"

echo "== libraries"
sudo -u onnhr bash -c "cd '$dest' && npm ci --omit=dev --no-audit --no-fund"

echo "== settings check"
sudo -u onnhr bash -c "set -a; . /etc/onnhr/onnhr.env; cd '$dest' && node scripts/check-production-env.js"

echo "== switch and restart"
previous="$(readlink -f /srv/onnhr/app || true)"
if [ -d /srv/onnhr/app ] && [ ! -L /srv/onnhr/app ]; then rmdir /srv/onnhr/app 2>/dev/null || mv /srv/onnhr/app "/srv/onnhr/app.before-$(date +%s)"; fi
ln -sfn "$dest" /srv/onnhr/app
systemctl restart onnhr
sleep 5
if systemctl is-active --quiet onnhr; then
  echo "Running $name."
  [ -n "$previous" ] && [ "$previous" != "$dest" ] && echo "To go back: sudo ln -sfn '$previous' /srv/onnhr/app && sudo systemctl restart onnhr"
  # Keep only this version and the one before it (to go back); older versions and older uploaded files are removed.
  for old in /srv/onnhr/releases/onnhr-*; do
    [ -d "$old" ] || continue
    [ "$(readlink -f "$old")" = "$(readlink -f "$dest")" ] && continue
    [ -n "$previous" ] && [ "$(readlink -f "$old")" = "$previous" ] && continue
    rm -rf "$old" && echo "Removed old version $(basename "$old")."
  done
  updir="$(cd "$(dirname "$file")" && pwd)"
  for oldfile in "$updir"/onnhr-*.tar.gz; do
    [ -f "$oldfile" ] || continue
    [ "$(basename "$oldfile")" = "$(basename "$file")" ] && continue
    rm -f "$oldfile" && echo "Removed old upload $(basename "$oldfile")."
  done
  # This script updates itself from the version just installed, so the next install uses the newest steps.
  self="$(readlink -f "$0" 2>/dev/null || true)"
  fresh="$dest/deploy/install-release.sh"
  if [ -n "$self" ] && [ -f "$self" ] && [ -f "$fresh" ] && ! cmp -s "$fresh" "$self"; then
    cp "$fresh" "$self" && { [ -n "${SUDO_USER:-}" ] && chown "$SUDO_USER" "$self" || true; } && echo "The install script was updated to the newest version."
  fi
else
  echo "The app did not start. See: sudo journalctl -u onnhr -n 80" >&2
  [ -n "$previous" ] && [ -d "$previous" ] && { ln -sfn "$previous" /srv/onnhr/app; systemctl restart onnhr; echo "Switched back to the previous version." >&2; }
  exit 1
fi
