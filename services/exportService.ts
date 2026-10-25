import { Category, LinkItem } from "../types";

/**
 * Generates a Netscape Bookmark HTML string compatible with Chrome/Edge/Firefox import.
 */
export const generateBookmarkHtml = (links: LinkItem[], categories: Category[]): string => {
  const now = Math.floor(Date.now() / 1000);

  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

  // Helper to escape HTML special characters
  const escapeHtml = (unsafe: string) => {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  // Group links by category
  const linksByCat = new Map<string, LinkItem[]>();
  links.forEach(link => {
    const list = linksByCat.get(link.categoryId) || [];
    list.push(link);
    linksByCat.set(link.categoryId, list);
  });

  // Organize categories into a tree
  const categoryMap = new Map<string, Category & { children: any[] }>();
  categories.forEach(cat => {
    categoryMap.set(cat.id, { ...cat, children: [] });
  });

  const rootCategories: any[] = [];
  categoryMap.forEach(cat => {
    if (cat.parentId && categoryMap.has(cat.parentId)) {
      categoryMap.get(cat.parentId)!.children.push(cat);
    } else {
      // Top level categories (common, dev, etc. or custom top level)
      // Note: 'common' is often treated as root or just a top level folder.
      rootCategories.push(cat);
    }
  });

  // Recursive function to generate HTML for a category and its children
  const renderCategory = (cat: any) => {
    let output = `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${escapeHtml(cat.name)}</H3>\n`;
    output += `    <DL><p>\n`;

    // 1. Render Links in this category
    const catLinks = linksByCat.get(cat.id) || [];
    catLinks.forEach(link => {
        const date = Math.floor(link.createdAt / 1000);
        const iconAttr = link.icon ? ` ICON="${link.icon}"` : '';
        output += `        <DT><A HREF="${link.url}" ADD_DATE="${date}"${iconAttr}>${escapeHtml(link.title)}</A>\n`;
    });

    // 2. Recurse for Subcategories
    if (cat.children && cat.children.length > 0) {
        cat.children.forEach((child: any) => {
            output += renderCategory(child);
        });
    }

    output += `    </DL><p>\n`;
    return output;
  };

  rootCategories.forEach(cat => {
      html += renderCategory(cat);
  });

  // Process Uncategorized (really uncategorized, not just common)
  const validCatIds = new Set(categories.map(c => c.id));
  const uncategorized = links.filter(l => !validCatIds.has(l.categoryId));

  if (uncategorized.length > 0) {
    html += `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">未分类</H3>\n`;
    html += `    <DL><p>\n`;
    uncategorized.forEach(link => {
        const date = Math.floor(link.createdAt / 1000);
        html += `        <DT><A HREF="${link.url}" ADD_DATE="${date}">${escapeHtml(link.title)}</A>\n`;
    });
    html += `    </DL><p>\n`;
  }

  html += `</DL><p>`;

  return html;
};

export const downloadHtmlFile = (content: string, filename: string = 'bookmarks.html') => {
  const blob = new Blob([content], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};