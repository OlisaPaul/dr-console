import test from 'node:test';
import assert from 'node:assert/strict';
import { HookAdapter } from '../lib/adapters.mjs';
import { initialState, LOCAL_TABLES } from '../lib/model.mjs';

test('recovery hooks must preserve destination notifications as well as licence', async () => {
  const adapter = new HookAdapter({ executable: '/not/executed', args: [] });
  let request;
  adapter.call = async payload => { request = payload; return { ok: true, preservedLocalTables: [...LOCAL_TABLES] }; };
  await adapter.execute(initialState(), 'rejoin', { key: 'preserve', host: 'production', title: 'Preserve local data' }, { jobId: 'fixture' });
  assert.deepEqual(request.preserveLocalTables, ['convoxcces_global.convoxccs_license_details', 'convoxcces_global.convoxccs_notifications', 'convoxcces_global.convoxccs_servers', 'convoxcces_global.convoxccs_web_servers']);
  adapter.call = async () => ({ ok: true, preservedLocalTables: [LOCAL_TABLES[0]] });
  await assert.rejects(adapter.execute(initialState(), 'rejoin', { key: 'preserve', host: 'production' }, { jobId: 'fixture' }), /notification table preservation/);
});
