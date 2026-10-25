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
      async put(key, value, options = {}) {
        const existing = objects.get(key)
        const condition = options.onlyIf
        const matches = condition instanceof Headers ? condition.get('If-Match') : condition?.etagMatches
        const absent = condition instanceof Headers ? condition.get('If-None-Match') === '*' : condition?.etagDoesNotMatch === '*'
        if ((matches && existing?.etag !== matches) || (absent && existing)) return null
        const object = { value, etag: crypto.randomUUID() }
        objects.set(key, object)
        return { etag: object.etag }
      },
      async get(key) {
        const object = objects.get(key)
        return object ? {
          etag: object.etag,
          json: async () => JSON.parse(object.value),
          arrayBuffer: async () => typeof object.value === 'string' ? new TextEncoder().encode(object.value).buffer : object.value,
        } : null
      },
      async delete(key) {
        objects.delete(key)
      },
    },
    ASSETS: { fetch: async () => new Response('static asset') },
  }
}

async function request(env, path, { data, token, method = data ? 'POST' : 'GET', headers = {}, unversioned = false } = {}) {
  // Existing API scenarios explicitly load the revision before editing. Conflict
  // scenarios below supply their own (possibly old/missing) revision.
  if (!unversioned && data && path === '/api/storage' && (data.links || data.categories || data.key === 'cate_config' || data.key?.startsWith('links:')) && data.version === undefined) {
    const snapshot = await (await request(env, '/api/storage?getConfig=true&admin=true', { token, headers })).json()
    data = { ...data, version: snapshot.version }
  }
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
    'public-data',
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
  const token = await login(env)
  delete env.CLOUDNAV_R2
  const response = await request(env, '/api/upload?key=icon.png', { method: 'DELETE', token: env.PASSWORD })
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
  assert.equal(response.headers.get('X-Navigation-Version'), null)
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
  const forbidden = await request(env, '/api/storage', { token: 'alpha-password', data: { categories: [] } })
  assert.equal(forbidden.status, 401)
  assert.equal(forbidden.headers.get('X-Navigation-Version'), null)
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
  assert.equal((await request(restored, '/api/storage', { token: restoreToken, data: { restore: true, links: adminData.links, categories: adminData.categories } })).status, 200)
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
  assert.equal(publicData.version, undefined)
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

test('public configuration whitelists hide all weather, memos and icon credentials in legacy and section settings', async () => {
  const secret = 'must-never-be-public'
  const sections = {
    weather: { enabled: true, provider: 'openweather', unit: 'celsius', qweatherApiKey: secret, openweatherApiKey: secret, visualcrossingApiKey: secret, accuweatherApiKey: secret, futureCredential: secret },
    mastodon: { enabled: true, source: 'memos', memosHost: `https://memos.example?token=${secret}`, memosToken: secret, memosVisibility: 'PRIVATE', customItems: ['public ticker'] },
    icon: { source: 'customapi', cacheEnabled: false, google: { enabled: true, apiKey: secret }, customapi: { enabled: true, url: `https://icons.example?key=${secret}`, headers: { Authorization: secret } }, customurl: { enabled: true, url: `https://icons.example/{domain}?key=${secret}` } },
  }
  for (const layout of ['legacy', 'sections']) {
    const env = createEnv()
    const token = await login(env)
    if (layout === 'legacy') await env.CLOUDNAV_KV.put('config', JSON.stringify({ ...sections, ticker: sections.mastodon }))
    else for (const [section, config] of Object.entries(sections)) await env.CLOUDNAV_KV.put(`config:${section}`, JSON.stringify(config))
    for (const section of Object.keys(sections)) {
      const response = await request(env, `/api/storage?getConfig=${section}`, { token: 'public' })
      const text = await response.text()
      assert.equal(response.status, 200)
      assert.doesNotMatch(text, /must-never-be-public|ApiKey|apiKey|memosToken|Authorization|futureCredential/)
      const admin = await (await request(env, `/api/storage?getConfig=${section}`, { token })).json()
      assert.deepEqual(admin, sections[section])
    }
  }
})

test('weather and Memos proxies retain guest functionality without returning secrets or private Memos', async t => {
  const env = createEnv()
  await env.CLOUDNAV_KV.put('config:weather', JSON.stringify({ enabled: true, provider: 'openweather', openweatherApiKey: 'weather-secret', openweatherCity: 'Shanghai' }))
  await env.CLOUDNAV_KV.put('config:mastodon', JSON.stringify({ enabled: true, source: 'memos', memosHost: 'https://memos.example', memosToken: 'memos-secret', memosVisibility: 'PRIVATE' }))
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('openweathermap')) {
      assert.equal(new URL(url).searchParams.get('appid'), 'weather-secret')
      return Response.json({ main: { temp: 21 }, weather: [{ main: 'Clouds' }], name: 'Shanghai', ignoredKey: 'weather-secret' })
    }
    assert.equal(options.headers.Authorization, 'Bearer memos-secret')
    assert.match(new URL(url).searchParams.get('filter'), /visibility == "PUBLIC"/)
    return Response.json({ memos: [{ uid: '1', content: 'Public note', visibility: 'PUBLIC' }, { uid: '2', content: 'PRIVATE NOTE', visibility: 'PRIVATE' }], ignoredToken: 'memos-secret' })
  })
  const weather = await (await request(env, '/api/public-data?kind=weather')).json()
  assert.deepEqual(weather, { weatherText: 'Clouds 21°C', region: 'Shanghai' })
  const memos = await (await request(env, '/api/public-data?kind=memos')).json()
  assert.equal(memos.length, 1)
  assert.equal(memos[0].content, 'Public note')
  assert.doesNotMatch(JSON.stringify(memos), /memos-secret|PRIVATE NOTE/)
  assert.equal(upstream.mock.callCount(), 2)
})

test('icon proxy keeps credentials server-side and refuses access to locked bookmark targets', async t => {
  const { env } = await privacyFixture()
  await env.CLOUDNAV_KV.put('config:icon', JSON.stringify({ source: 'customapi', customapi: { enabled: true, url: 'https://icons.example', headers: { Authorization: 'icon-secret' } } }))
  const bytes = new Uint8Array([0, 0, 1, 0])
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === 'https://icons.example/') {
      assert.equal(options.headers.Authorization, 'icon-secret')
      assert.deepEqual(JSON.parse(options.body), { url: 'https://common.example/' })
      return Response.json({ iconUrl: 'https://images.example/icon?token=icon-secret' })
    }
    return new Response(bytes, { headers: { 'Content-Type': 'image/x-icon' } })
  })
  const response = await request(env, '/api/public-data?kind=icon&url=https%3A%2F%2Fcommon.example')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Location'), null)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
  assert.equal((await request(env, '/api/public-data?kind=icon&url=https%3A%2F%2Fa.example')).status, 404)
  assert.equal((await request(env, '/api/public-data?kind=icon&url=https%3A%2F%2Funlisted.example')).status, 404)
  assert.equal(upstream.mock.callCount(), 2)
})

test('stale/missing versions are rejected on every raw and structured bookmark write route', async () => {
  const { env, token, links } = await privacyFixture()
  const old = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  const changed = links.map(link => ({ ...link, title: 'new committed title' }))
  const accepted = await request(env, '/api/storage', { token, data: { links: changed, version: old.version } })
  assert.equal(accepted.status, 200)
  assert.notEqual(accepted.headers.get('X-Navigation-Version'), old.version)
  for (const body of [{ links }, { saveConfig: 'links', links }, { saveConfig: 'links', categoryId: 'a', links }, { key: 'links:a', value: JSON.stringify(links) }, { categories: old.categories }, { key: 'cate_config', value: JSON.stringify(old.categories) }]) {
    assert.equal((await request(env, '/api/storage', { token, data: { ...body, version: old.version } })).status, 409)
    assert.equal((await request(env, '/api/storage', { token, data: body, unversioned: true })).status, 428)
  }
  const current = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.deepEqual(current.links, changed)
})

test('concurrent edits including first publication admit exactly one writer, even from the same revision', async () => {
  for (const initialized of [false, true]) {
    const env = createEnv()
    const token = await login(env)
    if (initialized) await request(env, '/api/storage', { token, data: { categories: [{ id: 'common', name: 'Public' }], links: [] } })
    const { version } = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
    const candidates = ['a', 'b'].map(id => [{ id, categoryId: 'common', title: id }])
    const results = await Promise.all(candidates.map(links => request(env, '/api/storage', { token, data: { version, links } })))
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
    const winner = results.findIndex(result => result.status === 200)
    const saved = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
    assert.deepEqual(saved.links, candidates[winner])
  }
})

test('stale mutable KV mirrors cannot resurrect data, and missing immutable snapshots fail closed', async t => {
  const { env, token } = await privacyFixture()
  const originalGet = env.CLOUDNAV_KV.get.bind(env.CLOUDNAV_KV)
  const originalPut = env.CLOUDNAV_KV.put.bind(env.CLOUDNAV_KV)
  const staleCategories = await originalGet('cate_config')
  const staleLinks = await originalGet('links:common')
  const old = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  const updated = old.links.map(link => link.id === 'bookmark-common' ? { ...link, title: 'new snapshot' } : link)
  // A different replica never observes updates to old mutable buckets.
  t.mock.method(env.CLOUDNAV_KV, 'put', async (key, ...args) => {
    if (key === 'cate_config' || key.startsWith('links:')) return
    return originalPut(key, ...args)
  })
  assert.equal((await request(env, '/api/storage', { token, data: { links: updated, version: old.version } })).status, 200)
  assert.equal(await originalGet('cate_config'), staleCategories)
  assert.equal(await originalGet('links:common'), staleLinks)
  assert.equal((await (await request(env, '/api/storage?getConfig=true', { token: 'public' })).json()).links[0].title, 'new snapshot')
  assert.equal((await request(env, '/api/storage', { token, data: { links: old.links, version: old.version } })).status, 409)
  t.mock.method(env.CLOUDNAV_KV, 'get', async (key, ...args) => key.startsWith('navigation_snapshot:') ? null : originalGet(key, ...args))
  assert.equal((await (await request(env, '/api/storage?checkAuth=true', { token })).json()).isAdmin, true)
  assert.equal((await request(env, '/api/storage?getConfig=weather', { token: 'public' })).status, 200)
  assert.equal((await request(env, '/api/storage', { token, data: { saveConfig: 'weather', config: { enabled: false } } })).status, 200)
  assert.equal((await request(env, '/api/storage?getConfig=true&admin=true', { token })).status, 503)
  assert.equal((await request(env, '/api/storage', { token, data: { links: [], version: old.version } })).status, 503)
})

test('extension adds and icon migration advance the same revision and cannot overwrite concurrent edits', async t => {
  const { env, token, links } = await privacyFixture()
  const old = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.equal((await request(env, '/api/link', { token, data: { title: 'extension', url: 'https://new.example', categoryId: 'common' } })).status, 200)
  assert.equal((await request(env, '/api/storage', { token, data: { links, version: old.version } })).status, 409)
  // Hold migration's network request while an editor commits a newer snapshot.
  await request(env, '/api/storage', { token, data: { links: [{ id: 'remote', categoryId: 'common', url: 'https://remote.example' }] } })
  let entered; let release
  const started = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async () => { entered(); await held; return new Response(new Uint8Array([0, 0, 1, 0])) })
  const migration = request(env, '/api/migrate-icons', { method: 'POST', token })
  await started
  await request(env, '/api/storage', { token, data: { links: [{ id: 'newer', categoryId: 'common', url: 'https://latest.example' }] } })
  release()
  assert.equal((await migration).status, 409)
  const saved = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.equal(saved.links[0].id, 'newer')
})

test('logout revokes both header/cookie tokens despite stale KV and fails closed on revocation errors', async t => {
  const env = createEnv()
  const token = await login(env)
  const legacy = 'a'.repeat(64)
  await env.CLOUDNAV_KV.put(`auth_token:${legacy}`, 'valid')
  const get = env.CLOUDNAV_KV.get.bind(env.CLOUDNAV_KV)
  t.mock.method(env.CLOUDNAV_KV, 'get', async (key, ...args) => key.startsWith('auth_token:') ? 'valid' : get(key, ...args))
  const response = await request(env, '/api/auth', { token, headers: { Cookie: `cloudnav_admin=${legacy}` }, data: { logout: true } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Set-Cookie'), /cloudnav_admin=;.*Max-Age=0/)
  for (const revoked of [token, legacy]) {
    for (const headers of [{ 'x-auth-password': revoked }, { Cookie: `cloudnav_admin=${revoked}` }]) {
      const check = await (await request(env, '/api/storage?checkAuth=true', { headers })).json()
      assert.equal(check.isAdmin, false)
      assert.equal((await request(env, '/api/storage', { headers, data: { saveConfig: 'website', config: {} } })).status, 401)
    }
  }
  const current = await login(env)
  const put = env.CLOUDNAV_R2.put.bind(env.CLOUDNAV_R2)
  t.mock.method(env.CLOUDNAV_R2, 'put', async (key, ...args) => { if (key.startsWith('__cloudnav/session/')) throw new Error('Unavailable'); return put(key, ...args) })
  t.mock.method(console, 'error', () => {})
  const failed = await request(env, '/api/auth', { token: current, data: { logout: true } })
  assert.equal(failed.status, 500)
  assert.equal(failed.headers.get('Set-Cookie'), null)
})

test('nonempty category deletion cannot be bypassed through structured, raw or combined writes', async () => {
  const { env, token } = await privacyFixture()
  const snapshot = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  for (const id of ['common', 'a', 'b', 'child', 'nested']) {
    const categories = snapshot.categories.filter(category => category.id !== id)
    const without = snapshot.links.filter(link => link.categoryId !== id)
    const moved = snapshot.links.map(link => link.categoryId === id ? { ...link, categoryId: id === 'common' ? 'b' : 'common' } : link)
    for (const data of [
      { categories }, { saveConfig: 'categories', categories },
      { key: 'cate_config', value: JSON.stringify(categories) },
      { categories, links: [] }, { categories, links: without }, { categories, links: moved },
    ]) {
      const response = await request(env, '/api/storage', { token, data: { ...data, version: snapshot.version } })
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /请先手动移动或删除书签/)
      assert.equal(response.headers.get('X-Navigation-Version'), null)
    }
  }
  const saved = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.deepEqual(saved, snapshot)
  assert.deepEqual((await (await request(env, '/api/storage?getConfig=links')).json()).map(link => link.id), ['bookmark-common'])
})

test('after manually removing bookmarks an empty parent can be deleted without exposing surviving children', async () => {
  const { env, token, links } = await privacyFixture()
  const remainingLinks = links.filter(link => link.categoryId !== 'a')
  assert.equal((await request(env, '/api/storage', { token, data: { links: remainingLinks } })).status, 200)
  const snapshot = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  const children = snapshot.categories.filter(category => category.id !== 'a')
  assert.equal((await request(env, '/api/storage', { token, data: { categories: children, version: snapshot.version } })).status, 200)
  const saved = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.deepEqual(saved.links, remainingLinks)
  assert.equal(saved.categories.find(category => category.id === 'child').parentId, undefined)
  assert.equal(saved.categories.find(category => category.id === 'child').visibility, 'private')
  assert.equal(saved.categories.find(category => category.id === 'nested').visibility, 'private')
  const visitor = await (await request(env, '/api/storage?getConfig=true')).json()
  assert.equal(visitor.links.some(link => link.id === 'bookmark-child'), false)
  const cookie = await unlock(env, 'child', 'alpha-password')
  assert.equal((await (await request(env, '/api/storage?getConfig=links&category=child', { headers: { Cookie: cookie } })).json()).length, 1)
  assert.equal((await request(env, '/api/storage', { token, data: { links: snapshot.links, version: snapshot.version } })).status, 409)
  assert.equal(await env.CLOUDNAV_KV.get('links:a'), null)
})

test('empty public/private categories including common are deletable through every category route', async () => {
  for (const route of ['structured', 'section', 'raw', 'combined']) {
    const env = createEnv()
    const token = await login(env)
    assert.equal((await request(env, '/api/storage', { token, data: {
      categories: [{ id: 'common', name: 'Public' }, { id: 'private', name: 'Private', visibility: 'private', password: 'secret' }], links: [],
    } })).status, 200)
    const data = route === 'structured' ? { categories: [] }
      : route === 'section' ? { saveConfig: 'categories', categories: [] }
      : route === 'raw' ? { key: 'cate_config', value: '[]' } : { links: [], categories: [] }
    assert.equal((await request(env, '/api/storage', { token, data })).status, 200)
    const saved = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
    assert.deepEqual(saved.categories, [])
    assert.deepEqual(saved.links, [])
  }
})

test('backup restore replaces every old bucket and uses backup passwords even for existing category IDs', async () => {
  const { env, token } = await privacyFixture()
  const donor = createEnv()
  const donorToken = await login(donor)
  const links = [{ id: 'backup-only', title: 'Backup private', categoryId: 'a', pinned: true }]
  await request(donor, '/api/storage', { token: donorToken, data: {
    categories: [{ id: 'a', name: 'Backup private', visibility: 'private', password: 'backup-password' }], links,
  } })
  const backup = await (await request(donor, '/api/storage?getConfig=true&admin=true', { token: donorToken })).json()
  await env.CLOUDNAV_KV.put('config:website', '{"icp":"unchanged"}')
  const oldCookie = await unlock(env, 'a', 'alpha-password')
  assert.equal((await request(env, '/api/storage', { token, data: { restore: true, links: backup.links, categories: backup.categories } })).status, 200)
  const saved = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  assert.deepEqual(saved.links, links)
  assert.deepEqual(saved.categories, backup.categories)
  for (const id of ['common', 'b', 'child', 'nested']) assert.equal(await env.CLOUDNAV_KV.get(`links:${id}`), null)
  assert.equal(await env.CLOUDNAV_KV.get('config:website'), '{"icp":"unchanged"}')
  assert.equal((await request(env, '/api/storage?getConfig=links&category=a', { headers: { Cookie: oldCookie } })).status, 403)
  assert.equal((await request(env, '/api/category-auth', { data: { categoryId: 'a', password: 'alpha-password' } })).status, 401)
  await unlock(env, 'a', 'backup-password')
  assert.deepEqual(await (await request(env, '/api/storage?getConfig=links')).json(), [])
})

test('restoring an empty backup discards all old bookmarks without creating common', async () => {
  const { env, token } = await privacyFixture()
  assert.equal((await request(env, '/api/storage', { token, data: { restore: true, links: [], categories: [] } })).status, 200)
  for (const headers of [{ 'x-auth-password': token }, {}]) {
    const saved = await (await request(env, '/api/storage?getConfig=true', { headers })).json()
    assert.deepEqual(saved.links, [])
    assert.deepEqual(saved.categories, [])
  }
  assert.equal(await env.CLOUDNAV_KV.get('links:common'), null)
})

test('restore requires a self-contained backup, administrator authentication and a current version', async () => {
  const { env, token } = await privacyFixture()
  const snapshot = await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json()
  const valid = { restore: true, links: [], categories: [] }
  const invalid = [
    { restore: true }, { restore: true, categories: [] }, { restore: true, links: [] },
    { ...valid, restore: 'true' }, { ...valid, restore: false },
    { ...valid, links: {} }, { ...valid, categories: {} },
    { ...valid, links: [{ id: 'x', categoryId: 'a' }] },
    { ...valid, links: [{ id: 'x' }] },
    { ...valid, categories: [{ id: 'a', name: 'Missing verifier', visibility: 'private' }] },
    { ...valid, categories: [{ id: 'child', name: 'Old parent', parentId: 'a' }] },
    { ...valid, categories: [{ id: 'common', name: 'Public' }], links: [{ id: 'x', categoryId: 'a' }] },
    { ...valid, saveConfig: 'categories' }, { ...valid, saveConfig: 'links', categoryId: 'a' },
    { ...valid, key: 'cate_config', value: '[]' }, { ...valid, key: 'links:a', value: '[]' },
  ]
  for (const data of invalid) {
    const response = await request(env, '/api/storage', { token, data: { ...data, version: snapshot.version } })
    assert.equal(response.status, 400, JSON.stringify(data))
    assert.equal(response.headers.get('X-Navigation-Version'), null)
  }
  assert.equal((await request(env, '/api/storage', { data: valid })).status, 401)
  const cookie = await unlock(env, 'a', 'alpha-password')
  assert.equal((await request(env, '/api/storage', { headers: { Cookie: cookie }, data: valid })).status, 401)
  assert.equal((await request(env, '/api/storage', { token, data: valid, unversioned: true })).status, 428)
  assert.equal((await request(env, '/api/storage', { token, data: { ...valid, version: 'stale-version' } })).status, 409)
  assert.deepEqual(await (await request(env, '/api/storage?getConfig=true&admin=true', { token })).json(), snapshot)
})

test('public bookmark metadata and favicon configuration do not reveal credential-bearing icon URLs', async t => {
  const env = createEnv()
  const token = await login(env)
  const icon = 'https://icons.example/private.png?key=hidden-icon-key'
  await request(env, '/api/storage', { token, data: { categories: [{ id: 'common', name: 'Public' }], links: [{ id: 'icon-bookmark', categoryId: 'common', url: 'https://public.example', icon, iconType: 'customapi', iconConfig: { customApiUrl: icon }, customIconUrl: icon }] } })
  await env.CLOUDNAV_KV.put('favicon:public.example', icon)
  for (const path of ['/api/storage?getConfig=true', '/api/storage?getConfig=links', '/api/storage?getConfig=favicon&domain=public.example']) {
    assert.doesNotMatch(await (await request(env, path, { token: 'public' })).text(), /hidden-icon-key|customApiUrl/)
  }
  const upstream = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), icon)
    return new Response(new Uint8Array([0, 0, 1, 0]), { headers: { 'Content-Type': 'image/png' } })
  })
  const response = await request(env, '/api/public-data?kind=icon&id=icon-bookmark')
  assert.equal(response.status, 200)
  assert.equal(upstream.mock.callCount(), 1)
  const full = await (await request(env, '/api/storage?getConfig=true', { token })).json()
  assert.equal(full.links[0].icon, icon)
})

test('infrastructure records cannot be read or deleted through the icon API', async () => {
  const { env, token } = await privacyFixture()
  for (const key of ['__cloudnav/navigation-head', `__cloudnav/session/${token}`]) {
    assert.equal((await request(env, `/api/favicon?key=${encodeURIComponent(key)}`, { token })).status, 404)
    assert.equal((await request(env, `/api/upload?key=${encodeURIComponent(key)}`, { method: 'DELETE', token })).status, 400)
    assert.ok(await env.CLOUDNAV_R2.get(key))
  }
  assert.equal((await request(env, '/api/storage', { token, data: { key: 'navigation_snapshot:protected', value: '{}' } })).status, 400)
})
