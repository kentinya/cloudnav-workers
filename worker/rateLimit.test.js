import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnv, request, login } from './testUtils.js';
import { AUTH_LIMITS, AUTH_WINDOW_MS } from './api/_rateLimit.js';

test('administrator password attempts share a bounded budget across login and legacy header routes', async () => {
  const env = createEnv();
  const token = await login(env);
  const headers = { 'CF-Connecting-IP': '203.0.113.1' };
  for (let attempt = 0; attempt < AUTH_LIMITS.admin.client; attempt++) {
    const response = attempt % 2
      ? await request(env, '/api/storage?checkAuth=true', { token: `wrong-${attempt}`, headers })
      : await request(env, '/api/auth', { data: { password: 'wrong' }, headers });
    assert.equal(response.status, attempt % 2 ? 200 : 401);
  }
  const blocked = await request(env, '/api/auth', { data: { password: env.PASSWORD }, headers });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal(blocked.headers.get('Set-Cookie'), null);
  assert.equal((await request(env, '/api/link', { data: { title: 'test', url: 'https://example.com' }, token: env.PASSWORD, headers })).status, 429);
  assert.equal((await request(env, '/api/storage?checkAuth=true', { token, headers })).status, 200);
  assert.equal((await request(env, '/api/auth', { data: { password: env.PASSWORD }, headers: { 'CF-Connecting-IP': '203.0.113.2' } })).status, 200);
});

test('spoofed forwarded headers cannot reset limits and the window expires', async t => {
  const env = createEnv();
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  for (let i = 0; i < AUTH_LIMITS.admin.client; i++) {
    assert.equal((await request(env, '/api/auth', { data: { password: 'wrong' }, headers: { 'X-Forwarded-For': `1.1.1.${i}` } })).status, 401);
  }
  assert.equal((await request(env, '/api/auth', { data: { password: 'wrong' }, headers: { 'X-Real-IP': '8.8.8.8' } })).status, 429);
  clock.mock.mockImplementation(() => now + AUTH_WINDOW_MS + 1);
  assert.equal((await request(env, '/api/auth', { data: { password: env.PASSWORD } })).status, 200);
});

test('private category guesses share limits across category IDs before password hashing', async () => {
  const env = createEnv();
  await env.CLOUDNAV_KV.put('cate_config', JSON.stringify(['one', 'two'].map(id => ({ id, name: id, visibility: 'private', password: 'secret' }))));
  for (let i = 0; i < AUTH_LIMITS.category.client; i++) {
    const response = await request(env, '/api/category-auth', { data: { categoryId: i % 2 ? 'one' : 'two', password: 'wrong' } });
    assert.equal(response.status, 401);
  }
  const blocked = await request(env, '/api/category-auth', { data: { categoryId: 'two', password: 'secret' } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal(blocked.headers.get('Set-Cookie'), null);
  assert.equal((await request(env, '/api/category-auth', { data: { categoryId: 'one', password: 'secret' }, headers: { 'CF-Connecting-IP': '198.51.100.2' } })).status, 200);
  assert.equal((await request(env, '/api/auth', { data: { password: env.PASSWORD } })).status, 200);
});

test('parallel guesses cannot bypass the counter and distributed clients hit the total budget', async () => {
  const env = createEnv();
  const responses = await Promise.all(Array.from({ length: 30 }, () => request(env, '/api/auth', { data: { password: 'wrong' } })));
  assert.ok(responses.filter(response => response.status === 401).length <= AUTH_LIMITS.admin.client);
  assert.ok(responses.some(response => response.status === 429));
  const distributed = createEnv();
  for (let i = 0; i < AUTH_LIMITS.admin.total; i++) {
    assert.equal((await request(distributed, '/api/auth', { data: { password: 'wrong' }, headers: { 'CF-Connecting-IP': `198.51.100.${i}` } })).status, 401);
  }
  assert.equal((await request(distributed, '/api/auth', { data: { password: distributed.PASSWORD }, headers: { 'CF-Connecting-IP': '8.8.8.8' } })).status, 429);
});

test('limiter storage errors fail closed without issuing sessions or category grants', async t => {
  const env = createEnv();
  await env.CLOUDNAV_KV.put('cate_config', '[{"id":"private","visibility":"private","password":"secret"}]');
  const put = env.CLOUDNAV_R2.put.bind(env.CLOUDNAV_R2);
  t.mock.method(env.CLOUDNAV_R2, 'put', async (key, ...args) => {
    if (key.startsWith('__cloudnav/rate/')) throw new Error('unavailable');
    return put(key, ...args);
  });
  assert.equal((await request(env, '/api/auth', { data: { password: env.PASSWORD } })).status, 503);
  assert.equal((await request(env, '/api/category-auth', { data: { categoryId: 'private', password: 'secret' } })).status, 503);
  assert.equal(await env.CLOUDNAV_KV.get('last_token'), null);
});
