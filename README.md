# ConVox recovery console

A local management UI and durable backend for the two-server ConVox recovery workflow:

1. Promote DR after verified fencing of production.
2. Rebuild returning production from the current DR data as a read-only replica.
3. Freeze DR, verify final database and file boundaries, cut over to production, and rebuild the DR standby.

The default application is a **simulation prototype**, not a deployed failover solution. It demonstrates all three workflows and persists simulated records, roles, jobs and audit events. It makes no SSH connections and modifies neither ConVox server in its default mode. Release 0.2 adds a separately provisioned **read-only SSH monitoring mode**; see [live status setup](deploy/LIVE_STATUS.md). Recovery execution remains an integration boundary: write-capable hooks are not included because the deployment's actual workers, safe_asterisk control, persistent fencing and carrier routing have not yet been verified.

## Run

Requires Node.js 22 or newer. No package installation or external dependencies are needed.

```powershell
cd C:\Users\DEEPIJA\Documents\ConVoxCCS\dr-console
npm start
```

Open `http://127.0.0.1:4180`. The backend binds only to loopback. Use another port by setting `PORT` before startup.

For access through Nginx on the independent archival management host at `https://10.3.0.151`, use [the RHEL deployment guide](deploy/RHEL_NGINX.md). It includes a systemd service, TLS/authenticated reverse proxy, and initial installer. The installer defaults to archival; `CONSOLE_HOST` can select another management IP or DNS name. Set `CONVOX_PUBLIC_ORIGIN` to the exact public origin; the backend continues rejecting other hosts and browser origins. Production stays `10.81.0.11` and DR stays `10.3.0.150`. The packaged default remains simulation mode.

```bash
npm test
```

## Try the complete drill

1. Click **Simulate production outage**.
2. Click **Bring DR online**, acknowledge potential missing transactions, and type `PROMOTE DR`.
3. Click **Save a test call**. The extra record is saved on DR in local persistent demo state.
4. Click **Production returns**. Its services remain stopped, database stays read-only, and it needs rebuilding.
5. Click **Prepare production**, then type `REBUILD PRODUCTION`. The simulated fresh seed and file catch-up preserve DR's newer records.
6. Click **Cut over to production**, then type `CUT OVER TO PRODUCTION`. Production becomes primary and DR becomes its read-only replica.
7. Restart the console or refresh the page: the roles and records remain in `data/simulation/state.json`.

Simulation does not prove the performance, licensing, network routing, or correctness of the actual ConVox installation. Simulation watermarks are integers, not MariaDB GTIDs.

## Read-only live monitoring

Use `CONVOX_MODE=observe` only after following [LIVE_STATUS.md](deploy/LIVE_STATUS.md). It uses a dedicated restricted SSH key, pinned host keys and a fixed unprivileged telemetry agent. Recovery endpoints reject operations in this mode before starting a job or contacting any mutation hook. Database status/identity failures remain unknown, and two writable databases generate a warning instead of fabricated healthy topology. File synchronization direction and completeness are never inferred from Lsyncd or replica lag. No application row values, SQL error text, passwords or private keys are returned to the UI.

Use [upgrade-rhel.sh](deploy/upgrade-rhel.sh) for an existing archival installation; the initial installer intentionally refuses existing files. Upgrading code does not automatically switch modes or provision SSH access.

## Backend safety boundaries

- State lives on the management host, separate from either ConVox application database.
- One mutation job runs at a time. A failed or interrupted job blocks further recovery operations until an operator inspects and reconciles the actual state.
- Jobs never resume automatically after a controller restart. Remote commands can outlive the local process; their result must be checked.
- Unreachable production is never treated as verified fencing. A live fencing hook must stop application, database, scheduled job, telephony, and file-sync writers, or obtain an authoritative external fence from the hypervisor/network control plane.
- Cutover requires a reachable production replica, read-only mode, healthy replication, zero lag, and a final boundary check after freezing DR. A cached zero-lag value is not a final consistency proof.
- Database and file sync must have exactly one source. Stop the old Lsyncd direction before activating the new source.
- Preserve each destination's `convoxcces_global.convoxccs_license_details`, `/var/www/convox4.conf`, and `/var/www/convoxwebpanel.conf`.
- Do not run `RESET MASTER` on the authoritative source or skip duplicate transactions to make a rebuild appear healthy.
- The RHEL installation has mixed MyISAM and InnoDB tables. A consistent locking seed may pause writes on the active server. Do not use `--single-transaction` alone and promise a consistent MyISAM backup.
- Asynchronous replication cannot guarantee zero lost transactions or complete in-flight recordings after an abrupt outage.

## Live integration contract

Deploy the controller on a third management host. Provision a root-owned executable that implements the contract below using restricted SSH or a server agent. Hooks must not trust cached frontend state. Do not place private keys or DB passwords in the frontend, repository, audit responses, or job output.

Copy `config.example.json` to `config.local.json` and configure the executable and fixed argument array. Set `CONVOX_MODE=live`. The application refuses startup without the configuration. It uses separate `data/live` storage. It requires a fresh status observation before allowing a job, and refreshes real observations before and after each step.

The executable is spawned without a shell. One JSON request is sent to its stdin; it must return one JSON response on stdout and a zero exit code. Keep operational logs private on the management host. A nonzero exit, invalid JSON, missing proofs, or invalid status stops the workflow. It must return promptly on `status`; execution steps have the configured timeout. Timeout is not evidence that remote work stopped.

Status request:

```json
{ "version": 1, "command": "status" }
```

Status response shape (values below are illustrative):

```json
{
  "ok": true,
  "observation": {
    "active": "production",
    "fileSource": "production",
    "servers": {
      "production": {
        "ip": "10.81.0.11", "reachable": true, "role": "primary",
        "readOnly": false, "fenced": false, "services": "running",
        "io": null, "sql": null, "lag": null, "gtid": "0-8111-577"
      },
      "dr": {
        "ip": "10.3.0.150", "reachable": true, "role": "replica",
        "readOnly": true, "fenced": false, "services": "stopped",
        "io": true, "sql": true, "lag": 0, "gtid": "0-8111-577"
      }
    }
  }
}
```

Report unreachable hosts with `reachable:false`; do not invent current database state. Report `lastIoError` and `lastSqlError` when present. Report authoritative role and sync source from persisted configuration plus actual observations, not from a failed ping. Detect any unfenced old primary, including after reboot.

An execute request includes:

```json
{
  "version": 1, "command": "execute", "action": "rejoin", "step": "seed",
  "host": "production", "authoritative": "dr", "jobId": "unique-job-id",
  "preserveLicenseTable": "convoxcces_global.convoxccs_license_details",
  "preserveFiles": ["/var/www/convox4.conf", "/var/www/convoxwebpanel.conf"],
  "filePaths": ["/var/www/html/calls/"],
  "outageAccepted": false
}
```

The actual filePaths also include ConVoxCCS, AGI, Perl, sounds, MOH, `/var/www/asterisk`, and `/etc/asterisk`. Ignore any attempt to select an unexpected host, database, path, or command. Use root-owned allowlists. Idempotency keys are `(jobId, action, step)`; keep durable remote step results and a distributed operation lock. Never run overlapping seeds or promotions from two management controllers.

Successful ordinary step: `{"ok":true}`. Fencing requires `{"ok":true,"fenced":true,"persistent":true}`. Promotion requires `{"ok":true,"persistent":true}`. `drain`, `catchup`, and `standby` additionally require `"databaseAndFilesCaughtUp":true`. Return these proofs only after verifying the following requirements:

| Action / step | Required server-side behavior |
| --- | --- |
| failover / fence | Persistently stop production writers and Lsyncd. If unreachable, prove an external power or network fence that survives reboot. Keep management SSH where possible. Runtime masks alone do not survive reboot. |
| failover / drain | Stop replica IO, apply all received relay events, fail on SQL errors, and record the promotion GTID. For a planned switch, verify the final source GTID and file boundary. For an outage, explicitly record the unprovable source boundary and potential recording loss; the acknowledgement must be present. |
| failover / promote | Remove the old replica connection, make DR writable, persist the primary role in MariaDB configuration, and prevent automatic reconnection to the old primary. Keep its unique server ID and binary logs. |
| failover / activate | Start only the actual verified ConVox services/cron workers installed on this RHEL deployment; verify required units and application health. |
| failover / route | Switch and verify web endpoint, SIP phones, trunk/carrier routing and NAT. A successful service start does not prove inbound calls work. |
| failover / verify | Observe DR as sole writable primary, production fenced, application healthy, and traffic routed correctly. |
| rejoin / fence | Persist returning production as read-only with application/cron/SIP/file-sync writers stopped, even across reboot. DR stays authoritative. |
| rejoin / preserve | Back up destination databases before replacing them, export its licence table, preserve local configs and capture checksums. |
| rejoin / seed | Produce a fresh consistent DR seed with exact replication coordinates. Exclude the licence table. Verify transfer/checksum; replace only the eight allowlisted application databases on fenced production; restore with session binlogging disabled and restore its licence. Keep destination fenced after any failure. |
| rejoin / files | Copy from DR to production, exclude local config files, verify closed recordings and scripts, preserve executable permissions/ownership correctly, and set SELinux labels. Do not use `--size-only` for application code: same-size edits must transfer. No deletion without a separately approved policy. |
| rejoin / replicate | Use the fresh seed coordinates, `MASTER_USE_GTID=slave_pos`, a restricted DR replication account and licence-table exclusion. Keep production read-only and its writers stopped. Do not reuse the original `0-8111-577` seed position. |
| rejoin / catchup | Verify healthy threads, exact source GTID application and file catch-up, then maintain DR → production file sync. This check does not freeze DR; final cutover repeats it after fencing DR writers. |
| failback / fence | Persistently freeze DR application writers and its file-sync sender while keeping MariaDB available to stream its final events. Record final GTID and recording boundary. |
| failback / catchup | Verify production has applied the recorded final DR GTID with SQL error-free and checksum-verified final file catch-up. Lag=0 alone is insufficient. |
| failback / promote | Promote production, persist its writable primary role, and maintain DR fencing. |
| failback / activate | Start the verified production services and confirm health. |
| failback / route | Switch and verify client/carrier routing to production. |
| failback / standby | Preserve DR environment data, safely reseed/rejoin it as production's read-only replica, and verify database and files. Never revive the stale old connection automatically. |
| failback / verify | Confirm production is authoritative, DR is read-only, licences intact, correct routes, and production → DR file sync operating. |

The live adapter verifies some essential postconditions, but **the hook must implement every requirement in this table**. A JSON success flag alone is not a real fence or consistency check. Until independently tested hooks exist, keep simulation mode.

## Deployment limitations

This preview uses a loopback session token and origin/Host checks, not multiuser authentication. Anyone able to access the local management endpoint is an operator. For shared or remote production deployment, add operator identity/authorization, MFA, HTTPS, secure secret storage, durable external fencing evidence, central auditing, controller availability, backups, and routing integrations. Restrict state-directory permissions on Windows with NTFS ACLs; POSIX mode bits do not establish Windows access controls.

Only one controller process may use a data directory. JSON state uses atomic replacement but is not a replicated operation database. Use a transactional database plus distributed locking before running multiple controllers. Audit history retains 500 events and 50 jobs locally; export to an append-only audit store before production use.
