const prefix = '__cloudnav/session/';

export async function saveSession(env, token, expiresAt) {
  if (!env.CLOUDNAV_R2) throw new Error('Cloudflare R2 binding CLOUDNAV_R2 not found');
  await env.CLOUDNAV_R2.put(`${prefix}${token}`, JSON.stringify({ expiresAt }));
}

export async function revokeSession(env, token) {
  if (!/^[a-f0-9]{64}$/i.test(token || '')) return;
  if (!env.CLOUDNAV_R2) throw new Error('Cloudflare R2 binding CLOUDNAV_R2 not found');
  // Keep a tombstone: a delayed KV replica must not revive the old session.
  await env.CLOUDNAV_R2.put(`${prefix}${token}`, JSON.stringify({ revoked: true }));
  await env.CLOUDNAV_KV.delete(`auth_token:${token}`);
}

export async function verifySession(r2, token, kv) {
  if (!r2) return false;
  const object = await r2.get(`${prefix}${token}`);
  if (object) {
    const record = await object.json();
    return !record.revoked && (record.expiresAt === null || record.expiresAt > Date.now());
  }
  // Existing sessions remain usable during upgrade, unless explicitly revoked.
  return await kv.get(`auth_token:${token}`) === 'valid';
}
