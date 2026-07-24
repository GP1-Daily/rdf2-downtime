#!/bin/sh

set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

if ! command -v php >/dev/null 2>&1; then
  echo "PHP CLI is required." >&2
  exit 1
fi

php -r 'exit(extension_loaded("pdo_mysql") && extension_loaded("curl") ? 0 : 1);' || {
  echo "Required PHP extensions are missing: pdo_mysql and/or curl." >&2
  exit 1
}
php -l sync.php >/dev/null

if ! id gp1sync >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/gp1-grab-sync --shell /usr/sbin/nologin gp1sync
fi

install -d -m 0755 -o root -g root /opt/gp1-grab-sync
install -d -m 0750 -o gp1sync -g gp1sync /var/lib/gp1-grab-sync
install -m 0755 -o root -g root sync.php /opt/gp1-grab-sync/sync.php
install -m 0644 -o root -g root gp1-grab-sync.service /etc/systemd/system/gp1-grab-sync.service
install -m 0644 -o root -g root gp1-grab-sync.timer /etc/systemd/system/gp1-grab-sync.timer

if [ ! -f /etc/gp1-grab-sync.ini ]; then
  install -m 0640 -o root -g gp1sync config.ini.example /etc/gp1-grab-sync.ini
fi

systemctl daemon-reload

echo "Files installed. Edit /etc/gp1-grab-sync.ini, then run:"
echo "  sudo systemctl start gp1-grab-sync.service"
echo "  sudo journalctl -u gp1-grab-sync.service -n 50 --no-pager"
echo "  sudo systemctl enable --now gp1-grab-sync.timer"
