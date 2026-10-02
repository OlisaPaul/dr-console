import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../lib/controller.mjs';
import { SimulationAdapter, HookAdapter } from '../lib/adapters.mjs';
import { validateObservation } from '../lib/model.mjs';

async function setup(t, adapter = new SimulationAdapter(1), mode = 'simulation') {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'convox-console-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const controller = await new Controller({ dataDir, adapter, mode }).init();
  return { controller, dataDir };
}
async function run(c, action, confirmation, acknowledge = false) {
  await c.start(action, confirmation, acknowledge); await c.pending;
  assert.equal(c.state.jobs[0].state, 'complete', c.state.jobs[0].error);
}
test('outage -> promotion -> DR writes -> return -> reverse replica -> cutover preserves new writes', async t => {
  const { controller: c } = await setup(t);
  await c.demo('outage');
  await run(c, 'failover', 'PROMOTE DR', true);
  assert.equal(c.state.active, 'dr'); assert.equal(c.state.servers.production.fenced, true);
  await c.demo('write'); await c.demo('write');
  const records = c.state.servers.dr.records;
  assert.equal(c.state.servers.production.records, records - 2);
  await c.demo('return'); await run(c, 'rejoin', 'REBUILD PRODUCTION');
  assert.equal(c.state.servers.production.readOnly, true);
  assert.equal(c.state.servers.production.records, records);
  await c.demo('write');
  await run(c, 'failback', 'CUT OVER TO PRODUCTION');
  assert.equal(c.state.active, 'production'); assert.equal(c.state.fileSource, 'production');
  assert.equal(c.state.servers.production.records, records + 1);
  assert.equal(c.state.servers.dr.records, records + 1);
  assert.equal(c.state.servers.dr.readOnly, true);
  assert.equal(c.state.servers.dr.services, 'stopped');
});
test('roles, saved DR writes, and audit history survive controller restart', async t => {
  const { controller: c, dataDir } = await setup(t);
  await run(c, 'failover', 'PROMOTE DR'); await c.demo('write');
  const reopened = await new Controller({ dataDir, adapter: new SimulationAdapter(1), mode: 'simulation' }).init();
  assert.equal(reopened.state.active, 'dr');
  assert.equal(reopened.state.servers.dr.records, 578);
  assert.ok(reopened.state.audit.length > 0);
});
test('cutover is blocked until production is a healthy read-only replica', async t => {
  const { controller: c } = await setup(t);
  await run(c, 'failover', 'PROMOTE DR');
  await assert.rejects(c.start('failback', 'CUT OVER TO PRODUCTION'), /healthy read-only/);
});
test('unplanned promotion requires a separate loss acknowledgement', async t => {
  const { controller: c } = await setup(t); await c.demo('outage');
  await assert.rejects(c.start('failover', 'PROMOTE DR'), /Acknowledge/);
  assert.equal(c.state.jobs.length, 0);
});
test('incorrect confirmation never starts a job', async t => {
  const { controller: c } = await setup(t);
  await assert.rejects(c.start('failover', 'yes'), /Confirmation/);
});
test('concurrent operations are rejected', async t => {
  const { controller: c } = await setup(t, new SimulationAdapter(10));
  await c.start('failover', 'PROMOTE DR');
  await assert.rejects(c.start('failover', 'PROMOTE DR'), /already running/);
  await c.pending;
});
test('fencing failure prevents promotion and blocks retries until reconciliation', async t => {
  const adapter = new SimulationAdapter(1);
  adapter.execute = async () => { throw new Error('Fencing not verified'); };
  const { controller: c } = await setup(t, adapter);
  await c.start('failover', 'PROMOTE DR'); await c.pending;
  assert.equal(c.state.active, 'production'); assert.equal(c.state.reconcileRequired, true);
  assert.equal(c.state.jobs[0].steps[2].state, 'pending');
  await assert.rejects(c.start('failover', 'PROMOTE DR'), /Reconcile/);
});
test('an interrupted persisted job does not resume automatically', async t => {
  const { controller: c, dataDir } = await setup(t);
  c.state.jobs.push({ state: 'running', steps: [{ state: 'running' }] }); await c.save();
  const reopened = await new Controller({ dataDir, adapter: new SimulationAdapter(1), mode: 'simulation' }).init();
  assert.equal(reopened.state.jobs[0].state, 'interrupted');
  assert.equal(reopened.state.jobs[0].steps[0].state, 'unknown');
  assert.equal(reopened.view().actions.failover.allowed, false);
});
test('live fencing hook must explicitly confirm persistent fencing', async () => {
  const adapter = new HookAdapter({ executable: '/usr/bin/example', args: [] });
  adapter.call = async () => ({ ok: true, fenced: true });
  await assert.rejects(adapter.execute({ active: 'production' }, 'failover', { key: 'fence', host: 'production' }, { jobId: 'test' }), /persistent fencing/);
});
test('two observed writable servers are rejected as split brain', async t => {
  const { controller: c } = await setup(t);
  c.state.servers.dr.readOnly = false;
  assert.throws(() => validateObservation(c.state), /SPLIT BRAIN/);
});
test('simulation controls cannot mutate live mode', async t => {
  const { controller: c } = await setup(t, new SimulationAdapter(1), 'live');
  await assert.rejects(c.demo('write'), /disabled in live mode/);
});
