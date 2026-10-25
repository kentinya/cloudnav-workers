import { getKV, getCorsHeaders, jsonResponse } from './_kvAdapter.js';
import { readConfigSection } from './_config.js';
import { isAdmin, readCategories, categoryAccess, readLinks } from './_access.js';

const options = { redirect: 'error' };
async function upstream(url, extra = {}) {
  const response = await fetch(url, { ...options, ...extra, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Upstream unavailable');
  return response;
}
const json = async (url, extra) => (await upstream(url, extra)).json();
const webURL = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid URL');
  return url;
};
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function publicMemoURL(value, fallback, token) {
  try {
    const url = webURL(value || fallback);
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) if (/token|key|auth|password/i.test(key)) url.searchParams.delete(key);
    if (token && (url.href.includes(token) || url.href.includes(encodeURIComponent(token)))) return fallback;
    return url.href;
  } catch { return fallback; }
}

export async function onRequest({ request, env }) {
  const cors = getCorsHeaders(env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const query = new URL(request.url).searchParams;
  const kind = query.get('kind');
  if (!['weather', 'memos', 'icon'].includes(kind)) return jsonResponse({ error: 'Not Found' }, 404, cors);
  if (request.method !== 'GET' && !(kind === 'icon' && request.method === 'POST')) return jsonResponse({ error: 'Method Not Allowed' }, 405, cors);
  try {
    const kv = getKV(env);
    if (kind === 'weather') {
      const c = await readConfigSection(kv, 'weather') || {};
      if (!c.enabled) return jsonResponse({}, 200, cors);
      let weatherText; let region;
      if (c.provider === 'qweather' && c.qweatherApiKey && c.qweatherLocation) {
        const host = c.qweatherHost || 'devapi.qweather.com';
        const data = await json(`https://${host}/v7/weather/now?${new URLSearchParams({ location: c.qweatherLocation, key: c.qweatherApiKey })}`);
        if (data.now) { weatherText = `${data.now.text} ${data.now.temp}${c.unit === 'fahrenheit' ? '°F' : '°C'}`; region = c.qweatherLocation; }
      } else if (c.provider === 'openweather' && c.openweatherApiKey) {
        const data = await json(`https://api.openweathermap.org/data/2.5/weather?${new URLSearchParams({ q: c.openweatherCity || 'Beijing', appid: c.openweatherApiKey, units: c.unit === 'fahrenheit' ? 'imperial' : 'metric' })}`);
        if (data.main) { weatherText = `${data.weather?.[0]?.main || ''} ${Math.round(data.main.temp)}${c.unit === 'fahrenheit' ? '°F' : '°C'}`; region = data.name; }
      } else if (c.provider === 'visualcrossing' && c.visualcrossingApiKey && c.visualcrossingLocation) {
        const data = await json(`https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(c.visualcrossingLocation)}/today?${new URLSearchParams({ unitGroup: 'metric', key: c.visualcrossingApiKey, contentType: 'json' })}`);
        if (data.days?.[0]) { weatherText = `${data.days[0].conditions} ${Math.round(data.days[0].temp)}°C`; region = data.address; }
      }
      return jsonResponse({ weatherText, region }, 200, cors);
    }
    if (kind === 'memos') {
      const c = await readConfigSection(kv, 'mastodon') || {};
      if (!c.enabled || c.source !== 'memos' || !c.memosHost) return jsonResponse([], 200, cors);
      const admin = await isAdmin(request, env);
      const host = webURL(c.memosHost).href.replace(/\/$/, '');
      const filters = [`visibility == ${JSON.stringify(admin ? c.memosVisibility || 'PUBLIC' : 'PUBLIC')}`];
      if (c.memosCreator) filters.push(`creator == ${JSON.stringify(`users/${c.memosCreator}`)}`);
      const data = await json(`${host}/api/v1/memos?${new URLSearchParams({ pageSize: String(Math.min(100, Math.max(1, Number(c.memosLimit) || 10))), filter: filters.join(' && ') })}`, { headers: { Accept: 'application/json', ...(c.memosToken ? { Authorization: `Bearer ${c.memosToken}` } : {}) } });
      const memos = data.memos || (Array.isArray(data) ? data : []);
      // Filtering the response too prevents a permissive upstream from publishing private notes.
      const safeHost = webURL(host); safeHost.username = ''; safeHost.password = ''; safeHost.search = '';
      const items = memos.filter(memo => admin || memo.visibility === 'PUBLIC').map(memo => ({
        id: memo.uid || memo.name || String(memo.id),
        content: escape((memo.content || memo.plainText || '').trim().substring(0, 120)),
        url: publicMemoURL(memo.url, `${safeHost.href.replace(/\/$/, '')}/${memo.name || memo.uid || memo.id}`, c.memosToken),
      })).filter(item => item.content);
      return jsonResponse(items, 200, cors);
    }
    const c = await readConfigSection(kv, 'icon') || {};
    const admin = await isAdmin(request, env);
    const categories = await readCategories(kv);
    const allowed = await categoryAccess(request, env, categories, admin);
    const links = await readLinks(kv, categories, allowed);
    const bookmark = query.has('id') ? links.find(link => link.id === query.get('id')) : null;
    if (query.has('id') && !bookmark) return jsonResponse({ error: 'Not Found' }, 404, cors);
    const target = bookmark ? webURL(bookmark.url).href : webURL(request.method === 'POST' ? (await request.json()).url : query.get('url')).href;
    if (!admin && !bookmark && !links.some(link => { try { return webURL(link.url).href === target; } catch { return false; } })) return jsonResponse({ error: 'Not Found' }, 404, cors);
    let iconURL;
    if (bookmark) {
      iconURL = bookmark.icon;
    } else if (c.source === 'customapi' && c.customapi?.enabled && c.customapi.url) {
      const data = await json(webURL(c.customapi.url).href, { method: 'POST', headers: { 'Content-Type': 'application/json', ...c.customapi.headers }, body: JSON.stringify({ url: target }) });
      iconURL = data.iconUrl || data.url || data.favicon;
    } else if (c.source === 'customurl' && c.customurl?.enabled && c.customurl.url) {
      iconURL = c.customurl.url.replaceAll('{domain}', new URL(target).hostname).replaceAll('{url}', encodeURIComponent(target));
    } else return jsonResponse({ error: 'Not Found' }, 404, cors);
    const icon = await upstream(webURL(iconURL).href, { redirect: 'follow' });
    const type = icon.headers.get('Content-Type') || '';
    if (!type.startsWith('image/')) throw new Error('Invalid icon');
    // Do not redirect: upstream URLs may themselves contain credentials.
    return new Response(await icon.arrayBuffer(), { headers: { ...cors, 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' } });
  } catch (error) {
    // Never echo credential-bearing URLs, response bodies, or upstream errors.
    return jsonResponse({ error: error.status ? '数据暂未同步，请稍后重试' : '暂时无法获取组件数据' }, error.status || 502, cors);
  }
}
