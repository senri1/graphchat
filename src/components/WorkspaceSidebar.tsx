import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceFolder, WorkspaceItem } from '../workspace/tree';

type Props = {
  root: WorkspaceFolder;
  activeChatId: string | null;
  focusedFolderId: string;
  onFocusFolder: (folderId: string) => void;
  onToggleFolder: (folderId: string) => void;
  onSelectChat: (chatId: string) => void;
  onCreateChat: (parentFolderId: string) => void;
  onCreateFolder: (parentFolderId: string) => void;
  onRenameItem: (itemId: string, name: string) => void;
  onDeleteItem: (itemId: string) => void;
  onMoveItem: (itemId: string, targetFolderId: string) => void;
};

type DragPayload = { id: string };

function parseDragPayload(data: string | null): DragPayload | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as any;
    if (!parsed?.id || typeof parsed.id !== 'string') return null;
    return { id: parsed.id };
  } catch {
    return null;
  }
}

export default function WorkspaceSidebar(props: Props) {
  const {
    root,
    activeChatId,
    focusedFolderId,
    onFocusFolder,
    onToggleFolder,
    onSelectChat,
    onCreateChat,
    onCreateFolder,
    onRenameItem,
    onDeleteItem,
    onMoveItem,
  } = props;

  const rootId = root.id;

  const [collapsed, setCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [openItemMenuId, setOpenItemMenuId] = useState<string | null>(null);
  const [itemMenuPos, setItemMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [revealedItemMenuId, setRevealedItemMenuId] = useState<string | null>(null);
  const sidebarRef = React.useRef<HTMLDivElement | null>(null);
  const itemMenuButtonRefs = React.useRef(new Map<string, HTMLButtonElement | null>());
  const itemMenuRef = React.useRef<HTMLDivElement | null>(null);

  const beginRename = (item: WorkspaceItem) => {
    setOpenItemMenuId(null);
    setRenamingId(item.id);
    setRenameDraft(item.name);
  };

  const commitRename = () => {
    const id = renamingId;
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!id) return;
    if (!next) return;
    onRenameItem(id, next);
  };

  const cancelRename = () => {
    setRenamingId(null);
  };

  const updateItemMenuPosition = React.useCallback((itemId: string) => {
    const btn = itemMenuButtonRefs.current.get(itemId);
    if (!btn) return;
    const rect = btn.getBoundingClientRect();

    const gap = 10;
    const viewportPadding = 8;
    const estimatedWidth = 150;
    const estimatedHeight = 100;

    let left = rect.right + gap;
    let top = rect.top;

    if (left + estimatedWidth > window.innerWidth - viewportPadding) {
      left = Math.max(viewportPadding, rect.left - gap - estimatedWidth);
    }
    if (top + estimatedHeight > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, window.innerHeight - viewportPadding - estimatedHeight);
    }

    setItemMenuPos({ left, top });
  }, []);

  React.useEffect(() => {
    if (!openItemMenuId) return;

    const onPointerDownCapture = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const btn = itemMenuButtonRefs.current.get(openItemMenuId);
      const menu = itemMenuRef.current;
      if (btn && btn.contains(target)) return;
      if (menu && menu.contains(target)) return;
      setOpenItemMenuId(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenItemMenuId(null);
    };

    const onReposition = () => updateItemMenuPosition(openItemMenuId);

    window.addEventListener('pointerdown', onPointerDownCapture, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);

    updateItemMenuPosition(openItemMenuId);
    return () => {
      window.removeEventListener('pointerdown', onPointerDownCapture, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [openItemMenuId, updateItemMenuPosition]);

  React.useEffect(() => {
    if (!revealedItemMenuId) return;

    const onPointerDownCapture = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const sidebar = sidebarRef.current;
      const menu = itemMenuRef.current;
      if (sidebar && sidebar.contains(target)) return;
      if (menu && menu.contains(target)) return;
      setRevealedItemMenuId(null);
    };

    window.addEventListener('pointerdown', onPointerDownCapture, true);
    return () => window.removeEventListener('pointerdown', onPointerDownCapture, true);
  }, [revealedItemMenuId]);

  const rowCommonHandlers = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      onPointerMove: (e: React.PointerEvent) => e.stopPropagation(),
      onPointerUp: (e: React.PointerEvent) => e.stopPropagation(),
      onWheel: (e: React.WheelEvent) => e.stopPropagation(),
    }),
    [],
  );

  const renderItem = (item: WorkspaceItem, depth: number) => {
    const indent = 10 + depth * 14;
    const isFolder = item.kind === 'folder';
    const isChat = item.kind === 'chat';
    const isActive = isChat && item.id === activeChatId;
    const isFocusedFolder = isFolder && item.id === focusedFolderId;
    const isRenaming = renamingId === item.id;

    const onDragStart = (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-graphchat-item', JSON.stringify({ id: item.id }));
      e.dataTransfer.setData('text/plain', item.id);
    };

    const onDragOverFolder = (e: React.DragEvent) => {
      if (!isFolder) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
    };

    const onDropFolder = (e: React.DragEvent) => {
      if (!isFolder) return;
      e.preventDefault();
      e.stopPropagation();
      const payload = parseDragPayload(e.dataTransfer.getData('application/x-graphchat-item'));
      if (!payload) return;
      if (payload.id === item.id) return;
      onMoveItem(payload.id, item.id);
    };

    if (item.kind === 'folder') {
      return (
        <div key={item.id}>
          <div
            className={`treeRow treeRow--folder ${isFocusedFolder ? 'treeRow--focused' : ''}`}
            style={{ paddingLeft: indent }}
            draggable={item.id !== rootId}
            onDragStart={item.id !== rootId ? onDragStart : undefined}
            onDragOver={onDragOverFolder}
            onDrop={onDropFolder}
            {...rowCommonHandlers}
            data-item-menu-open={openItemMenuId === item.id ? 'true' : 'false'}
            data-item-menu-revealed={revealedItemMenuId === item.id ? 'true' : 'false'}
          >
            <button
              className="treeRow__chev"
              type="button"
              onClick={() => {
                setOpenItemMenuId(null);
                setRevealedItemMenuId(item.id);
                onToggleFolder(item.id);
                onFocusFolder(item.id);
              }}
              aria-label={item.expanded ? 'Collapse folder' : 'Expand folder'}
            >
              {item.expanded ? '▾' : '▸'}
            </button>
            {isRenaming ? (
              <input
                className="treeRow__rename"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                autoFocus
              />
            ) : (
              <button
                className="treeRow__label"
                type="button"
                onClick={() => {
                  setOpenItemMenuId(null);
                  setRevealedItemMenuId(item.id);
                  onFocusFolder(item.id);
                }}
                title="Focus folder"
              >
                {item.name}
              </button>
            )}

            {!isRenaming ? (
              <div className="treeRow__menuWrap">
                <button
                  className="treeRow__menuBtn"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={openItemMenuId === item.id}
                  aria-label="Folder menu"
                  title="Menu"
                  ref={(el) => {
                    itemMenuButtonRefs.current.set(item.id, el);
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRevealedItemMenuId(item.id);
                    const nextId = openItemMenuId === item.id ? null : item.id;
                    setOpenItemMenuId(nextId);
                    if (nextId) updateItemMenuPosition(nextId);
                  }}
                >
                  ⋮
                </button>
                {openItemMenuId === item.id && itemMenuPos && typeof document !== 'undefined'
                  ? createPortal(
                      <div
                        className="treeRow__menu"
                        role="menu"
                        aria-label="Folder actions"
                        ref={itemMenuRef}
                        style={{ left: itemMenuPos.left, top: itemMenuPos.top }}
                      >
                        <button
                          className="treeRow__menuItem"
                          type="button"
                          role="menuitem"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            beginRename(item);
                          }}
                        >
                          Rename
                        </button>
                        {item.id !== rootId ? (
                          <button
                            className="treeRow__menuItem treeRow__menuItem--danger"
                            type="button"
                            role="menuitem"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setOpenItemMenuId(null);
                              onDeleteItem(item.id);
                            }}
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
            ) : null}
          </div>

          {item.expanded ? (
            <div>{item.children.map((child) => renderItem(child, depth + 1))}</div>
          ) : null}
        </div>
      );
    }

    return (
      <div
        key={item.id}
        className={`treeRow treeRow--chat ${isActive ? 'treeRow--active' : ''}`}
        style={{ paddingLeft: indent }}
        draggable
        onDragStart={onDragStart}
        {...rowCommonHandlers}
        data-item-menu-open={openItemMenuId === item.id ? 'true' : 'false'}
        data-item-menu-revealed={revealedItemMenuId === item.id ? 'true' : 'false'}
      >
        {isRenaming ? (
          <input
            className="treeRow__rename"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              }
            }}
            autoFocus
          />
        ) : (
          <button
            className="treeRow__label"
            type="button"
            onClick={() => {
              setOpenItemMenuId(null);
              setRevealedItemMenuId(item.id);
              onSelectChat(item.id);
            }}
          >
            {item.name}
          </button>
        )}
        {!isRenaming ? (
          <div className="treeRow__menuWrap">
            <button
              className="treeRow__menuBtn"
              type="button"
              aria-haspopup="menu"
              aria-expanded={openItemMenuId === item.id}
              aria-label="Chat menu"
              title="Menu"
              ref={(el) => {
                itemMenuButtonRefs.current.set(item.id, el);
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setRevealedItemMenuId(item.id);
                const nextId = openItemMenuId === item.id ? null : item.id;
                setOpenItemMenuId(nextId);
                if (nextId) updateItemMenuPosition(nextId);
              }}
            >
              ⋮
            </button>
            {openItemMenuId === item.id && itemMenuPos && typeof document !== 'undefined'
              ? createPortal(
                  <div
                    className="treeRow__menu"
                    role="menu"
                    aria-label="Chat actions"
                    ref={itemMenuRef}
                    style={{ left: itemMenuPos.left, top: itemMenuPos.top }}
                  >
                    <button
                      className="treeRow__menuItem"
                      type="button"
                      role="menuitem"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        beginRename(item);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="treeRow__menuItem treeRow__menuItem--danger"
                      type="button"
                      role="menuitem"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setOpenItemMenuId(null);
                        onDeleteItem(item.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>,
                  document.body,
                )
              : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className={`sidebarDock ${collapsed ? 'sidebarDock--collapsed' : ''}`}>
      <div className={`sidebarWrap ${collapsed ? 'sidebarWrap--collapsed' : ''}`} aria-hidden={collapsed}>
        <div className="sidebar" ref={sidebarRef} {...rowCommonHandlers}>
          <div className="sidebar__header">
            <button
              className="sidebar__title"
              type="button"
              onClick={() => onFocusFolder(rootId)}
              title="Focus root folder"
            >
              Chats
            </button>
            <div className="sidebar__headerActions">
              <button className="sidebar__btn" type="button" onClick={() => onCreateChat(focusedFolderId)}>
                New chat
              </button>
              <button className="sidebar__btn" type="button" onClick={() => onCreateFolder(focusedFolderId)}>
                New folder
              </button>
            </div>
          </div>
          <div
            className="sidebar__treeWrap"
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const payload = parseDragPayload(e.dataTransfer.getData('application/x-graphchat-item'));
              if (!payload) return;
              if (payload.id === rootId) return;
              onMoveItem(payload.id, rootId);
            }}
          >
            <div className="sidebar__tree">{root.children.map((child) => renderItem(child, 0))}</div>
          </div>
        </div>
      </div>

      <button
        className="sidebarToggle"
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        {...rowCommonHandlers}
      >
        {collapsed ? '›' : '‹'}
      </button>
    </div>
  );
}
