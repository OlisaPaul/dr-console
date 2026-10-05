import { spawn } from 'node:child_process';
import path from 'node:path';
import { Controller } from './controller.mjs';
import { HOSTS, IP, LOCAL_TABLES } from './model.mjs';
import { normalizeStatus, validateStatusObservation } from './ssh-status.mjs';

const IDS = { production: 8111, dr: 30150 };
const OPERATIONS = new Set(['status', 'preflight', 'reserve', 'backup', 'quiesce', 'boundary', 'catchup', 'files', 'fence', 'promote', 'activate', 'release']);
const PHRASES = { failover: 'PROMOTE DR', failback: 'CUT OVER TO PRODUCTION' };
const MESSAGE = 'Rebuild/rejoin is not implemented in control mode. Keep the old server fenced; do not restart it as primary.';

export function validateControlConfig(config) {
  for (const key of ['identityFile', 'knownHostsFile']) {
    if (typeof config?.[key] !== 'string' || !path.posix.isAbsolute(config[key]) || /[\r\n\0]/.test(config[key])) throw new Error('Control SSH paths must be absolute');
  }
  for (const host of HOSTS) {
    const s = config.servers?.[host];
    if (s?.ip !== IP[host] || s.serverId !== IDS[host] || s.user !== 'convoxcontrol' || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new Error('Control SSH identities must be pinned');
  }
  return config;
}

export function controlArguments(config, host) {
  const s = config.servers[host];
  return ['-T', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.knownHostsFile}`, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'LogLevel=ERROR',
    '-i', config.identityFile, '-p', String(s.port), `${s.user}@${s.ip}`, 'convox-control-v1'];
}

export function runControl(args, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ssh', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); done(new Error('Control request timed out; remote work may still be running. Do not retry blindly.')); }, 300000);
    child.stdout.on('data', data => { output += data; if (output.length > 262144) { child.kill(); done(new Error('Control output limit exceeded')); } });
    child.stderr.resume();
    child.on('error', () => done(new Error('SSH control executable unavailable')));
    child.stdin.on('error', () => done(new Error('Control request transport failed')));
    child.on('close', code => {
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true) throw new Error(result.message || 'Control request failed; inspect private agent logs');
        done(null, result);
      } catch (error) { done(new Error(output ? error.message : 'SSH control failed: check keys, authorization and reachability')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export class ControlAdapter {
  constructor(config, runner = runControl) { this.config = validateControlConfig(config); this.runner = runner; }
  async call(host, operation, jobId, details = {}) {
    if (!HOSTS.includes(host) || !OPERATIONS.has(operation)) throw new Error('Unknown control operation');
    return this.runner(controlArguments(this.config, host), { ...details, version: 1, host, operation, jobId });
  }
  async observe() {
    const servers = Object.fromEntries(await Promise.all(HOSTS.map(async host => {
      const result = await this.call(host, 'status');
      const s = normalizeStatus(host, result.status);
      if (!result.control || ['applicationFenced', 'databaseFenced', 'runtimeHealthy'].some(k => typeof result.control[k] !== 'boolean')) throw new Error('Incomplete control-agent safety observation');
      s.control = result.control;
      if (!s.reachable && result.control.databaseFenced) { s.error = null; s.role = 'fenced'; }
      // A stopped database is not a reachable database, even if SSH is reachable.
      return [host, s];
    })));
    const writers = HOSTS.filter(h => servers[h].reachable && servers[h].readOnly === false);
    const view = validateStatusObservation({ active: writers.length === 1 ? writers[0] : null, fileSource: null, servers, warnings: [] });
    view.warnings = ['Planned switchover only. Client/SIP routing requires team verification. Rebuild/rejoin is not enabled.'];
    if (writers.length > 1) view.warnings.unshift('SPLIT BRAIN: both databases are writable. All cutover actions are blocked.');
    return view;
  }
}

function plan(source, target) {
  return [
    ['reserve', 'Reserve both servers for this operation', source],
    ['preflight', 'Verify identities, local mappings, filters and startup readiness', target],
    ['backup', 'Back up databases and all four local tables on both servers', target],
    ['quiesce', 'Stop source application writers; keep SSH and database replication', source],
    ['boundary', 'Capture the final source GTID', source],
    ['catchup', 'Wait for that exact GTID on the target', target],
    ['files', 'Perform and checksum-verify the final source-to-target file copy', source],
    ['fence', 'Persistently mask and stop the source database', source],
    ['promote', 'Persist target as writable after verifying signed fencing evidence', target],
    ['activate', 'Start approved web and managed ConVox runtime services', target],
    ['route', 'Team: switch test endpoints and validate inbound/outbound calls', target]
  ].map(([key, title, host]) => ({ key, title, host, state: 'pending' }));
}

export class ControlController extends Controller {
  async init() {
    await super.init();
    this.state.active = null; this.state.fileSource = null;
    for (const server of Object.values(this.state.servers)) Object.assign(server, {
      role: 'unknown', readOnly: null, fenced: false, gtid: null, units: [], fileSync: 'unverified',
      sshReachable: false, control: null, processes: null
    });
    this.state.preflight = null;
    this.state.warnings = ['Refresh status and run preflight before a planned switchover.'];
    await this.save();
    return this;
  }
  view() {
    const s = structuredClone(this.state); s.busy = this.busy;
    s.actions = { rejoin: { allowed: false, reason: MESSAGE } };
    for (const action of Object.keys(PHRASES)) {
      try {
        if (this.busy || this.refreshing) throw new Error('An operation or observation is in progress');
        if (s.reconcileRequired) throw new Error('Inspect/reconcile the failed or interrupted operation first');
        if (s.jobs.some(j => j.state === 'awaiting-validation')) throw new Error('Validate routing and calls for the previous switchover first');
        const source = action === 'failover' ? 'production' : 'dr', target = source === 'production' ? 'dr' : 'production';
        const p = s.servers[source], d = s.servers[target];
        if (!s.checkedAt || s.observationError || s.active !== source || !p.reachable || p.readOnly !== false || !d.reachable || !d.readOnly || d.role !== 'replica' || d.io !== true || d.sql !== true || d.lag !== 0 || d.upstream !== IP[source] || d.error || d.lastIoError || d.lastSqlError) throw new Error('Both servers must be reachable; target must be a healthy read-only replica of the current source');
        if (!s.preflight || s.preflight.source !== source || Date.now() - Date.parse(s.preflight.at) > 300000) throw new Error('Run a successful preflight (valid for five minutes)');
        s.actions[action] = { allowed: true };
      } catch (error) { s.actions[action] = { allowed: false, reason: error.message }; }
    }
    return s;
  }
  async refresh() {
    if (this.busy || this.refreshing) throw new Error('An operation is in progress');
    this.refreshing = true;
    try { Object.assign(this.state, await this.adapter.observe(), { checkedAt: new Date().toISOString(), observationError: null }); }
    catch (error) { this.state.observationError = error.message; throw error; }
    finally { await this.save(); this.refreshing = false; }
    return this.view();
  }
  async preflight() {
    if (this.busy || this.refreshing || this.state.reconcileRequired) throw new Error('An operation/reconciliation is pending');
    await this.refresh();
    const source = this.state.active;
    if (!HOSTS.includes(source) || !HOSTS.every(h => this.state.servers[h].reachable)) throw new Error('Both databases must be reachable and exactly one writable');
    this.refreshing = true; this.state.preflight = null;
    try {
      const target = source === 'production' ? 'dr' : 'production';
      const results = await Promise.all(HOSTS.map(h => this.adapter.call(h, 'preflight', undefined, { source, target })));
      if (!results.every(r => r.ready === true)) throw new Error('Server preflight did not confirm readiness');
      this.state.preflight = { source, at: new Date().toISOString(), checks: results.flatMap(r => r.checks || []) };
      this.audit('Preflight passed', `${source} → ${target}; four local tables remain isolated`);
    } catch (error) { this.audit('Preflight blocked', error.message); throw error; }
    finally { await this.save(); this.refreshing = false; }
    return this.view();
  }
  async start(action, confirmation, _outageAccepted = false, operator = 'local-controller') {
    if (!PHRASES[action] || confirmation !== PHRASES[action]) throw new Error('Confirmation does not match a supported planned switchover');
    if (this.busy || this.refreshing) throw new Error('An operation is already running');
    await this.refresh();
    const available = this.view().actions[action];
    if (!available.allowed) throw new Error(available.reason);
    this.busy = true;
    const source = action === 'failover' ? 'production' : 'dr', target = source === 'production' ? 'dr' : 'production';
    const job = { id: (await import('node:crypto')).randomUUID(), action, source, target, operator, state: 'running', steps: plan(source, target), startedAt: new Date().toISOString() };
    this.state.jobs.unshift(job); this.state.jobs = this.state.jobs.slice(0, 50);
    this.audit('Planned UI switchover started', `${source} → ${target}; operator ${operator}`);
    try { await this.save(); } catch (error) { this.busy = false; throw error; }
    this.pending = this.run(job); return structuredClone(job);
  }
  async run(job) {
    const details = { source: job.source, target: job.target, localTables: [...LOCAL_TABLES] };
    try {
      for (const step of job.steps) {
        step.state = 'running'; step.startedAt = new Date().toISOString(); await this.save();
        let result;
        if (step.key === 'route') {
          step.state = 'awaiting-validation'; step.message = 'No carrier/DNS changes were made. Team confirmation is required.';
          job.state = 'awaiting-validation'; break;
        }
        if (['reserve', 'preflight', 'backup'].includes(step.key)) {
          for (const host of HOSTS) await this.adapter.call(host, step.key, job.id, details);
          result = { message: `${step.key} verified on both servers` };
        } else {
          // Recheck the old primary immediately before promotion, never infer a fence from an SSH failure.
          if (step.key === 'promote') details.fence = (await this.adapter.call(job.source, 'fence', job.id, details)).proof;
          result = await this.adapter.call(step.host, step.key, job.id, details);
          if (step.key === 'boundary') { if (!result.proof) throw new Error('Missing GTID boundary proof'); details.boundary = result.proof; }
          if (step.key === 'files') { if (!result.proof) throw new Error('Missing final file proof'); details.files = result.proof; }
          if (step.key === 'fence') { if (!result.proof) throw new Error('Missing source fencing proof'); details.fence = result.proof; }
        }
        step.state = 'complete'; step.message = result.message || 'Verified by restricted server agent'; step.finishedAt = new Date().toISOString();
        this.audit('Step completed', `${job.action}: ${step.title}`); await this.save();
      }
      Object.assign(this.state, await this.adapter.observe(), { checkedAt: new Date().toISOString() });
      if (this.state.active !== job.target || !this.state.servers[job.source].control?.databaseFenced) throw new Error('Final writable target / source fence observation failed');
      this.audit('Awaiting team validation', 'Database and service cutover finished; routing and actual calls are not verified');
    } catch (error) {
      job.state = 'failed'; job.error = error.message; this.state.reconcileRequired = true;
      const step = job.steps.find(s => s.state === 'running'); if (step) step.state = 'failed';
      this.audit('Operation stopped', error.message);
    } finally { job.finishedAt = new Date().toISOString(); this.state.preflight = null; await this.save(); this.busy = false; }
  }
  async validateTraffic(confirmation, operator = 'local-controller') {
    if (this.busy || this.refreshing || this.state.reconcileRequired) throw new Error('An operation/reconciliation is pending');
    if (confirmation !== 'I TESTED ROUTING AND CALLS') throw new Error('Confirmation does not match');
    const job = this.state.jobs.find(j => j.state === 'awaiting-validation');
    if (!job) throw new Error('No switchover awaiting validation');
    await this.refresh();
    if (this.state.active !== job.target || !this.state.servers[job.source].control?.databaseFenced || !this.state.servers[job.target].control?.runtimeHealthy) throw new Error('Primary/fence/runtime verification failed');
    this.busy = true;
    try {
      for (const host of HOSTS) await this.adapter.call(host, 'release', job.id);
      job.steps.at(-1).state = 'complete'; job.steps.at(-1).message = 'Routing and calls attested by operator, not automatically probed';
      job.state = 'complete'; job.finishedAt = new Date().toISOString();
      job.validatedBy = operator;
      this.audit('Team validated routing and calls', `${job.source} → ${job.target}; operator ${operator}`); await this.save();
    } catch (error) { this.state.reconcileRequired = true; await this.save(); throw error; }
    finally { this.busy = false; }
    return this.view();
  }
  async reconcile(confirmation, operator = 'local-controller') {
    if (confirmation !== 'I VERIFIED BOTH SERVERS') throw new Error('Confirmation does not match');
    await this.refresh();
    if (!HOSTS.every(h => this.state.servers[h].sshReachable) || !this.state.active || !this.state.servers[this.state.active === 'production' ? 'dr' : 'production'].control?.applicationFenced) throw new Error('A sole writer and a stopped/masked peer application must be observed before reconciliation');
    this.busy = true;
    try {
      for (const job of this.state.jobs.filter(j => ['failed', 'interrupted'].includes(j.state))) for (const host of HOSTS) await this.adapter.call(host, 'release', job.id);
      this.state.reconcileRequired = false; this.state.preflight = null;
      this.audit('Operator reconciled remote operations', `Operator ${operator} verified remote jobs and roles; no automatic rollback or reseed`); await this.save();
    } finally { this.busy = false; }
    return this.view();
  }
}
