import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = MAX_ICON_BYTES + 64 * 1024;
export const ICON_TIMEOUT_MS = 10000;
export const ICON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};
export const iconError = (message, status = 400) => Object.assign(new Error(message), { status });

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(iconError('图标请求超时', 504));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(iconError('图标请求超时', 504));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

// Content-Length is only an early rejection; the streamed bytes are authoritative.
export async function readBoundedBody(message, limit, signal) {
  if (Number(message.headers.get('Content-Length')) > limit) {
    message.body?.cancel().catch(() => {});
    throw iconError('图标或请求数据过大', 413);
  }
  const reader = message.body?.getReader();
  if (!reader) throw iconError('图标内容为空', 415);
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw iconError('图标或请求数据过大', 413);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const [first, second] = address.split(':').map(part => parseInt(part || '0', 16));
  // Global unicast only; exclude transition/tunnel and documentation ranges.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && ((second & 0xfe00) === 0 || second === 0xdb8));
}

export function publicURL(value) {
  let url;
  try { url = new URL(value); } catch { throw iconError('远程图标 URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096 ||
      (url.port && !['80', '443'].includes(url.port))) throw iconError('远程图标 URL 不受支持');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || (isIP(host) ? !isPublicAddress(host) :
      !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) ||
      !/^[a-z0-9.-]+$/.test(host))) throw iconError('禁止访问非公开网络地址');
  url.hash = '';
  return url;
}

async function checkDNS(url, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) return;
  const answers = await abortable(Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]), signal);
  const addresses = [];
  for (const answer of answers) {
    if (answer.status === 'fulfilled') addresses.push(...answer.value);
    else if (!['ENODATA', 'ENOTFOUND'].includes(answer.reason?.code)) throw iconError('远程地址解析失败', 502);
  }
  if (!addresses.length || addresses.some(address => !isPublicAddress(address))) throw iconError('禁止访问非公开网络地址');
}

// Each redirect is a new security decision. The overall deadline includes DNS,
// response headers AND body streaming. strictly_public egress is set in Wrangler
// so a later DNS change cannot reach a private same-zone origin through fetch.
export async function fetchPublicBytes(value, init = {}, { maxBytes = MAX_ICON_BYTES, timeoutMs = ICON_TIMEOUT_MS } = {}) {
  let url = publicURL(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;
  let headers = new Headers(init.headers);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      await checkDNS(url, signal);
      const response = await abortable(fetch(url.href, { ...init, headers, redirect: 'manual', signal }), signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.body?.cancel().catch(() => {});
        if (redirects === 3 || (init.method && init.method !== 'GET')) throw iconError('远程图标重定向过多或不受支持');
        const location = response.headers.get('Location');
        if (!location) throw iconError('远程图标重定向无效');
        const next = publicURL(new URL(location, url).href);
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw iconError('禁止不安全的重定向');
        if (next.origin !== url.origin) headers = new Headers({ Accept: headers.get('Accept') || 'image/*' });
        url = next;
        continue;
      }
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        throw iconError('远程图标获取失败', 502);
      }
      return { bytes: await readBoundedBody(response, maxBytes, signal), headers: response.headers };
    }
  } finally { clearTimeout(timer); }
}

function staticSVG(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); } catch { return false; }
  text = text.replace(/^<\?xml\s[^?]*\?>\s*/i, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text.startsWith('<svg') || /<!|<\?/.test(text)) return false;
  const allowed = new Set('svg g path rect circle ellipse line polyline polygon defs lineargradient radialgradient stop clippath mask pattern symbol use title desc style text tspan'.split(' '));
  const stack = [];
  let root = false;
  const safeStyle = value => !/[\\@]|expression\s*\(|(?:javascript|vbscript|data)\s*:/i.test(value) &&
    !/url\s*\(/i.test(value.replace(/url\(\s*['"]?#[\w:.-]+['"]?\s*\)/gi, ''));
  const tokens = text.match(/<[^>]*>|[^<]+/g) || [];
  if (tokens.join('') !== text) return false;
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (!stack.length && token.trim()) return false;
      if (stack.at(-1) === 'style' && (!safeStyle(token) || token.includes('&'))) return false;
      continue;
    }
    const tag = token.match(/^<(\/?)(([a-z][a-z0-9]*))([\s\S]*?)(\/?)>$/i);
    if (!tag || !allowed.has(tag[2].toLowerCase())) return false;
    const name = tag[2].toLowerCase();
    if (tag[1]) {
      if (tag[4].trim() || tag[5] || stack.pop() !== name) return false;
      continue;
    }
    if (!stack.length) { if (root || name !== 'svg') return false; root = true; }
    const attrs = tag[4];
    const pattern = /\s+([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/gy;
    let end = 0, attr;
    while ((attr = pattern.exec(attrs))) {
      end = pattern.lastIndex;
      const key = attr[1].toLowerCase();
      const value = attr[3] ?? attr[4];
      if (/^on|^xml:base$/.test(key) || /&(?!(?:amp|lt|gt|quot|apos);)/.test(value) || value.includes('<') || !safeStyle(value)) return false;
      if (/(?:^|:)href$/.test(key) && !/^#[\w:.-]+$/.test(value)) return false;
      if (key === 'xmlns' && value !== 'http://www.w3.org/2000/svg') return false;
      if (key.startsWith('xmlns:') && !(key === 'xmlns:xlink' && value === 'http://www.w3.org/1999/xlink')) return false;
    }
    if (attrs.slice(end).trim()) return false;
    if (!tag[5]) stack.push(name);
  }
  return root && !stack.length;
}

export function inspectIcon(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (!bytes.length) throw iconError('图标内容为空', 415);
  if (bytes.length > MAX_ICON_BYTES) throw iconError('图片大小不能超过 2MB', 413);
  const starts = signature => signature.every((byte, index) => bytes[index] === byte);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return { contentType: 'image/png', ext: 'png' };
  if (starts([255, 216, 255])) return { contentType: 'image/jpeg', ext: 'jpg' };
  const ascii = new TextDecoder().decode(bytes.subarray(0, 12));
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return { contentType: 'image/gif', ext: 'gif' };
  if (starts([0, 0, 1, 0])) return { contentType: 'image/x-icon', ext: 'ico' };
  if (bytes.length >= 12 && ascii.startsWith('RIFF') && ascii.slice(8) === 'WEBP') return { contentType: 'image/webp', ext: 'webp' };
  if (bytes.length >= 26 && starts([66, 77])) return { contentType: 'image/bmp', ext: 'bmp' };
  if (bytes.length >= 16 && ascii.slice(4, 8) === 'ftyp') {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (boxSize >= 16 && boxSize <= bytes.length) {
      const brands = [ascii.slice(8), ...Array.from({ length: Math.floor((boxSize - 16) / 4) }, (_, index) => new TextDecoder().decode(bytes.subarray(16 + index * 4, 20 + index * 4)))];
      if (brands.some(brand => ['avif', 'avis'].includes(brand))) return { contentType: 'image/avif', ext: 'avif' };
    }
  }
  if (staticSVG(bytes)) return { contentType: 'image/svg+xml', ext: 'svg' };
  throw iconError('文件不是受支持的安全图片', 415);
}

export async function fetchIcon(url, init, options) {
  const { bytes } = await fetchPublicBytes(url, init, options);
  return { bytes, ...inspectIcon(bytes) };
}

export function faviconSources(domain) {
  if (typeof domain !== 'string' || /[\s/\\?#@:]/.test(domain)) throw iconError('图标域名无效');
  const host = publicURL(`https://${domain}`).hostname;
  return [`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
    `https://www.faviconextractor.com/favicon/${encodeURIComponent(host)}?larger=true`];
}
