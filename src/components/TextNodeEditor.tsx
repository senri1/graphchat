import React, { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownMath from './MarkdownMath';
import type { Rect } from '../engine/types';

type Props = {
  nodeId: string;
  title: string | null;
  initialValue: string;
  anchorRect: Rect | null;
  viewport: { w: number; h: number };
  zoom: number;
  baseFontSizePx: number;
  onCommit: (next: string) => void;
  onCancel: () => void;
};

export default function TextNodeEditor(props: Props) {
  const { nodeId, title, initialValue, anchorRect, viewport, zoom, baseFontSizePx, onCommit, onCancel } = props;
  const [draft, setDraft] = useState(() => initialValue ?? '');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const committedRef = useRef(false);
  const draftRef = useRef(draft);
  const onCommitRef = useRef(onCommit);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCommitRef.current = onCommit;
    onCancelRef.current = onCancel;
  }, [onCommit, onCancel]);

  useEffect(() => {
    committedRef.current = false;
    setDraft(initialValue ?? '');
    draftRef.current = initialValue ?? '';
    const raf = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [nodeId, initialValue]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    const onPointerDownCapture = (e: PointerEvent) => {
      if (committedRef.current) return;
      const root = rootRef.current;
      const target = e.target as Node | null;
      if (!root || !target) return;
      if (root.contains(target)) return;
      committedRef.current = true;
      onCommitRef.current(draftRef.current);
    };
    window.addEventListener('pointerdown', onPointerDownCapture, true);
    return () => window.removeEventListener('pointerdown', onPointerDownCapture, true);
  }, []);

  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancelRef.current();
  };

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommitRef.current(draftRef.current);
  };

  const baseFontSize = Math.max(1, Math.round(Number.isFinite(baseFontSizePx) ? baseFontSizePx : 14));
  const z = Math.max(0.001, Number.isFinite(zoom) ? zoom : 1);
  const chrome = useMemo(() => {
    if (!anchorRect) return null;
    const totalContentWorldW = Math.max(1, anchorRect.w / z - 28);
    const paneWorldW = Math.max(1, totalContentWorldW * 0.5 - 6);
    return {
      headerH: 50 * z,
      cornerR: 18 * z,
      padX: 14 * z,
      padTop: 12 * z,
      gap: 10 * z,
      contentWorldW: paneWorldW,
      contentWorldH: Math.max(1, anchorRect.h / z - 64),
    };
  }, [anchorRect, z]);

  const style = useMemo<React.CSSProperties>(() => {
    if (anchorRect) {
      return {
        left: anchorRect.x,
        top: anchorRect.y,
        width: anchorRect.w,
        height: anchorRect.h,
        borderRadius: `${18 * z}px`,
      };
    }

    const margin = 12;
    const vpW = Math.max(1, viewport.w || window.innerWidth || 1);
    const vpH = Math.max(1, viewport.h || window.innerHeight || 1);
    const w = Math.min(740, vpW - margin * 2);
    const h = Math.min(Math.round(vpH * 0.72), vpH - margin * 2);
    return { left: (vpW - w) * 0.5, top: margin, width: w, height: h };
  }, [anchorRect, viewport.h, viewport.w, z]);

  const previewStyle = useMemo<React.CSSProperties>(
    () => ({
      fontSize: baseFontSize,
      color: 'rgba(255,255,255,0.92)',
      lineHeight: 'var(--node-line-height)',
      wordBreak: 'break-word',
      fontFamily: 'var(--node-font-family)',
    }),
    [baseFontSize],
  );

  const topbarStyle = useMemo<React.CSSProperties>(() => {
    if (!chrome) return {};
    return {
      height: `${chrome.headerH}px`,
      padding: `${chrome.padTop}px ${chrome.padX}px 0 ${chrome.padX}px`,
      alignItems: 'flex-start',
    };
  }, [chrome]);

  const bodyStyle = useMemo<React.CSSProperties>(() => {
    if (!chrome) return {};
    return {
      padding: `0 ${chrome.padX}px ${chrome.padX}px ${chrome.padX}px`,
      gap: `${chrome.gap}px`,
    };
  }, [chrome]);

  const textareaStyle = useMemo<React.CSSProperties>(() => {
    if (!chrome) return {};
    return {
      padding: `${Math.max(0, 10 * z)}px 0`,
      fontSize: `${Math.max(1, baseFontSize * z)}px`,
    };
  }, [baseFontSize, chrome, z]);

  return (
    <div
      ref={rootRef}
      className="editor"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="editor__topbar" style={topbarStyle}>
        <div className="editor__title">{title ?? 'Edit node'}</div>
        <div className="editor__actions">
          <button className="editor__btn" type="button" onClick={cancel}>
            Cancel
          </button>
          <button className="editor__btn editor__btn--primary" type="button" onClick={commit}>
            Done
          </button>
        </div>
      </div>

      <div className="editor__body" style={bodyStyle}>
        <textarea
          ref={taRef}
          className="editor__textarea"
          style={textareaStyle}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancel();
              return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              commit();
            }
          }}
        />

        <div className="editor__preview">
          <div
            className="editor__previewScaled"
            style={
              chrome
                ? {
                    width: `${chrome.contentWorldW}px`,
                    height: `${chrome.contentWorldH}px`,
                    transform: `scale(${z})`,
                    transformOrigin: '0 0',
                  }
                : undefined
            }
          >
            <MarkdownMath source={draft} className="mdx" style={previewStyle} />
          </div>
        </div>
      </div>
    </div>
  );
}
