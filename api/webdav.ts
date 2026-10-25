// Vercel WebDAV 代理接口
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCorsHeaders } from './_kvHelper.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsHeaders = getCorsHeaders();
  res.setHeader('Access-Control-Allow-Origin', corsHeaders['Access-Control-Allow-Origin']);
  res.setHeader('Access-Control-Allow-Methods', corsHeaders['Access-Control-Allow-Methods']);
  res.setHeader('Access-Control-Allow-Headers', corsHeaders['Access-Control-Allow-Headers']);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { operation, config, payload } = req.body;

    if (!config || !config.url || !config.username || !config.password) {
      return res.status(400).json({ error: 'Missing configuration' });
    }

    let baseUrl = config.url.trim();
    if (!baseUrl.endsWith('/')) baseUrl += '/';

    const filename = 'cloudnav_backup.json';
    const fileUrl = baseUrl + filename;
    const authHeader = `Basic ${btoa(`${config.username}:${config.password}`)}`;

    let fetchUrl = baseUrl;
    let method = 'PROPFIND';
    let headers: Record<string, string> = {
      'Authorization': authHeader,
      'User-Agent': 'CloudNav/1.0',
    };
    let requestBody: string | undefined;

    if (operation === 'check') {
      fetchUrl = baseUrl;
      method = 'PROPFIND';
      headers['Depth'] = '0';
    } else if (operation === 'upload') {
      fetchUrl = fileUrl;
      method = 'PUT';
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(payload);
    } else if (operation === 'download') {
      fetchUrl = fileUrl;
      method = 'GET';
    } else {
      return res.status(400).json({ error: 'Invalid operation' });
    }

    const response = await fetch(fetchUrl, { method, headers, body: requestBody });

    if (operation === 'download') {
      if (!response.ok) {
        if (response.status === 404) {
          return res.status(404).json({ error: 'Backup file not found' });
        }
        return res.status(response.status).json({ error: `WebDAV Error: ${response.status}` });
      }
      const data = await response.json();
      return res.status(200).json(data);
    }

    const success = response.ok || response.status === 207;
    return res.status(200).json({ success, status: response.status });

  } catch (err: any) {
    console.error('WebDAV API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
