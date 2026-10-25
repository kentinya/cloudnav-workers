import { adminToken } from './_access.js';
import { fetchIcon, inspectIcon, readBoundedBody, MAX_ICON_BYTES, MAX_UPLOAD_BYTES, ICON_TIMEOUT_MS, iconError } from './_icons.js';
// Cloudflare R2 图标上传、转存与删除接口

import { getKV, getCorsHeaders, verifyAuth, jsonResponse } from './_kvAdapter.js';

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405, corsHeaders);
  }

  // 1. 认证检查
  let kv;
  try {
    kv = getKV(env);
  } catch (e) {
    if (!env.PASSWORD) {
      return jsonResponse({ error: 'KV or PASSWORD not configured' }, 500, corsHeaders);
    }
  }

  const providedPassword = adminToken(request);
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

  // 处理删除请求 (DELETE)
  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (key?.startsWith('__cloudnav/')) return jsonResponse({ error: 'Reserved key' }, 400, corsHeaders);
    if (!key) {
      return jsonResponse({ error: 'Key parameter required' }, 400, corsHeaders);
    }

    try {
      if (!env.CLOUDNAV_R2) {
        return jsonResponse({ error: 'Cloudflare R2 binding CLOUDNAV_R2 not found' }, 500, corsHeaders);
      }
      await env.CLOUDNAV_R2.delete(key);
      return jsonResponse({ success: true }, 200, corsHeaders);
    } catch (err) {
      console.error('Delete error:', err);
      return jsonResponse({ error: err.message }, 500, corsHeaders);
    }
  }

  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw iconError('请使用 multipart/form-data 上传图片');
    const bytes = await readBoundedBody(request, MAX_UPLOAD_BYTES, AbortSignal.timeout(ICON_TIMEOUT_MS));
    let formData;
    try { formData = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
    catch { throw iconError('上传表单格式无效'); }
    const file = formData.get('file');
    const fetchUrl = formData.get('url');
    if ((!file && !fetchUrl) || (file && fetchUrl)) throw iconError('请提供一个图片文件或远程 URL');
    let icon;
    if (fetchUrl) {
      if (typeof fetchUrl !== 'string') throw iconError('远程图标 URL 无效');
      icon = await fetchIcon(fetchUrl);
    } else {
      if (!(file instanceof File)) throw iconError('图片文件无效');
      if (file.size > MAX_ICON_BYTES) throw iconError('图片大小不能超过 2MB', 413);
      const bytes = new Uint8Array(await file.arrayBuffer());
      icon = { bytes, ...inspectIcon(bytes) };
    }
    const categoryName = String(formData.get('categoryName') || 'common').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100) || 'common';
    if (categoryName.startsWith('__cloudnav')) throw iconError('Reserved key');
    const key = `${categoryName}/${crypto.randomUUID()}.${icon.ext}`;
    if (!env.CLOUDNAV_R2) throw new Error('Cloudflare R2 binding CLOUDNAV_R2 not found');
    await env.CLOUDNAV_R2.put(key, icon.bytes, {
      httpMetadata: { contentType: icon.contentType, cacheControl: 'public, max-age=31536000' },
    });
    return jsonResponse({ success: true, url: `/api/favicon?key=${encodeURIComponent(key)}` }, 200, corsHeaders);
  } catch (err) {
    if (!err.status) console.error('Upload error:', err);
    return jsonResponse({ error: err.status ? err.message : '图标上传失败，请重试' }, err.status || 500, corsHeaders);
  }
}
