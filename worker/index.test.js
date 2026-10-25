import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.js'

function createEnv() {
  const values = new Map()
  const objects = new Map()
  return {
    PASSWORD: 'local-test-password',
    UPLOAD_PLATFORM: 'cloudflare',
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
  data.set('platform', 'cloudflare')
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
    `/api/upload?key=${encodeURIComponent(key)}&platform=cloudflare`,
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
