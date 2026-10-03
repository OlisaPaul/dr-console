# Phase 1: live read-only status from archival

This release adds **observe** mode, not live recovery execution. It contacts production (10.81.0.11 / server ID 8111) and DR (10.3.0.150 / server ID 30150) over restricted SSH from archival (10.3.0.151). It reads MariaDB globals, replication status, discovered systemd units, Lsyncd state and Asterisk/safe_asterisk process counts. It cannot restart services, kill processes, seed databases, change read-only flags or switch routing. Snapshots are not proof of fencing or final catch-up.

The observer is a dedicated OS/DB account, not root SSH. Its forced SSH command runs a root-owned Python program as the unprivileged account, with no sudo rights. MariaDB uses local Unix-socket authentication with only REPLICA MONITOR; there is no database password and no application-data SELECT permission. Provisioning creates this management account with session binary logging disabled so it does not introduce replica-local GTIDs or replicate account creation. Provisioning is an administrative change; subsequent probes are read-only.

## A. Upgrade the already-installed archival console

Upload the NEW package from Windows:

```powershell
scp C:\Users\DEEPIJA\Documents\ConVoxCCS\dr-console\artifacts\convox-dr-console-deploy.zip root@10.3.0.151:/root/
```

On archival as root, extract into a new directory and upgrade code:

```bash
PACKAGE_DIR=$(mktemp -d /root/convox-console-update.XXXXXX)
unzip /root/convox-dr-console-deploy.zip -d "$PACKAGE_DIR"
bash "$PACKAGE_DIR/deploy/upgrade-rhel.sh"
```

The upgrade backs up code and console.env, stops/starts only the console service, and preserves Nginx, TLS, operator login, secrets and state. It keeps the current mode. Do not rerun the initial installer over an existing installation. If upgrade fails, inspect its printed backup path and journal; no automatic rollback is attempted. Existing Nginx continues serving but may briefly return 502 while the backend restarts.

## B. Create a dedicated observer key on archival

Install openssh-clients if required. Do not reuse an unrestricted root SSH key. The following is for a NEW key; do not overwrite an existing one:

```bash
install -d -o root -g convoxconsole -m 0750 /etc/convox-console/ssh
ssh-keygen -t ed25519 -N '' -f /etc/convox-console/ssh/observer_ed25519 -C convox-console-readonly
chown root:convoxconsole /etc/convox-console/ssh/observer_ed25519
chmod 0640 /etc/convox-console/ssh/observer_ed25519
chmod 0644 /etc/convox-console/ssh/observer_ed25519.pub
```

The service account must read the key; root remains its owner and the private key must not be sent to either managed server or committed to the project. If FIPS policy prohibits Ed25519, use an approved RSA key and update identityFile accordingly.

## C. Pin server host keys

On each server through an existing trusted administrator session:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On archival, collect candidates into a new file:

```bash
ssh-keyscan -T 5 -t ed25519 10.81.0.11 10.3.0.150 > /etc/convox-console/ssh/known_hosts.candidate
ssh-keygen -lf /etc/convox-console/ssh/known_hosts.candidate
```

Compare both fingerprints with the trusted sessions. **ssh-keyscan alone is not verification.** Only after both match, install them (inspect/preserve any existing known_hosts rather than overwriting it):

```bash
install -o root -g convoxconsole -m 0640 /etc/convox-console/ssh/known_hosts.candidate /etc/convox-console/ssh/known_hosts
```

If policy uses another host-key type, collect/verify that type instead. Never use StrictHostKeyChecking=no or accept-new here. For nonstandard SSH ports, use the correct keyscan port and update status.json; host-key names must include the port.

## D. Install the observer on each managed server

From archival, transfer only the PUBLIC key and the two setup files through your existing administrator SSH access:

```bash
scp /etc/convox-console/ssh/observer_ed25519.pub "$PACKAGE_DIR/deploy/convox-console-status.py" "$PACKAGE_DIR/deploy/install-observer-rhel.sh" root@10.81.0.11:/root/
scp /etc/convox-console/ssh/observer_ed25519.pub "$PACKAGE_DIR/deploy/convox-console-status.py" "$PACKAGE_DIR/deploy/install-observer-rhel.sh" root@10.3.0.150:/root/
```

Substitute your normal administrative account if root SSH is disabled, then place the files in /root/ with sudo. Install on production:

```bash
bash /root/install-observer-rhel.sh production /root/observer_ed25519.pub
```

Install on DR:

```bash
bash /root/install-observer-rhel.sh dr /root/observer_ed25519.pub
```

These initial setup scripts verify host IP and server ID, require MariaDB 10.5.29's active unix_socket plugin, refuse existing observer accounts/agent files, and create no service restart or role changes. They assume the local socket is /var/lib/mysql/mysql.sock; confirm this on both servers first. The script prints an actual JSON probe; check db.serverId and db.readOnly. If db is null, stop and inspect observer authentication locally before changing console mode.

The restricted authorized key permits source IP **10.3.0.151** only, disables PTY/forwarding/user rc, and forces the agent. The observer home/authorized_keys are root-owned so the account cannot change these restrictions. No sudo entry is installed. If the source is NATed, verify archival's actual egress address before adapting that exact restriction; do not remove it or use a broad subnet. Existing service accounts, licences and application configuration are untouched.

Do not rerun blindly after partial setup. Inspect the OS user, DB grant and installed files; the installer intentionally refuses overwrites. Public-key access may also be governed by local sshd/PAM policy. Check local SSH logs if needed; do not enable password/root login to bypass it.

## E. Verify as the actual console service account

On archival, run each command as one line:

```bash
sudo -u convoxconsole ssh -T -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/convox-console/ssh/known_hosts -o IdentitiesOnly=yes -o IdentityAgent=none -i /etc/convox-console/ssh/observer_ed25519 convoxstatus@10.81.0.11 convox-status-v1
sudo -u convoxconsole ssh -T -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/convox-console/ssh/known_hosts -o IdentitiesOnly=yes -o IdentityAgent=none -i /etc/convox-console/ssh/observer_ed25519 convoxstatus@10.3.0.150 convox-status-v1
```

Both should return JSON with ok=true and the correct database identity. Check the boundary by sending another command through the same options (replace the final convox-status-v1 with id): it must be rejected, not run id. No remote shell/SFTP is permitted through this key. Keep the ordinary administrator connection separate.

## F. Enable read-only monitoring

On archival:

```bash
install -o root -g convoxconsole -m 0640 "$PACKAGE_DIR/deploy/status.example.json" /etc/convox-console/status.json
sudoedit /etc/convox-console/console.env
```

Preserve the public origin and port. Set:

```ini
PORT=4180
CONVOX_MODE=observe
CONVOX_CONFIG_FILE=/etc/convox-console/status.json
CONVOX_PUBLIC_ORIGIN=https://10.3.0.151
CONVOX_DATA_DIR=/var/lib/convox-dr-console/observe
```

The separate observe directory preserves simulation history and is within the systemd service's writable state area. Existing simulation data must not be reused as live evidence.

```bash
restorecon -RF /etc/convox-console
systemctl restart convox-dr-console
systemctl --no-pager --full status convox-dr-console
```

Open https://10.3.0.151, refresh the browser, and click **Refresh status**. The banner must say **Live monitoring · read-only**. Status is a snapshot on manual refresh, not an automatic outage detector. All recovery/demo controls must be disabled. Connection setup lists discovered units; process counts also cover legacy safe_asterisk deployments without inventing a systemd unit.

Unknown/offline databases must remain unverified. Both writable databases must display a split-brain warning. Lsyncd active does not prove copy direction or completeness. Zero replica lag does not prove the final database/file boundary. Private SQL errors and row values are not returned to the UI.

## Return to simulation

Edit console.env to restore CONVOX_MODE=simulation and CONVOX_DATA_DIR=/var/lib/convox-dr-console, then restart only convox-dr-console. The observer accounts may remain for future testing. Do not remove their users or files without an explicit cleanup plan.

## Phase 2 prerequisites: actual recovery execution

Required before adding write-capable hooks: exact ConVox workers/cron/scripts on both servers, persistent fencing proof even after reboot, safe_asterisk path/user/autostart and graceful-stop behavior, backup/reseed tests preserving destination licence/configuration, closed-recording and same-size-code verification, exact final GTID boundary, and confirmed SIP/web/NAT routing procedure.

The provided pkill -9 asterisk sequence is not installed as an automated default: it abruptly terminates calls and safe_asterisk can respawn the process. The monitor key intentionally cannot perform that sequence. A write-capable recovery account/hook must be separately scoped and tested; never grant unrestricted sudo to the observer.

References: [MariaDB SHOW REPLICA STATUS privileges](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/show/show-replica-status), [OpenSSH authorized key restrictions](https://man.openbsd.org/sshd.8).
