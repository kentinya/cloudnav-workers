import assert from 'node:assert/strict';
import test from 'node:test';
import { navigationTransaction, NAVIGATION_HEAD } from './api/_navigation.js';
import { createEnv, request, login } from './testUtils.js';

async function read(env, token) {
  const response = await request(env, '/api/storage?getConfig=true&admin=true', { token });
  assert.equal(response.status, 200);
  return response.json();
}

async function fixture() {
  const operations = [];
  const env = createEnv((operation, key, value, options) => operations.push({ operation, key, value, options }));
  const token = await login(env);
  const categories = ['common', 'a', 'b', 'empty'].map(id => ({ id, name: id, visibility: 'public' }));
  const links = ['common', 'a', 'b'].map(id => ({ id: `bookmark-${id}`, categoryId: id, title: id }));
  assert.equal((await request(env, '/api/storage', { token, data: { categories, links } })).status, 200);
  const snapshot = await read(env, token);
  const head = await (await env.CLOUDNAV_R2.get(NAVIGATION_HEAD)).json();
  const previousRaw = await env.CLOUDNAV_KV.get(head.key);
  operations.length = 0;
  return { env, token, operations, snapshot, head, previousRaw };
}

function assertWrites(operations, previousKey, mirrors) {
  const snapshots = operations.filter(({ key }) => key.startsWith('navigation_snapshot:'));
  assert.equal(snapshots.length, previousKey ? 2 : 1);
  const fresh = snapshots.filter(({ key }) => key !== previousKey);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].operation, 'put');
  assert.equal(fresh[0].options, undefined);
  if (previousKey) {
    const retired = snapshots.find(({ key }) => key === previousKey);
    assert.equal(retired.operation, 'put');
    assert.deepEqual(retired.options, { expirationTtl: 86400 });
  }
  assert.deepEqual(operations.filter(({ key }) => !key.startsWith('navigation_snapshot:'))
    .map(({ operation, key }) => `${operation} ${key}`).sort(), mirrors.sort());
  assert.equal(operations.length, snapshots.length + mirrors.length);
}

test('first publication writes only changed compatibility keys', async () => {
  const operations = [];
  const env = createEnv((operation, key) => operations.push({ operation, key }));
  const token = await login(env);
  operations.length = 0;
  const categories = ['common', 'empty'].map(id => ({ id, name: id, visibility: 'public' }));
  const links = [{ id: 'bookmark', categoryId: 'common' }];
  assert.equal((await request(env, '/api/storage', { token, data: { categories, links } })).status, 200);
  assertWrites(operations, null, ['put cate_config', 'put links:common']);
  assert.equal(await env.CLOUDNAV_KV.get('links:empty'), null);
  assert.deepEqual((await read(env, token)).links, links);
});

test('editing one bookmark rewrites only its bucket and preserves the old snapshot grace period', async () => {
  const { env, token, operations, snapshot, head, previousRaw } = await fixture();
  const links = snapshot.links.map(link => link.categoryId === 'a' ? { ...link, title: 'edited' } : link);
  const response = await request(env, '/api/storage', { token, data: { categories: snapshot.categories, links, version: snapshot.version } });
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get('X-Navigation-Version'), snapshot.version);
  assertWrites(operations, head.key, ['put links:a']);
  assert.equal(await env.CLOUDNAV_KV.get(head.key), previousRaw);
  assert.deepEqual((await read(env, token)).links, links);
});

test('category edits and ordering do not rewrite unchanged bookmark mirrors', async () => {
  for (const reorder of [false, true]) {
    const { env, token, operations, snapshot, head } = await fixture();
    const categories = reorder ? [...snapshot.categories].reverse()
      : snapshot.categories.map(category => category.id === 'a' ? { ...category, name: 'renamed' } : category);
    assert.equal((await request(env, '/api/storage', { token, data: { categories, links: snapshot.links } })).status, 200);
    assertWrites(operations, head.key, ['put cate_config']);
    assert.deepEqual((await read(env, token)).categories, categories);
  }
});

test('moving and clearing bookmarks update only affected buckets, including the emptied source', async () => {
  for (const clear of [false, true]) {
    const { env, token, operations, snapshot, head } = await fixture();
    const links = clear ? snapshot.links.filter(link => link.categoryId !== 'a')
      : snapshot.links.map(link => link.categoryId === 'a' ? { ...link, categoryId: 'b' } : link);
    assert.equal((await request(env, '/api/storage', { token, data: { links } })).status, 200);
    assertWrites(operations, head.key, clear ? ['put links:a'] : ['put links:a', 'put links:b']);
    assert.equal(await env.CLOUDNAV_KV.get('links:a'), '[]');
    assert.deepEqual((await read(env, token)).links, links);
  }
});

test('removing an empty category deletes only its mirror and updates category configuration', async () => {
  const { env, token, operations, snapshot, head } = await fixture();
  const categories = snapshot.categories.filter(category => category.id !== 'empty');
  assert.equal((await request(env, '/api/storage', { token, data: { categories, links: snapshot.links } })).status, 200);
  assertWrites(operations, head.key, ['put cate_config', 'delete links:empty']);
  assert.equal(await env.CLOUDNAV_KV.get('links:empty'), null);
  assert.deepEqual((await read(env, token)).links, snapshot.links);
});

test('unchanged saves on all navigation routes perform zero KV writes and preserve the revision', async t => {
  const { env, token, operations, snapshot, head } = await fixture();
  const put = t.mock.method(env.CLOUDNAV_R2, 'put');
  const aLinks = snapshot.links.filter(link => link.categoryId === 'a');
  const bodies = [
    { categories: snapshot.categories, links: snapshot.links },
    { categories: snapshot.categories },
    { links: snapshot.links },
    { saveConfig: 'categories', categories: snapshot.categories },
    { saveConfig: 'links', links: snapshot.links },
    { saveConfig: 'links', categoryId: 'a', links: aLinks },
    { key: 'cate_config', value: JSON.stringify(snapshot.categories) },
    { key: 'links:a', value: JSON.stringify(aLinks) },
    // JSON whitespace and object field order do not change navigation data.
    { key: 'links:a', value: JSON.stringify(aLinks.map(({ id, categoryId, title }) => ({ title, categoryId, id })), null, 2) },
    { restore: true, categories: snapshot.categories, links: snapshot.links },
  ];
  for (const body of bodies) {
    const response = await request(env, '/api/storage', { token, data: { ...body, version: snapshot.version } });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(response.headers.get('X-Navigation-Version'), snapshot.version);
    assert.deepEqual(operations, []);
    assert.equal(put.mock.callCount(), 0);
    assert.deepEqual(await read(env, token), snapshot);
    assert.deepEqual(await (await env.CLOUDNAV_R2.get(NAVIGATION_HEAD)).json(), head);
  }
});

test('empty and legacy unchanged data do not create an initial snapshot', async t => {
  for (const populated of [false, true]) {
    const operations = [];
    const env = createEnv((operation, key) => operations.push({ operation, key }));
    const token = await login(env);
    if (populated) {
      await env.CLOUDNAV_KV.put('cate_config', '[{"id":"common","name":"Public","visibility":"public"}]');
      await env.CLOUDNAV_KV.put('links:common', '[{"id":"old","categoryId":"common"}]');
    }
    const snapshot = await read(env, token);
    operations.length = 0;
    const put = t.mock.method(env.CLOUDNAV_R2, 'put');
    const response = await request(env, '/api/storage', { token, data: { categories: snapshot.categories, links: snapshot.links, version: snapshot.version } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Navigation-Version'), snapshot.version);
    assert.deepEqual(operations, []);
    assert.equal(put.mock.callCount(), 0);
    assert.equal(await env.CLOUDNAV_R2.get(NAVIGATION_HEAD), null);
  }
});

test('unchanged saves still require the current navigation version', async () => {
  const { env, token, operations, snapshot } = await fixture();
  for (const [version, status] of [[undefined, 428], ['stale', 409]]) {
    const response = await request(env, '/api/storage', { token, unversioned: true,
      data: { categories: snapshot.categories, links: snapshot.links, version } });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('X-Navigation-Version'), null);
    assert.deepEqual(operations, []);
    assert.deepEqual(await read(env, token), snapshot);
  }
});

test('no-op commits reject a concurrent publication, including the first publication', async () => {
  for (const initialized of [false, true]) {
    const operations = [];
    const env = createEnv((operation, key) => operations.push({ operation, key }));
    if (initialized) {
      const initial = await navigationTransaction(env);
      await initial.kv.put('cate_config', '[{"id":"initial","name":"Initial","visibility":"public"}]');
      await initial.commit();
    }
    const noop = await navigationTransaction(env);
    const current = await noop.kv.get('cate_config');
    await noop.kv.put('cate_config', current);
    const winner = await navigationTransaction(env);
    await winner.kv.put('cate_config', JSON.stringify([...JSON.parse(current), { id: 'new', name: 'New', visibility: 'public' }]));
    await winner.commit();
    operations.length = 0;
    await assert.rejects(noop.commit(), { status: 409 });
    assert.equal(noop.committedVersion, undefined);
    assert.deepEqual(operations, []);
  }
});

test('concurrent changed commits publish only the winning mirrors and clean up the losing snapshot', async () => {
  const { env, operations, snapshot, head } = await fixture();
  const transactions = await Promise.all(['one', 'two'].map(async title => {
    const transaction = await navigationTransaction(env, snapshot.version, true);
    await transaction.kv.put('links:a', JSON.stringify([{ id: 'bookmark-a', categoryId: 'a', title }]));
    return transaction;
  }));
  const results = await Promise.allSettled(transactions.map(transaction => transaction.commit()));
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(operations.length, 5); // Two snapshots, one losing delete, one mirror, one retirement.
  assert.deepEqual(operations.filter(({ key }) => !key.startsWith('navigation_snapshot:')).map(({ operation, key }) => `${operation} ${key}`), ['put links:a']);
  const retired = operations.filter(({ key }) => key === head.key);
  assert.equal(retired.length, 1);
  assert.deepEqual(retired[0].options, { expirationTtl: 86400 });
  const deleted = operations.find(({ operation }) => operation === 'delete');
  assert.ok(deleted.key.startsWith('navigation_snapshot:'));
  assert.equal(await env.CLOUDNAV_KV.get(deleted.key), null);
});
