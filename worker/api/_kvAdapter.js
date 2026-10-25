import { verifySession } from './_sessions.js';
import { consumeAuthAttempt, passwordMatches } from './_rateLimit.js';
// Cloudflare Workers KV 与 API 辅助函数

/**
 * 获取 Worker 的 KV 绑定
 * @param {object} env - 函数 context.env
 * @returns {object} KV 实例
 */
export function getKV(env) {
  // Cloudflare Workers: KV 在 env 上
  if (env?.CLOUDNAV_KV && typeof env.CLOUDNAV_KV.get === 'function') {
    return env.CLOUDNAV_KV;
  }
  throw new Error('KV binding "CLOUDNAV_KV" not found. Please check your deployment configuration.');
}

/**
 * 获取 CORS 头，支持配置化
 * @param {object} env - 函数 context.env
 * @returns {object} CORS headers
 */
export function getCorsHeaders(env) {
  const origin = env?.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-auth-password',
    'Access-Control-Expose-Headers': 'X-Navigation-Version, X-Config-Version, Retry-After',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * 认证检查：验证密码或 Token
 * @param {object} params
 * @param {string} params.providedPassword - 客户端提供的密码或 Token
 * @param {string} params.serverPassword - 环境变量中的密码
 * @param {object} params.kv - KV 实例
 * @returns {Promise<boolean>}
 */
export async function verifyAuth({ providedPassword, serverPassword, kv, r2, request }) {
  if (!serverPassword || !providedPassword) return false;
  if (/^[0-9a-f]{64}$/i.test(providedPassword)) {
    // Valid sessions do not spend password-guessing budget.
    try { if (await verifySession(r2, providedPassword, kv)) return true; } catch { return false; }
  }
  if (providedPassword === 'public') return false;
  // Legacy extension/header password authentication must not bypass login limits.
  await consumeAuthAttempt(r2, request, 'admin');
  return passwordMatches(providedPassword, serverPassword);
}

/**
 * 创建标准 JSON 响应
 * @param {any} data - 响应数据
 * @param {number} status - HTTP 状态码
 * @param {object} extraHeaders - 额外响应头
 * @returns {Response}
 */
export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
