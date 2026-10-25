export const AUTH_WINDOW_MS = 10 * 60 * 1000;
export const AUTH_LIMITS = { admin: { client: 10, total: 100 }, category: { client: 20, total: 200 } };

// A bounded record per authentication surface, not one permanent R2 key per IP.
// R2's conditional write makes concurrent guesses share the same budget.
export async function consumeAuthAttempt(r2, request, scope) {
  if (!r2) throw Object.assign(new Error('缺少 CLOUDNAV_R2，无法安全验证密码'), { status: 503 });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request?.headers.get('CF-Connecting-IP') || 'local'));
  const client = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = `__cloudnav/rate/${scope}`;
  const limits = AUTH_LIMITS[scope];
  const limited = expiresAt => Object.assign(new Error('验证过于频繁，请稍后重试'), {
    status: 429, retryAfter: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
  });
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const object = await r2.get(key);
      const now = Date.now();
      let record = object ? await object.json() : null;
      if (!record || record.expiresAt <= now) record = { expiresAt: now + AUTH_WINDOW_MS, total: 0, clients: {} };
      const count = record.clients[client] || 0;
      if (count >= limits.client || record.total >= limits.total) throw limited(record.expiresAt);
      record.total++;
      record.clients[client] = count + 1;
      const result = await r2.put(key, JSON.stringify(record), {
        onlyIf: object ? { etagMatches: object.etag } : new Headers({ 'If-None-Match': '*' }),
      });
      if (result) return;
    }
    throw limited(Date.now() + 1000);
  } catch (error) {
    if (error.status === 429) throw error;
    throw Object.assign(new Error('密码验证服务暂时不可用，请稍后重试'), { status: 503 });
  }
}

export async function passwordMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length > 1024) return false;
  const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [left, right] = await Promise.all([digest(candidate), digest(expected)]);
  const bytes = new Uint8Array(right);
  return new Uint8Array(left).reduce((diff, byte, i) => diff | (byte ^ bytes[i]), 0) === 0;
}
