import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as dns } from 'node:dns';
import worker from './index.js';
import { createEnv, request, login } from './testUtils.js';
import { fetchIcon, inspectIcon, publicURL, isPublicAddress, MAX_ICON_BYTES, MAX_UPLOAD_BYTES } from './api/_icons.js';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="a"><stop offset="0" stop-color="red"/></linearGradient></defs><path fill="url(#a)" d="M0 0h24v24H0z"/></svg>';
test.beforeEach(t => {
  t.mock.method(dns, 'resolve4', async () => ['93.184.216.34']);
  t.mock.method(dns, 'resolve6', async () => []);
});

async function upload(env, token, { bytes = png, name = 'icon.png', type = 'image/png', url, categoryName = 'test' } = {}) {
  const form = new FormData();
  if (url) form.set('url', url);
  else form.set('file', new File([bytes], name, { type }));
  form.set('categoryName', categoryName);
  return worker.fetch(new Request('https://cloudnav.example/api/upload', {
    method: 'POST', headers: { 'x-auth-password': token }, body: form,
  }), env);
}

test('upload ignores claimed MIME/extensions and stores the type detected from actual bytes', async () => {
  const env = createEnv();
  const token = await login(env);
  const uploaded = await upload(env, token, { name: 'fake.html', type: 'text/html' });
  assert.equal(uploaded.status, 200);
  const { url } = await uploaded.json();
  assert.match(new URL(url, 'https://cloudnav.example').searchParams.get('key'), /\.png$/);
  const served = await request(env, url, { token });
  assert.equal(served.headers.get('Content-Type'), 'image/png');
  assert.equal(served.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(served.headers.get('Content-Security-Policy'), /sandbox/);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png);
});

test('public remote images and static SVG still upload and read through the original endpoints', async t => {
  const env = createEnv();
  const token = await login(env);
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(png, { headers: { 'Content-Type': 'application/octet-stream' } }));
  const response = await upload(env, token, { url: 'https://public.example/fake.html' });
  assert.equal(response.status, 200);
  const { url } = await response.json();
  const icon = await request(env, url, { token });
  assert.equal(icon.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await icon.arrayBuffer()), png);
  assert.equal(network.mock.callCount(), 1);
  const svgResponse = await upload(env, token, { bytes: svg, name: 'icon.svg', type: 'image/svg+xml' });
  assert.equal(svgResponse.status, 200);
  const svgIcon = await request(env, (await svgResponse.json()).url, { token });
  assert.equal(svgIcon.headers.get('Content-Type'), 'image/svg+xml');
  assert.equal(await svgIcon.text(), svg);
});

test('image signatures support the existing bitmap formats and inert SVG', () => {
  const cases = [
    [png, 'image/png'], [new Uint8Array([255, 216, 255]), 'image/jpeg'],
    [new TextEncoder().encode('GIF89a'), 'image/gif'],
    [new Uint8Array([0, 0, 1, 0]), 'image/x-icon'],
    [new TextEncoder().encode('RIFF0000WEBP'), 'image/webp'],
    [new TextEncoder().encode(svg), 'image/svg+xml'],
    [new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><title>Safe</title><path d="M0 0" /></svg>'), 'image/svg+xml'],
  ];
  for (const [bytes, contentType] of cases) assert.equal(inspectIcon(bytes).contentType, contentType);
});

test('empty, oversized, spoofed and active SVG uploads cannot create R2 objects', async t => {
  const env = createEnv();
  const token = await login(env);
  const put = t.mock.method(env.CLOUDNAV_R2, 'put');
  const invalid = [
    '', '<html><script>alert(1)</script></html>', '<?xml version="1.0"?><html/>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg><script>alert(1)</script></svg>', '<svg><foreignObject><html/></foreignObject></svg>',
    '<svg><image href="https://evil.example/a.png"/></svg>', '<svg><use href="https://evil.example/a.svg#x"/></svg>',
    '<svg><use href="&#106;avascript:alert(1)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY e SYSTEM "file:///etc/passwd">]><svg>&e;</svg>',
    '<svg><path fill="url(https://evil.example/image)"/></svg>',
    '<svg><style>@import "https://evil.example/style";</style></svg>',
    '<svg><style>path{fill:u\\72l(https://evil.example/a)}</style></svg>',
    '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
    '<svg><g></svg>', '<svg/><svg/>',
  ];
  for (const bytes of invalid) {
    const response = await upload(env, token, { bytes, type: 'image/png', name: 'fake.png' });
    assert.equal(response.status, 415, bytes);
  }
  const oversized = await upload(env, token, { bytes: new Uint8Array(MAX_ICON_BYTES + 1) });
  assert.equal(oversized.status, 413);
  assert.equal(put.mock.callCount(), 0);
});

test('multipart requests are bounded without trusting Content-Length and reject malformed fields', async () => {
  const env = createEnv();
  const token = await login(env);
  const headers = { 'x-auth-password': token, 'Content-Type': 'multipart/form-data; boundary=x' };
  for (const contentLength of [undefined, '1', String(MAX_UPLOAD_BYTES + 100)]) {
    const response = await worker.fetch(new Request('https://cloudnav.example/api/upload', {
      method: 'POST', headers: { ...headers, ...(contentLength ? { 'Content-Length': contentLength } : {}) }, body: new Uint8Array(MAX_UPLOAD_BYTES + 1),
    }), env);
    assert.equal(response.status, 413);
  }
  const form = new FormData();
  form.set('file', 'not a File');
  assert.equal((await worker.fetch(new Request('https://cloudnav.example/api/upload', { method: 'POST', headers: { 'x-auth-password': token }, body: form }), env)).status, 400);
  assert.equal((await upload(env, token, { categoryName: '__cloudnav' })).status, 400);
  assert.equal((await upload(env, 'public')).status, 401);
});

test('URL validation rejects protocols, credentials, local names and alternative private IP forms', () => {
  const invalid = [
    'file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://public.example/image.png',
    'https://user:password@public.example/a', 'https://public.example:8080/a',
    'http://localhost/a', 'http://localhost./a', 'http://foo.localhost/a', 'http://router.local/a',
    'http://service.internal/a', 'http://metadata.google.internal/a', 'http://metadata/a',
    'http://0/a', 'http://127.1/a', 'http://2130706433/a', 'http://0x7f000001/a',
    'http://0177.0.0.1/a', 'http://10.0.0.1/a', 'http://172.31.0.1/a', 'http://192.168.1.1/a',
    'http://169.254.169.254/latest/meta-data', 'http://100.100.100.200/a', 'http://224.0.0.1/a',
    'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'http://[fd00::1]/a', 'http://[fe80::1]/a',
  ];
  for (const value of invalid) assert.throws(() => publicURL(value), undefined, value);
  assert.equal(publicURL('https://public.example/icon.png').href, 'https://public.example/icon.png');
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true);
  for (const address of ['0.0.0.0', '198.18.0.1', '192.0.2.1', '2001:db8::1', '2002:7f00:1::', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(address), false);
});

test('remote upload rejects private DNS, mixed DNS answers and failed resolution before fetch', async t => {
  const env = createEnv();
  const token = await login(env);
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(png));
  const v4 = t.mock.method(dns, 'resolve4', async () => ['127.0.0.1']);
  const v6 = t.mock.method(dns, 'resolve6', async () => []);
  assert.equal((await upload(env, token, { url: 'https://private.example/icon' })).status, 400);
  v4.mock.mockImplementation(async () => ['93.184.216.34', '10.0.0.1']);
  assert.equal((await upload(env, token, { url: 'https://mixed.example/icon' })).status, 400);
  v4.mock.mockImplementation(async () => ['93.184.216.34']);
  v6.mock.mockImplementation(async () => ['fd00::1']);
  assert.equal((await upload(env, token, { url: 'https://ipv6.example/icon' })).status, 400);
  v4.mock.mockImplementation(async () => { throw Object.assign(new Error('DNS failure'), { code: 'SERVFAIL' }); });
  assert.equal((await upload(env, token, { url: 'https://failed.example/icon' })).status, 502);
  assert.equal(network.mock.callCount(), 0);
});

test('safe redirects work but every hop is validated and cross-origin credentials are stripped', async t => {
  const calls = [];
  const network = t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    if (url === 'https://public.example/icon') return new Response(null, { status: 302, headers: { Location: 'https://cdn.example/icon.png' } });
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    return new Response(png, { headers: { 'Content-Type': 'text/html' } });
  });
  const icon = await fetchIcon('https://public.example/icon', { headers: { Authorization: 'secret' } });
  assert.equal(icon.contentType, 'image/png');
  assert.equal(calls.length, 2);
  for (const location of ['http://127.0.0.1/private', 'https://[::1]/private', 'file:///etc/passwd', 'https://user:pass@cdn.example/a', 'http://cdn.example/a']) {
    network.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: location } }));
    const before = network.mock.callCount();
    await assert.rejects(fetchIcon('https://public.example/icon'));
    assert.equal(network.mock.callCount(), before + 1);
  }
  network.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: '/loop' } }));
  const before = network.mock.callCount();
  await assert.rejects(fetchIcon('https://public.example/icon'), /重定向过多/);
  assert.equal(network.mock.callCount(), before + 4);
});

test('redirect DNS is checked again before reaching a private second host', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { Location: 'https://private.example/icon' } }));
  t.mock.method(dns, 'resolve4', async host => host === 'private.example' ? ['10.0.0.1'] : ['93.184.216.34']);
  await assert.rejects(fetchIcon('https://public.example/icon'), /非公开/);
  assert.equal(network.mock.callCount(), 1);
});

test('upstream size limits include streamed bodies, ignore forged MIME and never cache invalid content', async t => {
  const env = createEnv();
  const token = await login(env);
  const put = t.mock.method(env.CLOUDNAV_R2, 'put');
  const network = t.mock.method(globalThis, 'fetch', async () => new Response('small', { headers: { 'Content-Length': String(MAX_ICON_BYTES + 1) } }));
  assert.equal((await upload(env, token, { url: 'https://public.example/icon' })).status, 413);
  network.mock.mockImplementation(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_ICON_BYTES));
    controller.enqueue(new Uint8Array(1));
    controller.close();
  } }), { headers: { 'Content-Length': '1', 'Content-Type': 'image/png' } }));
  assert.equal((await upload(env, token, { url: 'https://public.example/icon' })).status, 413);
  network.mock.mockImplementation(async () => new Response('<html>not an image</html>', { headers: { 'Content-Type': 'image/png' } }));
  assert.equal((await upload(env, token, { url: 'https://public.example/icon' })).status, 415);
  const fallback = await request(env, '/api/favicon?domain=public.example');
  assert.equal(fallback.status, 302);
  assert.equal(await env.CLOUDNAV_R2.get('favicon:public.example'), null);
  assert.equal(put.mock.callCount(), 0);
});

test('oversized legacy R2 icons are rejected before buffering their body', async t => {
  const env = createEnv();
  const token = await login(env);
  const get = env.CLOUDNAV_R2.get.bind(env.CLOUDNAV_R2);
  const buffer = t.mock.fn(async () => { throw new Error('must not buffer oversized icons'); });
  const cancel = t.mock.fn(async () => {});
  t.mock.method(env.CLOUDNAV_R2, 'get', async key => key === 'legacy/large.png'
    ? { size: MAX_ICON_BYTES + 1, body: { cancel }, arrayBuffer: buffer }
    : get(key));
  assert.equal((await request(env, '/api/favicon?key=legacy%2Flarge.png', { token })).status, 413);
  assert.equal(buffer.mock.callCount(), 0);
  assert.equal(cancel.mock.callCount(), 1);
});

test('deadlines cover connection, DNS and a response body that never ends', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => new Promise(() => {}));
  await assert.rejects(fetchIcon('https://public.example/icon', {}, { timeoutMs: 10 }), error => error.status === 504);
  network.mock.mockImplementation(async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })));
  await assert.rejects(fetchIcon('https://public.example/icon', {}, { timeoutMs: 10 }), error => error.status === 504);
  t.mock.method(dns, 'resolve4', async () => new Promise(() => {}));
  await assert.rejects(fetchIcon('https://public.example/icon', {}, { timeoutMs: 10 }), error => error.status === 504);
});

test('custom icon proxy applies the same SSRF and byte validation as uploads', async t => {
  const env = createEnv();
  const token = await login(env);
  await request(env, '/api/storage', { token, data: { categories: [{ id: 'common', name: 'Public' }], links: [{ id: 'bookmark', categoryId: 'common', url: 'https://public.example', icon: 'http://127.0.0.1/icon' }] } });
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(png));
  assert.equal((await request(env, '/api/public-data?kind=icon&id=bookmark')).status, 400);
  assert.equal(network.mock.callCount(), 0);
  await env.CLOUDNAV_KV.put('config:icon', JSON.stringify({ source: 'customapi', customapi: { enabled: true, url: 'http://169.254.169.254/api', headers: { Authorization: 'secret' } } }));
  assert.equal((await request(env, '/api/public-data?kind=icon&url=https%3A%2F%2Fpublic.example')).status, 400);
  assert.equal(network.mock.callCount(), 0);
});
