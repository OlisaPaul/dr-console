import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ControlAdapter, ControlController, validateControlConfig, controlArguments } from '../lib/control.mjs';
import { LOCAL_TABLES, IP } from '../lib/model.mjs';

const config = { identityFile: '/etc/convox-console/ssh/control_ed25519', knownHostsFile: '/etc/convox-console/ssh/known_hosts', servers: {
  production: { ip: IP.production, serverId: 8111, port: 22, user: 'convoxcontrol' }, dr: { ip: IP.dr, serverId: 30150, port: 22, user: 'convoxcontrol' }
} };
function observation() {
  return { active: 'production', fileSource: null, warnings: [], servers: {
    production: { ip: IP.production, reachable: true, sshReachable: true, role: 'primary', readOnly: false, services: 'running', control: { databaseFenced: false, applicationFenced: false } },
    dr: { ip: IP.dr, reachable: true, sshReachable: true, role: 'replica', readOnly: true, io: true, sql: true, lag: 0, upstream: IP.production, control: { databaseFenced: false, applicationFenced: true } }
  } };
}
async function setup(t, failOperation) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'convox-control-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const obs = observation(), calls = [];
  const adapter = {
    observe: async () => structuredClone(obs),
    call: async (host, operation, jobId, details) => {
      calls.push({ host, operation, jobId, details: structuredClone(details) });
      if (operation === failOperation) throw new Error(`${operation} refused`);
      if (operation === 'fence') Object.assign(obs.servers.production, { reachable: false, readOnly: null, control: { databaseFenced: true, applicationFenced: true } });
      if (operation === 'promote') { obs.active = 'dr'; Object.assign(obs.servers.dr, { role: 'primary', readOnly: false }); }
      if (operation === 'activate') obs.servers.dr.control.runtimeHealthy = true;
      return { ok: true, ready: true, checks: [`${host}: checked`], proof: { kind: operation } };
    }
  };
  const c = await new ControlController({ dataDir, adapter, mode: 'control' }).init();
  return { c, calls, obs, dataDir };
}

test('control config pins host, account, identity and strict host-key checking', () => {
  validateControlConfig(config);
  const args = controlArguments(config, 'dr');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.equal(args.at(-1), 'convox-control-v1');
  assert.throws(() => validateControlConfig({ ...config, identityFile: 'relative' }), /absolute/);
  const bad = structuredClone(config); bad.servers.dr.user = 'root';
  assert.throws(() => validateControlConfig(bad), /pinned/);
});
test('four local tables are included in every control operation', async t => {
  const { c, calls } = await setup(t);
  assert.equal(LOCAL_TABLES.length, 4);
  await c.preflight(); await c.start('failover', 'PROMOTE DR'); await c.pending;
  for (const call of calls.filter(c => !['preflight', 'reserve'].includes(c.operation))) assert.deepEqual(call.details.localTables, LOCAL_TABLES);
});
test('refresh alone cannot enable mutating control; preflight is mandatory and expires', async t => {
  const { c } = await setup(t); await c.refresh();
  assert.equal(c.view().actions.failover.allowed, false);
  await c.preflight(); assert.equal(c.view().actions.failover.allowed, true);
  c.state.preflight.at = new Date(Date.now() - 301000).toISOString();
  await assert.rejects(c.start('failover', 'PROMOTE DR'), /preflight/);
});
test('unreachable production is not treated as fenced even with loss acknowledgement', async t => {
  const { c, obs, calls } = await setup(t);
  await c.preflight(); obs.servers.production.reachable = false;
  await assert.rejects(c.start('failover', 'PROMOTE DR', true), /reachable/);
  assert.equal(calls.some(c => c.operation === 'promote'), false);
});
test('backup, writer fence, GTID, files and hard DB fence precede promotion; routing is never fabricated', async t => {
  const { c, calls } = await setup(t); await c.preflight(); await c.start('failover', 'PROMOTE DR'); await c.pending;
  assert.equal(c.state.jobs[0].state, 'awaiting-validation', c.state.jobs[0].error);
  const ops = calls.map(c => c.operation);
  for (const op of ['reserve', 'backup', 'quiesce', 'boundary', 'catchup', 'files', 'fence']) assert.ok(ops.indexOf(op) < ops.indexOf('promote'));
  assert.equal(ops.filter(op => op === 'fence').length, 2, 'fresh source fencing check immediately before promotion');
  assert.equal(c.view().actions.failover.allowed, false);
  await assert.rejects(c.validateTraffic('yes'), /Confirmation/);
  await c.validateTraffic('I TESTED ROUTING AND CALLS');
  assert.equal(c.state.jobs[0].state, 'complete');
  assert.ok(c.state.audit.some(e => e.event === 'Team validated routing and calls'));
});
for (const failure of ['reserve', 'backup', 'quiesce', 'boundary', 'catchup', 'files', 'fence']) {
  test(`${failure} failure blocks promotion and requires reconciliation`, async t => {
    const { c, calls } = await setup(t, failure); await c.preflight(); await c.start('failover', 'PROMOTE DR'); await c.pending;
    assert.equal(c.state.jobs[0].state, 'failed'); assert.equal(c.state.reconcileRequired, true);
    assert.equal(calls.some(c => c.operation === 'promote'), false);
    await assert.rejects(c.start('failover', 'PROMOTE DR'), /reconcil/);
  });
}
test('automatic rebuild is explicitly unavailable, not a fake live success', async t => {
  const { c } = await setup(t); await c.refresh();
  assert.equal(c.view().actions.rejoin.allowed, false);
  assert.match(c.view().actions.rejoin.reason, /not implemented/);
  await assert.rejects(c.start('rejoin', 'REBUILD PRODUCTION'), /supported/);
});
test('restart invalidates preflight and marks interrupted operation without replay', async t => {
  const { c, dataDir, calls } = await setup(t); await c.preflight();
  c.state.jobs.push({ state: 'running', steps: [{ state: 'running' }] }); await c.save();
  const count = calls.length;
  const next = await new ControlController({ dataDir, adapter: c.adapter, mode: 'control' }).init();
  assert.equal(next.state.preflight, null); assert.equal(next.state.jobs[0].state, 'interrupted');
  assert.equal(next.state.reconcileRequired, true); assert.equal(calls.length, count);
});
test('adapter refuses malformed safety flags from remote agents', async () => {
  const adapter = new ControlAdapter(config, async () => ({ ok: true, status: { version: 1, ok: true, units: [], db: null }, control: {} }));
  await assert.rejects(adapter.observe(), /safety observation/);
});
