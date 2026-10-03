#!/usr/bin/python3
"""Fixed read-only telemetry agent. Run as convoxstatus, never root; no arguments."""
import datetime
import json
import os
import re
import subprocess
import sys

MYSQL = ["/usr/bin/mysql", "--no-defaults", "--protocol=SOCKET", "--socket=/var/lib/mysql/mysql.sock", "--user=convoxstatus", "--batch"]
ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
DISCOVERY = re.compile(r"(?:convox|asterisk|celery|redis|voip|^php-fpm|^httpd|^nginx|^crond|^lsyncd)", re.I)
UNIT = re.compile(r"^[A-Za-z0-9_.@:-]+\.service$")

def run(args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=4, env=ENV, check=False)
    if result.returncode != 0:
        raise RuntimeError("Read-only probe failed")
    if len(result.stdout) > 262144:
        raise RuntimeError("Probe output too large")
    return result.stdout

def rows(text):
    lines = text.splitlines()
    if not lines:
        return []
    keys = lines[0].split("\t")
    parsed = []
    for line in lines[1:]:
        values = line.split("\t")
        if len(values) != len(keys):
            raise ValueError("Invalid database result")
        parsed.append(dict(zip(keys, values)))
    return parsed

def database():
    sql = "SELECT @@hostname AS hostname, @@server_id AS serverId, @@read_only AS readOnly, @@log_bin AS logBin, @@log_slave_updates AS logSlaveUpdates, @@gtid_slave_pos AS gtidSlave, @@gtid_binlog_pos AS gtidBinlog, @@gtid_current_pos AS gtidCurrent, @@event_scheduler AS eventScheduler"
    result = rows(run(MYSQL + ["-e", sql]))
    if len(result) != 1:
        raise ValueError("Missing database identity")
    db = result[0]
    db["serverId"] = int(db["serverId"])
    for key in ("readOnly", "logBin", "logSlaveUpdates"):
        if db[key] not in ("0", "1"):
            raise ValueError("Invalid database boolean")
        db[key] = db[key] == "1"
    return db

def replicas():
    result = []
    for row in rows(run(MYSQL + ["-e", "SHOW ALL SLAVES STATUS"])):
        lag = row.get("Seconds_Behind_Master", "NULL")
        result.append({"io": row.get("Slave_IO_Running") == "Yes", "sql": row.get("Slave_SQL_Running") == "Yes",
                       "lag": None if lag == "NULL" else int(lag), "source": row.get("Master_Host", ""),
                       "ioError": bool(row.get("Last_IO_Error", "")), "sqlError": bool(row.get("Last_SQL_Error", ""))})
    return result

def services():
    names = {"mariadb.service", "lsyncd.service", "crond.service"}
    try:
        for line in run(["/usr/bin/systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager"]).splitlines():
            name = line.split()[0] if line.split() else ""
            if UNIT.fullmatch(name) and DISCOVERY.search(name):
                names.add(name)
    except Exception:
        pass
    if len(names) > 100:
        raise RuntimeError("Too many service units")
    result = []
    # systemctl show may return nonzero for missing units but still provides their properties.
    probe = subprocess.run(["/usr/bin/systemctl", "show", "--no-pager", "-p", "Id", "-p", "LoadState", "-p", "ActiveState", "-p", "UnitFileState"] + sorted(names), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=4, env=ENV, check=False)
    if len(probe.stdout) > 262144:
        raise RuntimeError("Service output too large")
    for block in probe.stdout.strip().split("\n\n"):
        props = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        if props.get("Id") in names:
            result.append({"name": props["Id"], "load": props.get("LoadState", "error"), "active": props.get("ActiveState", "unknown"), "masked": props.get("UnitFileState", "").startswith("masked")})
    return result

def collect():
    result = {"version": 1, "ok": True, "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "db": None, "replicas": [], "replicationError": False, "units": []}
    try:
        result["db"] = database()
    except Exception:
        pass
    if result["db"]:
        try:
            result["replicas"] = replicas()
        except Exception:
            result["replicationError"] = True
    try:
        result["units"] = services()
    except Exception:
        pass
    try:
        counts = {}
        for key, name in (("asterisk", "asterisk"), ("safeAsterisk", "safe_asterisk")):
            probe = subprocess.run(["/usr/bin/pgrep", "-c", "-x", name], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=2, env=ENV, check=False)
            if probe.returncode not in (0, 1):
                raise RuntimeError("Process probe unavailable")
            counts[key] = int(probe.stdout.strip())
        result["processes"] = counts
    except Exception:
        pass
    return result

if __name__ == "__main__":
    if len(sys.argv) != 1 or os.environ.get("SSH_ORIGINAL_COMMAND") != "convox-status-v1" or os.geteuid() == 0:
        print(json.dumps({"version": 1, "ok": False, "message": "Only the restricted observer status request is allowed"}))
        sys.exit(1)
    print(json.dumps(collect()))
