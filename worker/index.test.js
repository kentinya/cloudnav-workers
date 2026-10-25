import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.js'

function createEnv() {
  const values = new Map()
  const objects = new Map()
  return {
    PASSWORD: 'local-test-password',
    CLOUDNAV_KV: {
      async get(key) {
        return values.get(key) ?? null
      },
      async put(key, value) {
        values.set(key, value)
      },
      async delete(key) {
        values.delete(key)
      },
    },
    CLOUDNAV_R2: {
      async put(key, value) {
        objects.set(key, value)
      },
      async get(key) {
        return objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null
      },
      async delete(key) {
        objects.delete(key)
      },
    },
    ASSETS: { fetch: async () => new Response('static asset') },
  }
}

function request(env, path, { data, token, method = data ? 'POST' : 'GET', headers = {} } = {}) {
  if (data) headers['Content-Type'] = 'application/json'
  if (token) headers['x-auth-password'] = token
  return worker.fetch(
    new Request(`https://cloudnav.example${path}`, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    }),
    env
  )
}

async function login(env) {
  const response = await request(env, '/api/auth', { data: { password: env.PASSWORD } })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.match(result.token, /^[0-9a-f]{64}$/)
  return result.token
}

test('every public API handles preflight, including icon deletion', async () => {
  const env = createEnv()
  for (const endpoint of [
    'auth',
    'storage',
    'link',
    'favicon',
    'upload',
    'migrate-icons',
    'webdav',
    'debug',
  ]) {
    const response = await request(env, `/api/${endpoint}`, { method: 'OPTIONS' })
    assert.equal(response.status, 204, endpoint)
    assert.match(response.headers.get('Access-Control-Allow-Methods'), /DELETE/)
    assert.match(response.headers.get('Access-Control-Allow-Headers'), /x-auth-password/)
  }
})

test('unknown API paths return JSON 404 instead of the SPA or internal helpers', async () => {
  const env = createEnv()
  for (const path of ['/api', '/api/', '/api/missing', '/api/_kvAdapter', '/api/__proto__']) {
    const response = await request(env, path, { headers: { 'Sec-Fetch-Mode': 'navigate' } })
    assert.equal(response.status, 404, path)
    assert.deepEqual(await response.json(), { error: 'Not Found' })
  }
})

test('non-API requests reach the asset binding unchanged', async () => {
  const env = createEnv()
  const incoming = new Request('https://cloudnav.example/assets/app.js?v=1')
  env.ASSETS.fetch = async received => {
    assert.equal(received, incoming)
    return new Response('asset body', { headers: { 'Content-Type': 'text/javascript' } })
  }
  const response = await worker.fetch(incoming, env)
  assert.equal(response.headers.get('Content-Type'), 'text/javascript')
  assert.equal(await response.text(), 'asset body')
})

test('login rejects invalid passwords and protected writes require authentication', async () => {
  const env = createEnv()
  assert.equal((await request(env, '/api/auth', { data: { password: 'wrong' } })).status, 401)
  assert.equal((await request(env, '/api/storage', { data: { categories: [] } })).status, 401)
  const response = await request(env, '/api/auth/', { data: { password: env.PASSWORD } })
  assert.equal(response.status, 200)
})

test('authenticated category writes, extension link creation, and token replacement survive routing', async () => {
  const env = createEnv()
  const token = await login(env)
  const categories = [{ id: 'common', name: 'Inbox', password: 'category-password' }]
  assert.equal((await request(env, '/api/storage', { token, data: { categories } })).status, 200)
  const response = await request(env, '/api/link', {
    token,
    data: { title: 'Example', url: 'https://example.com', categoryId: 'common' },
  })
  assert.equal(response.status, 200)
  const { link } = await response.json()
  const saved = await (await request(env, '/api/storage?getConfig=true&readOnly=true')).json()
  assert.equal(saved.links[0].id, link.id)
  assert.deepEqual(saved.categories, [{ id: 'common', name: 'Inbox' }])
  await login(env)
  assert.equal(
    (await request(env, '/api/storage', { token, data: { authOnly: true } })).status,
    401
  )
})

test('uploaded icons can be read and deleted through the R2 routes', async () => {
  const env = createEnv()
  const token = await login(env)
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const data = new FormData()
  data.set('file', new File([bytes], 'test.png', { type: 'image/png' }))
  data.set('categoryName', 'test')
  const upload = await worker.fetch(
    new Request('https://cloudnav.example/api/upload', {
      method: 'POST',
      headers: { 'x-auth-password': token },
      body: data,
    }),
    env
  )
  assert.equal(upload.status, 200)
  const { url } = await upload.json()
  const icon = await request(env, url)
  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get('Content-Type'), 'image/png')
  assert.deepEqual(new Uint8Array(await icon.arrayBuffer()), bytes)
  const key = new URL(url, 'https://cloudnav.example').searchParams.get('key')
  const deletion = await request(
    env,
    `/api/upload?key=${encodeURIComponent(key)}`,
    {
      method: 'DELETE',
      token,
    }
  )
  assert.equal(deletion.status, 200)
  assert.equal((await request(env, url)).status, 404)
})

test('debug, icon migration, and WebDAV routes invoke their handlers', async () => {
  const env = createEnv()
  const token = await login(env)
  const debug = await (await request(env, '/api/debug', { token })).json()
  assert.equal(debug.kvStatus, 'OK')
  const migration = await request(env, '/api/migrate-icons', { method: 'POST', token })
  assert.equal(migration.status, 200)
  assert.deepEqual(await migration.json(), { total: 0, cached: 0, failed: 0, skipped: 0 })
  assert.equal((await request(env, '/api/webdav', { data: {} })).status, 400)
})

test('uncaught handler failures return a JSON error without exposing the exception', async t => {
  t.mock.method(console, 'error', () => {})
  const response = await request({}, '/api/debug')
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'Internal Server Error' })
})

test('domain icons use R2 caching and respect the cache setting', async t => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const upstream = t.mock.method(globalThis, 'fetch', async () => new Response(bytes))
  const env = createEnv()
  const first = await request(env, '/api/favicon?domain=example.com')
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), bytes)
  const second = await request(env, '/api/favicon?domain=example.com')
  assert.equal(second.status, 200)
  assert.equal(upstream.mock.callCount(), 1)
  assert.ok(await env.CLOUDNAV_R2.get('favicon:example.com'))

  await env.CLOUDNAV_KV.put('config:icon', JSON.stringify({ cacheEnabled: false }))
  assert.equal((await request(env, '/api/favicon?domain=uncached.example')).status, 200)
  assert.equal(await env.CLOUDNAV_R2.get('favicon:uncached.example'), null)
})

test('bulk icon caching saves files to R2 and persists the new bookmark URLs', async t => {
  const env = createEnv()
  const token = await login(env)
  await env.CLOUDNAV_KV.put('cate_config', JSON.stringify([{ id: 'common' }]))
  await env.CLOUDNAV_KV.put('links:common', JSON.stringify([
    { id: 'remote', url: 'https://example.com' },
    { id: 'uploaded', url: 'https://upload.example', icon: '/api/favicon?key=custom.png', iconType: 'upload-cloudflare' },
  ]))
  const upstream = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([0, 0, 1, 0])))
  const response = await request(env, '/api/migrate-icons', { method: 'POST', token })
  assert.deepEqual(await response.json(), { total: 2, cached: 1, failed: 0, skipped: 1 })
  assert.equal(upstream.mock.callCount(), 1)
  assert.ok(await env.CLOUDNAV_R2.get('favicon:example.com'))
  const links = JSON.parse(await env.CLOUDNAV_KV.get('links:common'))
  assert.equal(links[0].icon, '/api/favicon?domain=example.com')
  assert.equal(links[1].icon, '/api/favicon?key=custom.png')
})

test('missing R2 bindings fail explicitly instead of reporting successful icon deletion', async () => {
  const env = createEnv()
  delete env.CLOUDNAV_R2
  const token = await login(env)
  const response = await request(env, '/api/upload?key=icon.png', { method: 'DELETE', token })
  assert.equal(response.status, 500)
  assert.match((await response.json()).error, /CLOUDNAV_R2/)
})
