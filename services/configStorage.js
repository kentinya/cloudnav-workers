// A single batch request replaces the old parallel writes. Only an acknowledged
// commit may update the editor's local state or display a success message.
export async function saveConfigSections(sections, authToken, configVersion) {
  const headers = { 'Content-Type': 'application/json', 'x-auth-password': authToken };
  if (!configVersion) {
    const loaded = await fetch('/api/storage?key=config&admin=true', { headers });
    if (!loaded.ok) throw new Error('读取云端设置失败，请重试');
    configVersion = (await loaded.json()).configVersion;
  }
  if (typeof configVersion !== 'string') throw new Error('缺少设置版本，请重新打开设置后重试');
  const response = await fetch('/api/storage', {
    method: 'POST', headers, body: JSON.stringify({ saveConfig: 'batch', configs: sections, configVersion }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success !== true) throw new Error(data.error || '保存失败，请重新加载确认云端设置后重试');
  const nextVersion = response.headers.get('X-Config-Version');
  if (!nextVersion) throw new Error('保存响应缺少版本，请重新加载确认云端设置');
  return nextVersion;
}
