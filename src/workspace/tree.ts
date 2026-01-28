export type WorkspaceChat = {
  kind: 'chat';
  id: string;
  name: string;
};

export type WorkspaceFolder = {
  kind: 'folder';
  id: string;
  name: string;
  expanded: boolean;
  children: WorkspaceItem[];
};

export type WorkspaceItem = WorkspaceChat | WorkspaceFolder;

export function findItem(root: WorkspaceFolder, itemId: string): WorkspaceItem | null {
  if (root.id === itemId) return root;
  for (const child of root.children) {
    if (child.id === itemId) return child;
    if (child.kind === 'folder') {
      const hit = findItem(child, itemId);
      if (hit) return hit;
    }
  }
  return null;
}

export function findFirstChatId(root: WorkspaceFolder): string | null {
  for (const child of root.children) {
    if (child.kind === 'chat') return child.id;
    const nested = findFirstChatId(child);
    if (nested) return nested;
  }
  return null;
}

export function collectChatIds(item: WorkspaceItem): string[] {
  if (item.kind === 'chat') return [item.id];
  const out: string[] = [];
  for (const child of item.children) out.push(...collectChatIds(child));
  return out;
}

export function toggleFolder(root: WorkspaceFolder, folderId: string): WorkspaceFolder {
  if (root.id === folderId) return { ...root, expanded: !root.expanded };
  let changed = false;
  const nextChildren = root.children.map((child) => {
    if (child.kind !== 'folder') return child;
    const next = toggleFolder(child, folderId);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children: nextChildren } : root;
}

export function renameItem(root: WorkspaceFolder, itemId: string, nextName: string): WorkspaceFolder {
  if (root.id === itemId) return { ...root, name: nextName };
  let changed = false;
  const nextChildren = root.children.map((child) => {
    if (child.id === itemId) {
      changed = true;
      return { ...child, name: nextName } as WorkspaceItem;
    }
    if (child.kind === 'folder') {
      const next = renameItem(child, itemId, nextName);
      if (next !== child) changed = true;
      return next;
    }
    return child;
  });
  return changed ? { ...root, children: nextChildren } : root;
}

export function insertItem(root: WorkspaceFolder, folderId: string, item: WorkspaceItem): WorkspaceFolder {
  const target = folderId ? findItem(root, folderId) : null;
  const effectiveFolderId = target && target.kind === 'folder' ? folderId : root.id;
  return insertItemInto(root, effectiveFolderId, item, 'end');
}

export function insertItemAtTop(root: WorkspaceFolder, folderId: string, item: WorkspaceItem): WorkspaceFolder {
  const target = folderId ? findItem(root, folderId) : null;
  const effectiveFolderId = target && target.kind === 'folder' ? folderId : root.id;
  return insertItemInto(root, effectiveFolderId, item, 'start');
}

type InsertPosition = 'start' | 'end';

function insertItemInto(root: WorkspaceFolder, folderId: string, item: WorkspaceItem, position: InsertPosition): WorkspaceFolder {
  if (root.id === folderId) {
    const nextChildren = position === 'start' ? [item, ...root.children] : [...root.children, item];
    return { ...root, expanded: true, children: nextChildren };
  }
  let changed = false;
  const nextChildren = root.children.map((child) => {
    if (child.kind !== 'folder') return child;
    const next = insertItemInto(child, folderId, item, position);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, expanded: true, children: nextChildren } : root;
}

function containsId(item: WorkspaceItem, maybeId: string): boolean {
  if (item.id === maybeId) return true;
  if (item.kind !== 'folder') return false;
  for (const child of item.children) {
    if (containsId(child, maybeId)) return true;
  }
  return false;
}

export function detachItem(root: WorkspaceFolder, itemId: string): { root: WorkspaceFolder; item: WorkspaceItem | null } {
  let detached: WorkspaceItem | null = null;

  const walk = (folder: WorkspaceFolder): WorkspaceFolder => {
    if (detached) return folder;

    let changed = false;
    const nextChildren: WorkspaceItem[] = [];

    for (const child of folder.children) {
      if (child.id === itemId) {
        detached = child;
        changed = true;
        continue;
      }

      if (child.kind === 'folder') {
        const nextFolder = walk(child);
        if (nextFolder !== child) changed = true;
        nextChildren.push(nextFolder);
        if (detached) continue;
        continue;
      }

      nextChildren.push(child);
    }

    return changed ? { ...folder, children: nextChildren } : folder;
  };

  const nextRoot = walk(root);
  return { root: nextRoot, item: detached };
}

export function deleteItem(root: WorkspaceFolder, itemId: string): { root: WorkspaceFolder; removed: WorkspaceItem | null } {
  const { root: nextRoot, item } = detachItem(root, itemId);
  return { root: nextRoot, removed: item };
}

export function moveItem(root: WorkspaceFolder, itemId: string, targetFolderId: string): WorkspaceFolder {
  if (!itemId || !targetFolderId) return root;
  if (itemId === root.id) return root;
  if (itemId === targetFolderId) return root;

  const item = findItem(root, itemId);
  if (!item) return root;
  if (item.kind === 'folder' && containsId(item, targetFolderId)) return root;

  const { root: without, item: detached } = detachItem(root, itemId);
  if (!detached) return root;
  const target = findItem(without, targetFolderId);
  const folderId = target && target.kind === 'folder' ? targetFolderId : without.id;
  return insertItem(without, folderId, detached);
}
