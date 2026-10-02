import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('HTTP rejects unauthenticated, cross-origin, and forged-host mutations', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'convox-http-test-'));
  const port = 4197, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PORT: String(port), CONVOX_MODE: 'simulation', CONVOX_DATA_DIR: dataDir, CONVOX_PUBLIC_ORIGIN: 'https://10.3.0.150' },
    windowsHide: true, stdio: 'pipe'
  });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  let session;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(stderr || 'HTTP test server exited');
    try { session = await fetch(`${base}/api/session`).then(r => r.json()); break; }
    catch { await delay(50); }
  }
  assert.ok(session?.token, 'Server started');
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const headers = { 'X-Console-Token': session.token, 'Content-Type': 'application/json', Origin: 'http://attacker.example' };
  assert.equal((await fetch(`${base}/api/demo`, { method: 'POST', headers, body: '{"command":"outage"}' })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/session`, { headers: { Host: 'attacker.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await fetch(`${base}/api/session`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  headers.Origin = base;
  const response = await fetch(`${base}/api/demo`, { method: 'POST', headers, body: '{"command":"outage"}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).servers.production.reachable, false);
  const observed = await fetch(`${base}/api/state`, { headers: { 'X-Console-Token': session.token } }).then(r => r.json());
  assert.equal(observed.mode, 'simulation');
  assert.equal(observed.audit[0].event, 'Simulated production outage');
  const proxied = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/api/refresh`, {
      method: 'POST', headers: { Host: '10.3.0.150', Origin: 'https://10.3.0.150', 'X-Console-Token': session.token, 'Content-Type': 'application/json' }
    }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(proxied, 200, 'Nginx-style Host and Origin can perform an authenticated request');
});
