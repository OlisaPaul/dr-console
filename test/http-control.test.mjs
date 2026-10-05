import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('control HTTP mode still rejects unauthorized writes, demo controls and unsupported rebuild', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'convox-control-http-'));
  const configPath = path.join(dir, 'control.json');
  const proxySecret = 'cd'.repeat(32);
  const secretPath = path.join(dir, 'proxy-secret');
  await writeFile(secretPath, proxySecret);
  await writeFile(configPath, JSON.stringify({ identityFile: '/nonexistent/control', knownHostsFile: '/nonexistent/known_hosts', servers: {
    production: { ip: '10.81.0.11', serverId: 8111, user: 'convoxcontrol', port: 22 },
    dr: { ip: '10.3.0.150', serverId: 30150, user: 'convoxcontrol', port: 22 }
  } }));
  const base = 'http://127.0.0.1:4196';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, stdio: 'pipe',
    env: { ...process.env, PORT: '4196', CONVOX_MODE: 'control', CONVOX_CONFIG_FILE: configPath, CONVOX_DATA_DIR: path.join(dir, 'state'), CONVOX_PUBLIC_ORIGIN: 'https://10.3.0.151', CONVOX_PROXY_SECRET_FILE: secretPath }
  });
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  t.after(async () => {
    if (child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
    await rm(dir, { recursive: true, force: true });
  });
  let session;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(stderr || 'Control server exited');
    try { session = await fetch(`${base}/api/session`, { headers: { 'X-Console-Proxy': proxySecret, 'X-Console-Operator': 'test-operator' } }).then(r => r.json()); break; } catch { await delay(50); }
  }
  assert.equal(session?.mode, 'control');
  const proxyHeaders = { 'X-Console-Proxy': proxySecret, 'X-Console-Operator': 'test-operator' };
  assert.equal((await fetch(`${base}/api/session`)).status, 403, 'direct localhost cannot obtain control session');
  const headers = { ...proxyHeaders, 'X-Console-Token': session.token, 'Content-Type': 'application/json', Origin: base };
  const bypass = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'X-Console-Token': session.token, 'Content-Type': 'application/json', Origin: base }, body: '{}' });
  assert.equal(bypass.status, 403, 'token alone cannot bypass Nginx login');
  const unauthorized = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { ...proxyHeaders, 'Content-Type': 'application/json', Origin: base }, body: '{}' });
  assert.equal(unauthorized.status, 401);
  const foreign = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
  for (const [route, body] of [['jobs', { action: 'rejoin', confirmation: 'REBUILD PRODUCTION' }], ['demo', { command: 'write' }], ['validate-traffic', { confirmation: 'I TESTED ROUTING AND CALLS' }]]) {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 409);
  }
  const state = await fetch(`${base}/api/state`, { headers }).then(r => r.json());
  assert.equal(state.active, null); assert.equal(state.jobs.length, 0);
  assert.ok(Object.values(state.actions).every(action => action.allowed === false));
});
