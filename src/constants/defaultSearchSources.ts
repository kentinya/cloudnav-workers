import { ExternalSearchSource } from '../../types';

export const DEFAULT_SEARCH_SOURCES: ExternalSearchSource[] = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=', icon: 'Search', enabled: true, createdAt: Date.now() },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=', icon: 'Search', enabled: true, createdAt: Date.now() },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=', icon: 'Search', enabled: true, createdAt: Date.now() },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=', icon: 'Search', enabled: true, createdAt: Date.now() },
  { id: 'github', name: 'GitHub', url: 'https://github.com/search?q=', icon: 'Github', enabled: true, createdAt: Date.now() },
];
