#!/usr/bin/env bash
# One-time setup of an Onn HR server on Ubuntu 24.04 (a Google Compute Engine VM). Run it as root:
#   sudo bash setup-server.sh
# It is safe to run again: nothing that exists is overwritten, and the secret keys are made only once.
#
# What it does:
#   - installs Node.js 24 (from NodeSource) and the tools the app needs
#   - makes a system user "onnhr" that runs the app and owns nothing else
#   - makes the folders: /srv/onnhr/app (the code), vault (employee documents), backups, logs
#   - makes /etc/onnhr/onnhr.env from the template, with new random secret keys, readable by root and onnhr only
#   - installs the service so the app starts on boot and restarts if it stops
# It does NOT open any port to the internet: Cloudflare Tunnel reaches the app from inside (docs/DEPLOY_GOOGLE.md).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run this with sudo." >&2; exit 1; fi
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== Node.js 24"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi
apt-get install -y build-essential python3 openssl   # bcrypt builds a native part on some machines
node -v

echo "== user and folders"
id onnhr >/dev/null 2>&1 || useradd --system --home /srv/onnhr --shell /usr/sbin/nologin onnhr
install -d -o onnhr -g onnhr -m 750 /srv/onnhr /srv/onnhr/app /srv/onnhr/vault /srv/onnhr/backups /srv/onnhr/logs
install -d -o root -g onnhr -m 750 /etc/onnhr

echo "== settings and secret keys"
if [ ! -f /etc/onnhr/onnhr.env ]; then
  cp "$HERE/onnhr.env.template" /etc/onnhr/onnhr.env
  put() { sed -i "s|^$1=.*|$1=$2|" /etc/onnhr/onnhr.env; }
  put JWT_SECRET "$(openssl rand -hex 48)"
  put REFRESH_SECRET "$(openssl rand -hex 48)"
  put PII_ENCRYPTION_KEY "$(openssl rand -base64 32)"
  put AUDIT_CHAIN_KEY "$(openssl rand -hex 48)"
  chown root:onnhr /etc/onnhr/onnhr.env
  chmod 640 /etc/onnhr/onnhr.env
  echo
  echo "  Made /etc/onnhr/onnhr.env with new secret keys."
  echo "  IMPORTANT: copy PII_ENCRYPTION_KEY into your password manager now. Without it, stored Social Security"
  echo "  numbers, bank details and documents can never be read again. To see it:"
  echo "      sudo grep ^PII_ENCRYPTION_KEY= /etc/onnhr/onnhr.env"
  echo
else
  echo "  /etc/onnhr/onnhr.env already exists; left as it is."
fi

echo "== service"
install -m 644 "$HERE/onnhr.service" /etc/systemd/system/onnhr.service
systemctl daemon-reload
systemctl enable onnhr >/dev/null
echo
echo "Done. Next: put the code in /srv/onnhr/app (deploy/install-release.sh), fill in the rest of"
echo "/etc/onnhr/onnhr.env, then: sudo systemctl start onnhr"
