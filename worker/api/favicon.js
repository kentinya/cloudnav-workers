import { canReadIcon } from './_access.js';
import { readConfigSection } from './_config.js';
// Cloudflare R2 图标缓存与代理接口

import { getCorsHeaders, jsonResponse, getKV } from './_kvAdapter.js';

import { fetchIcon, inspectIcon, faviconSources, ICON_HEADERS, MAX_ICON_BYTES } from './_icons.js';

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(env);
  const url = new URL(request.url);

  // 防盗链保护 (防站外盗用)
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refererHost = new URL(referer).hostname;
      const requestHost = url.hostname;
      if (refererHost !== requestHost && refererHost !== 'localhost' && refererHost !== '127.0.0.1') {
        return new Response('Forbidden: Hotlinking is not allowed', { status: 403 });
      }
    } catch (e) {}
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405, corsHeaders);
  }

  const key = url.searchParams.get('key');
  const domain = url.searchParams.get('domain');
  if (key?.startsWith('__cloudnav/')) return new Response('File Not Found', { status: 404 });

  if (!key && !domain) {
    return jsonResponse({ error: 'key or domain parameter required' }, 400, corsHeaders);
  }

  if (!await canReadIcon(request, env, key, key ? undefined : domain)) {
    return new Response('File Not Found', { status: 404, headers: corsHeaders });
  }

  let sources;
  try { if (!key) sources = faviconSources(domain); }
  catch (error) { return jsonResponse({ error: error.message }, error.status || 400, corsHeaders); }
  const iconConfig = await readConfigSection(getKV(env), 'icon');
  const cacheEnabled = iconConfig?.cacheEnabled !== false;

  const storageKey = key || `favicon:${domain}`;

  // 1. 尝试读取 R2 中的图标
  try {
    const object = await env.CLOUDNAV_R2?.get(storageKey);
    if (object) {
      // Older uploads may predate the size limit. Check R2's trusted metadata
      // before buffering them, so reads cannot exhaust Worker memory either.
      if (object.size > MAX_ICON_BYTES) {
        await object.body?.cancel();
        return jsonResponse({ error: '图片大小不能超过 2MB' }, 413, corsHeaders);
      }
      const cached = await object.arrayBuffer();
      return new Response(cached, {
        status: 200,
        headers: {
          'Content-Type': inspectIcon(cached).contentType,
          ...ICON_HEADERS,
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...corsHeaders
        }
      });
    }
  } catch (err) {
    console.error('R2 read error:', err);
  }

  // 如果请求的是自定义文件 key，但在存储中未找到，直接返回 404
  if (key) {
    return new Response('File Not Found', { status: 404, headers: corsHeaders });
  }

  // 2. 如果是 domain 请求且无缓存，则从上游抓取并保存
  let icon;
  for (const source of sources) {
    try {
      icon = await fetchIcon(source, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      break;
    } catch { /* Try the other provider, then the existing local fallback. */ }
  }
  if (icon) {
    if (cacheEnabled && env.CLOUDNAV_R2) {
      try {
        await env.CLOUDNAV_R2.put(storageKey, icon.bytes, {
          httpMetadata: { contentType: icon.contentType, cacheControl: 'public, max-age=31536000' },
        });
      } catch (error) { console.error('R2 write error:', error); }
    }
    return new Response(icon.bytes, {
      headers: { ...corsHeaders, ...ICON_HEADERS, 'Content-Type': icon.contentType, 'Cache-Control': 'public, max-age=604800' },
    });
  }

  // 4. 最终降级：重定向至本地默认 favicon
  return Response.redirect(`${url.origin}/favicon.ico`, 302);
}
