// Vercel 链接添加接口
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getKV, getCorsHeaders, verifyAuth } from './_kvHelper.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsHeaders = getCorsHeaders();
  res.setHeader('Access-Control-Allow-Origin', corsHeaders['Access-Control-Allow-Origin']);
  res.setHeader('Access-Control-Allow-Methods', corsHeaders['Access-Control-Allow-Methods']);
  res.setHeader('Access-Control-Allow-Headers', corsHeaders['Access-Control-Allow-Headers']);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const providedPassword = req.headers['x-auth-password'] as string;
  const isAuthenticated = await verifyAuth(providedPassword);

  if (!isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const kv = getKV();
    const newLinkData = req.body;

    if (!newLinkData.title || !newLinkData.url) {
      return res.status(400).json({ error: 'Missing title or url' });
    }

    const catsStr = await kv.get('cate_config');
    const categories = catsStr ? (typeof catsStr === 'string' ? JSON.parse(catsStr) : catsStr) : [];

    let targetCatId = '';
    let targetCatName = '';

    if (newLinkData.categoryId) {
      const explicitCat = categories.find((c: any) => c.id === newLinkData.categoryId);
      if (explicitCat) {
        targetCatId = explicitCat.id;
        targetCatName = explicitCat.name;
      }
    }

    if (!targetCatId && categories.length > 0) {
      const keywords = ['收集', '未分类', 'inbox', 'temp', 'later'];
      const match = categories.find((c: any) =>
        keywords.some((k: string) => c.name.toLowerCase().includes(k))
      );
      if (match) {
        targetCatId = match.id;
        targetCatName = match.name;
      } else {
        const common = categories.find((c: any) => c.id === 'common');
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

    // 读取该分类的现有链接 (分 key 存储)
    const existingStr = await kv.get(`links:${targetCatId}`);
    const existing = existingStr ? (typeof existingStr === 'string' ? JSON.parse(existingStr) : existingStr) : [];

    const updatedLinks = [newLink, ...existing];
    await kv.set(`links:${targetCatId}`, JSON.stringify(updatedLinks));

    return res.status(200).json({
      success: true,
      link: newLink,
      categoryName: targetCatName,
    });

  } catch (err: any) {
    console.error('Link API error:', err);
    return res.status(500).json({ error: err.message });
  }
}

