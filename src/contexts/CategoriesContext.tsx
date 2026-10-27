import React, { createContext, useContext, useReducer, useCallback, useMemo, useRef } from 'react';
import { Category, LinkItem, DEFAULT_CATEGORIES } from '../../types';
import { STORAGE_KEYS, API_ENDPOINTS } from '../constants';
import { useAuthContext } from './AuthContext';
import { useLinksContext } from './LinksContext';
import { cachePublicNavigation } from '../utils/navigationCache';
import { assertCategoryDeletionAllowed } from '../../services/navigationRules.js';

// --- Types ---
interface CategoriesState {
  categories: Category[];
  unlockedCategoryIds: Set<string>;
  expandedCategories: Set<string>;
}

type CategoriesAction =
  | { type: 'SET_CATEGORIES'; payload: Category[] }
  | { type: 'ADD_CATEGORY'; payload: Category }
  | { type: 'UPDATE_CATEGORY'; payload: Category }
  | { type: 'DELETE_CATEGORY'; payload: string }
  | { type: 'UNLOCK_CATEGORY'; payload: string }
  | { type: 'TOGGLE_EXPAND'; payload: string }
  | { type: 'SET_EXPANDED'; payload: Set<string> };

interface CategoriesContextValue extends CategoriesState {
  initCategories: (categories: Category[]) => void;
  addCategory: (cat: Category) => void;
  updateCategory: (cat: Category) => void;
  deleteCategory: (id: string) => void;
  unlockCategory: (id: string, password: string) => Promise<void>;
  toggleExpand: (id: string) => void;
  setCategoriesAndSync: (categories: Category[], links: LinkItem[]) => Promise<void>;
  categoryTree: CategoryWithChildren[];
  buildCategoryTree: (cats: Category[]) => CategoryWithChildren[];
}

export interface CategoryWithChildren extends Category {
  children: Category[];
}

// --- Reducer ---
function categoriesReducer(state: CategoriesState, action: CategoriesAction): CategoriesState {
  switch (action.type) {
    case 'SET_CATEGORIES':
      return { ...state, categories: action.payload, unlockedCategoryIds: new Set(action.payload.filter(category => !category.isLocked).map(category => category.id)) };
    case 'ADD_CATEGORY':
      return { ...state, categories: [...state.categories, action.payload] };
    case 'UPDATE_CATEGORY':
      return { ...state, categories: state.categories.map(c => c.id === action.payload.id ? action.payload : c) };
    case 'DELETE_CATEGORY':
      return { ...state, categories: state.categories.filter(c => c.id !== action.payload) };
    case 'UNLOCK_CATEGORY':
      return { ...state, unlockedCategoryIds: new Set([...state.unlockedCategoryIds, action.payload]) };
    case 'TOGGLE_EXPAND': {
      const next = new Set(state.expandedCategories);
      if (next.has(action.payload)) next.delete(action.payload);
      else next.add(action.payload);
      return { ...state, expandedCategories: next };
    }
    case 'SET_EXPANDED':
      return { ...state, expandedCategories: action.payload };
    default:
      return state;
  }
}

// --- Context ---
const CategoriesContext = createContext<CategoriesContextValue | null>(null);

// --- Helper ---
function buildCategoryTree(cats: Category[]): CategoryWithChildren[] {
  const topLevels = cats
    .filter(c => !c.parentId)
    .sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0));
  const subcategories = cats.filter(c => c.parentId);
  return topLevels.map(cat => ({
    ...cat,
    children: subcategories
      .filter(sub => sub.parentId === cat.id)
      .sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0)),
  }));
}

// --- Provider ---
export function CategoriesProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(categoriesReducer, {
    categories: [],
    unlockedCategoryIds: new Set<string>(),
    expandedCategories: new Set<string>(),
  });

  const { authToken } = useAuthContext();
  const { links: currentLinks, initLinks, isReadyToSave, saveNavigation } = useLinksContext();
  const activeAuth = useRef(authToken);
  activeAuth.current = authToken;

  const initCategories = useCallback((categories: Category[]) => {
    dispatch({ type: 'SET_CATEGORIES', payload: categories });
  }, []);

  const addCategory = useCallback((cat: Category) => {
    dispatch({ type: 'ADD_CATEGORY', payload: cat });
  }, []);

  const updateCategory = useCallback((cat: Category) => {
    dispatch({ type: 'UPDATE_CATEGORY', payload: cat });
  }, []);

  const deleteCategory = useCallback((id: string) => {
    assertCategoryDeletionAllowed(state.categories, state.categories.filter(category => category.id !== id), currentLinks);
    dispatch({ type: 'DELETE_CATEGORY', payload: id });
  }, [state.categories, currentLinks]);

  const reloadNavigation = useCallback(async () => {
    const response = await fetch(`${API_ENDPOINTS.STORAGE}?getConfig=true${authToken ? '&admin=true' : ''}`, { headers: { 'x-auth-password': authToken || 'public' } });
    if (!response.ok) throw new Error('读取分类失败，请重试');
    const data = await response.json();
    if (activeAuth.current !== authToken) return;
    if (!Array.isArray(data.links) || !Array.isArray(data.categories) || (authToken && data.isAdmin !== true)) {
      throw new Error('管理员完整数据尚未加载，请刷新后重试');
    }
    initLinks(data.links, authToken || undefined, data.version);
    dispatch({ type: 'SET_CATEGORIES', payload: data.categories });
    cachePublicNavigation(data.links, data.categories);
  }, [authToken, initLinks]);

  const unlockCategory = useCallback(async (id: string, password: string) => {
    const response = await fetch('/api/category-auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: id, password }),
    });
    if (!response.ok) throw new Error((await response.json()).error || '分类密码验证失败');
    await reloadNavigation();
  }, [reloadNavigation]);

  const toggleExpand = useCallback((id: string) => {
    dispatch({ type: 'TOGGLE_EXPAND', payload: id });
  }, []);

  const setCategoriesAndSync = useCallback(async (categories: Category[], links: LinkItem[]) => {
    if (!authToken) throw new Error('请先登录管理员');
    if (!isReadyToSave()) throw new Error('管理员完整数据尚未加载，请刷新后重试');
    assertCategoryDeletionAllowed(state.categories, categories, currentLinks);
    await saveNavigation({ categories });
    await reloadNavigation();
  }, [authToken, reloadNavigation, isReadyToSave, saveNavigation, state.categories, currentLinks]);

  const categoryTree = useMemo(() => buildCategoryTree(state.categories), [state.categories]);

  return (
    <CategoriesContext.Provider value={{
      ...state,
      initCategories,
      addCategory, updateCategory, deleteCategory,
      unlockCategory, toggleExpand, setCategoriesAndSync,
      categoryTree, buildCategoryTree,
    }}>
      {children}
    </CategoriesContext.Provider>
  );
}

// --- Hook ---
export function useCategoriesContext() {
  const ctx = useContext(CategoriesContext);
  if (!ctx) throw new Error('useCategoriesContext must be used within CategoriesProvider');
  return ctx;
}
