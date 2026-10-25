// 链接添加接口（Chrome 扩展等外部调用）
// 支持 EdgeOne Pages / Cloudflare Workers

import { getKV, getCorsHeaders, verifyAuth, jsonResponse } from './_kvAdapter.js';

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405, corsHeaders);
  }

  // 认证检查
  const providedPassword = request.headers.get('x-auth-password');
  const isAuthenticated = await verifyAuth({
    providedPassword,
    serverPassword: env.PASSWORD,
    kv: getKV(env),
  });

  if (!isAuthenticated) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }

  try {
    const kv = getKV(env);
    const newLinkData = await request.json();

    if (!newLinkData.title || !newLinkData.url) {
      return jsonResponse({ error: 'Missing title or url' }, 400, corsHeaders);
    }

    // 读取分类配置
    const catsStr = await kv.get('cate_config');
    const categories = catsStr ? JSON.parse(catsStr) : [];

    // 确定目标分类
    let targetCatId = '';
    let targetCatName = '';

    if (newLinkData.categoryId) {
      const explicitCat = categories.find(c => c.id === newLinkData.categoryId);
      if (explicitCat) {
        targetCatId = explicitCat.id;
        targetCatName = explicitCat.name;
      }
    }

    if (!targetCatId && categories.length > 0) {
      const keywords = ['收集', '未分类', 'inbox', 'temp', 'later'];
      const match = categories.find(c =>
        keywords.some(k => c.name.toLowerCase().includes(k))
      );
      if (match) {
        targetCatId = match.id;
        targetCatName = match.name;
      } else {
        const common = categories.find(c => c.id === 'common');
        if (common) {
          targetCatId = 'common';
          targetCatName = common.name;
        } else {
          targetCatId = categories[0].id;
          targetCatName = categories[0].name;
        }
      }
    }

    if (!targetCatId) {
      targetCatId = 'common';
      targetCatName = '默认';
    }

    // 创建链接对象
    const newLink = {
      id: Date.now().toString(),
      title: newLinkData.title,
      url: newLinkData.url,
      description: newLinkData.description || '',
      categoryId: targetCatId,
      createdAt: Date.now(),
      pinned: false,
      icon: newLinkData.icon || undefined,
    };

    // 读取该分类的现有链接
    const existingStr = await kv.get(`links:${targetCatId}`);
    const existing = existingStr ? JSON.parse(existingStr) : [];

    // 插入到列表头部
    const updatedLinks = [newLink, ...existing];

    // 写入分类链接 key
    await kv.put(`links:${targetCatId}`, JSON.stringify(updatedLinks));

    return jsonResponse({
      success: true,
      link: newLink,
      categoryName: targetCatName,
    }, 200, corsHeaders);

  } catch (err) {
    console.error('Link API error:', err);
    return jsonResponse({ error: err.message }, 500, corsHeaders);
  }
}
