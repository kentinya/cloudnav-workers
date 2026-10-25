import { normalizeLinkIcon } from '../../services/iconStorage.js';
import React, { createContext, useContext, useReducer, useCallback, useMemo, useLayoutEffect, useRef } from 'react';
import { LinkItem, Category } from '../../types';
import { STORAGE_KEYS, API_ENDPOINTS } from '../constants';
import { useAuthContext } from './AuthContext';
import { cachePublicNavigation } from '../utils/navigationCache';
import { toast } from '../../components/Toast';

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
  initLinks: (links: LinkItem[], verifiedToken?: string) => void;
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

  const isReadyToSave = useCallback(() => Boolean(
    authToken && activeAuth.current === authToken && loadedToken.current === authToken
  ), [authToken]);

  useLayoutEffect(() => {
    loadedToken.current = null;
    dispatch({ type: 'SET_LINKS', payload: [] });
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_KEY);
  }, [authToken]);

  // 初始化（不触发同步）
  const initLinks = useCallback((links: LinkItem[], verifiedToken?: string) => {
    loadedToken.current = verifiedToken && verifiedToken === activeAuth.current ? verifiedToken : null;
    dispatch({ type: 'SET_LINKS', payload: links });
  }, []);

  // 同步到云端
  const syncToCloud = useCallback(async (links: LinkItem[], categories: Category[], token: string, includeCategories: boolean) => {
    dispatch({ type: 'SET_SYNC_STATUS', payload: 'saving' });
    try {
      const res = await fetch(API_ENDPOINTS.STORAGE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-password': token,
        },
        body: JSON.stringify(includeCategories ? { links, categories } : { links }),
      });
      if (res.status === 401) {
        dispatch({ type: 'SET_SYNC_STATUS', payload: 'error' });
        toast.error('管理员会话已失效，请重新登录后再保存');
        return false;
      }
      if (!res.ok) throw new Error('Sync failed');
      dispatch({ type: 'SET_SYNC_STATUS', payload: 'saved' });
      setTimeout(() => dispatch({ type: 'SET_SYNC_STATUS', payload: 'idle' }), 2000);
      return true;
    } catch (e) {
      console.error('Sync failed:', e);
      toast.error('保存失败，请刷新确认云端数据后重试');
      dispatch({ type: 'SET_SYNC_STATUS', payload: 'error' });
      return false;
    }
  }, []);

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
    if (!isReadyToSave()) {
      toast.error('管理员完整数据尚未加载，请刷新后重试');
      return false;
    }
    dispatch({ type: 'SET_LINKS', payload: links });
    cachePublicNavigation(links, categories);
    return syncToCloud(links.map(normalizeLinkIcon), categories, authToken!, includeCategories);
  }, [isReadyToSave, authToken, syncToCloud]);

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
      initLinks, isReadyToSave,
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
