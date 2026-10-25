export const CONFIG_SECTIONS = ['ai', 'website', 'mastodon', 'weather', 'search', 'icon', 'view', 'ui'];
const CONFIG_OBJECT = '__cloudnav/config';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const failure = (message, status) => Object.assign(new Error(message), { status });

// One strongly consistent R2 object publishes ALL settings at once. KV is read
// only for the initial legacy import; stale section keys cannot undo a commit.
export function configurationTransaction(env, expectedVersion) {
  const source = env.CLOUDNAV_KV;
  let loaded, current, etag, version, dirty = false, committedVersion;
  const load = () => loaded ||= (async () => {
    if (!env.CLOUDNAV_R2) throw failure('缺少 CLOUDNAV_R2，无法安全保存设置', 503);
    const object = await env.CLOUDNAV_R2.get(CONFIG_OBJECT);
    if (object) {
      const snapshot = await object.json();
      current = snapshot.config; version = snapshot.version; etag = object.etag;
    } else {
      current = JSON.parse(await source.get('config') || '{}');
      if (!record(current)) throw failure('设置数据无效', 503);
      const sections = await Promise.all(CONFIG_SECTIONS.map(async section => [section, await source.get(`config:${section}`)]));
      for (const [section, raw] of sections) if (raw) current[section] = JSON.parse(raw);
      if (!current.mastodon && current.ticker) current.mastodon = current.ticker;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(current)));
      version = `legacy-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    if (!record(current)) throw failure('设置数据无效', 503);
    if (current.mastodon) current.ticker = current.mastodon;
  })();
  const kv = {
    ...source,
    async get(key, ...options) {
      if (key !== 'config' && !key.startsWith('config:')) return source.get(key, ...options);
      await load();
      const value = key === 'config' ? current : current[key.slice(7)];
      return value === undefined ? null : JSON.stringify(value);
    },
    async put(key, raw, ...options) {
      if (key !== 'config' && !key.startsWith('config:')) return source.put(key, raw, ...options);
      const value = JSON.parse(raw);
      if (!record(value)) throw failure('设置必须是对象', 400);
      await load();
      if (key === 'config') current = { ...value };
      else current = { ...current, [key.slice(7)]: value };
      if (current.mastodon) current.ticker = current.mastodon;
      dirty = true;
    },
    async delete(key) {
      if (key !== 'config' && !key.startsWith('config:')) return source.delete(key);
      await load();
      if (key === 'config') current = {};
      else {
        const next = { ...current };
        delete next[key.slice(7)];
        current = next;
      }
      dirty = true;
    },
    async configVersion() { await load(); return version; },
  };
  return {
    kv,
    async commit() {
      if (!dirty) return;
      if (expectedVersion !== undefined && expectedVersion !== version) throw failure('设置已被其他操作修改，请重新打开设置后重试', 409);
      const nextVersion = crypto.randomUUID();
      const result = await env.CLOUDNAV_R2.put(CONFIG_OBJECT, JSON.stringify({ version: nextVersion, config: current }), {
        onlyIf: etag ? { etagMatches: etag } : new Headers({ 'If-None-Match': '*' }),
      });
      if (!result) throw failure('设置已被其他操作修改，请重新打开设置后重试', 409);
      committedVersion = nextVersion;
    },
    get committedVersion() { return committedVersion; },
  };
}

export async function readConfigSection(kv, section) {
  const raw = await kv.get(`config:${section}`);
  if (raw) return JSON.parse(raw);
  const config = JSON.parse(await kv.get('config') || '{}');
  return config[section] || (section === 'mastodon' ? config.ticker : null) || null;
}

// Explicit public fields, including nested objects: newly added credential fields
// must not become public just because they were added to administrator settings.
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
export function publicConfig(section, value) {
  switch (section) {
    case 'ai': return pick(value, ['websiteTitle', 'faviconUrl', 'navigationName', 'sidebarNavigationName', 'defaultViewMode']);
    case 'weather': return pick(value, ['enabled', 'provider', 'unit']);
    case 'mastodon': return pick(value, ['enabled', 'source', 'mastodonInstance', 'mastodonUsername', 'mastodonLimit', 'mastodonExcludeReplies', 'mastodonExcludeReblogs', 'customItems']);
    case 'icon': return {
      ...pick(value, ['source', 'cacheEnabled']),
      faviconextractor: value.faviconextractor ? pick(value.faviconextractor, ['enabled']) : undefined,
      google: value.google ? pick(value.google, ['enabled']) : undefined,
      customapi: value.customapi ? { enabled: value.customapi.enabled, url: '/api/public-data?kind=icon' } : undefined,
      customurl: value.customurl ? { enabled: value.customurl.enabled, url: '/api/public-data?kind=icon&url={url}' } : undefined,
    };
    case 'website': return pick(value, ['icp', 'mps']);
    case 'view': return pick(value, ['mode', 'defaultMode']);
    case 'ui': return pick(value, ['showPinnedWebsites', 'darkMode']);
    case 'search': return pick(value, ['mode', 'externalSources', 'selectedSource', 'defaultEngine']);
    default: return {};
  }
}
