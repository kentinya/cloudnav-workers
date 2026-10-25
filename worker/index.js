import { onRequest as categoryAuth } from './api/category-auth.js'
import { onRequest as auth } from './api/auth.js'
import { onRequest as storage } from './api/storage.js'
import { onRequest as link } from './api/link.js'
import { onRequest as favicon } from './api/favicon.js'
import { onRequest as upload } from './api/upload.js'
import { onRequest as migrateIcons } from './api/migrate-icons.js'
import { onRequest as webdav } from './api/webdav.js'
import { onRequest as debug } from './api/debug.js'
import { getCorsHeaders, jsonResponse } from './api/_kvAdapter.js'

// Explicit routes for the Cloudflare Worker API.
const routes = new Map([
  ['/api/auth', auth],
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
        const response = await handler({ request, env })
        const headers = new Headers(response.headers)
        headers.set('Cache-Control', 'private, no-store')
        headers.set('Vary', 'Cookie, x-auth-password')
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
      } catch (error) {
        console.error('Worker API error:', error)
        return jsonResponse({ error: 'Internal Server Error' }, 500, getCorsHeaders(env))
      }
    }

    return env.ASSETS.fetch(request)
  },
}
