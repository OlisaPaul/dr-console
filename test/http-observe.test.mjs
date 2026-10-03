import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('observation HTTP mode rejects real jobs and demo writes before SSH', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'convox-observe-http-'));
  const configPath = path.join(dir, 'status.json');
  await writeFile(configPath, JSON.stringify({ identityFile: '/nonexistent/observer', knownHostsFile: '/nonexistent/known_hosts', servers: {
    production: { ip: '10.81.0.11', serverId: 8111, user: 'convoxstatus', port: 22 },
    dr: { ip: '10.3.0.150', serverId: 30150, user: 'convoxstatus', port: 22 }
  } }));
  const base = 'http://127.0.0.1:4198';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, stdio: 'pipe',
    env: { ...process.env, PORT: '4198', CONVOX_MODE: 'observe', CONVOX_CONFIG_FILE: configPath, CONVOX_DATA_DIR: path.join(dir, 'state'), CONVOX_PUBLIC_ORIGIN: 'https://10.3.0.151' }
  });
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  t.after(async () => {
    if (child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
    await rm(dir, { recursive: true, force: true });
  });
  let session;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(stderr || 'Observer server exited');
    try { session = await fetch(`${base}/api/session`).then(r => r.json()); break; } catch { await delay(50); }
  }
  assert.equal(session?.mode, 'observe');
  const headers = { 'X-Console-Token': session.token, 'Content-Type': 'application/json', Origin: base };
  for (const [route, body] of [['jobs', { action: 'failover', confirmation: 'PROMOTE DR', outageAccepted: true }], ['demo', { command: 'write' }], ['reconcile', { confirmation: 'I VERIFIED BOTH SERVERS' }]]) {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 409);
  }
  const state = await fetch(`${base}/api/state`, { headers }).then(r => r.json());
  assert.equal(state.active, null);
  assert.equal(state.checkedAt, null);
  assert.equal(state.jobs.length, 0);
  assert.ok(Object.values(state.actions).every(action => action.allowed === false));
});
