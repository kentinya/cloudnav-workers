import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnv, request, login } from './testUtils.js';

async function read(env, token) {
  const response = await request(env, '/api/storage?key=config&admin=true', { token });
  assert.equal(response.status, 200);
  const data = await response.json();
  return { config: JSON.parse(data.value), version: data.configVersion };
}

test('settings batch publishes all sections together and legacy keys cannot resurrect old settings', async () => {
  const env = createEnv();
  const token = await login(env);
  await env.CLOUDNAV_KV.put('config', JSON.stringify({ website: { icp: 'legacy' }, preferences: { keep: true }, webdav: { url: 'https://dav.example' } }));
  await env.CLOUDNAV_KV.put('config:weather', '{"enabled":false}');
  const before = await read(env, token);
  const configs = { website: { icp: 'new' }, weather: { enabled: true }, mastodon: { source: 'custom', customItems: ['hello'] }, ai: { apiKey: 'secret' } };
  const saved = await request(env, '/api/storage', { token, data: { saveConfig: 'batch', configVersion: before.version, configs } });
  assert.equal(saved.status, 200);
  const after = await read(env, token);
  assert.equal(after.version, saved.headers.get('X-Config-Version'));
  for (const [section, config] of Object.entries(configs)) {
    assert.deepEqual(after.config[section], config);
    assert.deepEqual(await (await request(env, `/api/storage?getConfig=${section}`, { token })).json(), config);
  }
  assert.deepEqual(after.config.ticker, configs.mastodon);
  assert.deepEqual(after.config.webdav, before.config.webdav);
  assert.deepEqual(after.config.preferences, before.config.preferences);
  await env.CLOUDNAV_KV.put('config:website', '{"icp":"stale"}');
  assert.deepEqual(await read(env, token), after);
  assert.doesNotMatch(await (await request(env, '/api/storage?getConfig=ai')).text(), /secret|apiKey/);
});

test('failed publication, invalid batches and stale revisions leave the complete previous settings intact', async t => {
  const env = createEnv();
  const token = await login(env);
  await env.CLOUDNAV_KV.put('config', '{"website":{"icp":"old"},"ai":{"apiKey":"old-key"}}');
  const before = await read(env, token);
  const batch = { saveConfig: 'batch', configVersion: before.version, configs: { website: { icp: 'new' }, ai: { apiKey: 'new-key' } } };
  const put = env.CLOUDNAV_R2.put.bind(env.CLOUDNAV_R2);
  const mock = t.mock.method(env.CLOUDNAV_R2, 'put', async (key, ...args) => {
    if (key === '__cloudnav/config') throw new Error('R2 unavailable');
    return put(key, ...args);
  });
  t.mock.method(console, 'error', () => {});
  const failed = await request(env, '/api/storage', { token, data: batch });
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('X-Config-Version'), null);
  assert.deepEqual(await read(env, token), before);
  mock.mock.restore();
  for (const configs of [{ website: {}, invalid: {} }, { website: {}, ai: null }, [], {}]) {
    assert.equal((await request(env, '/api/storage', { token, data: { ...batch, configs } })).status, 400);
    assert.deepEqual(await read(env, token), before);
  }
  assert.equal((await request(env, '/api/storage', { token, data: { ...batch, configVersion: undefined } })).status, 428);
  assert.equal((await request(env, '/api/storage', { token, data: { ...batch, configVersion: 'stale' } })).status, 409);
  assert.equal((await request(env, '/api/storage', { data: batch })).status, 401);
  assert.deepEqual(await read(env, token), before);
});

test('concurrent settings batches admit only one complete snapshot, including the first save', async () => {
  for (const initialized of [false, true]) {
    const env = createEnv();
    const token = await login(env);
    if (initialized) await request(env, '/api/storage', { token, data: { saveConfig: 'website', config: { icp: 'initial' } } });
    const before = await read(env, token);
    const batches = ['one', 'two'].map(value => ({ website: { icp: value }, ai: { apiKey: value } }));
    const responses = await Promise.all(batches.map(configs => request(env, '/api/storage', { token, data: { saveConfig: 'batch', configVersion: before.version, configs } })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const after = await read(env, token);
    const winner = batches[responses.findIndex(response => response.status === 200)];
    assert.deepEqual(after.config.website, winner.website);
    assert.deepEqual(after.config.ai, winner.ai);
  }
});

test('single-section and raw configuration saves use the same revision and affect login expiry', async () => {
  const env = createEnv();
  let token = await login(env);
  const before = await read(env, token);
  assert.equal((await request(env, '/api/storage', { token, data: { key: 'config:website', value: JSON.stringify({ passwordExpiry: { value: 2, unit: 'day' } }) } })).status, 200);
  const after = await read(env, token);
  assert.notEqual(after.version, before.version);
  assert.equal((await request(env, '/api/storage', { token, data: { saveConfig: 'batch', configVersion: before.version, configs: { ai: {} } } })).status, 409);
  token = await login(env);
  const session = await (await env.CLOUDNAV_R2.get(`__cloudnav/session/${token}`)).json();
  assert.ok(Math.abs(session.expiresAt - Date.now() - 172800000) < 5000);
  assert.equal((await request(env, '/api/storage', { token, data: { key: 'config', value: '{"ai":{"websiteTitle":"raw"}}' } })).status, 200);
  assert.equal((await read(env, token)).config.ai.websiteTitle, 'raw');
});

test('settings read failures cannot be mistaken for defaults and overwrite saved configuration', async t => {
  const env = createEnv();
  const token = await login(env);
  const before = await read(env, token);
  const get = env.CLOUDNAV_R2.get.bind(env.CLOUDNAV_R2);
  t.mock.method(env.CLOUDNAV_R2, 'get', async key => {
    if (key === '__cloudnav/config') throw new Error('read unavailable');
    return get(key);
  });
  const put = t.mock.method(env.CLOUDNAV_R2, 'put');
  t.mock.method(console, 'error', () => {});
  assert.equal((await request(env, '/api/storage?key=config', { token })).status, 500);
  assert.equal((await request(env, '/api/storage', { token, data: { saveConfig: 'batch', configVersion: before.version, configs: { website: {} } } })).status, 500);
  assert.equal(put.mock.callCount(), 0);
});

test('the configuration middleware still delegates navigation deletes to the navigation transaction', async () => {
  const env = createEnv();
  const token = await login(env);
  await request(env, '/api/storage', { token, data: { categories: [{ id: 'common', name: 'Public' }], links: [{ id: 'bookmark', categoryId: 'common' }] } });
  const snapshot = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json();
  const categories = [{ id: 'common', name: 'Public' }];
  assert.equal((await request(env, '/api/storage', { token, data: { categories, links: [], version: snapshot.version } })).status, 200);
  const saved = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json();
  assert.deepEqual(saved.links, []);
  assert.equal(await env.CLOUDNAV_KV.get('links:common'), '[]');
});
