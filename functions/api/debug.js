// 调试接口（需要认证）
// 支持 EdgeOne Pages / Cloudflare Workers

import { getKV, getCorsHeaders, verifyAuth, jsonResponse } from './_kvAdapter.js';

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 认证检查（通过 query param 或 header）
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-auth-password');

  const isAuthenticated = await verifyAuth({
    providedPassword: token,
    serverPassword: env.PASSWORD,
    kv: getKV(env),
  });

  if (!isAuthenticated) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  // 返回调试信息
  const result = {
    message: 'Debug Info',
    envKeys: {},
    kvStatus: 'Unknown',
  };

  try {
    if (env) {
      for (const key in env) {
        const value = env[key];
        result.envKeys[key] = typeof value === 'string' ? 'String (Hidden)' : typeof value;
      }
    }

    try {
      const kv = getKV(env);
      // 测试 KV 可读
      await kv.get('__ping__');
      result.kvStatus = 'OK';
    } catch (e) {
      result.kvStatus = `Error: ${e.message}`;
    }

    return jsonResponse(result, 200, corsHeaders);

  } catch (e) {
    return jsonResponse({
      error: 'Exception in debug function',
      message: e.message,
    }, 500, corsHeaders);
  }
}
