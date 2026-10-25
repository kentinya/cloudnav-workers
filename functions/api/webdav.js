// WebDAV 代理接口
// 支持 EdgeOne Pages / Cloudflare Workers

import { getCorsHeaders, jsonResponse } from './_kvAdapter.js';

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405, corsHeaders);
  }

  try {
    const body = await request.json();
    const { operation, config, payload } = body;

    if (!config || !config.url || !config.username || !config.password) {
      return jsonResponse({ error: 'Missing configuration' }, 400, corsHeaders);
    }

    let baseUrl = config.url.trim();
    if (!baseUrl.endsWith('/')) baseUrl += '/';

    const filename = 'cloudnav_backup.json';
    const fileUrl = baseUrl + filename;
    const authHeader = `Basic ${btoa(`${config.username}:${config.password}`)}`;

    let fetchUrl = baseUrl;
    let method = 'PROPFIND';
    let headers = {
      'Authorization': authHeader,
      'User-Agent': 'CloudNav/1.0',
    };
    let requestBody = undefined;

    if (operation === 'check') {
      fetchUrl = baseUrl;
      method = 'PROPFIND';
      headers['Depth'] = '0';
    } else if (operation === 'upload') {
      fetchUrl = fileUrl;
      method = 'PUT';
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(payload);
    } else if (operation === 'download') {
      fetchUrl = fileUrl;
      method = 'GET';
    } else {
      return jsonResponse({ error: 'Invalid operation' }, 400, corsHeaders);
    }

    const response = await fetch(fetchUrl, { method, headers, body: requestBody });

    if (operation === 'download') {
      if (!response.ok) {
        if (response.status === 404) {
          return jsonResponse({ error: 'Backup file not found' }, 404, corsHeaders);
        }
        return jsonResponse({ error: `WebDAV Error: ${response.status}` }, response.status, corsHeaders);
      }
      const data = await response.json();
      return jsonResponse(data, 200, corsHeaders);
    }

    const success = response.ok || response.status === 207;
    return jsonResponse({ success, status: response.status }, 200, corsHeaders);

  } catch (err) {
    console.error('WebDAV API error:', err);
    return jsonResponse({ error: err.message }, 500, corsHeaders);
  }
}
