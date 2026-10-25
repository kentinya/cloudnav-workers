// KV has no compare-and-swap. R2 atomically publishes a pointer to an immutable KV
// snapshot; readers never pair a fresh revision with stale, mutable KV buckets.
export const NAVIGATION_HEAD = '__cloudnav/navigation-head';
const SNAPSHOT_PREFIX = 'navigation_snapshot:';

function failure(message, status) {
  return Object.assign(new Error(message), { status });
}

export async function navigationTransaction(env, expectedVersion, requireVersion = false) {
  const source = env.CLOUDNAV_KV;
  let loaded;
  const staged = new Map();
  let version;
  let committed = false;
  const load = () => loaded ||= (async () => {
    if (!env.CLOUDNAV_R2) throw failure('缺少 CLOUDNAV_R2，无法安全校验导航版本', 503);
    const head = await env.CLOUDNAV_R2.get(NAVIGATION_HEAD);
    if (head) {
      const manifest = await head.json();
      const raw = await source.get(manifest.key);
      if (!raw) throw failure('导航快照尚未同步，请稍后重试', 503);
      const snapshot = JSON.parse(raw);
      if (snapshot.version !== manifest.version) throw failure('导航快照版本无效', 503);
      version = manifest.version;
      return { ...snapshot, etag: head.etag, key: manifest.key };
    }
    const categories = JSON.parse(await source.get('cate_config') || '[]');
    const buckets = Object.fromEntries(await Promise.all([...new Set(['common', ...categories.map(c => c.id)])].map(async id => [id, JSON.parse(await source.get(`links:${id}`) || '[]')])));
    if (buckets.common.length && !categories.some(category => category.id === 'common')) categories.unshift({ id: 'common', name: '常用推荐', icon: 'Star', visibility: 'public' });
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ categories, buckets })));
    version = `legacy-${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    return { categories, buckets, version, etag: null };
  })();
  const isNavigation = key => key === 'cate_config' || key.startsWith('links:');
  const kv = {
    async get(key, ...options) {
      if (!isNavigation(key)) return source.get(key, ...options);
      if (staged.has(key)) return staged.get(key);
      const snapshot = await load();
      return JSON.stringify(key === 'cate_config' ? snapshot.categories : snapshot.buckets[key.slice(6)] || []);
    },
    async put(key, value, ...options) {
      if (!isNavigation(key)) return source.put(key, value, ...options);
      await load();
      staged.set(key, value);
    },
    async delete(key) {
      if (!isNavigation(key)) return source.delete(key);
      await load();
      staged.set(key, null);
    },
    async navigationVersion() { await load(); return version; },
  };
  return {
    kv,
    async commit() {
      if (!staged.size) return;
      const previous = await load();
      if (requireVersion && typeof expectedVersion !== 'string') throw failure('缺少导航版本，请刷新后重试', 428);
      if (expectedVersion !== undefined && expectedVersion !== previous.version) throw failure('导航已被其他操作修改，请刷新后重试', 409);
      let categories = staged.has('cate_config') ? JSON.parse(staged.get('cate_config') || '[]') : previous.categories;
      const buckets = { ...previous.buckets };
      for (const [key, value] of staged) if (key.startsWith('links:')) buckets[key.slice(6)] = JSON.parse(value || '[]');
      const retained = new Set(categories.map(c => c.id));
      const removed = previous.categories.filter(c => !retained.has(c.id));
      // A category-only delete must move its old bookmarks in the SAME snapshot.
      // Never trust an omitted/emptied client bucket as evidence to discard them.
      const moved = removed.flatMap(c => previous.buckets[c.id] || []);
      for (const category of removed) delete buckets[category.id];
      if (moved.length) {
        const oldIds = new Set(moved.map(link => link.id));
        for (const id of Object.keys(buckets)) buckets[id] = buckets[id].filter(link => !oldIds.has(link.id));
        buckets.common = [...(buckets.common || []), ...moved.map(link => ({ ...link, categoryId: 'common' }))];
      }
      if ((buckets.common || []).length && !retained.has('common')) {
        categories = [{ id: 'common', name: '常用推荐', icon: 'Star', visibility: 'public' }, ...categories];
      }
      const ids = new Set(categories.map(c => c.id));
      for (const [id, links] of Object.entries(buckets)) {
        if (links.length && !ids.has(id)) throw failure('书签目标分类不存在', 400);
      }
      const next = { version: crypto.randomUUID(), categories, buckets };
      const key = `${SNAPSHOT_PREFIX}${next.version}`;
      await source.put(key, JSON.stringify(next));
      const result = await env.CLOUDNAV_R2.put(NAVIGATION_HEAD, JSON.stringify({ key, version: next.version }), {
        onlyIf: previous.etag ? { etagMatches: previous.etag } : new Headers({ 'If-None-Match': '*' }),
      });
      if (!result) {
        await source.delete(key).catch(() => {});
        throw failure('导航已被其他操作修改，请刷新后重试', 409);
      }
      version = next.version;
      committed = true;
      // Compatibility mirrors are NOT used for version checks or navigation reads.
      // They may lag/fail/reorder without making a stale write authoritative.
      const mirrors = [source.put('cate_config', JSON.stringify(categories)), ...Object.entries(buckets).map(([id, links]) => source.put(`links:${id}`, JSON.stringify(links))), ...removed.map(c => source.delete(`links:${c.id}`))];
      // Retire superseded snapshots after a grace period for in-flight readers.
      if (previous.key) mirrors.push(source.put(previous.key, JSON.stringify({ version: previous.version, categories: previous.categories, buckets: previous.buckets }), { expirationTtl: 86400 }));
      const results = await Promise.allSettled(mirrors);
      if (results.some(result => result.status === 'rejected')) console.warn('Navigation committed; compatibility mirror or snapshot cleanup incomplete');
    },
    get committedVersion() { return committed ? version : undefined; },
  };
}
