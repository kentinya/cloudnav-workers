import { onRequest as auth } from '../functions/api/auth.js'
import { onRequest as storage } from '../functions/api/storage.js'
import { onRequest as link } from '../functions/api/link.js'
import { onRequest as favicon } from '../functions/api/favicon.js'
import { onRequest as upload } from '../functions/api/upload.js'
import { onRequest as migrateIcons } from '../functions/api/migrate-icons.js'
import { onRequest as webdav } from '../functions/api/webdav.js'
import { onRequest as debug } from '../functions/api/debug.js'
import { getCorsHeaders, jsonResponse } from '../functions/api/_kvAdapter.js'

// Reuse the existing handlers while replacing Pages' file-based routing.
const routes = new Map([
  ['/api/auth', auth],
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
        return await handler({ request, env })
      } catch (error) {
        console.error('Worker API error:', error)
        return jsonResponse({ error: 'Internal Server Error' }, 500, getCorsHeaders(env))
      }
    }

    return env.ASSETS.fetch(request)
  },
}
