#!/usr/bin/env bash
# One-time agent installation only: no DB role, replication or application changes.
set -Eeuo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 && $# == 3 ]] || fail 'Usage as root: install-control-rhel.sh production|dr /root/control_ed25519.pub /root/convox-cluster-secret'
HOST="$1"
case "$HOST" in
    production) EXPECTED_IP=10.81.0.11; EXPECTED_ID=8111 ;;
    dr) EXPECTED_IP=10.3.0.150; EXPECTED_ID=30150 ;;
    *) fail 'Select production or dr.' ;;
esac
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
for CMD in mysql python3 ip ssh-keygen useradd install restorecon visudo; do command -v "$CMD" >/dev/null || fail "Missing: $CMD"; done
[[ "$(mysql -Nse 'SELECT @@server_id')" == "$EXPECTED_ID" ]] || fail 'Wrong MariaDB identity.'
ip -4 -o address show | awk '{print $4}' | cut -d/ -f1 | grep -Fxq "$EXPECTED_IP" || fail 'Wrong server IP.'
[[ -f "$2" && -f "$3" ]] || fail 'Public key or shared secret file missing.'
[[ "$(stat -c %U "$3")" == root && "$(stat -c %a "$3")" == 600 ]] || fail 'Shared secret must be root-owned mode 0600.'
ssh-keygen -l -f "$2" >/dev/null || fail 'Invalid public key.'
PUBLIC_KEY="$(awk 'NF {n++; if(n==1) print $1 " " $2} END {if(n!=1) exit 1}' "$2")" || fail 'Supply one public key.'
[[ "$PUBLIC_KEY" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+$ ]] || fail 'Use an Ed25519 control key.'
! getent passwd convoxcontrol >/dev/null || fail 'Control account exists; inspect instead of overwriting.'
[[ ! -e /etc/convox-console-agent/control.json && ! -e /usr/local/libexec/convox-console-control ]] || fail 'Agent exists; inspect instead of overwriting.'
[[ -f "$SOURCE_DIR/convox-console-control.py" && -f "$SOURCE_DIR/convox-console-runtime.service" ]] || fail 'Agent deployment files missing.'
python3 - "$3" <<'PY'
import pathlib, re, sys
if re.fullmatch(r'[a-f0-9]{64}', pathlib.Path(sys.argv[1]).read_text().strip()) is None:
    raise SystemExit('Secret file must contain one 32-byte hex key')
PY

useradd --system --user-group --create-home --home-dir /home/convoxcontrol --shell /bin/bash convoxcontrol
chown root:root /home/convoxcontrol
chmod 0755 /home/convoxcontrol
install -d -o root -g root -m 0755 /home/convoxcontrol/.ssh /usr/local/libexec
install -d -o root -g root -m 0700 /etc/convox-console-agent /var/lib/convox-console-agent
install -o root -g root -m 0755 "$SOURCE_DIR/convox-console-control.py" /usr/local/libexec/convox-console-control
install -o root -g root -m 0644 "$SOURCE_DIR/convox-console-runtime.service" /usr/lib/systemd/system/convox-console-runtime.service
printf '%s\n' '#!/bin/bash' '[[ "$SSH_ORIGINAL_COMMAND" == "convox-control-v1" ]] || exit 1' 'exec /usr/bin/sudo -n /usr/local/libexec/convox-console-control' > /usr/local/libexec/convox-control-entry
chown root:root /usr/local/libexec/convox-control-entry
chmod 0755 /usr/local/libexec/convox-control-entry
printf 'from="10.3.0.151",restrict,command="/usr/local/libexec/convox-control-entry" %s\n' "$PUBLIC_KEY" > /home/convoxcontrol/.ssh/authorized_keys
chown root:root /home/convoxcontrol/.ssh/authorized_keys
chmod 0644 /home/convoxcontrol/.ssh/authorized_keys
printf '%s\n' 'Defaults:convoxcontrol !requiretty' 'convoxcontrol ALL=(root) NOPASSWD: /usr/local/libexec/convox-console-control ""' > /etc/sudoers.d/convox-console-control
chmod 0440 /etc/sudoers.d/convox-console-control
visudo -cf /etc/sudoers.d/convox-console-control >/dev/null || fail 'Sudo rule validation failed.'
python3 - "$HOST" "$3" <<'PY'
import json, os, pathlib, sys
cfg = {'host': sys.argv[1], 'clusterSecret': pathlib.Path(sys.argv[2]).read_text().strip(),
       'adminReviewedStartup': False, 'startupUnits': ['php-fpm.service', 'nginx.service'],
       'workerLauncher': '/var/www/convox_perl/convox_screen.pl',
       'fileIdentity': '/root/.ssh/convox-file-sync', 'fileKnownHosts': '/root/.ssh/known_hosts'}
path = pathlib.Path('/etc/convox-console-agent/control.json')
path.write_text(json.dumps(cfg, indent=2) + '\n')
os.chmod(path, 0o600)
PY
restorecon -RF /home/convoxcontrol /usr/local/libexec/convox-control-entry /usr/local/libexec/convox-console-control /etc/sudoers.d/convox-console-control /etc/convox-console-agent /var/lib/convox-console-agent /usr/lib/systemd/system/convox-console-runtime.service
systemctl daemon-reload
# Only the newly installed runtime is masked; existing ConVox services are untouched.
systemctl mask convox-console-runtime.service
printf 'Agent installed without changing database roles or existing services. Review startup dependencies and set adminReviewedStartup=true before preflight. No automatic cutover occurred.\n'
