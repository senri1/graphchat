import React, { useMemo, useState } from 'react';
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

  const beginRename = (item: WorkspaceItem) => {
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
          >
            <button
              className="treeRow__chev"
              type="button"
              onClick={() => {
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
                onClick={() => onFocusFolder(item.id)}
                title="Focus folder"
              >
                {item.name}
              </button>
            )}

            <div className="treeRow__actions">
              <button className="treeRow__iconBtn" type="button" onClick={() => beginRename(item)} title="Rename">
                Rename
              </button>
              {item.id !== rootId ? (
                <button
                  className="treeRow__iconBtn treeRow__iconBtn--danger"
                  type="button"
                  onClick={() => onDeleteItem(item.id)}
                  title="Delete folder"
                >
                  Delete
                </button>
              ) : null}
            </div>
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
        style={{ paddingLeft: indent + 18 }}
        draggable
        onDragStart={onDragStart}
        {...rowCommonHandlers}
      >
        <div className="treeRow__dot" />
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
          <button className="treeRow__label" type="button" onClick={() => onSelectChat(item.id)}>
            {item.name}
          </button>
        )}
        <div className="treeRow__actions">
          <button className="treeRow__iconBtn" type="button" onClick={() => beginRename(item)} title="Rename">
            Rename
          </button>
          <button
            className="treeRow__iconBtn treeRow__iconBtn--danger"
            type="button"
            onClick={() => onDeleteItem(item.id)}
            title="Delete chat"
          >
            Delete
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={`sidebarDock ${collapsed ? 'sidebarDock--collapsed' : ''}`}>
      <div className={`sidebarWrap ${collapsed ? 'sidebarWrap--collapsed' : ''}`} aria-hidden={collapsed}>
        <div className="sidebar" {...rowCommonHandlers}>
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
            className="sidebar__tree"
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
            {root.children.map((child) => renderItem(child, 0))}
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
