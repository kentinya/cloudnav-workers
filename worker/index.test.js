import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.js'

function createEnv(onWrite = () => {}) {
  const values = new Map()
  const objects = new Map()
  return {
    PASSWORD: 'local-test-password',
    CLOUDNAV_KV: {
      async get(key) {
        return values.get(key) ?? null
      },
      async put(key, value, options) {
        onWrite('put', key, value, options)
        values.set(key, value)
      },
      async delete(key) {
        onWrite('delete', key)
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
    'category-auth',
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
  const saved = await (await request(env, '/api/storage?getConfig=true&readOnly=true', { token })).json()
  assert.equal(saved.links[0].id, link.id)
  assert.equal(saved.categories[0].visibility, 'private')
  assert.equal(saved.categories[0].password, undefined)
  assert.equal((await (await request(env, '/api/storage?getConfig=true')).json()).links.length, 0)
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
  const icon = await request(env, url, { token })
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
  assert.equal((await request(env, '/api/webdav', { data: {}, token })).status, 400)
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

async function privacyFixture() {
  const env = createEnv()
  const token = await login(env)
  const categories = [
    { id: 'common', name: 'Public', visibility: 'public' },
    { id: 'a', name: 'Private A', visibility: 'private', password: 'alpha-password' },
    { id: 'b', name: 'Private B', visibility: 'private', password: 'beta-password' },
    { id: 'child', name: 'Child', parentId: 'a', visibility: 'public' },
    { id: 'nested', name: 'Nested private', parentId: 'a', visibility: 'private', password: 'nested-password' },
  ]
  const links = categories.map(category => ({
    id: `bookmark-${category.id}`, title: `title-${category.id}`, url: `https://${category.id}.example`,
    categoryId: category.id, pinned: true, icon: `/api/favicon?key=${category.id}.png`,
  }))
  const response = await request(env, '/api/storage', { token, data: { categories, links } })
  assert.equal(response.status, 200)
  return { env, token, links }
}

async function unlock(env, categoryId, password, cookie = '') {
  const response = await request(env, '/api/category-auth', {
    data: { categoryId, password }, headers: { Cookie: cookie },
  })
  assert.equal(response.status, 200, await response.clone().text())
  const setCookie = response.headers.get('Set-Cookie')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.match(setCookie, /Secure/)
  assert.doesNotMatch(setCookie, new RegExp(password))
  return [cookie, setCookie.split(';')[0]].filter(Boolean).join('; ')
}

test('anonymous navigation is public and all bookmark read variants exclude private data', async () => {
  const { env } = await privacyFixture()
  const check = await (await request(env, '/api/storage?checkAuth=true')).json()
  assert.equal(check.requiresAuth, false)
  assert.equal(check.isAdmin, false)
  for (const path of [
    '/api/storage?getConfig=true', '/api/storage?getConfig=true&readOnly=false',
    '/api/storage?getConfig=true&readOnly=true', '/api/storage?getConfig=links',
    '/api/storage?getConfig=links&search=title-a', '/api/storage?getConfig=categories',
  ]) {
    const response = await request(env, path)
    assert.equal(response.status, 200, path)
    const text = await response.text()
    assert.doesNotMatch(text, /title-a|title-b|title-child|title-nested|alpha-password|beta-password|passwordHash|pbkdf2/)
    assert.match(response.headers.get('Cache-Control'), /no-store/)
  }
  const data = await (await request(env, '/api/storage?getConfig=true')).json()
  assert.deepEqual(data.links.map(link => link.id), ['bookmark-common'])
  assert.equal(data.categories.find(category => category.id === 'child').isLocked, true)
  assert.equal((await request(env, '/api/storage?getConfig=links&category=a')).status, 403)
  for (const key of ['cate_config', 'links:a', 'config', 'config:ai', 'last_token']) {
    assert.equal((await request(env, `/api/storage?key=${encodeURIComponent(key)}`)).status, 401, key)
  }
})

test('category grants unlock only that category and public descendants, never administrator actions', async () => {
  const { env } = await privacyFixture()
  assert.equal((await request(env, '/api/category-auth', { data: { categoryId: 'a', password: env.PASSWORD } })).status, 401)
  assert.equal((await request(env, '/api/category-auth', { data: { categoryId: 'b', password: 'alpha-password' } })).status, 401)
  const cookie = await unlock(env, 'a', 'alpha-password')
  const headers = { Cookie: cookie }
  const data = await (await request(env, '/api/storage?getConfig=true', { headers })).json()
  assert.deepEqual(data.links.map(link => link.categoryId).sort(), ['a', 'child', 'common'])
  assert.equal(data.categories.find(category => category.id === 'nested').isLocked, true)
  assert.equal(data.categories.find(category => category.id === 'b').isLocked, true)
  assert.doesNotMatch(JSON.stringify(data), /passwordHash|alpha-password/)
  assert.equal((await request(env, '/api/storage?getConfig=links&category=b', { headers })).status, 403)
  const categoryToken = cookie.split('=')[1]
  for (const path of ['/api/storage', '/api/link', '/api/upload', '/api/migrate-icons', '/api/webdav']) {
    const response = await request(env, path, { headers, token: categoryToken, data: { categories: [], saveConfig: 'favicon', domain: 'x', icon: 'x' } })
    assert.equal(response.status, 401, path)
  }
  assert.equal((await request(env, '/api/debug', { headers, token: categoryToken })).status, 401)
  assert.equal((await request(env, '/api/storage', { token: 'alpha-password', data: { categories: [] } })).status, 401)
  assert.equal((await request(env, '/api/storage?key=links:a', { headers })).status, 401)
})

test('nested private categories require their own password after their parent is unlocked', async () => {
  const { env } = await privacyFixture()
  assert.equal((await request(env, '/api/category-auth', { data: { categoryId: 'nested', password: 'nested-password' } })).status, 403)
  const parentCookie = await unlock(env, 'a', 'alpha-password')
  const cookie = await unlock(env, 'nested', 'nested-password', parentCookie)
  const data = await (await request(env, '/api/storage?getConfig=true', { headers: { Cookie: cookie } })).json()
  assert.deepEqual(data.links.map(link => link.categoryId).sort(), ['a', 'child', 'common', 'nested'])
})

test('passwords are hashed, blank edits preserve them, changes revoke grants, and admin backups can restore verifiers', async () => {
  const { env, token } = await privacyFixture()
  const cookie = await unlock(env, 'a', 'alpha-password')
  const stored = JSON.parse(await env.CLOUDNAV_KV.get('cate_config'))
  assert.equal(stored[1].password, undefined)
  assert.match(stored[1].passwordHash, /^pbkdf2-sha256\$/)
  const adminData = await (await request(env, '/api/storage?getConfig=true', { token })).json()
  assert.equal(adminData.links.length, 5)
  assert.equal(adminData.categories[1].password, undefined)
  adminData.categories[1].name = 'Renamed'
  assert.equal((await request(env, '/api/storage', { token, data: { categories: adminData.categories } })).status, 200)
  assert.equal(JSON.parse(await env.CLOUDNAV_KV.get('cate_config'))[1].passwordHash, stored[1].passwordHash)
  assert.equal((await (await request(env, '/api/storage?getConfig=links&category=a', { headers: { Cookie: cookie } })).json()).length, 1)
  adminData.categories[1].password = 'replacement-password'
  assert.equal((await request(env, '/api/storage', { token, data: { categories: adminData.categories } })).status, 200)
  assert.equal((await request(env, '/api/storage?getConfig=links&category=a', { headers: { Cookie: cookie } })).status, 403)
  assert.equal((await request(env, '/api/category-auth', { data: { categoryId: 'a', password: 'alpha-password' } })).status, 401)
  await unlock(env, 'a', 'replacement-password')

  const restored = createEnv()
  const restoreToken = await login(restored)
  assert.equal((await request(restored, '/api/storage', { token: restoreToken, data: adminData })).status, 200)
  await unlock(restored, 'b', 'beta-password')
  assert.equal((await request(restored, '/api/storage', {
    token: restoreToken, data: { categories: [{ id: 'empty', name: 'Private', visibility: 'private' }] },
  })).status, 400)
})

test('legacy password categories are private before migration and never return plaintext even to the administrator', async () => {
  const env = createEnv()
  await env.CLOUDNAV_KV.put('cate_config', JSON.stringify([{ id: 'legacy', name: 'Legacy', password: 'old-password' }]))
  await env.CLOUDNAV_KV.put('links:legacy', JSON.stringify([{ id: 'old', categoryId: 'legacy', title: 'legacy-bookmark' }]))
  const visitor = await (await request(env, '/api/storage?getConfig=true')).json()
  assert.equal(visitor.links.length, 0)
  assert.equal(visitor.categories[0].visibility, 'private')
  assert.doesNotMatch(JSON.stringify(visitor), /old-password|passwordHash/)
  const cookie = await unlock(env, 'legacy', 'old-password')
  assert.equal((await (await request(env, '/api/storage?getConfig=true', { headers: { Cookie: cookie } })).json()).links.length, 1)
  const token = await login(env)
  const admin = await (await request(env, '/api/storage?getConfig=true', { token })).json()
  assert.doesNotMatch(JSON.stringify(admin), /old-password/)
  assert.equal((await request(env, '/api/storage', { token, data: { categories: admin.categories } })).status, 200)
  assert.doesNotMatch(await env.CLOUDNAV_KV.get('cate_config'), /old-password/)
})

test('private custom icons require a category grant or an administrator session and cannot be publicly cached', async () => {
  const { env, token } = await privacyFixture()
  const bytes = new Uint8Array([0, 0, 1, 0])
  await env.CLOUDNAV_R2.put('a.png', bytes)
  await env.CLOUDNAV_R2.put('common.png', bytes)
  assert.equal((await request(env, '/api/favicon?key=common.png')).status, 200)
  assert.equal((await request(env, '/api/favicon?key=a.png')).status, 404)
  await env.CLOUDNAV_KV.put('favicon:a.example', '/private-image.png')
  assert.deepEqual(await (await request(env, '/api/storage?getConfig=favicon&domain=a.example')).json(), { icon: null, cached: false })
  assert.equal((await request(env, '/api/favicon?domain=a.example')).status, 404)
  const cookie = await unlock(env, 'a', 'alpha-password')
  const response = await request(env, '/api/favicon?key=a.png', { headers: { Cookie: cookie } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Cache-Control'), /no-store/)
  assert.equal((await request(env, '/api/favicon?key=a.png', { headers: { Cookie: `cloudnav_admin=${token}` } })).status, 200)
})

test('administrator logout revokes the token and cookie while category tokens can never become admin sessions', async () => {
  const { env, token } = await privacyFixture()
  const adminHeaders = { Cookie: `cloudnav_admin=${token}` }
  assert.equal((await (await request(env, '/api/storage?getConfig=true', { headers: adminHeaders })).json()).links.length, 5)
  const response = await request(env, '/api/auth', { headers: adminHeaders, data: { logout: true } })
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/)
  const visitor = await (await request(env, '/api/storage?getConfig=true', { headers: adminHeaders })).json()
  assert.deepEqual(visitor.links.map(link => link.categoryId), ['common'])
  assert.equal((await request(env, '/api/storage', { token, data: { categories: [] } })).status, 401)
  const grant = await unlock(env, 'a', 'alpha-password')
  assert.equal((await (await request(env, '/api/storage?checkAuth=true', { headers: { Cookie: `cloudnav_admin=${grant.split('=')[1]}` } })).json()).isAdmin, false)
  assert.equal((await request(env, '/api/storage', { data: { saveConfig: 'favicon', domain: 'a', icon: 'injected' } })).status, 401)
  assert.equal(await env.CLOUDNAV_KV.get('favicon:a'), null)
})

test('expired category grants fail closed even before the KV record is removed', async () => {
  const { env } = await privacyFixture()
  const cookie = await unlock(env, 'a', 'alpha-password')
  const key = `category_token:${cookie.split('=')[1]}`
  const grant = JSON.parse(await env.CLOUDNAV_KV.get(key))
  await env.CLOUDNAV_KV.put(key, JSON.stringify({ ...grant, expiresAt: Date.now() - 1 }))
  const response = await request(env, '/api/storage?getConfig=links&category=a', { headers: { Cookie: cookie } })
  assert.equal(response.status, 403)
})


test('login, session checks and navigation/config hydration never write business KV data', async () => {
  const writes = []
  const env = createEnv((...write) => writes.push(write))
  const seed = {
    cate_config: JSON.stringify([{ id: 'common', name: 'Public' }, { id: 'a', name: 'Private', password: 'private-password' }]),
    'links:common': JSON.stringify([{ id: 'public', categoryId: 'common', title: 'Public cloud bookmark' }]),
    'links:a': JSON.stringify([{ id: 'private', categoryId: 'a', title: 'Private cloud bookmark', pinned: true }]),
    config: JSON.stringify({ website: { icp: 'legacy' }, webdav: { url: 'https://dav.example' }, preferences: { retained: true } }),
    'config:website': JSON.stringify({ icp: 'cloud', passwordExpiry: { value: 2, unit: 'day' } }),
    'config:mastodon': JSON.stringify({ enabled: false, customItems: [{ text: 'cloud' }] }),
  }
  for (const [key, value] of Object.entries(seed)) await env.CLOUDNAV_KV.put(key, value)
  writes.length = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await login(env)
    for (const path of ['?checkAuth=true', '?getConfig=true&admin=true', '?key=config&admin=true',
      ...['website', 'ai', 'weather', 'mastodon', 'icon', 'search', 'view', 'ui'].map(section => `?getConfig=${section}`)]) {
      assert.equal((await request(env, `/api/storage${path}`, { token })).status, 200, path)
    }
    const logout = await request(env, '/api/auth', { token, data: { logout: true } })
    assert.equal(logout.status, 200)
    await request(env, '/api/storage?getConfig=true', { headers: { 'x-auth-password': 'public' } })
  }
  assert.ok(writes.length > 0)
  assert.ok(writes.every(([, key]) => /^(auth_token:|last_auth_time$|last_token$)/.test(key)), JSON.stringify(writes))
  const tokenWrite = writes.find(([, key]) => key.startsWith('auth_token:'))
  assert.equal(tokenWrite[3].expirationTtl, 172800)
  for (const [key, value] of Object.entries(seed)) assert.equal(await env.CLOUDNAV_KV.get(key), value, key)
})

test('administrator hydration fails closed when a token expires or is not available yet', async () => {
  const { env, token, links } = await privacyFixture()
  for (const invalid of ['not-yet-replicated', 'public']) {
    const response = await request(env, '/api/storage?getConfig=true&admin=true', { token: invalid })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).links, undefined)
  }
  const full = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.equal(full.isAdmin, true)
  assert.equal(full.links.length, links.length)
  const publicData = await (await request(env, '/api/storage?getConfig=true', { token: 'public' })).json()
  assert.equal(publicData.isAdmin, false)
  assert.equal(publicData.links.length, 1)
})

test('section settings overlay legacy settings without dropping unrelated fields or ticker updates', async () => {
  const env = createEnv()
  const token = await login(env)
  await env.CLOUDNAV_KV.put('config', JSON.stringify({
    website: { icp: 'old' }, ticker: { enabled: false },
    webdav: { url: 'https://dav.example' }, preferences: { retained: true },
  }))
  const legacyTicker = await (await request(env, '/api/storage?getConfig=mastodon', { token })).json()
  assert.deepEqual(legacyTicker, { enabled: false })
  await env.CLOUDNAV_KV.put('config:website', JSON.stringify({ icp: 'new' }))
  await env.CLOUDNAV_KV.put('config:mastodon', JSON.stringify({ enabled: true }))
  const { value } = await (await request(env, '/api/storage?key=config', { token })).json()
  const merged = JSON.parse(value)
  assert.deepEqual(merged.website, { icp: 'new' })
  assert.deepEqual(merged.webdav, { url: 'https://dav.example' })
  assert.deepEqual(merged.preferences, { retained: true })
  assert.deepEqual(merged.ticker, { enabled: true })
})

test('empty navigation stays empty on login/read and the first explicit bookmark save creates only an inbox', async () => {
  const writes = []
  const env = createEnv((...write) => writes.push(write))
  const token = await login(env)
  const empty = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.deepEqual(empty.links, [])
  assert.deepEqual(empty.categories, [])
  assert.equal(await env.CLOUDNAV_KV.get('cate_config'), null)
  await env.CLOUDNAV_KV.put('cate_config', '[]')
  const link = { id: 'first', categoryId: 'common', title: 'My first bookmark' }
  assert.equal((await request(env, '/api/storage', { token, data: { links: [link] } })).status, 200)
  const saved = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.deepEqual(saved.links, [link])
  assert.equal(saved.categories.length, 1)
  assert.equal(saved.categories[0].id, 'common')
})

test('bookmark-only edits preserve category metadata/password verifiers and all settings', async () => {
  const { env, token, links } = await privacyFixture()
  const categories = await env.CLOUDNAV_KV.get('cate_config')
  const config = JSON.stringify({ icp: 'keep-this-setting' })
  await env.CLOUDNAV_KV.put('config:website', config)
  const edited = links.map(link => link.id === 'bookmark-common' ? { ...link, title: 'Edited public bookmark' } : link)
  assert.equal((await request(env, '/api/storage', { token, data: { links: edited } })).status, 200)
  assert.equal(await env.CLOUDNAV_KV.get('cate_config'), categories)
  assert.equal(await env.CLOUDNAV_KV.get('config:website'), config)
  const saved = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.deepEqual(saved.links, edited)
})
