import assert from 'node:assert/strict'
import worker from './index.js'

export function createEnv(onWrite = () => {}) {
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

export async function request(env, path, { data, token, method = data ? 'POST' : 'GET', headers = {}, unversioned = false } = {}) {
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

export async function login(env) {
  const response = await request(env, '/api/auth', { data: { password: env.PASSWORD } })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.match(result.token, /^[0-9a-f]{64}$/)
  return result.token
}
