# UI-controlled planned switchover — 0.3 UAT implementation

This package implements a **real planned switchover**, initiated in the existing
archival UI. It is not installed remotely by creating the ZIP. Test the agents
on your UAT servers before relying on it. The default mode remains unchanged.

Supported: reachable production → healthy DR, preflight, consistent rollback
backups, writer shutdown, an exact final GTID under a held global read lock,
checksum-verified final file copy, persistent database fencing, persistent
promotion, approved application startup, and explicit team routing attestation.

**Not implemented:** unreachable-primary/external fencing; automatic database
rebuild/rejoin; automatic reverse replication/file-sync provisioning; automatic
carrier/DNS routing. The old primary remains fenced. The reverse cutover button
works only after that server has independently been rebuilt as a healthy replica
of the new primary and a reverse file-copy key has been provisioned. It does not
rebuild the old peer after switching back. Do not mistake simulation's complete
rejoin/failback demonstration for these live capabilities.

## One-time deployment, not commands for each drill

Use a trusted administrator session for the installation steps. Do not expose
the control key or cluster receipt secret in chat, screenshots, Git or the UI.
Restrict archival access to your operator network. Keep the existing HTTPS and
operator authentication. Do not disable SELinux or host-key verification.

1. Upload `convox-dr-console-control-0.3.0.zip` to archival (`10.3.0.151`). Extract
   into a **new** root-private directory, avoiding stale files from the 0.2 ZIP:

   ```bash
   install -d -m 0700 /root/convox-console-control-0.3.0
   unzip /root/convox-dr-console-control-0.3.0.zip -d /root/convox-console-control-0.3.0
   bash /root/convox-console-control-0.3.0/deploy/upgrade-rhel.sh
   ```

   Upgrade preserves the current observe mode, configuration, TLS, credentials
   and state. It does not run a cutover or install agents on other hosts.

2. On archival, create a **separate** Ed25519 control key (do not replace the
   observer key). If the destination exists, inspect instead of overwriting:

   ```bash
   ssh-keygen -t ed25519 -N '' -f /etc/convox-console/ssh/control_ed25519
   chown root:convoxconsole /etc/convox-console/ssh/control_ed25519
   chmod 0640 /etc/convox-console/ssh/control_ed25519
   restorecon /etc/convox-console/ssh/control_ed25519
   ```

3. Generate a new shared **agent receipt secret** on archival, privately:

   ```bash
   ( umask 077; openssl rand -hex 32 > /root/convox-cluster-secret )
   ```

   This is not a MariaDB password. Both server agents need the **same** secret
   to authenticate evidence from the other host. Its loss requires controlled
   rotation on both agents; do not rotate during an operation.

4. Transfer the files separately to production and DR, using pinned keys:

   ```bash
   scp -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/convox-console/ssh/known_hosts /etc/convox-console/ssh/control_ed25519.pub /root/convox-cluster-secret /root/convox-console-control-0.3.0/deploy/convox-console-control.py /root/convox-console-control-0.3.0/deploy/convox-console-runtime.service /root/convox-console-control-0.3.0/deploy/install-control-rhel.sh root@10.81.0.11:/root/
   scp -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/convox-console/ssh/known_hosts /etc/convox-console/ssh/control_ed25519.pub /root/convox-cluster-secret /root/convox-console-control-0.3.0/deploy/convox-console-control.py /root/convox-console-control-0.3.0/deploy/convox-console-runtime.service /root/convox-console-control-0.3.0/deploy/install-control-rhel.sh root@10.3.0.150:/root/
   ```

5. Through trusted root sessions, install the corresponding agent:

   **Production:**

   ```bash
   chmod 0600 /root/convox-cluster-secret
   bash /root/install-control-rhel.sh production /root/control_ed25519.pub /root/convox-cluster-secret
   ```

   **DR:**

   ```bash
   chmod 0600 /root/convox-cluster-secret
   bash /root/install-control-rhel.sh dr /root/control_ed25519.pub /root/convox-cluster-secret
   ```

   The installer refuses existing accounts/configuration instead of overwriting
   them. It creates a fixed sudo entrypoint, constrained SSH account, root-owned
   agent configuration and a **new initially masked** runtime unit. It does not
   change existing MariaDB roles, replication or ConVox services.

6. On **both** servers, review `/etc/convox-console-agent/control.json` locally.
   Do not paste this file: it contains the shared secret. Set
   `adminReviewedStartup` to `true` only after confirming all of the following:

   - Both local IP-mapping tables identify that host, and the standby excludes
     all four local tables in both live replication and persistent configuration.
   - Root cron, rc.local, login scripts and auxiliary services cannot independently
     restart ConVox when the console masks cron and the application units.
   - The approved startup set is **PHP-FPM + Nginx + one safe_asterisk wrapper +
     `/var/www/convox_perl/convox_screen.pl` every minute**.
     The installed `/usr/sbin/safe_asterisk` must support `ASTSAFE_FOREGROUND`;
     the runtime sets it to `1` so systemd supervises the actual wrapper. An
     unsupported vendor wrapper blocks preflight; do not replace it blindly.
   - No extra FastAGI, WebSocket, dongle, Ubuntu-only MIS or other startup script
     is required for the features being tested. These components are not
     started/copied by this release; if needed, keep the flag false and extend
     the reviewed agent first. Presence of their directories proves nothing.
   - The vendor launcher and its enabled service files exist, are executable,
     and their code/dependencies have been reviewed. World-writable application
     code is a security concern; correct ownership/ACLs before production use.
   - The existing file-copy key on the active source can reach the standby as
     `convoxsync`, with host keys pinned in `/root/.ssh/known_hosts` and required
     destination ACLs. Final copies do not change ownership/permissions or delete.
   - MariaDB's local socket is `/var/lib/mysql/mysql.sock`; root can run mysql and
     mariadb-dump noninteractively. Credentials, if needed, remain in private
     server-local client defaults, never in agent arguments or the browser.
   - MariaDB option directories are readable by mysql. The agent manages only
     `99-convox-role.cnf`, mode 0640 root:mysql, and checks its effective role via
     `my_print_defaults --mysqld` as mysql. CLI/environment overrides must be
     reviewed independently; no startup option may override the intended role.
   - Test trunk, NAT, media firewall and client routing support the standby IP.
     Team members have agreed to pause new calls before running preflight.

   The flag is a deployment gate, not proof of external fencing or routing.

7. Verify control SSH on archival. These requests are read-only:

   ```bash
   printf '%s' '{"version":1,"host":"production","operation":"status"}' | sudo -u convoxconsole ssh -T -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/convox-console/ssh/known_hosts -o IdentitiesOnly=yes -o IdentityAgent=none -i /etc/convox-console/ssh/control_ed25519 convoxcontrol@10.81.0.11 convox-control-v1
   printf '%s' '{"version":1,"host":"dr","operation":"status"}' | sudo -u convoxconsole ssh -T -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/convox-console/ssh/known_hosts -o IdentitiesOnly=yes -o IdentityAgent=none -i /etc/convox-console/ssh/control_ed25519 convoxcontrol@10.3.0.150 convox-control-v1
   ```

   Both should return `ok:true`, correct server IDs and actual states. An error
   means stop and inspect authentication, sudo/SELinux policy or agent configuration.

8. On archival bind live controls to the authenticated Nginx proxy. This installs
   a private proxy credential; it does not change console mode:

   ```bash
   bash /root/convox-console-control-0.3.0/deploy/configure-control-proxy-rhel.sh
   ```

   Control-mode requests require both the operator identity provided by Nginx and
   this credential. A direct localhost session token cannot bypass operator login.
   The credential is never in public assets; do not print Nginx's full configuration
   or paste the generated include file. Use `/healthz` for credential-free minimal
   process health checks only (it returns no roles or session token).

9. On archival install the control configuration:

   ```bash
   install -o root -g convoxconsole -m 0640 /root/convox-console-control-0.3.0/deploy/control.example.json /etc/convox-console/control.json
   ```

   Back up `/etc/convox-console/console.env` outside its include directory, then
   change only these fields (keep existing port/origin and other settings):

   ```ini
   CONVOX_MODE=control
   CONVOX_CONFIG_FILE=/etc/convox-console/control.json
   CONVOX_DATA_DIR=/var/lib/convox-dr-console/control
   CONVOX_PROXY_SECRET_FILE=/etc/convox-console/proxy-secret
   ```

   ```bash
   systemctl restart convox-dr-console
   systemctl --no-pager --full status convox-dr-console
   ```

   No role changes occur simply by selecting control mode. Existing observe-mode
   state remains separate. Nginx stays on archival port 443. Preflight can take
   longer than the proxy timeout; if the browser request times out, wait for the
   controller then refresh rather than starting a cutover blindly.

## From then on: use the UI

1. Open `https://10.3.0.151`, sign in and refresh. Verify **Live control · planned
   switchover**, not Simulation and not Live monitoring · read-only.
2. Pause new test traffic and finish active calls. Click **Run preflight checks**.
   A failed prerequisite explains why promotion remains blocked. Checks expire
   after five minutes and are repeated inside the job.
3. Click **Bring DR online** and type `PROMOTE DR`. The dialog explicitly warns
   about write-locking backups and the planned service interruption.
4. Watch the job: reservations → preflight → private rollback backups → source
   writer shutdown → exact GTID → checksum files → old DB fence → promotion →
   approved runtime startup. SSH/archival remain running. No shell commands or
   passwords can be entered in this dialog.
5. The job pauses at **Awaiting team validation**. Change the test web/SIP
   destinations, test inbound/outbound calls, queues/transfers and recording
   playback, and ensure production remains stopped. Click **Confirm routing and
   call tests** and type `I TESTED ROUTING AND CALLS` only if tests passed.
   This is recorded as operator attestation, not an automatic traffic probe.

The old primary's database, cron, legacy Asterisk, web services and Lsyncd stay
persistently masked. The target starts only PHP-FPM, Nginx and the native console
runtime. Cron maintenance, Apache, the legacy Asterisk service and Lsyncd stay
masked. The new runtime runs the vendor worker launcher itself instead of
unmasking every root cron job. It refuses duplicate Asterisk startup and requires
a persisted primary marker plus a writable local DB. Errors stop the job without
automatic rollback. Existing agent operations do not resume on controller restart.

The target has **no newly rebuilt standby** after this cutover. Do not simply
restart the old production DB/application. The UI's **Prepare production** button
is disabled until a separately implemented/tested rebuild workflow exists.

## Failure handling and limits

- Each server keeps a root-private operation reservation and exclusive agent
  lock. A second controller cannot overlap the same server operation. Signed
  receipts bind host pair, job, GTID and file boundary; fresh fence evidence must
  be under 30 seconds old. Synchronize clocks on both nodes.
- The source's global read-lock holder lasts at most ten minutes. If it disappears
  or expires, the final copy/fence refuses rather than inventing consistency.
  Files and backups have bounded timeouts; large data may require a reviewed
  timeout/performance change before this implementation is suitable.
- A transport/controller timeout is **not cancellation**. Remote work may still
  run. Read the UI error and inspect root-private `operation.json` and the service
  journal. Do not delete locks or press promotion again blindly.
- Reconciliation requires a sole writable database and a fenced peer application.
  Some partial failures leave both DBs read-only, intentionally requiring a trusted
  administrator to inspect the remote state and select a safe recovery path. This
  version does not promise command-free repair of every partial failure.
- The target's persistent primary role is checked from option files and running
  variables; a real restart/boot test and call tests are still necessary in UAT.
- The global read lock is a planned write pause, not downtime-free failover. Active
  calls block preflight. An abrupt production outage stays blocked without an
  independently implemented authoritative external fence.
- The four local tables and two environment files are backed up, not changed or
  restored by this operation. Incoming filters do not protect a manual DROP or
  restore; a future reseed must preserve/exclude all four tables separately.
- Only the original eight file roots are copied. No deletions, ownership changes,
  executable-bit repairs, disk snapshots, database restores, RESET MASTER, carrier
  commands, or arbitrary program execution are accepted from browser requests.
- Keep one controller instance per state directory. Use stronger centralized
  operator authentication/auditing and independent backups before production use.

## Local verification vs server validation

Node tests exercise mock control transport and UI/controller guards. Python tests
mock OS/DB/process actions and receipt validation. They do **not** establish that
the actual RHEL/SIP/ConVox environment works. Perform the one-time deployment,
read-only preflight and supervised UAT drill before enabling this for real service.
