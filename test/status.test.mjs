import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadOnlySshAdapter, normalizeStatus, sshArguments, validateStatusConfig } from '../lib/ssh-status.mjs';
import { Controller } from '../lib/controller.mjs';

const config = { identityFile: '/etc/convox-console/ssh/observer_ed25519', knownHostsFile: '/etc/convox-console/ssh/known_hosts', servers: {
  production: { ip: '10.81.0.11', serverId: 8111, user: 'convoxstatus', port: 22 },
  dr: { ip: '10.3.0.150', serverId: 30150, user: 'convoxstatus', port: 22 }
} };
function response(host, readOnly = host === 'dr') {
  return { version: 1, ok: true, observedAt: new Date().toISOString(),
    db: { serverId: host === 'production' ? 8111 : 30150, readOnly, gtidSlave: readOnly ? '0-8111-10' : '', gtidBinlog: '0-8111-10', gtidCurrent: '0-8111-10', logBin: true, logSlaveUpdates: true, eventScheduler: 'OFF' },
    replicas: readOnly ? [{ io: true, sql: true, lag: 0, source: '10.81.0.11', ioError: false, sqlError: false }] : [],
    units: [{ name: 'mariadb.service', load: 'loaded', active: 'active', masked: false }, { name: 'lsyncd.service', load: 'loaded', active: 'inactive', masked: false }],
    processes: { asterisk: 1, safeAsterisk: 1 } };
}

test('observer SSH always pins host keys and sends only the fixed command', () => {
  const args = sshArguments(validateStatusConfig(config), 'production');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('IdentityAgent=none'));
  assert.equal(args.at(-1), 'convox-status-v1');
  assert.equal(args.at(-2), 'convoxstatus@10.81.0.11');
  assert.throws(() => validateStatusConfig({ ...config, identityFile: '/etc/key\nmalicious' }));
  assert.throws(() => validateStatusConfig({ ...config, servers: { ...config.servers, dr: { ...config.servers.dr, user: 'root' } } }));
  assert.throws(() => validateStatusConfig({ ...config, servers: { ...config.servers, dr: { ...config.servers.dr, ip: '10.3.0.151' } } }));
});
test('real status contains no fabricated file watermark or fencing claim', async () => {
  const calls = [];
  const adapter = new ReadOnlySshAdapter(config, async args => { calls.push(args); return response(args.at(-2).endsWith('10.81.0.11') ? 'production' : 'dr'); });
  const view = await adapter.observe();
  assert.equal(view.active, 'production');
  assert.equal(view.fileSource, null);
  assert.equal(view.servers.production.fenced, false);
  assert.equal(view.servers.dr.gtid, '0-8111-10');
  assert.equal(view.servers.dr.io, true);
  assert.equal(view.servers.dr.lag, 0);
  assert.equal(view.servers.dr.fileWatermark, undefined);
  assert.equal(view.servers.production.processes.safeAsterisk, 1);
  assert.equal(calls.length, 2);
  await assert.rejects(adapter.execute(), /cannot execute/);
});
test('unreachable peer never establishes a sole writer or fencing', async () => {
  const adapter = new ReadOnlySshAdapter(config, async args => {
    if (args.at(-2).endsWith('10.3.0.150')) throw new Error('SSH status timed out');
    return response('production');
  });
  const view = await adapter.observe();
  assert.equal(view.active, null);
  assert.equal(view.servers.dr.reachable, false);
  assert.equal(view.servers.dr.fenced, false);
  assert.match(view.warnings.join(' '), /unreachable server is fenced/);
});
test('both writable databases are displayed with a split-brain warning', async () => {
  const adapter = new ReadOnlySshAdapter(config, async args => response(args.at(-2).endsWith('10.81.0.11') ? 'production' : 'dr', false));
  const view = await adapter.observe();
  assert.equal(view.active, null);
  assert.equal(view.servers.production.readOnly, false);
  assert.equal(view.servers.dr.readOnly, false);
  assert.match(view.warnings[0], /SPLIT BRAIN/);
});
test('wrong server ID is rejected and database failures retain SSH/service status', () => {
  const wrong = response('dr'); wrong.db.serverId = 8111;
  assert.throws(() => normalizeStatus('dr', wrong), /identity mismatch/);
  const noDb = response('dr'); noDb.db = null;
  const status = normalizeStatus('dr', noDb);
  assert.equal(status.sshReachable, true);
  assert.equal(status.reachable, false);
  assert.equal(status.readOnly, null);
  assert.equal(status.units.length, 2);
});
test('observer controller rejects mutations before any job or remote execution', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'convox-status-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let calls = 0;
  const adapter = new ReadOnlySshAdapter(config, async args => { calls++; return response(args.at(-2).endsWith('10.81.0.11') ? 'production' : 'dr'); });
  const controller = await new Controller({ dataDir, adapter, mode: 'observe' }).init();
  assert.equal(controller.view().active, null);
  assert.equal(controller.view().servers.production.readOnly, null);
  await controller.refresh();
  assert.ok(Object.values(controller.view().actions).every(a => a.allowed === false));
  const before = calls;
  await assert.rejects(controller.start('failover', 'PROMOTE DR', true), /monitoring only/);
  await assert.rejects(controller.demo('write'), /disabled/);
  await assert.rejects(controller.reconcile('I VERIFIED BOTH SERVERS'), /read-only/);
  assert.equal(calls, before);
  assert.equal(controller.view().jobs.length, 0);
});
