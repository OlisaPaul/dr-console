import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { initialState, prerequisites, makePlan, validateObservation, CONFIRMATIONS } from './model.mjs';
import { validateStatusObservation } from './ssh-status.mjs';

export class Controller {
  constructor({ dataDir, adapter, mode }) { this.dataDir = dataDir; this.adapter = adapter; this.mode = mode; this.busy = false; this.state = null; this.refreshing = false; }
  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await readFile(path.join(this.dataDir, 'state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.state = initialState(); }
    if (this.state.mode && this.state.mode !== this.mode) throw new Error('Use separate data directories for simulation and live operation');
    this.state.mode = this.mode;
    this.state.reconcileRequired ??= false;
    for (const job of this.state.jobs) {
      if (job.state === 'running') {
        job.state = 'interrupted'; job.error = 'Controller restarted. Inspect servers and reconcile before continuing.';
        job.finishedAt = new Date().toISOString(); this.state.reconcileRequired = true;
        for (const step of job.steps) if (step.state === 'running') step.state = 'unknown';
      }
    }
    if (this.mode !== 'simulation') {
      this.state.checkedAt = null; this.state.observationError = 'Awaiting verified live observation';
      for (const server of Object.values(this.state.servers)) {
        server.reachable = false; server.services = 'unverified'; server.io = null; server.sql = null; server.lag = null;
      }
    }
    if (this.mode === 'observe') {
      this.state.active = null; this.state.fileSource = null; this.state.warnings = [];
      for (const server of Object.values(this.state.servers)) {
        Object.assign(server, { role: 'unknown', readOnly: null, fenced: false, records: null, watermark: null, fileWatermark: null, gtid: null, units: [], fileSync: 'unverified', sshReachable: false, processes: null, error: null, lastIoError: null, lastSqlError: null, upstream: null });
      }
    }
    await this.save(); return this;
  }
  async save() {
    this.state.revision++;
    const temp = path.join(this.dataDir, 'state.json.tmp');
    await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600, flush: true });
    await rename(temp, path.join(this.dataDir, 'state.json'));
  }
  audit(event, details) {
    this.state.audit.unshift({ id: randomUUID(), at: new Date().toISOString(), event, details });
    this.state.audit = this.state.audit.slice(0, 500);
  }
  view() {
    const s = structuredClone(this.state);
    s.busy = this.busy;
    s.actions = {};
    for (const action of Object.keys(CONFIRMATIONS)) {
      try {
        if (this.mode === 'observe') throw new Error('Live monitoring only: recovery execution is not enabled');
        if (this.busy || this.refreshing) throw new Error('An operation or observation is in progress');
        if (s.reconcileRequired) throw new Error('An interrupted or failed operation requires reconciliation');
        if (this.mode === 'live' && (!s.checkedAt || s.observationError)) throw new Error('Refresh live status before continuing');
        prerequisites(s, action); s.actions[action] = { allowed: true };
      } catch (error) { s.actions[action] = { allowed: false, reason: error.message }; }
    }
    return s;
  }
  async refresh() {
    if (this.busy || this.refreshing) throw new Error('An operation is in progress');
    this.refreshing = true;
    try {
      const validate = this.mode === 'observe' ? validateStatusObservation : validateObservation;
      const observed = validate(await this.adapter.observe(this.state));
      Object.assign(this.state, observed, { checkedAt: new Date().toISOString(), observationError: null });
    } catch (error) {
      this.state.observationError = error.message; throw error;
    } finally { await this.save(); this.refreshing = false; }
    return this.view();
  }
  async start(action, confirmation, outageAccepted = false) {
    if (this.mode === 'observe') throw new Error('Live monitoring only: recovery execution is not enabled');
    if (this.busy || this.refreshing) throw new Error('An operation is already running');
    if (this.state.reconcileRequired) throw new Error('Reconcile the previous operation first');
    if (CONFIRMATIONS[action] !== confirmation || !CONFIRMATIONS[action]) throw new Error('Confirmation does not match');
    this.busy = true;
    let job;
    try {
      if (this.mode === 'live') {
        const observed = validateObservation(await this.adapter.observe(this.state));
        Object.assign(this.state, observed, { checkedAt: new Date().toISOString(), observationError: null });
      }
      prerequisites(this.state, action);
      if (action === 'failover' && !this.state.servers.production.reachable && !outageAccepted) throw new Error('Acknowledge possible loss of transactions not received before the outage');
      job = { id: randomUUID(), action, state: 'running', startedAt: new Date().toISOString(), steps: makePlan(action), outageAccepted };
      this.state.jobs.unshift(job); this.state.jobs = this.state.jobs.slice(0, 50);
      this.audit('Operation started', `${action} (${this.mode})`); await this.save();
    } catch (error) { this.busy = false; throw error; }
    this.pending = this.run(job);
    return job;
  }
  async run(job) {
    try {
      for (const step of job.steps) {
        step.state = 'running'; step.startedAt = new Date().toISOString(); await this.save();
        const result = await this.adapter.execute(this.state, job.action, step, { jobId: job.id, outageAccepted: job.outageAccepted });
        if (this.mode === 'live') {
          const observed = validateObservation(await this.adapter.observe(this.state));
          Object.assign(this.state, observed);
          const target = this.state.servers[step.host];
          if (step.key === 'fence' && (!target.fenced || (target.reachable && !target.readOnly))) throw new Error('Observed fencing/read-only state does not match hook result');
          if (step.key === 'promote' && (this.state.active !== step.host || !target.reachable || target.readOnly || target.fenced)) throw new Error('Observed writable primary does not match promotion');
          if (['replicate', 'standby'].includes(step.key) && (!target.readOnly || target.role !== 'replica' || target.io !== true || target.sql !== true)) throw new Error('Replica verification failed');
        }
        validateObservation(this.state);
        step.state = 'complete'; step.message = result.message; step.finishedAt = new Date().toISOString();
        this.state.checkedAt = new Date().toISOString(); this.audit('Step completed', `${job.action}: ${step.title}`); await this.save();
      }
      job.state = 'complete'; this.audit('Operation completed', job.action);
    } catch (error) {
      job.state = 'failed'; job.error = error.message; this.state.reconcileRequired = true;
      const current = job.steps.find(s => s.state === 'running'); if (current) current.state = 'failed';
      this.audit('Operation stopped', error.message);
    } finally { job.finishedAt = new Date().toISOString(); await this.save(); this.busy = false; }
  }
  async reconcile(confirmation) {
    if (this.mode === 'observe') throw new Error('Recovery reconciliation is unavailable in read-only monitoring');
    if (confirmation !== 'I VERIFIED BOTH SERVERS') throw new Error('Confirmation does not match');
    await this.refresh();
    this.state.reconcileRequired = false; this.audit('Operator reconciled state', 'Both server roles verified by operator'); await this.save();
    return this.view();
  }
  async demo(command) {
    if (this.mode !== 'simulation') throw new Error('Demo controls are disabled in live mode');
    if (this.busy || this.refreshing) throw new Error('An operation is running');
    if (command === 'outage') {
      if (this.state.active !== 'production') throw new Error('Outage demo requires production to be primary');
      this.state.servers.production.reachable = false; this.state.servers.production.services = 'unavailable';
      this.state.servers.dr.io = false; this.state.servers.dr.lag = null;
      this.audit('Simulated production outage', 'No real server was contacted');
    } else if (command === 'return') {
      if (this.state.active !== 'dr') throw new Error('Promote DR before simulating production return');
      Object.assign(this.state.servers.production, { reachable: true, fenced: true, readOnly: true, services: 'stopped', role: 'fenced' });
      this.audit('Simulated production return', 'Production returns fenced, awaiting a rebuild');
    } else if (command === 'write') {
      const active = this.state.servers[this.state.active];
      if (!active.reachable || active.fenced || active.readOnly) throw new Error('No writable primary available');
      active.records += 1; active.watermark += 1; active.fileWatermark += 1;
      const replica = this.state.servers[this.state.active === 'dr' ? 'production' : 'dr'];
      if (replica.reachable && replica.role === 'replica' && replica.io && replica.sql) {
        replica.records = active.records; replica.watermark = active.watermark; replica.fileWatermark = active.fileWatermark; replica.lag = 0;
      }
      this.audit('Simulated call saved', `Persisted demo record ${active.records} on ${this.state.active}`);
    } else if (command === 'reset') {
      this.state = { ...initialState(), mode: 'simulation', reconcileRequired: false };
      this.audit('Simulation reset', 'Only local demo state was reset');
    } else throw new Error('Unknown simulation command');
    this.state.checkedAt = new Date().toISOString(); await this.save(); return this.view();
  }
}
