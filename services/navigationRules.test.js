import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBackupNavigation, assertCategoryDeletionAllowed } from './navigationRules.js';

test('category editor blocks public/private bookmarks but allows empty categories', () => {
  for (const visibility of ['public', 'private']) {
    const categories = [{ id: 'full', visibility }, { id: 'empty', visibility }];
    const links = [{ id: 'bookmark', categoryId: 'full', pinned: true }];
    assert.throws(() => assertCategoryDeletionAllowed(categories, [categories[1]], links), /请先手动移动或删除书签/);
    assert.doesNotThrow(() => assertCategoryDeletionAllowed(categories, [categories[0]], links));
    assert.equal(links[0].categoryId, 'full');
  }
  assert.throws(() => assertCategoryDeletionAllowed([{ id: 'common' }], [], [{ id: 'legacy' }]), /请先手动移动或删除书签/);
});

test('backup validation accepts empty data and preserves private hierarchies without rewriting bookmarks', () => {
  assert.doesNotThrow(() => assertBackupNavigation([], []));
  const categories = [
    { id: 'parent', name: 'Private', visibility: 'private', password: 'secret' },
    { id: 'child', name: 'Child', parentId: 'parent', visibility: 'public' },
  ];
  const links = [{ id: 'bookmark', categoryId: 'child', pinned: true }];
  const before = JSON.stringify({ links, categories });
  assert.doesNotThrow(() => assertBackupNavigation(links, categories));
  assert.equal(JSON.stringify({ links, categories }), before);
});

test('backup validation rejects dangling references, duplicate IDs and missing private passwords', () => {
  const categories = [{ id: 'public', name: 'Public' }];
  for (const links of [null, {}, [null], [{ id: 'x' }], [{ id: 'x', categoryId: 'old-private' }], [{ id: 'x', categoryId: 'public' }, { id: 'x', categoryId: 'public' }]]) {
    assert.throws(() => assertBackupNavigation(links, categories));
  }
  for (const invalid of [null, {}, [null], [{ id: 'x', name: '' }], [...categories, ...categories],
    [{ id: 'x', name: 'X', parentId: 'old-parent' }],
    [{ id: 'x', name: 'X', parentId: 'x' }],
    [{ id: 'x', name: 'X', parentId: 'y' }, { id: 'y', name: 'Y', parentId: 'x' }],
    [{ id: 'x', name: 'X', visibility: 'private', hasPassword: true }],
    [{ id: 'x', name: 'X', visibility: 'invalid' }]]) {
    assert.throws(() => assertBackupNavigation([], invalid));
  }
});
