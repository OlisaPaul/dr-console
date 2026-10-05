#!/usr/bin/python3
"""Root-owned, fixed-operation ConVox agent. Never accepts shell/SQL/path input.

SSH ingress is a separate unprivileged account with a fixed sudo command.
Signed source receipts bind the final GTID, file boundary and fence to one job.
No reseeding, password transport, routing changes or outage promotion is offered.
"""
import datetime
import fcntl
import hashlib
import hmac
import json
import os
import pathlib
import re
import signal
import stat
import subprocess
import sys
import time

CONFIG = pathlib.Path('/etc/convox-console-agent/control.json')
ROOT = pathlib.Path('/var/lib/convox-console-agent')
IPS = {'production': '10.81.0.11', 'dr': '10.3.0.150'}
IDS = {'production': 8111, 'dr': 30150}
TABLES = ['convoxccs_license_details', 'convoxccs_notifications', 'convoxccs_servers', 'convoxccs_web_servers']
PATHS = ['/var/www/html/calls/', '/var/www/html/ConVoxCCS/', '/var/www/asterisk/', '/var/www/convox_agi/', '/var/www/convox_moh/', '/var/www/convox_perl/', '/var/www/convox_sounds/', '/etc/asterisk/']
UNITS = ['crond.service', 'lsyncd.service', 'nginx.service', 'httpd.service', 'php-fpm.service', 'asterisk.service', 'convox-console-runtime.service']
MYSQL = ['/usr/bin/mysql', '--protocol=SOCKET', '--socket=/var/lib/mysql/mysql.sock', '--batch']
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'HOME': '/root'}
GTID = re.compile(r'^\d+-\d+-\d+(?:,\d+-\d+-\d+)*$')
JOB = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
DISCOVERY = re.compile(r'convox|asterisk|celery|redis|voip|php-fpm|httpd|nginx|crond|lsyncd', re.I)


class Refusal(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def command(args, timeout=30, input_text=None):
    # No shell, request-supplied arguments, SQL strings or executable paths.
    try:
        p = subprocess.run(args, input=input_text, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True, timeout=timeout, env=ENV, check=False)
    except subprocess.TimeoutExpired:
        private_log({'event': 'command-timeout', 'executable': args[0]})
        raise Refusal('Server-side command timed out; inspect private agent state before retrying')
    if p.returncode != 0:
        private_log({'event': 'command-failed', 'executable': args[0], 'code': p.returncode, 'stderr': p.stderr[-4096:]})
        raise Refusal('Server-side command failed; inspect /var/lib/convox-console-agent/agent.log privately')
    require(len(p.stdout) < 1048576, 'Server-side output limit exceeded')
    return p.stdout


def private_log(value):
    # stderr can contain sensitive SQL details; never send it to the browser.
    with open(ROOT / 'agent.log', 'a', encoding='utf-8') as stream:
        os.chmod(ROOT / 'agent.log', 0o600)
        stream.write(json.dumps({'at': time.time(), **value}) + '\n')


def sql(statement, timeout=15):
    return command(MYSQL + ['-e', statement], timeout=timeout)


def rows(value):
    lines = value.splitlines()
    if not lines:
        return []
    names = lines[0].split('\t')
    result = []
    for line in lines[1:]:
        values = line.split('\t')
        require(len(values) == len(names), 'Malformed database telemetry')
        result.append(dict(zip(names, values)))
    return result


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    with open(temp, 'w', encoding='utf-8') as stream:
        os.chmod(temp, 0o600)
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def load_config():
    s = CONFIG.stat()
    require(s.st_uid == 0 and stat.S_IMODE(s.st_mode) & 0o077 == 0, 'Agent config must be root-owned and private')
    cfg = json.loads(CONFIG.read_text())
    require(cfg.get('host') in IPS, 'Invalid agent host')
    require(isinstance(cfg.get('adminReviewedStartup'), bool), 'Missing startup review flag')
    require(re.fullmatch(r'[a-f0-9]{64}', cfg.get('clusterSecret', '')) is not None, 'Missing shared agent receipt secret')
    require(cfg.get('startupUnits') == ['php-fpm.service', 'nginx.service'], 'First release permits only PHP-FPM and Nginx startup')
    require(cfg.get('workerLauncher') == '/var/www/convox_perl/convox_screen.pl', 'Unapproved worker launcher')
    require(cfg.get('fileIdentity') == '/root/.ssh/convox-file-sync', 'Unapproved file sync identity')
    require(cfg.get('fileKnownHosts') == '/root/.ssh/known_hosts', 'Unapproved file sync host-key store')
    return cfg


def db():
    value = rows(sql('SELECT @@hostname AS hostname, @@server_id AS serverId, @@read_only AS readOnly, @@log_bin AS logBin, @@log_slave_updates AS logSlaveUpdates, @@gtid_slave_pos AS gtidSlave, @@gtid_binlog_pos AS gtidBinlog, @@gtid_current_pos AS gtidCurrent, @@event_scheduler AS eventScheduler'))[0]
    value['serverId'] = int(value['serverId'])
    for field in ['readOnly', 'logBin', 'logSlaveUpdates']:
        value[field] = value[field] == '1'
    return value


def unit(name):
    p = subprocess.run(['/usr/bin/systemctl', 'show', name, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState'],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5, env=ENV)
    props = dict(line.split('=', 1) for line in p.stdout.splitlines() if '=' in line)
    require('LoadState' in props and 'ActiveState' in props, 'Service state unavailable')
    return {'name': name, 'load': props['LoadState'], 'active': props['ActiveState'],
            'masked': props.get('UnitFileState', '').startswith('masked')}


def processes():
    result = []
    for line in command(['/usr/bin/ps', '-eo', 'pid=,ppid=,stat=,comm=']).splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            pid = int(parts[0])
            vendor_process = False
            try:
                args = pathlib.Path('/proc/' + str(pid) + '/cmdline').read_bytes()
                vendor_process = any(p in args for p in [b'/var/www/convox_', b'/var/www/html/ConVoxCCS/', b'/var/www/html/WebSocket/'])
            except FileNotFoundError:
                continue
            result.append({'pid': pid, 'parent': int(parts[1]), 'state': parts[2], 'name': parts[3], 'vendor': vendor_process})
    return result


def writers():
    return [p for p in processes() if not p['state'].startswith('Z') and
            (p['name'].startswith('convox') or p.get('vendor') or p['name'] in ['asterisk', 'safe_asterisk', 'nginx', 'httpd', 'php-fpm'])]


def application_fenced():
    # Persistent /etc masks (not /run masks) plus actual absent processes.
    return not writers() and all(os.path.islink('/etc/systemd/system/' + n) and
        os.readlink('/etc/systemd/system/' + n) == '/dev/null' and
        unit(n)['active'] in ['inactive', 'failed'] for n in UNITS)


def database_fenced():
    return (application_fenced() and os.path.islink('/etc/systemd/system/mariadb.service') and
            os.readlink('/etc/systemd/system/mariadb.service') == '/dev/null' and
            unit('mariadb.service')['active'] in ['inactive', 'failed'] and
            not any(p['name'] in ['mariadbd', 'mysqld'] and not p['state'].startswith('Z') for p in processes()))


def snapshot(cfg):
    data = {'version': 1, 'ok': True, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'db': None, 'replicas': [], 'replicationError': False, 'units': []}
    try:
        data['db'] = db()
        require(data['db']['serverId'] == IDS[cfg['host']], 'Wrong database identity')
    except Refusal:
        if unit('mariadb.service')['active'] == 'active':
            raise
    if data['db']:
        try:
            data['replicas'] = [{'io': r['Slave_IO_Running'] == 'Yes', 'sql': r['Slave_SQL_Running'] == 'Yes',
                'lag': None if r['Seconds_Behind_Master'] == 'NULL' else int(r['Seconds_Behind_Master']),
                'source': r['Master_Host'], 'ioError': bool(r['Last_IO_Error']), 'sqlError': bool(r['Last_SQL_Error'])}
                for r in rows(sql('SHOW ALL SLAVES STATUS'))]
        except Exception:
            data['replicationError'] = True
    data['units'] = [unit(n) for n in UNITS + ['mariadb.service']]
    live = writers()
    data['processes'] = {'asterisk': sum(p['name'] == 'asterisk' for p in live), 'safeAsterisk': sum(p['name'] == 'safe_asterisk' for p in live)}
    runtime = (data['db'] is not None and not data['db']['readOnly'] and
        data['processes'] == {'asterisk': 1, 'safeAsterisk': 1} and
        any(p['name'].startswith('convox') for p in live) and
        all(unit(n)['active'] == 'active' for n in cfg['startupUnits'] + ['convox-console-runtime.service']))
    return {'ok': True, 'status': data, 'control': {'applicationFenced': application_fenced(), 'databaseFenced': database_fenced(), 'runtimeHealthy': runtime}}


def valid_request(request, host):
    require(isinstance(request, dict) and request.get('version') == 1 and request.get('host') == host, 'Invalid request identity')
    op = request.get('operation')
    require(op in ['status', 'preflight', 'reserve', 'backup', 'quiesce', 'boundary', 'catchup', 'files', 'fence', 'promote', 'activate', 'release'], 'Unknown operation')
    if op not in ['status', 'preflight']:
        require(JOB.fullmatch(request.get('jobId', '')) is not None, 'Invalid operation ID')
    if op not in ['status', 'release']:
        require({request.get('source'), request.get('target')} == set(IPS), 'Invalid switchover pair')
    return op


def sign_receipt(cfg, request, kind, **fields):
    payload = {'host': cfg['host'], 'source': request['source'], 'target': request['target'],
               'jobId': request['jobId'], 'kind': kind, 'at': time.time(), **fields}
    signature = hmac.new(bytes.fromhex(cfg['clusterSecret']), json.dumps(payload, sort_keys=True, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
    return {'payload': payload, 'signature': signature}


def verify_receipt(cfg, request, receipt, kind):
    require(isinstance(receipt, dict) and isinstance(receipt.get('payload'), dict), 'Missing signed source evidence')
    payload = receipt['payload']
    expected = hmac.new(bytes.fromhex(cfg['clusterSecret']), json.dumps(payload, sort_keys=True, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
    require(isinstance(receipt.get('signature'), str) and hmac.compare_digest(expected, receipt['signature']), 'Source evidence signature rejected')
    require(payload.get('kind') == kind and payload.get('host') == request['source'] and
        all(payload.get(k) == request[k] for k in ['jobId', 'source', 'target']), 'Source evidence belongs to another operation')
    require(isinstance(payload.get('at'), (float, int)) and 0 <= time.time() - payload['at'] < (30 if kind == 'fence' else 600), 'Source evidence is stale; clocks must be synchronized')
    require(isinstance(payload.get('gtid'), str) and GTID.fullmatch(payload['gtid']) is not None, 'Invalid source GTID evidence')
    return payload


def services_from_config():
    text = pathlib.Path('/var/www/convox4.conf').read_text()
    sections, current, toggles = [], None, {}
    for line in text.splitlines():
        line = re.split(r'[#;]', line, 1)[0].strip()
        if line.startswith('[SERVICE_'):
            current = {}; sections.append(current)
        elif '=' in line:
            key, value = [p.strip() for p in line.split('=', 1)]
            if current is not None:
                current[key] = value
            if key in ['enable_whatsapp', 'enable_webchat']:
                toggles[key] = value
    selected = []
    for service in sections:
        if service.get('service_active') != 'Y' or service.get('service_add_to_screen') != 'Y':
            continue
        screen = service.get('service_screen', '')
        if ('whatsapp' in screen and toggles.get('enable_whatsapp') == 'N') or ('webchat' in screen and toggles.get('enable_webchat') == 'N'):
            continue
        file = pathlib.Path(service.get('service_path', '')) / service.get('service_name', '')
        require(str(file).startswith('/var/www/') and file.is_file() and os.access(file, os.X_OK), 'An enabled ConVox service file is missing or not executable; inspect local service definitions')
        selected.append(file)
    require(selected, 'No enabled Screen worker definitions found')
    return selected


def preflight(cfg, request):
    require(cfg.get('adminReviewedStartup') is True, 'Administrator must review boot launchers, auxiliary services and the startup set first')
    database = db()
    require(database['serverId'] == IDS[cfg['host']] and database['logBin'] and database['eventScheduler'] == 'OFF', 'Database identity, binlogging or event scheduler failed preflight')
    local_ips = command(['/usr/sbin/ip', '-4', '-o', 'address', 'show'])
    require(re.search(r'\binet ' + re.escape(IPS[cfg['host']]) + r'/', local_ips) is not None, 'Host IP does not match configured identity')
    if cfg['host'] == request['target']:
        filters = sql('SELECT @@replicate_wild_ignore_table').splitlines()[-1].split(',')
        require(all('convoxcces_global.' + t in filters for t in TABLES), 'All four server-local tables must be excluded from incoming replication')
        persisted = pathlib.Path('/etc/my.cnf.d/90-convox-replication.cnf').read_text()
        require(all(re.search(r'^\s*replicate_wild_ignore_table\s*=\s*convoxcces_global\.' + re.escape(t) + r'\s*$', persisted, re.M) for t in TABLES), 'Four local-table exclusions are not persistent')
    ip = IPS[cfg['host']]
    mapping = rows(sql("SELECT COUNT(*) AS count FROM convoxcces_global.convoxccs_servers WHERE server_ip='" + ip + "' AND telnet_host='" + ip + "'"))[0]
    web = rows(sql("SELECT COUNT(*) AS count FROM convoxcces_global.convoxccs_web_servers WHERE server_ip='" + ip + "' AND active=1"))[0]
    require(int(mapping['count']) > 0 and int(web['count']) > 0, 'Local ConVox database IP mappings do not identify this server')
    require(os.access(cfg['workerLauncher'], os.X_OK), 'Worker launcher is missing or not executable')
    wrapper_environment()
    for folder in PATHS:
        path = pathlib.Path(folder)
        require(path.is_dir() and path.resolve() == path, 'A file-sync root is missing or redirects through a symlink; inspect the allowlist')
    services_from_config()
    for name in cfg['startupUnits']:
        require(pathlib.Path('/usr/lib/systemd/system/' + name).is_file(), 'Approved startup unit is not installed')
    command(['/usr/sbin/nginx', '-t'])
    command(['/usr/sbin/php-fpm', '-t'])
    discovered = command(['/usr/bin/systemctl', 'list-units', '--type=service', '--state=active', '--no-legend', '--no-pager'])
    for line in discovered.splitlines():
        name = line.split()[0]
        require(not DISCOVERY.search(name) or name in UNITS, 'Unmanaged ConVox/telephony service is active; explicitly resolve it before cutover')
    if cfg['host'] == request['target']:
        require(database['readOnly'] and database['logSlaveUpdates'], 'Target must be read-only with log_slave_updates enabled')
        replica = rows(sql('SHOW ALL SLAVES STATUS'))
        require(len(replica) == 1 and replica[0]['Master_Host'] == IPS[request['source']] and
            replica[0]['Slave_IO_Running'] == replica[0]['Slave_SQL_Running'] == 'Yes' and
            not replica[0]['Last_IO_Error'] and not replica[0]['Last_SQL_Error'], 'Target is not a healthy replica of the expected source')
        require(application_fenced(), 'Target application must be absent and persistently masked')
    else:
        require(not database['readOnly'], 'Source is not writable')
        require(not rows(sql('SHOW ALL SLAVES STATUS')), 'Source still has an upstream replica connection; review topology first')
        require(len([p for p in writers() if p['name'] == 'asterisk']) <= 1, 'Multiple source Asterisk instances; cannot drain safely')
        if any(p['name'] == 'asterisk' for p in writers()):
            require(re.search(r'^0 active channels$', command(['/usr/sbin/asterisk', '-rx', 'core show channels count']), re.M), 'Drain all source calls before starting switchover')
        require(pathlib.Path(cfg['fileIdentity']).is_file(), 'Source file-copy key is missing')
        file_ssh(cfg, request['target'], 'true')
    return {'ok': True, 'ready': True, 'checks': [cfg['host'] + ': identity, four isolated tables, local IPs, service files, web syntax and writer state checked']}


def file_ssh_args(cfg):
    return ['/usr/bin/ssh', '-T', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=' + cfg['fileKnownHosts'], '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
            '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=5', '-i', cfg['fileIdentity']]


def file_ssh(cfg, target, remote_command):
    return command(file_ssh_args(cfg) + ['convoxsync@' + IPS[target], remote_command])


def persist_role(read_only):
    import grp
    parent = pathlib.Path('/etc/my.cnf.d')
    require(parent.is_dir() and parent.stat().st_mode & 0o005 == 0o005, 'MariaDB configuration directory is not readable/traversable by mysql; fix permissions first')
    file = parent / '99-convox-role.cnf'
    temporary = parent / '99-convox-role.cnf.console-tmp'
    # Only this known role file is managed; copy any original in the job backup first.
    temporary.write_text('[mysqld]\nread_only=' + ('ON' if read_only else 'OFF') + '\nevent_scheduler=OFF\n')
    os.chown(temporary, 0, grp.getgrnam('mysql').gr_gid)
    os.chmod(temporary, 0o640)
    with open(temporary, 'rb') as stream:
        os.fsync(stream.fileno())
    os.replace(temporary, file)
    command(['/usr/sbin/restorecon', str(file)])
    # Check the effective server option groups as mysql, not only the text we wrote.
    options = command(['/usr/sbin/runuser', '-u', 'mysql', '--', '/usr/bin/my_print_defaults', '--mysqld'])
    require(effective_read_only(options) is read_only, 'Persistent role is overridden or unreadable by mysql; inspect option files before continuing')
    sql('SET GLOBAL read_only=' + ('ON' if read_only else 'OFF') + '; SET GLOBAL event_scheduler=OFF;')


def effective_read_only(options):
    value = None
    for option in options.splitlines():
        if option.replace('_', '-') == '--skip-read-only':
            value = False
        match = re.fullmatch(r'--read[-_]only(?:=(ON|OFF|on|off|1|0|TRUE|FALSE|true|false))?', option)
        if match:
            value = match.group(1) not in ['OFF', 'off', '0', 'FALSE', 'false']
    return value


def backup(cfg, request, state):
    directory = ROOT / request['jobId']
    directory.mkdir(mode=0o700, exist_ok=True)
    state['backup'] = str(directory)
    # Consistent mixed-engine backup. UI warns that this can briefly pause DB writes.
    dump = ['/usr/bin/mariadb-dump', '--lock-all-tables', '--routines', '--events', '--triggers', '--hex-blob', '--quick']
    for name, args in [('all.sql', ['--all-databases']), ('local-tables.sql', ['convoxcces_global'] + TABLES)]:
        with open(directory / name, 'wb') as output:
            os.chmod(directory / name, 0o600)
            p = subprocess.run(dump + args, stdout=output, stderr=subprocess.DEVNULL, timeout=180, env=ENV)
        require(p.returncode == 0 and (directory / name).stat().st_size > 0, 'Rollback database backup failed')
    command(['/usr/bin/tar', '-czf', str(directory / 'environment.tar.gz'), '-C', '/var/www', 'convox4.conf', 'convoxwebpanel.conf'])
    if pathlib.Path('/etc/my.cnf.d/99-convox-role.cnf').exists():
        command(['/usr/bin/cp', '-p', '/etc/my.cnf.d/99-convox-role.cnf', str(directory / '99-convox-role.cnf.before')])
    hashes = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in directory.iterdir() if f.is_file()}
    atomic_json(directory / 'checksums.json', hashes)
    return {'ok': True, 'message': 'Private database, four-local-table and environment backups saved; no data was replaced'}


def mask_units(names):
    for name in names:
        command(['/usr/bin/systemctl', 'mask', name])
    command(['/usr/bin/systemctl', 'daemon-reload'])


def terminate_named(name):
    pids = [p['pid'] for p in writers() if p['name'] == name]
    for pid in pids:
        os.kill(pid, signal.SIGTERM)


def quiesce(cfg, request, state):
    require(cfg['host'] == request['source'] and state.get('backup') and state['steps'].get('backup') == 'complete', 'Completed source rollback backup is required')
    # Do not drop active calls: calls could have arrived since preflight.
    if any(p['name'] == 'asterisk' for p in writers()):
        require(re.search(r'^0 active channels$', command(['/usr/sbin/asterisk', '-rx', 'core show channels count']), re.M), 'Active source calls appeared; stop new traffic and drain calls')
    mask_units(UNITS)
    for name in UNITS:
        if name != 'asterisk.service' and unit(name)['active'] not in ['inactive', 'failed']:
            command(['/usr/bin/systemctl', 'stop', name])
    terminate_named('safe_asterisk')
    time.sleep(2)
    require(not any(p['name'] == 'safe_asterisk' for p in writers()), 'Asterisk wrapper did not stop')
    terminate_named('asterisk')
    # Close only Screen parents that own exclusively ConVox child processes.
    all_processes = processes()
    parents = {p['parent'] for p in all_processes if p['name'].startswith('convox') and not p['state'].startswith('Z')}
    for pid in parents:
        parent = next((p for p in all_processes if p['pid'] == pid), None)
        require(parent is not None and parent['name'] == 'screen', 'An unmanaged ConVox writer needs explicit stop handling')
        children = [p for p in all_processes if p['parent'] == pid and not p['state'].startswith('Z')]
        require(children and all(p['name'].startswith('convox') for p in children), 'Refusing to close a Screen session containing unrelated processes')
        sessions = re.findall(r'^\s*(' + str(pid) + r'\.[^\s]+)', command(['/usr/bin/screen', '-ls']), re.M)
        require(len(sessions) == 1, 'Cannot uniquely identify a ConVox Screen session')
        command(['/usr/bin/screen', '-S', sessions[0], '-X', 'quit'])
    (ROOT / 'primary').unlink(missing_ok=True)
    for _ in range(20):
        if application_fenced():
            break
        time.sleep(1)
    require(application_fenced(), 'Source application writers did not stop or respawned')
    persist_role(True)
    state['quiesced'] = True
    return {'ok': True, 'message': 'Source application persistently masked and absent; database remains available read-only; SSH unchanged'}


def lock_alive(state, request):
    pid = state.get('lockPid')
    if not isinstance(pid, int):
        return False
    try:
        return request['jobId'].encode() in pathlib.Path('/proc/' + str(pid) + '/cmdline').read_bytes()
    except OSError:
        return False


def boundary(cfg, request, state):
    require(cfg['host'] == request['source'] and state.get('quiesced') and application_fenced(), 'Source application is not fenced')
    database = db()
    require(database['readOnly'] and not rows(sql('SHOW ALL SLAVES STATUS')), 'Source database must be read-only with no upstream connection')
    # Keep an actual global read lock across SSH requests. If the holder dies or
    # its 10-minute window expires, files/fence refuse and promotion cannot occur.
    log = ROOT / request['jobId'] / 'read-lock.log'
    statement = 'FLUSH TABLES WITH READ LOCK; SELECT @@gtid_current_pos; DO SLEEP(600); /* ' + request['jobId'] + ' */'
    with open(log, 'wb') as output:
        p = subprocess.Popen(MYSQL + ['--unbuffered', '--skip-column-names', '-e', statement], stdin=subprocess.DEVNULL,
            stdout=output, stderr=subprocess.DEVNULL, env=ENV, start_new_session=True)
    state['lockPid'] = p.pid
    for _ in range(50):
        value = log.read_text().strip()
        if GTID.fullmatch(value):
            state['boundary'] = value
            require(lock_alive(state, request), 'Source read-lock holder exited')
            return {'ok': True, 'proof': sign_receipt(cfg, request, 'boundary', gtid=value)}
        require(p.poll() is None, 'Source global read lock failed')
        time.sleep(0.1)
    raise Refusal('Source global read lock timed out; inspect before retrying')


def catchup(cfg, request, state):
    require(cfg['host'] == request['target'] and application_fenced(), 'Target application must remain fenced')
    receipt = verify_receipt(cfg, request, request.get('boundary'), 'boundary')
    replica = rows(sql('SHOW ALL SLAVES STATUS'))
    require(len(replica) == 1 and replica[0]['Master_Host'] == IPS[request['source']] and
        replica[0]['Slave_SQL_Running'] == replica[0]['Slave_IO_Running'] == 'Yes' and not replica[0]['Last_SQL_Error'] and not replica[0]['Last_IO_Error'], 'Target replication is not healthy')
    answer = rows(sql("SELECT MASTER_GTID_WAIT('" + receipt['gtid'] + "', 120) AS reached", timeout=130))[0]['reached']
    require(answer != 'NULL' and int(answer) >= 0, 'Target did not reach the exact source GTID')
    state['caughtUp'] = receipt['gtid']
    return {'ok': True, 'message': 'Target applied the exact signed source GTID'}


def files(cfg, request, state):
    require(cfg['host'] == request['source'] and application_fenced() and lock_alive(state, request), 'Source writer/read-lock fence is not intact')
    # The remote user is the existing ACL-scoped file account, never root.
    # No --delete, --inplace, --size-only, chmod or ownership changes.
    import shlex
    transport = shlex.join(file_ssh_args(cfg))
    for folder in PATHS:
        destination = 'convoxsync@' + IPS[request['target']] + ':' + folder
        args = ['/usr/bin/rsync', '-rlc', '--no-owner', '--no-group', '--no-perms', '--omit-dir-times',
                '--partial-dir=.rsync-partial', '--delay-updates', '--exclude=.rsync-partial/', '-e', transport]
        command(args + [folder, destination], timeout=180)
        differences = command(args + ['--dry-run', '--itemize-changes', folder, destination], timeout=180)
        require(not differences.strip(), 'Final file checksums differ; target cannot be promoted')
        require(lock_alive(state, request), 'Source read lock expired during final file synchronization')
    state['filesVerified'] = state['boundary']
    return {'ok': True, 'proof': sign_receipt(cfg, request, 'files', gtid=state['boundary']),
            'message': 'Eight allowlisted folders copied and checksum-verified; environment files untouched'}


def fence(cfg, request, state):
    require(cfg['host'] == request['source'] and state.get('filesVerified') == state.get('boundary') and state.get('boundary'), 'Final GTID/file boundary is required')
    if not database_fenced():
        require(application_fenced() and lock_alive(state, request), 'Source fence/read lock was lost; refusing promotion evidence')
        require(db()['gtidCurrent'] == state['boundary'], 'Source GTID changed after the recorded boundary')
        mask_units(['mariadb.service', 'mysql.service'])
        command(['/usr/bin/systemctl', 'stop', 'mariadb.service'], timeout=60)
    require(database_fenced(), 'Source database is not persistently masked and stopped')
    state['fenced'] = True
    return {'ok': True, 'proof': sign_receipt(cfg, request, 'fence', gtid=state['boundary']), 'message': 'Source database and application fenced; SSH remains available'}


def promote(cfg, request, state):
    require(cfg['host'] == request['target'] and state.get('backup') and state['steps'].get('backup') == 'complete' and application_fenced(), 'Completed target backup/application fence is required')
    evidence = [verify_receipt(cfg, request, request.get(k), k) for k in ['boundary', 'files', 'fence']]
    require(all(p['gtid'] == state.get('caughtUp') for p in evidence), 'GTID, file and source fence evidence do not agree')
    require(db()['readOnly'], 'Target is already writable; reconcile rather than retry')
    sql('STOP SLAVE; RESET SLAVE ALL;')
    # Keep own server ID / binlogs. No RESET MASTER, DROP or restore is performed.
    persist_role(False)
    require(not db()['readOnly'] and not rows(sql('SHOW ALL SLAVES STATUS')), 'Target primary role did not take effect')
    (ROOT / 'primary').write_text(request['jobId'] + '\n')
    state['promoted'] = True
    return {'ok': True, 'message': 'Target role persisted writable; old replica connection removed; four local tables unchanged'}


def activate(cfg, request, state):
    require(cfg['host'] == request['target'] and state.get('promoted') and not db()['readOnly'], 'Verified target promotion is required')
    services_from_config()
    for folder in PATHS:
        command(['/usr/sbin/restorecon', '-R', folder], timeout=60)
    for name in cfg['startupUnits'] + ['convox-console-runtime.service']:
        command(['/usr/bin/systemctl', 'unmask', '--runtime', name])
        command(['/usr/bin/systemctl', 'unmask', name])
        command(['/usr/bin/systemctl', 'enable', '--now', name], timeout=60)
    # Keep cron, legacy asterisk unit, Apache and Lsyncd masked. One native runtime
    # owns safe_asterisk and runs the vendor worker launcher every minute.
    for _ in range(30):
        if snapshot(cfg)['control']['runtimeHealthy']:
            state['activated'] = True
            return {'ok': True, 'message': 'Approved runtime active with one Asterisk and one wrapper; team must validate calls'}
        time.sleep(1)
    raise Refusal('Runtime health check failed; source stays fenced, inspect target services')


def wrapper_environment():
    # Upstream safe_asterisk backgrounds its loop unless this flag is set.
    # An older/vendor wrapper must be reviewed rather than treated as supervised.
    wrapper = pathlib.Path('/usr/sbin/safe_asterisk')
    require(wrapper.is_file() and os.access(wrapper, os.X_OK) and
            'ASTSAFE_FOREGROUND' in wrapper.read_text(),
            'Installed safe_asterisk does not support reviewed foreground supervision')
    return {**ENV, 'ASTSAFE_FOREGROUND': '1'}


def runtime(cfg):
    require(cfg.get('adminReviewedStartup') is True, 'Startup set is not administrator-approved')
    require((ROOT / 'primary').is_file() and not db()['readOnly'], 'Runtime requires persisted writable primary marker')
    require(not any(p['name'] in ['asterisk', 'safe_asterisk'] for p in writers()), 'Refusing duplicate Asterisk startup')
    services_from_config()
    with open(ROOT / 'runtime.log', 'ab', buffering=0) as output:
        wrapper = subprocess.Popen(['/usr/sbin/safe_asterisk'], stdin=subprocess.DEVNULL, stdout=output, stderr=output, env=wrapper_environment())
        while True:
            require(wrapper.poll() is None and (ROOT / 'primary').is_file() and not db()['readOnly'], 'Primary runtime lost its wrapper or role')
            p = subprocess.run([cfg['workerLauncher']], stdin=subprocess.DEVNULL, stdout=output, stderr=output, env=ENV, timeout=30)
            require(p.returncode == 0, 'Vendor worker launcher failed; inspect private runtime log')
            time.sleep(60)


def dispatch(cfg, request):
    op = valid_request(request, cfg['host'])
    if op == 'status':
        return snapshot(cfg)
    job_file = ROOT / 'operation.json'
    current = json.loads(job_file.read_text()) if job_file.exists() else None
    if op == 'preflight':
        result = preflight(cfg, request)
        if request.get('jobId') is not None:
            require(current is not None and all(current.get(k) == request.get(k) for k in ['jobId', 'source', 'target']), 'Preflight operation reservation is mismatched')
            current['preflightPassed'] = True
            atomic_json(job_file, current)
        return result
    require(cfg.get('adminReviewedStartup') is True, 'Startup set is not administrator-approved')
    if op == 'reserve':
        require(current is None or current['jobId'] == request['jobId'], 'Another remote operation is reserved; reconcile it first')
        if current is None:
            current = {'jobId': request['jobId'], 'source': request['source'], 'target': request['target'], 'steps': {}}
            atomic_json(job_file, current)
        return {'ok': True}
    if op == 'release':
        require(current is None or current['jobId'] == request['jobId'], 'Refusing to release another operation')
        if current:
            # A timeout/interruption may leave the global read lock holder alive.
            if lock_alive(current, current):
                os.kill(current['lockPid'], signal.SIGTERM)
            atomic_json(ROOT / (current['jobId'] + '.history.json'), current)
            job_file.unlink()
        return {'ok': True}
    require(current is not None and all(current.get(k) == request.get(k) for k in ['jobId', 'source', 'target']), 'Remote operation reservation is missing or mismatched')
    require(current.get('preflightPassed') is True, 'A successful reserved-job preflight is required before mutation')
    if op == 'fence' and current.get('fenced'):
        require(database_fenced(), 'Previously fenced source has restarted')
        return {'ok': True, 'proof': sign_receipt(cfg, request, 'fence', gtid=current['boundary'])}
    require(current['steps'].get(op) not in ['running', 'failed', 'complete'], 'Step was already attempted; inspect/reconcile rather than replay')
    current['steps'][op] = 'running'; atomic_json(job_file, current)
    try:
        result = globals()[op](cfg, request, current)
        current['steps'][op] = 'complete'
        return result
    except Exception:
        current['steps'][op] = 'failed'
        raise
    finally:
        atomic_json(job_file, current)


def main():
    require(os.geteuid() == 0, 'Agent must be invoked through its fixed sudo entrypoint')
    os.umask(0o077)
    cfg = load_config()
    if sys.argv == [sys.argv[0], '--runtime']:
        runtime(cfg); return
    require(len(sys.argv) == 1, 'Agent does not accept command-line arguments')
    request = json.loads(sys.stdin.read(262145))
    require(len(json.dumps(request)) <= 262144, 'Request exceeds limit')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    # Persistent reservation prevents a second controller from mutating either host.
    with open(ROOT / 'agent.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(dispatch(cfg, request)))


if __name__ == '__main__':
    try:
        main()
    except Refusal as error:
        print(json.dumps({'ok': False, 'message': str(error)})); sys.exit(1)
    except Exception:
        # Never return raw SQL/subprocess/config error text or secrets to the UI.
        print(json.dumps({'ok': False, 'message': 'Agent failed safely; inspect root-owned config and operation state locally'})); sys.exit(1)
