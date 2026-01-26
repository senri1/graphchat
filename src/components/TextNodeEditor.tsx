import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownMath from './MarkdownMath';
import type { Rect } from '../engine/types';

type Props = {
  nodeId: string;
  title: string | null;
  initialValue: string;
  anchorRect: Rect | null;
  getScreenRect?: () => Rect | null;
  viewport: { w: number; h: number };
  zoom: number;
  baseFontSizePx: number;
  onResize: (nextRect: Rect) => void;
  onResizeEnd: () => void;
  onCommit: (next: string) => void;
  onCancel: () => void;
};

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export default function TextNodeEditor(props: Props) {
  const { nodeId, title, initialValue, anchorRect, getScreenRect, viewport, zoom, baseFontSizePx, onResize, onResizeEnd, onCommit, onCancel } = props;
  const [draft, setDraft] = useState(() => initialValue ?? '');
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorRectRef = useRef<Rect | null>(anchorRect ?? null);
  const committedRef = useRef(false);
  const draftRef = useRef(draft);
  const onCommitRef = useRef(onCommit);
  const onCancelRef = useRef(onCancel);
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  const resizeRef = useRef<{
    pointerId: number;
    corner: ResizeCorner;
    startClient: { x: number; y: number };
    startRect: Rect;
    startZoom: number;
  } | null>(null);
  const getScreenRectRef = useRef<Props['getScreenRect']>(getScreenRect);

  const [liveRect, setLiveRect] = useState<Rect | null>(() => anchorRect ?? null);
  const deferredDraft = useDeferredValue(draft);

  useEffect(() => {
    onCommitRef.current = onCommit;
    onCancelRef.current = onCancel;
    onResizeRef.current = onResize;
    onResizeEndRef.current = onResizeEnd;
  }, [onCancel, onCommit, onResize, onResizeEnd]);

  useEffect(() => {
    committedRef.current = false;
    setDraft(initialValue ?? '');
    draftRef.current = initialValue ?? '';
    const raf = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [nodeId, initialValue]);

  useEffect(() => {
    if (resizeRef.current) return;
    setLiveRect(anchorRect ?? null);
    anchorRectRef.current = anchorRect ?? null;
  }, [anchorRect?.x, anchorRect?.y, anchorRect?.w, anchorRect?.h, nodeId]);

  useEffect(() => {
    getScreenRectRef.current = getScreenRect;
  }, [getScreenRect]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const followEnabled = typeof getScreenRect === 'function';

  useEffect(() => {
    if (!followEnabled) return;
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      raf = requestAnimationFrame(tick);
      if (resizeRef.current) return;

      const el = rootRef.current;
      const fn = getScreenRectRef.current;
      if (!el || !fn) return;
      const r = fn();
      if (!r) return;
      anchorRectRef.current = r;

      const x = Math.round(r.x);
      const y = Math.round(r.y);
      const w = Math.max(1, Math.round(r.w));
      const h = Math.max(1, Math.round(r.h));

      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      try {
        cancelAnimationFrame(raf);
      } catch {
        // ignore
      }
    };
  }, [followEnabled]);

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

  const applyResize = (start: Rect, corner: ResizeCorner, dx: number, dy: number, minW: number, minH: number): Rect => {
    const right = start.x + start.w;
    const bottom = start.y + start.h;

    let next: Rect;
    switch (corner) {
      case 'nw': {
        next = { x: start.x + dx, y: start.y + dy, w: start.w - dx, h: start.h - dy };
        if (next.w < minW) {
          next.w = minW;
          next.x = right - next.w;
        }
        if (next.h < minH) {
          next.h = minH;
          next.y = bottom - next.h;
        }
        break;
      }
      case 'ne': {
        next = { x: start.x, y: start.y + dy, w: start.w + dx, h: start.h - dy };
        if (next.w < minW) next.w = minW;
        if (next.h < minH) {
          next.h = minH;
          next.y = bottom - next.h;
        }
        break;
      }
      case 'sw': {
        next = { x: start.x + dx, y: start.y, w: start.w - dx, h: start.h + dy };
        if (next.w < minW) {
          next.w = minW;
          next.x = right - next.w;
        }
        if (next.h < minH) next.h = minH;
        break;
      }
      case 'se': {
        next = { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy };
        if (next.w < minW) next.w = minW;
        if (next.h < minH) next.h = minH;
        break;
      }
    }

    return next;
  };

  const onResizePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - active.startClient.x;
    const dy = e.clientY - active.startClient.y;
    const minW = 160 * active.startZoom;
    const minH = 110 * active.startZoom;
    const next = applyResize(active.startRect, active.corner, dx, dy, minW, minH);
    setLiveRect(next);
    onResizeRef.current(next);
  };

  const onResizePointerEnd = (e: React.PointerEvent<HTMLElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = null;
    onResizeEndRef.current();
  };

  const beginResize = (corner: ResizeCorner) => (e: React.PointerEvent<HTMLElement>) => {
    if (resizeRef.current) return;
    const startRect = liveRect ?? anchorRectRef.current;
    if (!startRect) return;
    e.preventDefault();
    e.stopPropagation();

    resizeRef.current = {
      pointerId: e.pointerId,
      corner,
      startClient: { x: e.clientX, y: e.clientY },
      startRect,
      startZoom: Math.max(0.001, Number.isFinite(zoom) ? zoom : 1),
    };

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

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
  const activeAnchorRect = liveRect ?? anchorRect;
  const chrome = useMemo(() => {
    if (!activeAnchorRect) return null;
    const totalContentWorldW = Math.max(1, activeAnchorRect.w / z - 28);
    const paneWorldW = previewEnabled ? Math.max(1, totalContentWorldW * 0.5 - 6) : Math.max(1, totalContentWorldW);
    return {
      headerH: 50 * z,
      cornerR: 18 * z,
      padX: 14 * z,
      padTop: 12 * z,
      contentWorldW: paneWorldW,
      contentWorldH: Math.max(1, activeAnchorRect.h / z - 64),
    };
  }, [activeAnchorRect, previewEnabled, z]);

  const style = useMemo<React.CSSProperties>(() => {
    if (activeAnchorRect) {
      if (followEnabled) {
        return {
          left: 0,
          top: 0,
          width: activeAnchorRect.w,
          height: activeAnchorRect.h,
          transform: `translate3d(${Math.round(activeAnchorRect.x)}px, ${Math.round(activeAnchorRect.y)}px, 0)`,
          borderRadius: `${18 * z}px`,
          willChange: 'transform',
        };
      }

      return {
        left: activeAnchorRect.x,
        top: activeAnchorRect.y,
        width: activeAnchorRect.w,
        height: activeAnchorRect.h,
        borderRadius: `${18 * z}px`,
      };
    }

    const margin = 12;
    const vpW = Math.max(1, viewport.w || window.innerWidth || 1);
    const vpH = Math.max(1, viewport.h || window.innerHeight || 1);
    const w = Math.min(740, vpW - margin * 2);
    const h = Math.min(Math.round(vpH * 0.72), vpH - margin * 2);
    return { left: (vpW - w) * 0.5, top: margin, width: w, height: h };
  }, [activeAnchorRect, followEnabled, viewport.h, viewport.w, z]);

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
      <div
        className="editor__resizeHandle editor__resizeHandle--nw"
        aria-hidden="true"
        onPointerDown={beginResize('nw')}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
      />
      <div
        className="editor__resizeHandle editor__resizeHandle--ne"
        aria-hidden="true"
        onPointerDown={beginResize('ne')}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
      />
      <div
        className="editor__resizeHandle editor__resizeHandle--sw"
        aria-hidden="true"
        onPointerDown={beginResize('sw')}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
      />
      <div
        className="editor__resizeHandle editor__resizeHandle--se"
        aria-hidden="true"
        onPointerDown={beginResize('se')}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
      />

      <div className="editor__topbar" style={topbarStyle}>
        <div className="editor__title">{title ?? 'Edit node'}</div>
        <div className="editor__actions">
          <label className="editor__toggle">
            <span>Preview</span>
            <input
              type="checkbox"
              checked={previewEnabled}
              onChange={(e) => setPreviewEnabled(Boolean((e.currentTarget as HTMLInputElement).checked))}
            />
          </label>
          <button className="editor__btn" type="button" onClick={cancel}>
            Cancel
          </button>
          <button className="editor__btn editor__btn--primary" type="button" onClick={commit}>
            Done
          </button>
        </div>
      </div>

      <div className={`editor__body ${previewEnabled ? 'editor__body--preview' : ''}`} style={bodyStyle}>
        <div className="editor__pane editor__pane--edit">
          <div className="editor__paneLabel">Edit</div>
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
        </div>

        {previewEnabled ? (
          <div className="editor__pane editor__pane--preview">
            <div className="editor__paneLabel">Preview</div>
            <div className="editor__preview">
              <div
                className="editor__previewScaled"
                style={
                  chrome
                    ? {
                        width: `${chrome.contentWorldW}px`,
                        transform: `scale(${z})`,
                        transformOrigin: '0 0',
                      }
                    : undefined
                }
              >
                {(deferredDraft ?? '').trim().length > 0 ? (
                  <MarkdownMath source={deferredDraft} className="mdx" style={previewStyle} />
                ) : (
                  <div className="editor__emptyPreview">Nothing to preview.</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
