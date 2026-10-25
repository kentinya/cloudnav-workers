// Shared by the category editor and the authoritative navigation transaction.
export function assertCategoryDeletionAllowed(previous, next, links) {
  const retained = new Set(next.map(category => category.id));
  const removed = new Set(previous.filter(category => !retained.has(category.id)).map(category => category.id));
  if (links.some(link => removed.has(link.categoryId || 'common'))) {
    throw Object.assign(new Error('分类内还有书签，请先手动移动或删除书签后再删除分类。'), { status: 400 });
  }
}

// A backup is self-contained: never infer missing categories from current data.
export function assertBackupNavigation(links, categories) {
  const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!Array.isArray(links) || !Array.isArray(categories)) invalid('无效的备份文件：links 和 categories 必须是数组。');
  const byId = new Map();
  for (const category of categories) {
    if (!category || typeof category.id !== 'string' || !category.id || byId.has(category.id) || typeof category.name !== 'string' || !category.name.trim()) {
      invalid('备份分类 ID 或名称无效。');
    }
    byId.set(category.id, category);
    if (category.visibility && !['public', 'private'].includes(category.visibility)) invalid('分类可见性无效');
    const privateCategory = category.visibility === 'private' || (category.visibility !== 'public' && !!(category.password || category.passwordHash));
    if (privateCategory && !(typeof category.password === 'string' && category.password) &&
        !(typeof category.passwordHash === 'string' && /^pbkdf2-sha256\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(category.passwordHash))) {
      invalid('私密分类必须设置独立密码');
    }
  }
  for (const category of categories) {
    const seen = new Set([category.id]);
    let parent = category.parentId;
    while (parent) {
      if (!byId.has(parent) || seen.has(parent)) invalid('备份父分类不存在或存在循环。');
      seen.add(parent);
      parent = byId.get(parent).parentId;
    }
  }
  const linkIds = new Set();
  for (const link of links) {
    if (!link || typeof link.id !== 'string' || !link.id || linkIds.has(link.id)) invalid('备份书签 ID 无效或重复。');
    if (!byId.has(link.categoryId)) invalid('备份书签目标分类不存在，请修正备份后重试。');
    linkIds.add(link.id);
  }
}
