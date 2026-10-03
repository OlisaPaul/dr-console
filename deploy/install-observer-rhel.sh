#!/usr/bin/env bash
# Initial setup of one fixed telemetry account. No service/role/replication changes.
set -Eeuo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root on the selected ConVox server.'
[[ $# == 2 ]] || fail 'Usage: install-observer-rhel.sh production|dr /root/observer_ed25519.pub'
case "$1" in
  production) EXPECTED_IP=10.81.0.11; EXPECTED_ID=8111 ;;
  dr) EXPECTED_IP=10.3.0.150; EXPECTED_ID=30150 ;;
  *) fail 'Select production or dr.' ;;
esac
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
KEY_FILE="$2"
for CMD in mysql ip python3 ssh-keygen useradd install restorecon runuser; do command -v "$CMD" >/dev/null || fail "Missing: $CMD"; done
[[ -x /usr/bin/python3 && -x /usr/bin/mysql ]] || fail 'Expected /usr/bin/python3 and /usr/bin/mysql.'
[[ -f "$KEY_FILE" ]] || fail 'Public key file missing.'
ssh-keygen -l -f "$KEY_FILE" >/dev/null || fail 'Invalid public key.'
PUBLIC_KEY="$(awk 'NF {n++; if(n==1) print $1 " " $2} END {if(n!=1) exit 1}' "$KEY_FILE")" || fail 'Supply exactly one public key.'
[[ "$PUBLIC_KEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))[[:space:]][A-Za-z0-9+/=]+$ ]] || fail 'Unsupported public key format.'
ip -4 -o address show | awk '{print $4}' | cut -d/ -f1 | grep -Fxq "$EXPECTED_IP" || fail 'Wrong target host IP.'
[[ "$(mysql -Nse 'SELECT @@server_id')" == "$EXPECTED_ID" ]] || fail 'Wrong MariaDB server ID.'
[[ "$(mysql -Nse "SELECT COUNT(*) FROM information_schema.PLUGINS WHERE PLUGIN_NAME='unix_socket' AND PLUGIN_STATUS='ACTIVE'")" == 1 ]] || fail 'Active unix_socket authentication is required.'
[[ "$(mysql -Nse "SELECT COUNT(*) FROM mysql.user WHERE User='convoxstatus'")" == 0 ]] || fail 'Database observer already exists. Inspect instead of overwriting.'
! getent passwd convoxstatus >/dev/null || fail 'OS observer already exists. Inspect instead of overwriting.'
[[ ! -e /usr/local/libexec/convox-console-status ]] || fail 'Observer agent already exists.'

useradd --system --user-group --create-home --home-dir /home/convoxstatus --shell /bin/bash convoxstatus
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$SOURCE_DIR/convox-console-status.py" /usr/local/libexec/convox-console-status
# Root owns the home and authorized_keys so this account cannot relax key restrictions.
chown root:root /home/convoxstatus
chmod 0755 /home/convoxstatus
install -d -o root -g root -m 0755 /home/convoxstatus/.ssh
printf 'from="10.3.0.151",restrict,command="/usr/local/libexec/convox-console-status" %s\n' "$PUBLIC_KEY" > /home/convoxstatus/.ssh/authorized_keys
chown root:root /home/convoxstatus/.ssh/authorized_keys
chmod 0644 /home/convoxstatus/.ssh/authorized_keys
mysql <<'SQL'
SET SESSION sql_log_bin=0;
CREATE USER 'convoxstatus'@'localhost' IDENTIFIED VIA unix_socket;
GRANT REPLICA MONITOR ON *.* TO 'convoxstatus'@'localhost';
SQL
restorecon -RF /home/convoxstatus /usr/local/libexec/convox-console-status
runuser -u convoxstatus -- env SSH_ORIGINAL_COMMAND=convox-status-v1 /usr/local/libexec/convox-console-status
printf '\nObserver installed. Verify db identity in the JSON, then test restricted SSH from archival. No recovery controls were enabled.\n'
