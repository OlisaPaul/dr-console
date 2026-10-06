# Prepare production and cut over to production — 0.4 UAT

This release adds two deliberately separate UI operations:

1. **Prepare production** replaces only the eight allowlisted ConVox databases
   on fenced production from a fresh, consistent DR seed. It restores
   production's licence, notifications, server mapping and web-server mapping,
   configures DR → production GTID replication, baseline-copies the eight file
   roots, and leaves production read-only with all application services masked.
2. **Cut over to production** is the existing planned switchover in reverse. It
   freezes DR writers, captures the final GTID, waits for production, performs
   a final checksum copy, fences DR, promotes production, and pauses for manual
   routing and call validation.

The prepare operation is destructive to the eight production application
databases. It first makes root-private rollback backups on both servers. It
does not overwrite `/var/www/convox4.conf` or
`/var/www/convoxwebpanel.conf`, and it never starts production's web, worker or
Asterisk runtime.

## Hard prerequisites

- DR `10.3.0.150` is the sole writable, runtime-healthy primary.
- Production `10.81.0.11` has both MariaDB and the application persistently
  fenced, as observed by the console.
- The previous failover job has been completed with routing/call attestation;
  neither server has an outstanding agent reservation.
- Both servers have the same root-owned mode-0600
  `/root/convox-repl-password`. It must be 16–128 characters and contain only
  letters, digits and `_.@%+=:-`. Do not print or paste it.
- The root file-copy key on **each** server can reach the opposite server's
  `convoxsync` account with its host key pinned in `/root/.ssh/known_hosts`.
- Both servers have genuine synchronized chrony/NTP. The earlier job-bound
  manual-clock exception is intentionally not accepted for a new reseed or
  cutover. Fix NTP before using the UI.
- At least 2 GiB is free on `/var/lib/mysql`. Independent backups still remain
  required.

## Install 0.4

On Windows, upload the new package to archival:

```powershell
scp "C:\Users\DEEPIJA\Documents\ConVoxCCS\dr-console\artifacts\convox-dr-console-control-0.4.0.zip" root@10.3.0.151:/root/
```

On archival:

```bash
install -d -m 0700 /root/convox-console-control-0.4.0
unzip /root/convox-dr-console-control-0.4.0.zip -d /root/convox-console-control-0.4.0

scp -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/etc/convox-console/ssh/known_hosts \
  /root/convox-console-control-0.4.0/deploy/convox-console-control.py \
  /root/convox-console-control-0.4.0/deploy/install-rejoin-rhel.sh \
  root@10.81.0.11:/root/

scp -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/etc/convox-console/ssh/known_hosts \
  /root/convox-console-control-0.4.0/deploy/convox-console-control.py \
  /root/convox-console-control-0.4.0/deploy/install-rejoin-rhel.sh \
  root@10.3.0.150:/root/
```

Run through a trusted root session on production:

```bash
bash /root/install-rejoin-rhel.sh production
```

Run through a trusted root session on DR:

```bash
bash /root/install-rejoin-rhel.sh dr
```

The installer backs up the previous agent, provisions only the fixed transfer
directory and replica option file, and replaces the restricted agent. It does
not start/stop a service, change `read_only`, configure replication, or run a
reseed. It refuses an active console reservation. Install both agents before
upgrading the archival controller so an older agent is never asked to execute a
new operation.

Finally, upgrade/restart only the archival console:

```bash
bash /root/convox-console-control-0.4.0/deploy/upgrade-rhel.sh
systemctl --no-pager --full status convox-dr-console
```

## Use the UI

1. Open `https://10.3.0.151`, sign in, and click **Refresh status**. Confirm DR
   is the only writer and production says database/application fenced.
2. Click **Prepare production**, type `REBUILD PRODUCTION`, and watch every step.
   Do not manually start production or edit its databases while it runs.
3. A successful job ends with DR still active and production shown as a healthy
   read-only replica with application fenced and zero lag.
4. Pause/drain test calls. Click **Run cutover preflight**. It expires after five
   minutes.
5. Click **Cut over to production**, type `CUT OVER TO PRODUCTION`, and watch the
   final boundary, checksum, fence, promotion and runtime steps.
6. Manually route test web/SIP traffic to production. Test inbound/outbound
   calls, queue/transfer behavior and recording playback. Only then attest with
   `I TESTED ROUTING AND CALLS`.

After failback, DR is fenced. This release does **not** automatically rebuild DR
as the new production standby; keep it fenced until a separately reviewed
Prepare DR workflow is implemented.

## Failure rule

Any failure stops the job and sets reconciliation required. Do not delete
`operation.json`, manually promote a server, start the fenced application, or
click a second operation. Inspect `/var/lib/convox-console-agent/agent.log` and
the UI step on both servers. A transport timeout does not prove the remote
operation stopped.
