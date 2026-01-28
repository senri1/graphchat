import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceFolder } from '../workspace/tree';

type Props = {
  open: boolean;
  title?: string;
  confirmLabel?: string;
  root: WorkspaceFolder;
  initialSelectionId?: string | null;
  disableFolderIds?: Set<string>;
  footerLeft?: React.ReactNode;
  onClose: () => void;
  onConfirm: (destinationFolderId: string) => void | Promise<void>;
  onCreateFolder?: (parentFolderId: string) => Promise<string> | string;
};

type FlatFolder = { id: string; name: string; depth: number };

function walkFolders(root: WorkspaceFolder): FlatFolder[] {
  const out: FlatFolder[] = [];
  const visit = (folder: WorkspaceFolder, depth: number) => {
    out.push({ id: folder.id, name: folder.name, depth });
    for (const child of folder.children ?? []) {
      if (child?.kind !== 'folder') continue;
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

export default function FolderPickerDialog(props: Props) {
  const open = props.open;
  const onClose = props.onClose;
  const disableSet = props.disableFolderIds ?? new Set<string>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  const flat = useMemo(() => walkFolders(props.root), [props.root]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flat;
    return flat.filter((f) => String(f.name ?? '').toLowerCase().includes(q));
  }, [flat, query]);

  useEffect(() => {
    if (!open) return;
    const initial = props.initialSelectionId && flat.some((f) => f.id === props.initialSelectionId) ? props.initialSelectionId : props.root.id;
    setSelectedId(initial);
    setQuery('');
    const raf = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [open, props.initialSelectionId, props.root.id, flat]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const portalTarget = typeof document !== 'undefined' ? document.body : null;
  if (!open || !portalTarget) return null;

  const canConfirm = Boolean(selectedId) && !disableSet.has(String(selectedId ?? ''));

  return createPortal(
    <div className="folderPickerOverlay" role="dialog" aria-modal="true" aria-label={props.title || 'Select folder'}>
      <div className="folderPickerOverlay__backdrop" onMouseDown={onClose} />
      <div
        className="folderPickerDialog"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <div className="folderPickerDialog__title">{props.title || 'Choose folder'}</div>

        <div className="folderPickerDialog__controls">
          <input
            ref={searchRef}
            className="settingsTextInput folderPickerDialog__search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search folders…"
            aria-label="Search folders"
          />
          {props.onCreateFolder ? (
            <button
              className="settingsBtn"
              type="button"
              onClick={async () => {
                const pid = selectedId && !disableSet.has(selectedId) ? selectedId : props.root.id;
                try {
                  const created = await props.onCreateFolder!(pid);
                  if (created) setSelectedId(String(created));
                } catch {
                  // ignore
                }
              }}
            >
              New folder
            </button>
          ) : null}
        </div>

        <div className="folderPickerDialog__list" role="list">
          {filtered.map((f) => {
            const disabled = disableSet.has(f.id);
            const selected = selectedId === f.id;
            return (
              <button
                key={f.id}
                type="button"
                role="listitem"
                className={`folderPickerRow ${selected ? 'folderPickerRow--selected' : ''} ${disabled ? 'folderPickerRow--disabled' : ''}`}
                onClick={() => {
                  if (disabled) return;
                  setSelectedId(f.id);
                }}
              >
                <span className="folderPickerRow__indent" style={{ width: `${Math.max(0, f.depth) * 12}px` }} />
                <span className="folderPickerRow__name">{f.name}</span>
              </button>
            );
          })}
        </div>

        <div className="folderPickerDialog__footer">
          <div className="folderPickerDialog__footerLeft">{props.footerLeft}</div>
          <div className="folderPickerDialog__actions">
            <button className="settingsBtn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className={`settingsBtn ${canConfirm ? 'settingsBtn--primary' : ''}`}
              type="button"
              disabled={!canConfirm}
              onClick={() => {
                const id = String(selectedId ?? '');
                if (!id || disableSet.has(id)) return;
                void props.onConfirm(id);
              }}
            >
              {props.confirmLabel || 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
