import { spawn } from 'node:child_process';
import path from 'node:path';
import { HOSTS, IP } from './model.mjs';

const IDS = { production: 8111, dr: 30150 };
const safePath = value => typeof value === 'string' && path.posix.isAbsolute(value) && !/[\r\n\0]/.test(value);
export function validateStatusConfig(config) {
  if (!safePath(config?.identityFile) || !safePath(config?.knownHostsFile)) throw new Error('SSH key and known-hosts paths must be absolute server-side paths');
  for (const host of HOSTS) {
    const entry = config.servers?.[host];
    if (entry?.ip !== IP[host] || entry?.serverId !== IDS[host] || entry?.user !== 'convoxstatus') throw new Error(`Status configuration must pin ${host} IP, server ID and restricted observer account`);
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw new Error('Invalid SSH port');
  }
  return config;
}

export function sshArguments(config, host) {
  const entry = config.servers[host];
  return ['-T', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.knownHostsFile}`, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1',
    '-o', 'LogLevel=ERROR', '-i', config.identityFile, '-p', String(entry.port), `${entry.user}@${entry.ip}`, 'convox-status-v1'];
}

export function runSsh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ssh', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('SSH status timed out')); }, 30000);
    child.stdout.on('data', data => {
      output += data;
      if (output.length > 262144) { child.kill(); finish(new Error('SSH status exceeded output limit')); }
    });
    // Do not expose private paths, server stderr or credentials through the UI.
    child.stderr.resume();
    child.on('error', () => finish(new Error('SSH executable unavailable')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('SSH status failed: check reachability, pinned host key and observer authorization'));
      try { finish(null, JSON.parse(output)); } catch { finish(new Error('Invalid observer JSON response')); }
    });
  });
}

function unavailable(host, error) {
  return { ip: IP[host], reachable: false, sshReachable: false, role: 'unknown', readOnly: null,
    fenced: false, services: 'unverified', io: null, sql: null, lag: null, gtid: null,
    units: [], fileSync: 'unverified', error };
}

export function normalizeStatus(host, raw) {
  if (raw?.version !== 1 || raw.ok !== true || !Array.isArray(raw.units) || raw.units.length > 100) throw new Error('Invalid observer response');
  if (raw.db && (raw.db.serverId !== IDS[host] || typeof raw.db.readOnly !== 'boolean')) throw new Error('Database identity mismatch; observation rejected');
  const units = raw.units.map(unit => {
    if (!/^[A-Za-z0-9_.@:-]+\.service$/.test(unit.name) || !['loaded', 'not-found', 'masked', 'error'].includes(unit.load) ||
        !['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'unknown'].includes(unit.active) || typeof unit.masked !== 'boolean') throw new Error('Invalid service observation');
    return { name: unit.name, load: unit.load, active: unit.active, masked: unit.masked };
  });
  const s = { ...unavailable(host, raw.db ? null : 'SSH connected; database status unavailable or observer permission denied'),
    sshReachable: true, units, observedAt: raw.observedAt,
    services: `${units.filter(u => u.active === 'active').length} active / ${units.filter(u => u.load !== 'not-found').length} discovered`,
    fileSync: units.find(u => u.name === 'lsyncd.service')?.active || 'unverified' };
  if (raw.processes && Number.isInteger(raw.processes.asterisk) && raw.processes.asterisk >= 0 && Number.isInteger(raw.processes.safeAsterisk) && raw.processes.safeAsterisk >= 0) s.processes = { asterisk: raw.processes.asterisk, safeAsterisk: raw.processes.safeAsterisk };
  if (!raw.db) return s;
  const db = raw.db;
  for (const key of ['gtidSlave', 'gtidBinlog', 'gtidCurrent']) if (typeof db[key] !== 'string' || !/^(?:\d+-\d+-\d+(?:,\d+-\d+-\d+)*)?$/.test(db[key])) throw new Error('Invalid database GTID');
  if (!Array.isArray(raw.replicas) || raw.replicas.length > 10) throw new Error('Invalid replica observation');
  const replica = raw.replicas.length === 1 ? raw.replicas[0] : null;
  if (replica && (typeof replica.io !== 'boolean' || typeof replica.sql !== 'boolean' ||
      (replica.lag !== null && (!Number.isFinite(replica.lag) || replica.lag < 0)) ||
      typeof replica.ioError !== 'boolean' || typeof replica.sqlError !== 'boolean' || typeof replica.source !== 'string')) throw new Error('Invalid replica thread observation');
  Object.assign(s, { reachable: true, serverId: db.serverId, readOnly: db.readOnly,
    role: db.readOnly ? (replica ? 'replica' : 'read-only') : 'primary', gtid: db.gtidCurrent,
    gtidSlave: db.gtidSlave, gtidBinlog: db.gtidBinlog, logBin: db.logBin, logSlaveUpdates: db.logSlaveUpdates,
    eventScheduler: db.eventScheduler, io: replica?.io ?? null, sql: replica?.sql ?? null, lag: replica?.lag ?? null,
    upstream: replica?.source ?? null,
    lastIoError: replica?.ioError ? 'Replication IO error; inspect MariaDB privately' : null,
    lastSqlError: replica?.sqlError ? 'Replication SQL error; inspect MariaDB privately' : null,
    error: raw.replicationError ? 'Replication status permission denied or unavailable' : raw.replicas.length > 1 ? 'Multiple replication channels; topology needs review' : null });
  return s;
}

export function validateStatusObservation(observation) {
  if (!observation || (observation.active !== null && !HOSTS.includes(observation.active)) || observation.fileSource !== null) throw new Error('Invalid read-only observation');
  for (const host of HOSTS) {
    const s = observation.servers?.[host];
    if (!s || s.ip !== IP[host] || typeof s.reachable !== 'boolean' || s.fenced !== false ||
        (s.reachable && (s.serverId !== IDS[host] || typeof s.readOnly !== 'boolean'))) throw new Error(`Invalid ${host} read-only observation`);
  }
  return { active: observation.active, fileSource: null, servers: observation.servers, warnings: observation.warnings || [] };
}

export class ReadOnlySshAdapter {
  constructor(config, runner = runSsh) { this.config = validateStatusConfig(config); this.runner = runner; this.readOnly = true; }
  async observe() {
    const servers = Object.fromEntries(await Promise.all(HOSTS.map(async host => {
      try { return [host, normalizeStatus(host, await this.runner(sshArguments(this.config, host)))]; }
      catch (error) { return [host, unavailable(host, error.message)]; }
    })));
    const writable = HOSTS.filter(host => servers[host].reachable && servers[host].readOnly === false);
    const warnings = ['Status snapshots do not prove fencing, routing, file consistency or readiness for promotion.'];
    if (writable.length > 1) warnings.unshift('SPLIT BRAIN WARNING: both observed databases are writable. Recovery controls are disabled.');
    if (HOSTS.some(host => !servers[host].reachable)) warnings.unshift('At least one database is unverified. Do not infer that an unreachable server is fenced.');
    return validateStatusObservation({ active: writable.length === 1 && HOSTS.every(h => servers[h].reachable) ? writable[0] : null, fileSource: null, servers, warnings });
  }
  async execute() { throw new Error('Read-only monitoring cannot execute recovery operations'); }
}
