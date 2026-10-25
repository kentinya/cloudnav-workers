import { normalizeLinkIcon } from '../../services/iconStorage.js';
import React, { createContext, useContext, useReducer, useCallback, useMemo, useLayoutEffect, useRef } from 'react';
import { LinkItem, Category } from '../../types';
import { STORAGE_KEYS, API_ENDPOINTS } from '../constants';
import { useAuthContext } from './AuthContext';
import { cachePublicNavigation } from '../utils/navigationCache';
import { toast } from '../../components/Toast';
import { assertBackupNavigation } from '../../services/navigationRules.js';

// --- Types ---
interface LinksState {
  links: LinkItem[];
  syncStatus: 'idle' | 'saving' | 'saved' | 'error';
}

type LinksAction =
  | { type: 'SET_LINKS'; payload: LinkItem[] }
  | { type: 'ADD_LINK'; payload: LinkItem }
  | { type: 'UPDATE_LINK'; payload: LinkItem }
  | { type: 'DELETE_LINK'; payload: string }
  | { type: 'DELETE_LINKS'; payload: Set<string> }
  | { type: 'SET_SYNC_STATUS'; payload: LinksState['syncStatus'] };

interface LinksContextValue extends LinksState {
  initLinks: (links: LinkItem[], verifiedToken?: string, version?: string) => void;
  saveNavigation: (body: { links?: LinkItem[]; categories?: Category[]; restore?: true }) => Promise<void>;
  restoreNavigation: (links: LinkItem[], categories: Category[]) => Promise<void>;
  isReadyToSave: () => boolean;
  addLink: (data: Omit<LinkItem, 'id' | 'createdAt'>) => void;
  updateLink: (link: LinkItem) => void;
  deleteLink: (id: string) => void;
  deleteLinks: (ids: Set<string>) => void;
  updateLinks: (links: LinkItem[]) => void;
  setLinksAndSync: (links: LinkItem[], categories: Category[], includeCategories?: boolean) => Promise<boolean>;
  pinnedLinks: LinkItem[];
  getLinksByCategory: (categoryId: string) => LinkItem[];
}

// --- Reducer ---
function linksReducer(state: LinksState, action: LinksAction): LinksState {
  switch (action.type) {
    case 'SET_LINKS':
      return { ...state, links: action.payload.map(normalizeLinkIcon) };
    case 'ADD_LINK':
      return { ...state, links: [normalizeLinkIcon(action.payload), ...state.links] };
    case 'UPDATE_LINK':
      return { ...state, links: state.links.map(l => l.id === action.payload.id ? normalizeLinkIcon(action.payload) : l) };
    case 'DELETE_LINK':
      return { ...state, links: state.links.filter(l => l.id !== action.payload) };
    case 'DELETE_LINKS':
      return { ...state, links: state.links.filter(l => !action.payload.has(l.id)) };
    case 'SET_SYNC_STATUS':
      return { ...state, syncStatus: action.payload };
    default:
      return state;
  }
}

// --- Context ---
const LinksContext = createContext<LinksContextValue | null>(null);

// --- Provider ---
export function LinksProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(linksReducer, {
    links: [],
    syncStatus: 'idle',
  });

  const { authToken } = useAuthContext();

  const activeAuth = useRef(authToken);
  activeAuth.current = authToken;
  const loadedToken = useRef<string | null>(null);
  const navigationVersion = useRef<string | null>(null);
  const saving = useRef(false);

  const isReadyToSave = useCallback(() => Boolean(
    authToken && activeAuth.current === authToken && loadedToken.current === authToken && navigationVersion.current
  ), [authToken]);

  useLayoutEffect(() => {
    loadedToken.current = null;
    navigationVersion.current = null;
    dispatch({ type: 'SET_LINKS', payload: [] });
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_KEY);
  }, [authToken]);

  // 初始化（不触发同步）
  const initLinks = useCallback((links: LinkItem[], verifiedToken?: string, version?: string) => {
    navigationVersion.current = version || null;
    loadedToken.current = verifiedToken && verifiedToken === activeAuth.current ? verifiedToken : null;
    dispatch({ type: 'SET_LINKS', payload: links });
  }, []);

  // One version stream is shared by bookmark, category, import and restore writes.
  const saveNavigation = useCallback(async (body: { links?: LinkItem[]; categories?: Category[]; restore?: true }) => {
    if (!isReadyToSave()) throw new Error('管理员完整数据尚未加载，请刷新后重试');
    if (saving.current) throw new Error('正在保存，请稍后再操作');
    saving.current = true;
    dispatch({ type: 'SET_SYNC_STATUS', payload: 'saving' });
    try {
      const response = await fetch(API_ENDPOINTS.STORAGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-password': authToken! },
        body: JSON.stringify({ ...body, version: navigationVersion.current }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '保存失败，请刷新确认云端数据后重试');
      }
      if (activeAuth.current !== authToken) return;
      const nextVersion = response.headers.get('X-Navigation-Version');
      if (!nextVersion) throw new Error('保存响应缺少版本，请刷新后重试');
      navigationVersion.current = nextVersion;
      dispatch({ type: 'SET_SYNC_STATUS', payload: 'saved' });
      setTimeout(() => dispatch({ type: 'SET_SYNC_STATUS', payload: 'idle' }), 2000);
    } catch (error) {
      // A conflict or an ambiguous network result must be resolved by reloading,
      // never by retrying an old full snapshot with a newly fetched version.
      loadedToken.current = null;
      dispatch({ type: 'SET_SYNC_STATUS', payload: 'error' });
      throw error;
    } finally {
      saving.current = false;
    }
  }, [authToken, isReadyToSave]);

  const addLink = useCallback((data: Omit<LinkItem, 'id' | 'createdAt'>) => {
    const newLink: LinkItem = {
      ...data,
      id: Date.now().toString(),
      createdAt: Date.now(),
    };
    dispatch({ type: 'ADD_LINK', payload: newLink });
  }, []);

  const updateLink = useCallback((link: LinkItem) => {
    dispatch({ type: 'UPDATE_LINK', payload: link });
  }, []);

  const deleteLink = useCallback((id: string) => {
    dispatch({ type: 'DELETE_LINK', payload: id });
  }, []);

  const deleteLinks = useCallback((ids: Set<string>) => {
    dispatch({ type: 'DELETE_LINKS', payload: ids });
  }, []);

  const updateLinks = useCallback((links: LinkItem[]) => {
    dispatch({ type: 'SET_LINKS', payload: links });
  }, []);

  // 设置链接并同步（用于 updateData 场景）
  const setLinksAndSync = useCallback(async (links: LinkItem[], categories: Category[], includeCategories = false) => {
    try {
      const normalized = links.map(normalizeLinkIcon) as LinkItem[];
      await saveNavigation(includeCategories ? { links: normalized, categories } : { links: normalized });
      if (activeAuth.current === authToken) {
        dispatch({ type: 'SET_LINKS', payload: normalized });
        cachePublicNavigation(normalized, categories);
      }
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败，请刷新后重试');
      return false;
    }
  }, [saveNavigation, authToken]);

  const restoreNavigation = useCallback(async (links: LinkItem[], categories: Category[]) => {
    assertBackupNavigation(links, categories);
    const normalized = links.map(normalizeLinkIcon) as LinkItem[];
    await saveNavigation({ links: normalized, categories, restore: true });
    if (activeAuth.current === authToken) {
      dispatch({ type: 'SET_LINKS', payload: normalized });
      cachePublicNavigation(normalized, categories);
    }
  }, [saveNavigation, authToken]);

  // 置顶链接
  const pinnedLinks = useMemo(() =>
    state.links
      .filter(l => l.pinned)
      .sort((a, b) => (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0)),
    [state.links]
  );

  // 按分类获取链接（按 weight 排序，weight 相同按 order 排序）
  const getLinksByCategory = useCallback((categoryId: string) =>
    state.links
      .filter(l => l.categoryId === categoryId)
      .sort((a, b) => {
        const wa = a.weight ?? Infinity;
        const wb = b.weight ?? Infinity;
        if (wa !== wb) return wa - wb;
        return (a.order ?? 0) - (b.order ?? 0);
      }),
    [state.links]
  );

  return (
    <LinksContext.Provider value={{
      ...state,
      initLinks, isReadyToSave, saveNavigation, restoreNavigation,
      addLink, updateLink, deleteLink, deleteLinks,
      updateLinks, setLinksAndSync, pinnedLinks, getLinksByCategory,
    }}>
      {children}
    </LinksContext.Provider>
  );
}

// --- Hook ---
export function useLinksContext() {
  const ctx = useContext(LinksContext);
  if (!ctx) throw new Error('useLinksContext must be used within LinksProvider');
  return ctx;
}
