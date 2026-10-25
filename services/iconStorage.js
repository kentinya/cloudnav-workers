/** @typedef {import('../types').LinkItem} LinkItem */
/** @typedef {import('../types').StoredIconBackup} StoredIconBackup */

/** Return the R2 key only for icons served by this application's API. */
export function getStoredIconKey(url) {
  if (typeof url !== 'string' || !url.startsWith('/api/favicon?')) return null;
  return new URL(url, 'https://cloudnav.invalid').searchParams.get('key');
}

/**
 * Read old bookmark metadata without retaining another storage backend.
 * Embedded icon files in older backups are restored to R2 separately.
 * @param {LinkItem & { edgeoneBlobUrl?: string }} link
 * @returns {LinkItem}
 */
export function normalizeLinkIcon(link) {
  const { edgeoneBlobUrl, ...normalized } = link;
  const legacyUpload = link.iconType === 'upload' || link.iconType === 'upload-edgeone';
  const legacyUrl = edgeoneBlobUrl || (legacyUpload ? link.icon : undefined);

  if (!normalized.cloudflareR2Url && getStoredIconKey(legacyUrl)) {
    normalized.cloudflareR2Url = legacyUrl;
  }
  if (!normalized.customIconUrl && legacyUrl && !getStoredIconKey(legacyUrl)) {
    normalized.customIconUrl = legacyUrl;
  }
  if (legacyUpload) {
    normalized.icon ||= legacyUrl;
    normalized.iconType = getStoredIconKey(normalized.icon)
      ? 'upload-cloudflare'
      : normalized.icon ? 'customurl' : 'google';
  } else if (!normalized.iconType && getStoredIconKey(normalized.icon)) {
    normalized.iconType = 'upload-cloudflare';
  }
  return normalized;
}

/** @param {LinkItem} link */
export function getStoredIconUrls(link) {
  const normalized = normalizeLinkIcon(link);
  return [...new Set([normalized.icon, normalized.cloudflareR2Url].filter(url => getStoredIconKey(url)))];
}

/** @param {LinkItem} link */
export function remapStoredIcon(link, key, newUrl) {
  const updated = normalizeLinkIcon(link);
  if (getStoredIconKey(updated.icon) === key) {
    updated.icon = newUrl;
    updated.iconType = 'upload-cloudflare';
    updated.cloudflareR2Url = newUrl;
  } else if (getStoredIconKey(updated.cloudflareR2Url) === key) {
    updated.cloudflareR2Url = newUrl;
  }
  return updated;
}

/**
 * Restore all embedded icons to R2, ignoring obsolete backup platform labels.
 * @param {StoredIconBackup[]} uploadedIcons
 * @param {LinkItem[]} linksList
 * @param {(current: number, total: number) => void} [onProgress]
 * @returns {Promise<LinkItem[]>}
 */
export async function restoreUploadedIcons(uploadedIcons, linksList, onProgress) {
  let updatedLinks = linksList.map(normalizeLinkIcon);
  const authToken = localStorage.getItem('cloudnav_auth_token') || localStorage.getItem('authToken') || '';

  for (const [index, icon] of uploadedIcons.entries()) {
    onProgress?.(index + 1, uploadedIcons.length);
    try {
      const response = await fetch(icon.data);
      const blob = await response.blob();
      const file = new File([blob], icon.key.split('/').pop() || 'icon.png', { type: blob.type });
      const formData = new FormData();
      formData.append('file', file);
      formData.append('categoryName', icon.key.split('/')[0] || 'common');

      const upload = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-auth-password': authToken },
        body: formData,
      });
      if (!upload.ok) throw new Error(`Icon upload failed: ${upload.status}`);
      const result = await upload.json();
      if (!result.success || !result.url) throw new Error('Icon upload returned no URL');
      updatedLinks = updatedLinks.map(link => remapStoredIcon(link, icon.key, result.url));
    } catch (error) {
      console.error(`Failed to restore icon: ${icon.key}`, error);
    }
  }
  return updatedLinks;
}
