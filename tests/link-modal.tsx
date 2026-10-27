import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LinkModal from '../components/LinkModal';
import type { LinkItem, IconSourceType } from '../types';

// Run in a real browser: native constraint validation happens before onSubmit,
// so invoking the React save handler directly would miss this regression.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const categories = [{ id: 'common', name: 'Common' }];
const results: string[] = [];

async function checkTitle(name: string, run: (host: HTMLDivElement, saves: any[], render: (isOpen?: boolean) => Promise<void>) => Promise<void>, provider = 'openai', apiKey = 'test-key') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const saves: any[] = [];
  const originalFetch = globalThis.fetch;
  const render = async (isOpen = true) => {
    await act(async () => root.render(<LinkModal isOpen={isOpen} categories={categories}
      aiConfig={{ provider, apiKey, baseUrl: 'https://ai.example/v1', model: 'test-model' } as any}
      onClose={() => {}} onSave={link => saves.push(link)} />));
  };
  try {
    await render();
    await run(host, saves, render);
    results.push(`PASS ${name}`);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    host.remove();
  }
}

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

async function input(host: HTMLDivElement, id: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const titleButton = (host: HTMLDivElement) => host.querySelector<HTMLButtonElement>('[aria-label="AI 自动填写标题"]')!;
const titleValue = (host: HTMLDivElement) => host.querySelector<HTMLInputElement>('#link-title')!.value;

async function waitForTitle(host: HTMLDivElement) {
  const deadline = Date.now() + 2000;
  while (titleButton(host).disabled && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(!titleButton(host).disabled, 'Title request did not finish');
}

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
  await checkTitle('Title AI requires a URL and an API key', async host => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Unexpected network call'); };
    expect(titleButton(host).disabled, 'Title AI should be disabled without URL');
    await input(host, 'link-url', 'example.com');
    await act(async () => titleButton(host).click());
    expect(calls === 0 && titleValue(host) === '', 'Missing key should not call AI or fill title');
  }, 'openai', '');
  for (const provider of ['openai', 'claude', 'google']) {
    await checkTitle(`${provider}: fill an empty title from URL and save`, async (host, saves) => {
      let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls++;
        expect(String(init?.body).includes('https://example.com/'), 'Prompt must contain normalized URL');
        const data = provider === 'google'
          ? { candidates: [{ content: { role: 'model', parts: [{ text: '示例网站' }] } }] }
          : provider === 'claude' ? { content: [{ type: 'text', text: '示例网站' }] }
          : { choices: [{ message: { content: '示例网站' } }] };
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      };
      await input(host, 'link-url', 'example.com');
      await act(async () => titleButton(host).click());
      await waitForTitle(host);
      expect(calls === 1 && titleValue(host) === '示例网站', `Expected generated title from ${provider}, got ${titleValue(host)} (${calls} calls)`);
      await act(async () => host.querySelector('form')!.requestSubmit());
      expect(saves.length === 1 && saves[0].title === '示例网站' && saves[0].url === 'https://example.com', 'Generated title should save');
    }, provider);
  }
  await checkTitle('AI failures preserve the current title and allow retry', async host => {
    await input(host, 'link-url', 'example.com');
    await input(host, 'link-title', '原标题');
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }));
    await act(async () => titleButton(host).click());
    expect(titleValue(host) === '原标题' && !titleButton(host).disabled, 'Empty AI response must preserve title');
    globalThis.fetch = async () => { throw new Error('Simulated network failure'); };
    await act(async () => titleButton(host).click());
    expect(titleValue(host) === '原标题' && !titleButton(host).disabled, 'Network failure must preserve title');
  });
  for (const action of ['title', 'url', 'close', 'save']) {
    await checkTitle(`Late AI response is ignored after ${action}`, async (host, saves, render) => {
      let resolve!: (response: Response) => void;
      globalThis.fetch = async () => new Promise<Response>(done => { resolve = done; });
      await input(host, 'link-url', 'example.com');
      await input(host, 'link-title', '原标题');
      await act(async () => titleButton(host).click());
      expect(titleButton(host).disabled, 'Button should be disabled during generation');
      if (action === 'title') await input(host, 'link-title', '手动标题');
      if (action === 'url') await input(host, 'link-url', 'other.example.com');
      if (action === 'close') { await render(false); await render(); }
      if (action === 'save') await act(async () => host.querySelector('form')!.requestSubmit());
      await act(async () => {
        resolve(new Response(JSON.stringify({ choices: [{ message: { content: '过期标题' } }] })));
      });
      const expected = action === 'title' ? '手动标题' : action === 'close' ? '' : '原标题';
      expect(titleValue(host) === expected, 'Late result overwrote the form');
      if (action === 'save') expect(saves.length === 1 && saves[0].title === '原标题', 'Save should use current title');
    });
  }
  await checkTitle('Unsupported URL schemes do not call AI', async host => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Unexpected network call'); };
    await input(host, 'link-url', 'javascript:alert(1)');
    await act(async () => titleButton(host).click());
    expect(calls === 0 && titleValue(host) === '', 'Invalid URL should not generate a title');
  });
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
