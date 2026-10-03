import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { initialState } from '../lib/model.mjs';

test('read-only overview renders unknown topology without demo claims or enabled recovery', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const cutoff = source.lastIndexOf('try {\n  const session = await fetch');
  assert.ok(cutoff > 0);
  const main = { innerHTML: '', addEventListener() {}, querySelectorAll: () => [], querySelector: () => null };
  const node = { addEventListener() {} };
  const document = { activeElement: null, querySelector: id => id === '#main' ? main : node, querySelectorAll: () => [] };
  const view = initialState();
  view.mode = 'observe'; view.active = null; view.fileSource = null; view.checkedAt = null;
  view.actions = Object.fromEntries(['failover', 'rejoin', 'failback'].map(a => [a, { allowed: false, reason: 'Live monitoring only' }]));
  for (const server of Object.values(view.servers)) Object.assign(server, { reachable: false, readOnly: null, role: 'unknown', fenced: false, services: 'unverified', fileSync: 'unverified', gtid: null });
  vm.runInNewContext(source.slice(0, cutoff) + '\nstate = fixture; render();', { document, fixture: view, clearTimeout, setTimeout });
  assert.match(main.innerHTML, /Live monitoring · read-only/);
  assert.match(main.innerHTML, /Not verified/);
  assert.match(main.innerHTML, /File consistency not verified/);
  assert.equal(main.innerHTML.includes('AUTHORITATIVE'), false);
  assert.equal(main.innerHTML.includes('Database + recordings'), false);
  assert.equal(main.innerHTML.includes('Demo records saved'), false);
  assert.equal((main.innerHTML.match(/data-action="(?:failover|rejoin|failback)" disabled/g) || []).length, 3);
});
