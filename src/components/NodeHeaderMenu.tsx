import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type ClientRect = { left: number; top: number; right: number; bottom: number };

type Props = {
  nodeId: string;
  getButtonRect: (nodeId: string) => ClientRect | null;
  rawEnabled: boolean;
  onRaw: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export default function NodeHeaderMenu(props: Props) {
  const { nodeId, getButtonRect, rawEnabled, onRaw, onDelete, onClose } = props;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const updatePosition = useCallback(() => {
    const rect = getButtonRect(nodeId);
    if (!rect) {
      setPos(null);
      return;
    }

    const gap = 10;
    const viewportPadding = 8;
    const estimatedWidth = 150;
    const estimatedHeight = 96;

    let left = rect.right + gap;
    let top = rect.top;

    if (left + estimatedWidth > window.innerWidth - viewportPadding) {
      left = Math.max(viewportPadding, rect.left - gap - estimatedWidth);
    }
    if (top + estimatedHeight > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, window.innerHeight - viewportPadding - estimatedHeight);
    }

    setPos({ left, top });
  }, [getButtonRect, nodeId]);

  useEffect(() => {
    updatePosition();
  }, [updatePosition]);

  const onCloseRef = useRef(onClose);
  const nodeIdRef = useRef(nodeId);
  const getButtonRectRef = useRef(getButtonRect);
  const updatePositionRef = useRef(updatePosition);

  useEffect(() => {
    onCloseRef.current = onClose;
    nodeIdRef.current = nodeId;
    getButtonRectRef.current = getButtonRect;
    updatePositionRef.current = updatePosition;
  }, [getButtonRect, nodeId, onClose, updatePosition]);

  useEffect(() => {
    const onPointerDownCapture = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;

      const menu = menuRef.current;
      if (menu && menu.contains(target)) return;

      const rect = getButtonRectRef.current(nodeIdRef.current);
      if (rect) {
        const x = e.clientX;
        const y = e.clientY;
        const insideButton = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        if (insideButton) return;
      }

      onCloseRef.current();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };

    const onReposition = () => updatePositionRef.current();

    window.addEventListener('pointerdown', onPointerDownCapture, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('wheel', onReposition, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onPointerDownCapture, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('wheel', onReposition);
    };
  }, []);

  const portalTarget = typeof document !== 'undefined' ? document.body : null;
  const menu = useMemo(() => {
    if (!portalTarget || !pos) return null;
    return createPortal(
      <div
        className="treeRow__menu"
        role="menu"
        aria-label="Node actions"
        ref={menuRef}
        style={{ left: pos.left, top: pos.top }}
      >
        <button
          className="treeRow__menuItem"
          type="button"
          role="menuitem"
          disabled={!rawEnabled}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!rawEnabled) return;
            onClose();
            onRaw();
          }}
        >
          Raw
        </button>
        <button
          className="treeRow__menuItem treeRow__menuItem--danger"
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            onDelete();
          }}
        >
          Delete
        </button>
      </div>,
      portalTarget,
    );
  }, [onClose, onDelete, onRaw, portalTarget, pos, rawEnabled]);

  return menu;
}
