import { useCallback, useRef } from 'react';
import { LinkItem, Category } from '../../types';
import { STORAGE_KEYS, API_ENDPOINTS } from '../constants';
import { useLinksContext } from '../contexts/LinksContext';
import { useCategoriesContext } from '../contexts/CategoriesContext';
import { useConfigContext } from '../contexts/ConfigContext';
import { useAuthContext } from '../contexts/AuthContext';
import { cachePublicNavigation } from '../utils/navigationCache';
import { configManager } from '../utils/configManager';

/**
 * 数据同步 Hook：管理 localStorage ↔ KV 的加载和同步
 */
export function useDataSync() {
  const { links = [], initLinks, setLinksAndSync } = useLinksContext();
  const { categories = [], initCategories } = useCategoriesContext();
  const { initConfig } = useConfigContext();
  const { authToken, isCheckingAuth } = useAuthContext();
  const generation = useRef(0);
  const activeAuth = useRef(authToken);
  activeAuth.current = authToken;

  // 从 KV 加载链接和分类
  const loadFromCloud = useCallback(async (): Promise<{ links: LinkItem[]; categories: Category[]; version?: string } | null> => {
    try {
      const res = await fetch(`${API_ENDPOINTS.STORAGE}?getConfig=true&readOnly=true${authToken ? '&admin=true' : ''}`, { headers: { 'x-auth-password': authToken || 'public' } });
      if (!res.ok) return null;
      const data = await res.json();
      if (Array.isArray(data.links) && Array.isArray(data.categories) && (!authToken || (data.isAdmin === true && typeof data.version === 'string'))) {
        return { links: data.links || [], categories: data.categories || [], version: data.version };
      }
      return null;
    } catch (e) {
      console.error('Load from cloud failed:', e);
      return null;
    }
  }, [authToken]);

  // 从 KV 加载各个配置
  const loadConfigsFromCloud = useCallback(async () => {
    const configKeys = ['search', 'website', 'ai', 'weather', 'mastodon', 'icon', 'view', 'ui'];
    const configMap: Record<string, any> = {};

    await Promise.all(configKeys.map(async (key) => {
      try {
        const res = await fetch(`${API_ENDPOINTS.STORAGE}?getConfig=${key}`, { headers: { 'x-auth-password': authToken || 'public' } });
        if (res.ok) {
          const data = await res.json();
          if (authToken !== activeAuth.current) return;
          if (data && Object.keys(data).length > 0) {
            if (key === 'view') {
              if (data.defaultMode) {
                configManager.updateViewMode(data.defaultMode, true);
                const userPref = localStorage.getItem('cloudnav_view_mode_preference');
                if (!userPref) {
                  configMap.viewMode = data.defaultMode;
                }
              }
            } else if (key === 'ui') {
              if (typeof data.showPinnedWebsites === 'boolean') {
                configMap.showPinnedWebsites = data.showPinnedWebsites;
              }
            } else {
              // 将后端命名的 'mastodon' 映射为前端统一使用的 'ticker'
              const configKey = key === 'mastodon' ? 'ticker' : key;
              configMap[configKey] = data;
            }
          }
        }
      } catch (e) {
        console.error(`Load config ${key} failed:`, e);
      }
    }));

    // 更新 ConfigContext
    if (authToken === activeAuth.current && Object.keys(configMap).length > 0) {
      initConfig(configMap);
    }
  }, [initConfig, authToken]);

  // 初始化数据
  const initData = useCallback(async () => {
    if (isCheckingAuth) return false;
    const current = ++generation.current;
    // Previously cached administrator data must never paint on a public visit.
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_KEY);
    initLinks([]);
    initCategories([]);

    // 2. 并行从云端获取最新数据
    const [cloud] = await Promise.all([
      loadFromCloud(),
      loadConfigsFromCloud(),
    ]);

    if (current !== generation.current || authToken !== activeAuth.current) return false;
    if (cloud) {
      let cats = cloud.categories;
      const visibleLinks = cloud.links;
      if (!cats.some((c: Category) => c.id === 'common')) {
        cats = [{ id: 'common', name: '常用推荐', icon: 'Star' }, ...cats];
      }
      initLinks(visibleLinks, authToken || undefined, cloud.version);
      initCategories(cats);
      cachePublicNavigation(visibleLinks, cats);
      return true;
    }
    return false;
  }, [loadFromCloud, loadConfigsFromCloud, initLinks, initCategories, isCheckingAuth, authToken]);

  // 同步到云端
  const syncToCloud = useCallback(async () => {
    if (!links.length && !categories.length) return;
    setLinksAndSync(links, categories);
  }, [links, categories, setLinksAndSync]);

  return { initData, loadFromCloud, syncToCloud };
}
