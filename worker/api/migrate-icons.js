import { adminToken } from './_access.js';
import { getKV, getCorsHeaders, verifyAuth, jsonResponse } from './_kvAdapter.js';

import { fetchIcon, faviconSources } from './_icons.js';

const CONCURRENCY = 3;

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405, corsHeaders);
  }

  const providedPassword = adminToken(request);
  const kv = getKV(env);
  const isAuthenticated = await verifyAuth({
    request,
    providedPassword,
    serverPassword: env.PASSWORD,
    r2: env.CLOUDNAV_R2,
    kv,
  });

  if (!isAuthenticated) {
    return jsonResponse({ error: '需要密码验证' }, 401, corsHeaders);
  }

  try {
    const catsStr = await kv.get('cate_config');
    const categories = catsStr ? JSON.parse(catsStr) : [];

    const categoryLinks = {};
    for (const cat of categories) {
      const data = await kv.get(`links:${cat.id}`);
      categoryLinks[cat.id] = data ? JSON.parse(data) : [];
    }

    let total = 0;
    let cached = 0;
    let failed = 0;
    let skipped = 0;
    const modifiedCategories = new Set();

    const queue = [];
    for (const cat of categories) {
      for (const link of categoryLinks[cat.id]) {
        total++;
        let domain = null;
        try {
          domain = new URL(link.url).hostname;
        } catch (e) {}

        if (!domain) {
          skipped++;
          continue;
        }

        if (link.icon?.startsWith('/api/favicon?key=') ||
            link.icon?.startsWith('/api/favicon?domain=') ||
            link.iconType === 'upload-cloudflare') {
          skipped++;
          continue;
        }

        queue.push({ catId: cat.id, link, domain });
      }
    }

    if (!env.CLOUDNAV_R2) {
      return jsonResponse({ error: 'Cloudflare R2 binding CLOUDNAV_R2 not found' }, 500, corsHeaders);
    }

    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const batch = queue.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ({ catId, link, domain }) => {
        try {
          let icon;
          for (const source of faviconSources(domain)) {
            try { icon = await fetchIcon(source, { headers: { 'User-Agent': 'Mozilla/5.0' } }); break; }
            catch { /* Try the other provider. */ }
          }
          if (!icon) { failed++; return; }
          const storageKey = `favicon:${domain}`;
          await env.CLOUDNAV_R2.put(storageKey, icon.bytes, {
            httpMetadata: { contentType: icon.contentType, cacheControl: 'public, max-age=31536000' },
          });

          link.icon = `/api/favicon?domain=${encodeURIComponent(domain)}`;
          modifiedCategories.add(catId);
          cached++;
        } catch (e) {
          console.error(`Migration failed for ${domain}:`, e);
          failed++;
        }
      }));
    }

    for (const catId of modifiedCategories) {
      await kv.put(`links:${catId}`, JSON.stringify(categoryLinks[catId]));
    }

    return jsonResponse({ total, cached, failed, skipped }, 200, corsHeaders);

  } catch (err) {
    console.error('Migration error:', err);
    return jsonResponse({ error: err.message }, 500, corsHeaders);
  }
}
