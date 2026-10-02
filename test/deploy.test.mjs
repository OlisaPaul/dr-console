import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = name => readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8');
const installer = read('install-rhel.sh');

test('archival defaults agree across installer, environment and Nginx', () => {
  assert.ok(installer.includes('CONSOLE_HOST="${CONSOLE_HOST:-10.3.0.151}"'));
  assert.match(read('console.env'), /^CONVOX_PUBLIC_ORIGIN=https:\/\/10\.3\.0\.151$/m);
  assert.match(read('console.env'), /^CONVOX_MODE=simulation$/m);
  assert.match(read('convox-dr-console.conf'), /listen 443 ssl;/);
  assert.match(read('convox-dr-console.conf'), /server_name 10\.3\.0\.151;/);
  assert.match(read('convox-dr-console.conf'), /proxy_pass http:\/\/127\.0\.0\.1:4180;/);
  assert.equal(installer.includes('10.3.0.150'), false);
});

test('installer host validator accepts valid management hosts and rejects unsafe input', () => {
  const match = installer.match(/node --input-type=module -e '([^']+)' "\$CONSOLE_HOST" \|\| fail/);
  assert.ok(match, 'Host validator must exist before installation');
  for (const host of ['10.3.0.151', 'archival', 'archival.example.internal']) {
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', match[1], host]).status, 0, host);
  }
  for (const host of ['999.3.0.151', 'https://10.3.0.151', 'host:443', 'bad..host', '-bad.example', 'bad;host', 'host|injection', 'host\nvalue', 'a'.repeat(64)+'.internal']) {
    assert.notEqual(spawnSync(process.execPath, ['--input-type=module', '-e', match[1], host]).status, 0, host);
  }
});
