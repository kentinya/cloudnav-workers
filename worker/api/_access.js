import { getKV, verifyAuth } from './_kvAdapter.js';

const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));
const equal = (a, b) => a.length === b.length && a.reduce((diff, byte, i) => diff | (byte ^ b[i]), 0) === 0;

export function cookies(request) {
  return new Map((request.headers.get('Cookie') || '').split(';').map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
}

export function sessionCookie(request, name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

export function adminToken(request) {
  return request.headers.get('x-auth-password') || cookies(request).get('cloudnav_admin') || '';
}

export async function isAdmin(request, env, kv = getKV(env)) {
  return verifyAuth({ providedPassword: adminToken(request), serverPassword: env.PASSWORD, kv, r2: env.CLOUDNAV_R2 });
}

export function isPrivate(category) {
  return category.visibility === 'private' || (category.visibility !== 'public' && !!(category.password || category.passwordHash));
}

export async function readCategories(kv) {
  return JSON.parse(await kv.get('cate_config') || '[]');
}

async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: 100000 }, key, 256);
}

export async function hashPassword(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2-sha256$${salt}$${hex(await derive(password, salt))}`;
}

export async function matchesPassword(category, password) {
  if (typeof password !== 'string' || !password) return false;
  if (category.passwordHash) {
    const [algorithm, salt, hash] = category.passwordHash.split('$');
    if (algorithm !== 'pbkdf2-sha256' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(hash)) return false;
    return equal(new Uint8Array(await derive(password, salt)), unhex(hash));
  }
  // Compatibility with existing categories; the next administrator save hashes them.
  if (!category.password) return false;
  const digest = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
  return equal(new Uint8Array(await digest(password)), new Uint8Array(await digest(category.password)));
}

export async function passwordVersion(category) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(category.passwordHash || category.password || '')));
}

export async function categoryCookieName(categoryId) {
  return `cloudnav_category_${hex(await crypto.subtle.digest('SHA-256', encoder.encode(categoryId))).slice(0, 32)}`;
}

export async function categoryAccess(request, env, categories, admin = false) {
  const kv = getKV(env);
  const cookieValues = cookies(request);
  const granted = new Set();
  await Promise.all(categories.filter(isPrivate).map(async category => {
    const token = cookieValues.get(await categoryCookieName(category.id));
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
    const stored = await kv.get(`category_token:${token}`);
    if (!stored) return;
    const grant = JSON.parse(stored);
    if (grant.categoryId === category.id && grant.expiresAt > Date.now() && grant.version === await passwordVersion(category)) {
      granted.add(category.id);
    }
  }));
  const byId = new Map(categories.map(category => [category.id, category]));
  const allowed = new Set();
  const canRead = (id, visited = new Set()) => {
    if (allowed.has(id)) return true;
    const category = byId.get(id);
    if (!category || visited.has(id)) return false;
    visited.add(id);
    if (category.parentId && !canRead(category.parentId, visited)) return false;
    if (!admin && isPrivate(category) && !granted.has(id)) return false;
    allowed.add(id);
    return true;
  };
  categories.forEach(category => canRead(category.id));
  return allowed;
}

export async function safeCategories(categories, allowed, admin = false) {
  return Promise.all(categories.map(async ({ password, passwordHash, hasPassword, isLocked, ...category }) => ({
    ...category,
    visibility: isPrivate({ ...category, password, passwordHash }) ? 'private' : 'public',
    hasPassword: !!(password || passwordHash),
    isLocked: !allowed.has(category.id),
    // Administrator backups retain verifiers, never plaintext passwords.
    ...(admin && isPrivate({ ...category, password, passwordHash }) ? { passwordHash: passwordHash || (password ? await hashPassword(password) : undefined) } : {}),
  })));
}

export async function prepareCategories(input, previous) {
  if (!Array.isArray(input)) throw new Error('分类数据必须是数组');
  const ids = new Set();
  // Reparent surviving children when their parent is removed. Preserve inherited
  // privacy by copying the removed private ancestor's verifier to its child.
  input = input.map(item => {
    if (!item) return item;
    const category = { ...item };
    const seen = new Set();
    while (category.parentId && !input.some(candidate => candidate?.id === category.parentId)) {
      if (seen.has(category.parentId)) throw new Error('父分类无效或存在循环');
      seen.add(category.parentId);
      const parent = previous.find(candidate => candidate.id === category.parentId);
      if (!parent) break;
      if (isPrivate(parent) && !isPrivate(category)) {
        category.visibility = 'private';
        if (parent.passwordHash) category.passwordHash = parent.passwordHash;
        else category.password = parent.password;
      }
      category.parentId = parent.parentId;
      category.isSubcategory = !!category.parentId;
    }
    return category;
  });
  const prepared = [];
  for (const item of input) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim()) {
      throw new Error('分类 ID 或名称无效');
    }
    ids.add(item.id);
    const old = previous.find(category => category.id === item.id);
    const { password, passwordHash, hasPassword, isLocked, ...category } = item;
    category.visibility = item.visibility || (isPrivate(item) || (old && isPrivate(old)) ? 'private' : 'public');
    if (!['public', 'private'].includes(category.visibility)) throw new Error('分类可见性无效');
    if (category.visibility === 'private') {
      if (typeof password === 'string' && password) category.passwordHash = await hashPassword(password);
      else if (old?.passwordHash) category.passwordHash = old.passwordHash;
      else if (old?.password) category.passwordHash = await hashPassword(old.password);
      else if (typeof passwordHash === 'string' && /^pbkdf2-sha256\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(passwordHash)) category.passwordHash = passwordHash;
      else throw new Error('私密分类必须设置独立密码');
    }
    prepared.push(category);
  }
  for (const category of prepared) {
    const seen = new Set([category.id]);
    let parent = category.parentId;
    while (parent) {
      if (!ids.has(parent) || seen.has(parent)) throw new Error('父分类无效或存在循环');
      seen.add(parent);
      parent = prepared.find(item => item.id === parent).parentId;
    }
  }
  return prepared;
}

export async function readLinks(kv, categories, allowed) {
  const arrays = await Promise.all(categories.filter(category => allowed.has(category.id)).map(async category => {
    const links = JSON.parse(await kv.get(`links:${category.id}`) || '[]');
    return links.filter(link => allowed.has(link.categoryId || category.id));
  }));
  return arrays.flat();
}

// A stored custom icon belongs to the same access scope as its bookmarks.
export async function canReadIcon(request, env, key, domain) {
  if (await isAdmin(request, env)) return true;
  const kv = getKV(env);
  const categories = await readCategories(kv);
  const allowed = await categoryAccess(request, env, categories);
  let referenced = false;
  for (const category of categories) {
    const links = JSON.parse(await kv.get(`links:${category.id}`) || '[]');
    for (const link of links) {
      const urls = [link.icon, link.cloudflareR2Url, link.edgeoneBlobUrl];
      let matchesDomain = false;
      try { matchesDomain = !!domain && new URL(link.url).hostname === domain; } catch {}
      if (matchesDomain || (key && urls.some(value => typeof value === 'string' && value.startsWith('/api/favicon?') && new URL(value, request.url).searchParams.get('key') === key))) {
        referenced = true;
        if (allowed.has(category.id) && allowed.has(link.categoryId || category.id)) return true;
      }
    }
  }
  // An unreferenced object may be an administrator's upload awaiting Save.
  return !!domain && !referenced;
}
