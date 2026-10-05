import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { validateObservation, FILES, EXCLUSIONS, LICENSE, LOCAL_TABLES } from './model.mjs';

export class SimulationAdapter {
  constructor(delayMs = 900) { this.delayMs = delayMs; }
  async observe(state) { return structuredClone({ active: state.active, fileSource: state.fileSource, servers: state.servers }); }
  async execute(state, action, step) {
    await delay(this.delayMs);
    const p = state.servers.production, d = state.servers.dr;
    const h = state.servers[step.host];
    if (step.key === 'fence') {
      h.readOnly = true; h.fenced = true; h.services = 'stopped';
      if (h.role !== 'replica') h.role = 'fenced';
    }
    if (step.key === 'drain') { d.sql = true; d.lag = 0; }
    if (step.key === 'seed' || step.key === 'standby') {
      const source = step.key === 'seed' ? d : p;
      Object.assign(h, { reachable: true, role: 'rebuilding', readOnly: true, records: source.records, watermark: source.watermark });
    }
    if (step.key === 'files') p.fileWatermark = d.fileWatermark;
    if (step.key === 'replicate' || step.key === 'standby') {
      Object.assign(h, { role: 'replica', readOnly: true, fenced: true, services: 'stopped', io: true, sql: true, lag: 0 });
    }
    if (step.key === 'catchup') {
      Object.assign(p, { records: d.records, watermark: d.watermark, fileWatermark: d.fileWatermark, lag: 0, io: true, sql: true });
    }
    if (step.key === 'promote') {
      Object.assign(h, { role: 'primary', readOnly: false, fenced: false, io: null, sql: null, lag: null });
      state.active = step.host; state.fileSource = step.host;
    }
    if (step.key === 'activate') h.services = 'running';
    if (step.key === 'verify' && action === 'failback') {
      d.fileWatermark = p.fileWatermark; state.fileSource = 'production';
    }
    return { ok: true, message: `Simulation: ${step.title}`, persistent: true, fenced: step.key === 'fence', databaseAndFilesCaughtUp: ['drain', 'catchup', 'standby'].includes(step.key) };
  }
}

// Hooks are provisioned by an administrator, never by a browser request.
// No shell is used. The executable must enforce the contract in README.md.
export class HookAdapter {
  constructor(config) {
    this.config = config;
    if (!config.executable || !Array.isArray(config.args)) throw new Error('Live configuration requires executable and args');
  }
  async call(payload) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.executable, this.config.args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill(); finish(new Error('Hook timed out. Remote work may still be running; reconcile before another operation.'));
      }, this.config.timeoutMs ?? 1800000);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 1048576) { child.kill(); finish(new Error('Hook output exceeded limit')); }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
      child.on('error', error => finish(error));
      child.stdin.on('error', error => finish(error));
      child.on('close', code => {
        if (code !== 0) return finish(new Error(`Hook exited ${code}; review its private server-side logs`));
        try {
          const result = JSON.parse(stdout);
          if (!result.ok) throw new Error(result.message || 'Hook refused operation');
          finish(null, result);
        } catch (error) { finish(error); }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
  async observe() {
    const result = await this.call({ version: 1, command: 'status' });
    return validateObservation(result.observation);
  }
  async execute(state, action, step, context) {
    const result = await this.call({
      version: 1, command: 'execute', action, step: step.key, host: step.host,
      jobId: context.jobId, authoritative: state.active, preserveLicenseTable: LICENSE,
      preserveLocalTables: [...LOCAL_TABLES],
      preserveFiles: EXCLUSIONS, filePaths: FILES,
      outageAccepted: context.outageAccepted
    });
    if (step.key === 'fence' && (!result.fenced || !result.persistent)) throw new Error('Hook did not prove persistent fencing');
    if (['preserve', 'seed', 'standby'].includes(step.key) && (!Array.isArray(result.preservedLocalTables) || !LOCAL_TABLES.every(table => result.preservedLocalTables.includes(table)))) throw new Error('Hook did not confirm destination licence and notification table preservation');
    if (step.key === 'promote' && !result.persistent) throw new Error('Hook did not prove the primary role persists across restart');
    if (['drain', 'catchup', 'standby'].includes(step.key) && !result.databaseAndFilesCaughtUp) throw new Error('Hook did not verify the required database and file boundaries');
    return { ok: true, message: `Verified hook: ${step.title}` };
  }
}
