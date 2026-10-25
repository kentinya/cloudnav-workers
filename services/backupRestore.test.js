import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreBackup } from './backupRestore.js';

test('local/WebDAV restore awaits persistence before applying settings and completing', async () => {
  const data = {
    links: [{ id: 'private-bookmark', categoryId: 'private', pinned: true }],
    categories: [{ id: 'private', name: 'Private', visibility: 'private', password: 'secret' }],
    searchConfig: { mode: 'internal' }, aiConfig: { enabled: false },
  };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const restore = restoreBackup(data, {
    onRestore: async (links, categories) => {
      assert.deepEqual(links, data.links);
      assert.deepEqual(categories, data.categories);
      calls.push('saving');
      await pending;
      calls.push('saved');
    },
    onRestoreSearchConfig: config => { assert.deepEqual(config, data.searchConfig); calls.push('search'); },
    onRestoreAIConfig: config => { assert.deepEqual(config, data.aiConfig); calls.push('ai'); },
  }).then(() => calls.push('success'));
  assert.deepEqual(calls, ['saving']);
  release();
  await restore;
  assert.deepEqual(calls, ['saving', 'saved', 'search', 'ai', 'success']);
});

test('failed restore propagates the server error and never applies settings or reports success', async () => {
  const calls = [];
  await assert.rejects(restoreBackup({ links: [], categories: [], searchConfig: {}, aiConfig: {} }, {
    onRestore: async () => { throw new Error('导航已被其他操作修改'); },
    onRestoreSearchConfig: () => calls.push('search'),
    onRestoreAIConfig: () => calls.push('ai'),
  }).then(() => calls.push('success')), /导航已被其他操作修改/);
  assert.deepEqual(calls, []);
});

test('invalid backup is rejected before uploads or navigation writes', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected upload'); });
  let writes = 0;
  await assert.rejects(restoreBackup({
    categories: [], links: [{ id: 'private', categoryId: 'missing' }],
    uploadedIcons: [{ key: 'private/icon.png', data: 'data:image/png;base64,AAAA' }],
  }, { onRestore: async () => { writes++; } }), /目标分类不存在/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(writes, 0);
});
