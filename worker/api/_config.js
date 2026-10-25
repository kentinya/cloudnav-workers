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
