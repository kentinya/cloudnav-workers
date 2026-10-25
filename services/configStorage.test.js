import assert from 'node:assert/strict';
import test from 'node:test';
import { saveConfigSections } from './configStorage.js';

test('settings use one batch request and await an acknowledged commit', async t => {
  const sections = { ai: { apiKey: 'secret' }, website: { icp: 'new' }, icon: { source: 'google' } };
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.headers['x-auth-password'], 'token');
    assert.deepEqual(JSON.parse(options.body), { saveConfig: 'batch', configs: sections, configVersion: 'old' });
    await held;
    return Response.json({ success: true }, { headers: { 'X-Config-Version': 'new' } });
  });
  let completed = false;
  const save = saveConfigSections(sections, 'token', 'old').then(version => { completed = true; return version; });
  assert.deepEqual(calls, ['/api/storage']);
  assert.equal(completed, false);
  release();
  assert.equal(await save, 'new');
});

test('settings cache synchronization loads a revision and never writes if hydration fails', async t => {
  const calls = [];
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    if (!options.method) return Response.json({ configVersion: 'loaded' });
    assert.equal(JSON.parse(options.body).configVersion, 'loaded');
    return Response.json({ success: true }, { headers: { 'X-Config-Version': 'saved' } });
  });
  assert.equal(await saveConfigSections({ weather: {} }, 'token'), 'saved');
  assert.equal(calls.length, 2);
  mock.mock.mockImplementation(async () => new Response('unauthorized', { status: 401 }));
  await assert.rejects(saveConfigSections({ weather: {} }, 'token'), /读取云端设置失败/);
  assert.equal(mock.mock.callCount(), 3);
});

test('failed, ambiguous or unacknowledged settings saves cannot report success', async t => {
  const responses = [
    () => Response.json({ error: '冲突' }, { status: 409 }),
    () => Response.json({ success: false }),
    () => Response.json({ success: true }),
    () => new Response('not JSON'),
    () => { throw new Error('network failed'); },
  ];
  const mock = t.mock.method(globalThis, 'fetch', async () => responses.shift()());
  for (let i = 0; i < 5; i++) await assert.rejects(saveConfigSections({ ai: {} }, 'token', 'old'));
  assert.equal(mock.mock.callCount(), 5);
});
