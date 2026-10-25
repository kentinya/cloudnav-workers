import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LinkModal from '../components/LinkModal';
import type { LinkItem, IconSourceType } from '../types';

// Run in a real browser: native constraint validation happens before onSubmit,
// so invoking the React save handler directly would miss this regression.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const categories = [{ id: 'common', name: 'Common' }];
const results: string[] = [];

async function check(name: string, iconType: IconSourceType, icon: string, valid = true, fetchIcon = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const saves: any[] = [];
  const initialData: LinkItem = {
    id: 'existing', title: 'Example', url: 'https://example.com/path',
    categoryId: 'common', createdAt: 1, iconType, icon,
  };
  try {
    await act(async () => {
      root.render(<LinkModal isOpen categories={categories} initialData={initialData}
        aiConfig={{} as any} onClose={() => {}} onSave={link => saves.push(link)} />);
    });
    if (fetchIcon) {
      const button = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === '获取图标');
      if (!button) throw new Error('Missing fetch icon button');
      await act(async () => button.click());
    }
    const form = host.querySelector('form')!;
    if (form.checkValidity() !== valid) throw new Error(`Unexpected native validity: ${form.checkValidity()}`);
    // requestSubmit runs the same native validation as clicking 保存.
    await act(async () => form.requestSubmit());
    if (saves.length !== (valid ? 1 : 0)) throw new Error(`Unexpected save count: ${saves.length}`);
    if (valid) {
      const saved = saves[0];
      const expectedIcon = fetchIcon ? '/api/favicon?domain=example.com' : icon;
      if (saved.icon !== expectedIcon || saved.iconType !== iconType || saved.url !== initialData.url ||
          saved.title !== initialData.title || saved.categoryId !== initialData.categoryId) {
        throw new Error('Saved bookmark or icon changed unexpectedly');
      }
    }
    results.push(`PASS ${name}`);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

try {
  await check('Google: fetch icon then save an edited bookmark', 'google', '', true, true);
  await check('Favicon Extractor: fetch icon then save', 'faviconextractor', '', true, true);
  await check('Reopen and save a stored relative favicon path', 'google', '/api/favicon?domain=example.com');
  await check('Empty favicon still saves', 'google', '');
  await check('External HTTPS favicon still saves', 'google', 'https://example.com/icon.png');
  await check('Invalid favicon text cannot submit', 'google', 'not an icon URL', false);
  await check('Malformed external favicon cannot submit', 'google', 'https://?', false);
  await check('Unsafe favicon scheme cannot submit', 'google', 'javascript:alert(1)', false);
  await check('Custom external URL still saves', 'customurl', 'https://example.com/icon.png');
  await check('Invalid custom URL cannot submit', 'customurl', 'not an icon URL', false);
  await check('Uploaded R2 relative icon path still saves', 'upload-cloudflare', '/api/favicon?key=common%2Ficon.png');
  results.push(`\n${results.length} tests passed`);
  document.documentElement.dataset.testStatus = 'passed';
} catch (error) {
  results.push(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  document.documentElement.dataset.testStatus = 'failed';
  console.error(error);
}
document.getElementById('results')!.textContent = results.join('\n');
// Let the optional local runner collect results without a browser automation dependency.
import.meta.hot?.send('link-modal-results', { status: document.documentElement.dataset.testStatus, results });
