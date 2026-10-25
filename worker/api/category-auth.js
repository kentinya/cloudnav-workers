import { getKV, getCorsHeaders, jsonResponse } from './_kvAdapter.js';
import { categoryAccess, categoryCookieName, isPrivate, matchesPassword, passwordVersion, readCategories, sessionCookie } from './_access.js';
import { consumeAuthAttempt } from './_rateLimit.js';

export async function onRequest({ request, env }) {
  const headers = getCorsHeaders(env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405, headers);
  await consumeAuthAttempt(env.CLOUDNAV_R2, request, 'category');
  const { categoryId, password } = await request.json();
  const kv = getKV(env);
  const categories = await readCategories(kv);
  const category = categories.find(item => item.id === categoryId);
  if (!category || !isPrivate(category)) return jsonResponse({ error: '私密分类不存在' }, 404, headers);
  const allowed = await categoryAccess(request, env, categories);
  if (category.parentId && !allowed.has(category.parentId)) {
    return jsonResponse({ error: '请先解锁父分类' }, 403, headers);
  }
  if (typeof password !== 'string' || password.length > 1024 || !await matchesPassword(category, password)) return jsonResponse({ error: '分类密码错误' }, 401, headers);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const ttl = 60 * 60;
  await kv.put(`category_token:${token}`, JSON.stringify({
    categoryId, version: await passwordVersion(category), expiresAt: Date.now() + ttl * 1000,
  }), { expirationTtl: ttl });
  return jsonResponse({ success: true, categoryId }, 200, {
    ...headers, 'Set-Cookie': sessionCookie(request, await categoryCookieName(categoryId), token, ttl),
  });
}
