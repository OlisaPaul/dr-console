#!/usr/bin/env bash
# Upgrade code only. Preserve mode, config, keys, TLS, authentication and state.
set -Eeuo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root on archival.'
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ -f /etc/convox-console/console.env && -f /opt/convox-dr-console/server.mjs ]] || fail 'Existing console installation required.'
[[ -x /usr/bin/node ]] || fail 'Node is missing.'
/usr/bin/node -e 'if(Number(process.versions.node.split(".")[0])<22) process.exit(1)' || fail 'Node >=22 required.'
[[ "$(stat -c %U /opt/convox-dr-console)" == root ]] || fail 'Controller code must be root-owned.'
BACKUP_DIR="$(mktemp -d /root/convox-console-upgrade.XXXXXX)"
tar -czf "$BACKUP_DIR/code.tar.gz" -C /opt/convox-dr-console server.mjs package.json lib public
install -m 0600 /etc/convox-console/console.env "$BACKUP_DIR/console.env"
systemctl stop convox-dr-console
install -o root -g root -m 0644 "$SOURCE_DIR/server.mjs" "$SOURCE_DIR/package.json" /opt/convox-dr-console/
for DIRECTORY in lib public; do
    install -d -o root -g root -m 0755 "/opt/convox-dr-console/$DIRECTORY"
    find "$SOURCE_DIR/$DIRECTORY" -maxdepth 1 -type f -exec install -o root -g root -m 0644 -t "/opt/convox-dr-console/$DIRECTORY" {} +
done
if command -v restorecon >/dev/null; then restorecon -RF /opt/convox-dr-console; fi
systemctl start convox-dr-console
curl --fail --silent --retry 10 --retry-connrefused --retry-delay 1 --max-time 5 --output /dev/null http://127.0.0.1:4180/ || fail "Upgrade health check failed. Preserve $BACKUP_DIR and inspect journalctl -u convox-dr-console."
printf 'Code upgraded. Configuration and state preserved. Backup: %s\n' "$BACKUP_DIR"
printf 'Follow deploy/LIVE_STATUS.md to provision read-only monitoring. No mode was automatically changed.\n'
