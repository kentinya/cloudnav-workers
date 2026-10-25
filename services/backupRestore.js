import { normalizeLinkIcon, restoreUploadedIcons } from './iconStorage.js';
import { assertBackupNavigation } from './navigationRules.js';

// Both local and WebDAV restores must finish saving before applying settings or
// reporting success. Validation precedes even the embedded-icon uploads.
export async function restoreBackup(data, { onRestore, onRestoreSearchConfig, onRestoreAIConfig, onProgress }) {
  assertBackupNavigation(data.links, data.categories);
  const links = Array.isArray(data.uploadedIcons) && data.uploadedIcons.length
    ? await restoreUploadedIcons(data.uploadedIcons, data.links, onProgress)
    : data.links.map(normalizeLinkIcon);
  await onRestore(links, data.categories);
  if (data.searchConfig) await onRestoreSearchConfig(data.searchConfig);
  if (data.aiConfig) await onRestoreAIConfig(data.aiConfig);
}
