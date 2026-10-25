import { LinkItem, Category } from '../types';

// Simple UUID generator
const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
};

export interface ImportResult {
  links: LinkItem[];
  categories: Category[];
}

export const parseBookmarks = async (file: File): Promise<ImportResult> => {
  const text = await file.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/html');

  const links: LinkItem[] = [];
  const categories: Category[] = [];
  const categoryMap = new Map<string, string>(); // Name -> ID

  // Helper to get or create category ID with hierarchy support
  const getCategoryId = (name: string, parentId?: string): string => {
    if (!name) return 'common';
    // Normalize: remove generic folders like "Bookmarks Bar"
    if (['Bookmarks Bar', '书签栏', 'Other Bookmarks', '其他书签'].includes(name)) {
        return 'common';
    }

    // Create a unique key that includes parent to handle same-named subcategories
    const uniqueKey = parentId ? `${parentId}/${name}` : name;

    if (categoryMap.has(uniqueKey)) {
      return categoryMap.get(uniqueKey)!;
    }

    const newId = generateId();
    categories.push({
      id: newId,
      name: name,
      icon: 'Folder', // Default icon for imported folders
      parentId: parentId,
      isSubcategory: !!parentId
    });
    categoryMap.set(uniqueKey, newId);
    return newId;
  };

  // Helper to ensure all categories in the path are created
  const ensureCategoryPath = (categoryPath: string[]): string => {
    if (categoryPath.length === 0) return 'common';

    let categoryId = 'common';
    let parentId: string | undefined;

    for (let i = 0; i < categoryPath.length; i++) {
      const categoryName = categoryPath[i];
      categoryId = getCategoryId(categoryName, parentId);
      parentId = categoryId; // For next iteration, this becomes parent
    }

    return categoryId; // Return the deepest category ID
  };

  // Traverse the DL/DT structure with hierarchy support
  // Chrome structure: <DT><H3>Folder Name</H3><DL> ...items... </DL>

  const traverse = (element: Element, categoryPath: string[] = []) => {
    const children = Array.from(element.children);

    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      const tagName = node.tagName.toUpperCase();

      if (tagName === 'DT') {
        // DT can contain an H3 (Folder) or A (Link)
        const h3 = node.querySelector('h3');
        const a = node.querySelector('a');
        const dl = node.querySelector('dl');

        if (h3 && dl) {
            // It's a folder - create hierarchy
            const folderName = h3.textContent || 'Unknown';

            // Skip generic folders
            if (['Bookmarks Bar', '书签栏', 'Other Bookmarks', '其他书签'].includes(folderName)) {
                traverse(dl, categoryPath);
            } else {
                const newCategoryPath = [...categoryPath, folderName];
                // Ensure all categories in the path are created
                ensureCategoryPath(newCategoryPath);
                traverse(dl, newCategoryPath);
            }
        } else if (a) {
            // It's a link
            const title = a.textContent || a.getAttribute('href') || 'No Title';
            const url = a.getAttribute('href');

            if (url && !url.startsWith('chrome://') && !url.startsWith('about:')) {
                // Get the deepest category in the current path
                const categoryId = ensureCategoryPath(categoryPath);

                links.push({
                    id: generateId(),
                    title: title,
                    url: url,
                    categoryId: categoryId,
                    createdAt: Date.now(),
                    icon: a.getAttribute('icon') || undefined
                });
            }
        }
      }
    }
  };

  const rootDl = doc.querySelector('dl');
  if (rootDl) {
    traverse(rootDl, []);
  }

  return { links, categories };
};