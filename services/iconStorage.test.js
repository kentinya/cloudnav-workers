import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getStoredIconUrls, normalizeLinkIcon, remapStoredIcon, restoreUploadedIcons,
} from './iconStorage.js';

test('older local icon metadata becomes R2 metadata without changing the original bookmark', () => {
  const original = {
    id: 'old', icon: '/api/favicon?key=Inbox%2Fimage.png',
    iconType: 'upload-edgeone', edgeoneBlobUrl: '/api/favicon?key=Inbox%2Fimage.png',
  };
  const normalized = normalizeLinkIcon(original);
  assert.equal(normalized.icon, original.icon);
  assert.equal(normalized.iconType, 'upload-cloudflare');
  assert.equal(normalized.cloudflareR2Url, original.icon);
  assert.equal('edgeoneBlobUrl' in normalized, false);
  assert.equal(original.iconType, 'upload-edgeone');
  assert.deepEqual(getStoredIconUrls(normalized), [original.icon]);
});

test('older externally hosted icons remain custom URLs and are never treated as local R2 files', () => {
  const original = { icon: 'https://old.example/icon.png', iconType: 'upload-edgeone' };
  const normalized = normalizeLinkIcon(original);
  assert.equal(normalized.icon, original.icon);
  assert.equal(normalized.iconType, 'customurl');
  assert.deepEqual(getStoredIconUrls(normalized), []);
});

test('restoring an icon rewrites encoded and unencoded keys and preserves other icon choices', () => {
  const newUrl = '/api/favicon?key=new%2Ficon.png';
  for (const oldUrl of ['/api/favicon?key=分类%2F图标.png', '/api/favicon?key=分类/图标.png']) {
    const updated = remapStoredIcon({ icon: oldUrl, iconType: 'upload' }, '分类/图标.png', newUrl);
    assert.equal(updated.icon, newUrl);
    assert.equal(updated.cloudflareR2Url, newUrl);
    assert.equal(updated.iconType, 'upload-cloudflare');
  }
  const updated = remapStoredIcon({
    icon: 'https://example.com/custom.png', iconType: 'customurl',
    cloudflareR2Url: '/api/favicon?key=分类%2F图标.png',
  }, '分类/图标.png', newUrl);
  assert.equal(updated.iconType, 'customurl');
  assert.equal(updated.icon, 'https://example.com/custom.png');
  assert.equal(updated.cloudflareR2Url, newUrl);
});

test('legacy backup platform labels are ignored while embedded files are restored to R2', async t => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: () => 'test-token' },
  });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
  });
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const uploads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === dataUrl) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(url, '/api/upload');
    assert.equal(options.headers['x-auth-password'], 'test-token');
    assert.equal(options.body.has('platform'), false);
    assert.ok(options.body.get('file') instanceof File);
    uploads.push(options.body.get('categoryName'));
    return Response.json({ success: true, url: '/api/favicon?key=new%2Ficon.png' });
  });
  const original = { icon: '/api/favicon?key=旧分类%2F图标.png', iconType: 'upload-edgeone' };
  const restored = await restoreUploadedIcons([
    { key: '旧分类/图标.png', platform: 'edgeone', data: dataUrl },
  ], [original]);
  assert.deepEqual(uploads, ['旧分类']);
  assert.equal(restored[0].iconType, 'upload-cloudflare');
  assert.equal(restored[0].icon, '/api/favicon?key=new%2Ficon.png');
  assert.equal(original.icon, '/api/favicon?key=旧分类%2F图标.png');
});
