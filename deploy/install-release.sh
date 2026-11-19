#!/usr/bin/env bash
# Run on the server, as root, with the file made by deploy/make-release.sh and the SHA-256 it printed:
#   sudo bash install-release.sh onnhr-abc1234.tar.gz <sha256>
# It checks the file, unpacks it next to the running version, installs the libraries, runs the settings check,
# then switches /srv/onnhr/app to the new version and restarts. If anything fails before the switch, the running
# version is untouched. The previous version is kept so you can switch back (see the last lines it prints).
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
else
  echo "The app did not start. See: sudo journalctl -u onnhr -n 80" >&2
  [ -n "$previous" ] && [ -d "$previous" ] && { ln -sfn "$previous" /srv/onnhr/app; systemctl restart onnhr; echo "Switched back to the previous version." >&2; }
  exit 1
fi
