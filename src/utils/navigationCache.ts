import type { Category, LinkItem } from '../../types';
import { STORAGE_KEYS } from '../constants';

// Private bookmarks and password drafts stay in memory, including for administrators.
export function cachePublicNavigation(links: LinkItem[], categories: Category[]) {
  const publicIds = new Set<string>();
  const isPublic = (category: Category, seen = new Set<string>()): boolean => {
    if (seen.has(category.id) || category.visibility === 'private' || category.password || category.passwordHash || category.hasPassword) return false;
    seen.add(category.id);
    const parent = categories.find(item => item.id === category.parentId);
    return category.parentId ? !!parent && isPublic(parent, seen) : true;
  };
  categories.filter(category => isPublic(category)).forEach(category => publicIds.add(category.id));
  localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_KEY, JSON.stringify({
    links: links.filter(link => publicIds.has(link.categoryId)),
    categories: categories.map(({ password, passwordHash, ...category }) => category),
  }));
}
