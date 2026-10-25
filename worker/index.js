import { onRequest as publicData } from './api/public-data.js'
import { onRequest as categoryAuth } from './api/category-auth.js'
import { onRequest as auth } from './api/auth.js'
import { onRequest as storage } from './api/storage.js'
import { onRequest as link } from './api/link.js'
import { onRequest as favicon } from './api/favicon.js'
import { onRequest as upload } from './api/upload.js'
import { onRequest as migrateIcons } from './api/migrate-icons.js'
import { onRequest as webdav } from './api/webdav.js'
import { onRequest as debug } from './api/debug.js'
import { navigationTransaction } from './api/_navigation.js'
import { getCorsHeaders, jsonResponse } from './api/_kvAdapter.js'
import { configurationTransaction } from './api/_config.js'

// Explicit routes for the Cloudflare Worker API.
const routes = new Map([
  ['/api/auth', auth],
  ['/api/public-data', publicData],
  ['/api/category-auth', categoryAuth],
  ['/api/storage', storage],
  ['/api/link', link],
  ['/api/favicon', favicon],
  ['/api/upload', upload],
  ['/api/migrate-icons', migrateIcons],
  ['/api/webdav', webdav],
  ['/api/debug', debug],
])

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname.replace(/\/$/, '')

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const handler = routes.get(pathname)
      if (!handler) {
        return jsonResponse({ error: 'Not Found' }, 404, getCorsHeaders(env))
      }

      try {
        // Stage every navigation writer, including extension adds and icon migration.
        const body = request.method === 'POST' && pathname === '/api/storage' ? await request.clone().json() : {}
        const transaction = env.CLOUDNAV_KV ? await navigationTransaction(env, body.version, pathname === '/api/storage') : null
        const configuration = transaction ? configurationTransaction({ ...env, CLOUDNAV_KV: transaction.kv }, body.configVersion) : null
        const response = await handler({ request, env: configuration ? { ...env, CLOUDNAV_KV: configuration.kv } : env })
        if (response.ok) await transaction?.commit()
        if (response.ok) await configuration?.commit()
        const headers = new Headers(response.headers)
        if (transaction?.committedVersion) headers.set('X-Navigation-Version', transaction.committedVersion)
        if (configuration?.committedVersion) headers.set('X-Config-Version', configuration.committedVersion)
        headers.set('Cache-Control', 'private, no-store')
        headers.set('Vary', 'Cookie, x-auth-password')
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
      } catch (error) {
        if (!error.status) console.error('Worker API error:', error)
        return jsonResponse({ error: error.status ? error.message : 'Internal Server Error' }, error.status || 500, { ...getCorsHeaders(env), 'Cache-Control': 'private, no-store', ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) })
      }
    }

    return env.ASSETS.fetch(request)
  },
}
