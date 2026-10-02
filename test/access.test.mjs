import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedAddresses } from '../lib/access.mjs';

test('default deployment accepts only localhost hosts and origins', () => {
  const { origins, hosts } = allowedAddresses(4180);
  assert.equal(hosts.has('10.3.0.150'), false);
  assert.equal(origins.has('https://10.3.0.150'), false);
  assert.equal(hosts.has('127.0.0.1:4180'), true);
});
test('explicit proxy origin permits DR without accepting unrelated hosts or schemes', () => {
  const { origins, hosts } = allowedAddresses(4180, 'https://10.3.0.150');
  assert.equal(hosts.has('10.3.0.150'), true);
  assert.equal(origins.has('https://10.3.0.150'), true);
  assert.equal(origins.has('http://10.3.0.150'), false);
  assert.equal(hosts.has('10.3.0.150.attacker.example'), false);
  assert.equal(origins.has('https://attacker.example'), false);
});
test('alternate TLS port is treated as a distinct origin', () => {
  const { origins, hosts } = allowedAddresses(4180, 'https://10.3.0.150:8443');
  assert.equal(hosts.has('10.3.0.150:8443'), true);
  assert.equal(origins.has('https://10.3.0.150:8443'), true);
  assert.equal(hosts.has('10.3.0.150'), false);
});
test('archival origin permits the management host, not the managed servers', () => {
  const { origins, hosts } = allowedAddresses(4180, 'https://10.3.0.151');
  assert.equal(hosts.has('10.3.0.151'), true);
  assert.equal(origins.has('https://10.3.0.151'), true);
  assert.equal(hosts.has('10.3.0.150'), false);
  assert.equal(hosts.has('10.81.0.11'), false);
  assert.equal(origins.has('http://10.3.0.151'), false);
});
test('origins with credentials, non-root paths or queries are rejected', () => {
  for (const origin of ['https://user:password@10.3.0.150', 'https://10.3.0.150/console', 'https://10.3.0.150/?token=x', 'file:///etc/passwd', 'https://10.3.0.150/#x']) {
    assert.throws(() => allowedAddresses(4180, origin));
  }
});
