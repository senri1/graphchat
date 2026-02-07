import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Rect } from '../engine/types';

type Props = {
  nodeId: string;
  title: string | null;
  initialValue: string;
  anchorRect: Rect | null;
  getScreenRect?: () => Rect | null;
  getZoom?: () => number;
  viewport: { w: number; h: number };
  zoom: number;
  baseFontSizePx: number;
  compiledPdfUrl: string | null;
  compileError: string | null;
  compiledAt: number | null;
  onDraftChange?: (next: string) => void;
  onResize: (nextRect: Rect) => void;
  onResizeEnd: () => void;
  onCommit: (next: string) => void;
  onCancel: () => void;
  onCompile: (source: string) => Promise<void>;
};

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export default function LatexNodeEditor(props: Props) {
  const {
    nodeId,
    title,
    initialValue,
    anchorRect,
    getScreenRect,
    getZoom,
    viewport,
    zoom,
    baseFontSizePx,
    compiledPdfUrl,
    compileError,
    compiledAt,
    onDraftChange,
    onResize,
    onResizeEnd,
    onCommit,
    onCancel,
    onCompile,
  } = props;

  const [draft, setDraft] = useState(() => initialValue ?? '');
  const [isCompiling, setIsCompiling] = useState(false);
  const [runtimeCompileError, setRuntimeCompileError] = useState<string | null>(null);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(draft);
  const anchorRectRef = useRef<Rect | null>(anchorRect ?? null);
  const onCommitRef = useRef(onCommit);
  const onCancelRef = useRef(onCancel);
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  const onCompileRef = useRef(onCompile);
  const onDraftChangeRef = useRef<Props['onDraftChange']>(onDraftChange);
  const getScreenRectRef = useRef<Props['getScreenRect']>(getScreenRect);
  const getZoomRef = useRef<Props['getZoom']>(getZoom);
  const resizeRef = useRef<{
    pointerId: number;
    corner: ResizeCorner;
    startClient: { x: number; y: number };
    startRect: Rect;
    startZoom: number;
  } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClient: { x: number; y: number };
    startRect: Rect;
  } | null>(null);

  const [liveRect, setLiveRect] = useState<Rect | null>(() => anchorRect ?? null);
  const liveRectRef = useRef<Rect | null>(anchorRect ?? null);

  useEffect(() => {
    onCommitRef.current = onCommit;
    onCancelRef.current = onCancel;
    onResizeRef.current = onResize;
    onResizeEndRef.current = onResizeEnd;
    onCompileRef.current = onCompile;
    onDraftChangeRef.current = onDraftChange;
  }, [onCancel, onCommit, onCompile, onDraftChange, onResize, onResizeEnd]);

  useEffect(() => {
    getScreenRectRef.current = getScreenRect;
  }, [getScreenRect]);

  useEffect(() => {
    getZoomRef.current = getZoom;
  }, [getZoom]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    liveRectRef.current = liveRect ?? null;
  }, [liveRect]);

  useEffect(() => {
    setDraft(initialValue ?? '');
    draftRef.current = initialValue ?? '';
    onDraftChangeRef.current?.(initialValue ?? '');
    setRuntimeCompileError(null);
    setIsCompiling(false);
    const raf = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [initialValue, nodeId]);

  useEffect(() => {
    if (resizeRef.current || dragRef.current) return;
    setLiveRect(anchorRect ?? null);
    anchorRectRef.current = anchorRect ?? null;
  }, [anchorRect?.x, anchorRect?.y, anchorRect?.w, anchorRect?.h, nodeId]);

  const followEnabled = typeof getScreenRect === 'function';
  useEffect(() => {
    if (!followEnabled) return;
    let raf = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      raf = requestAnimationFrame(tick);
      const el = rootRef.current;
      const fn = getScreenRectRef.current;
      if (!el) return;

      const rawZoom = getZoomRef.current?.();
      const zNow = Math.max(0.001, Number.isFinite(rawZoom as number) ? Number(rawZoom) : 1);
      el.style.setProperty('--editor-scale', String(zNow));

      if (resizeRef.current || dragRef.current) return;
      if (!fn) return;
      const r = fn();
      if (!r) return;
      anchorRectRef.current = r;

      const w = Math.max(1, Number(r.w));
      const h = Math.max(1, Number(r.h));
      el.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
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

  const applyResize = (start: Rect, corner: ResizeCorner, dx: number, dy: number, minW: number, minH: number): Rect => {
    const right = start.x + start.w;
    const bottom = start.y + start.h;

    let next: Rect;
    switch (corner) {
      case 'nw':
        next = { x: start.x + dx, y: start.y + dy, w: start.w - dx, h: start.h - dy };
        break;
      case 'ne':
        next = { x: start.x, y: start.y + dy, w: start.w + dx, h: start.h - dy };
        break;
      case 'sw':
        next = { x: start.x + dx, y: start.y, w: start.w - dx, h: start.h + dy };
        break;
      default:
        next = { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy };
        break;
    }

    if (next.w < minW) {
      if (corner === 'nw' || corner === 'sw') next.x = right - minW;
      next.w = minW;
    }
    if (next.h < minH) {
      if (corner === 'nw' || corner === 'ne') next.y = bottom - minH;
      next.h = minH;
    }
    return next;
  };

  const beginResize = (corner: ResizeCorner) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = liveRectRef.current ?? anchorRectRef.current;
    if (!rect) return;
    const pointerId = e.pointerId;
    const target = e.currentTarget;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // ignore
    }

    const z = Math.max(0.001, Number.isFinite(zoom) ? Number(zoom) : 1);
    resizeRef.current = {
      pointerId,
      corner,
      startClient: { x: e.clientX, y: e.clientY },
      startRect: { ...rect },
      startZoom: z,
    };
  };

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = (e.clientX - active.startClient.x) / active.startZoom;
    const dy = (e.clientY - active.startClient.y) / active.startZoom;
    const next = applyResize(active.startRect, active.corner, dx, dy, 340, 240);
    setLiveRect(next);
    onResizeRef.current(next);
  };

  const onResizePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    resizeRef.current = null;
    const next = liveRectRef.current;
    if (next) onResizeRef.current(next);
    onResizeEndRef.current();
  };

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = liveRectRef.current ?? anchorRectRef.current;
    if (!rect) return;
    const pointerId = e.pointerId;
    const target = e.currentTarget;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // ignore
    }

    dragRef.current = {
      pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      startRect: { ...rect },
    };
  };

  const onDragPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const z = Math.max(0.001, Number.isFinite(zoom) ? Number(zoom) : 1);
    const dx = (e.clientX - active.startClient.x) / z;
    const dy = (e.clientY - active.startClient.y) / z;
    const next: Rect = { ...active.startRect, x: active.startRect.x + dx, y: active.startRect.y + dy };
    setLiveRect(next);
    onResizeRef.current(next);
  };

  const onDragPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    dragRef.current = null;
    const next = liveRectRef.current;
    if (next) onResizeRef.current(next);
    onResizeEndRef.current();
  };

  const commit = useCallback(() => {
    onCommitRef.current(draftRef.current);
  }, []);

  const cancel = useCallback(() => {
    onCancelRef.current();
  }, []);

  const compile = useCallback(async () => {
    if (isCompiling) return;
    setRuntimeCompileError(null);
    setIsCompiling(true);
    try {
      await onCompileRef.current(draftRef.current);
    } catch (err: any) {
      const msg = err ? String(err?.message ?? err) : 'Compile failed.';
      setRuntimeCompileError(msg);
    } finally {
      setIsCompiling(false);
    }
  }, [isCompiling]);

  const activeAnchorRect = liveRect ?? anchorRect ?? null;
  const style = useMemo<React.CSSProperties>(() => {
    const baseFontSize = Math.max(10, baseFontSizePx || 16);
    if (activeAnchorRect) {
      if (followEnabled) {
        return {
          transform: `translate3d(${activeAnchorRect.x}px, ${activeAnchorRect.y}px, 0)`,
          width: activeAnchorRect.w,
          height: activeAnchorRect.h,
          borderRadius: 'calc(18px * var(--editor-scale, 1))',
          willChange: 'transform',
          ...(typeof zoom === 'number' ? ({ ['--editor-scale' as any]: zoom, ['--editor-font-size' as any]: `${baseFontSize}px` } as any) : ({} as any)),
        };
      }
      return {
        left: activeAnchorRect.x,
        top: activeAnchorRect.y,
        width: activeAnchorRect.w,
        height: activeAnchorRect.h,
        borderRadius: 'calc(18px * var(--editor-scale, 1))',
        ...(typeof zoom === 'number' ? ({ ['--editor-scale' as any]: zoom, ['--editor-font-size' as any]: `${baseFontSize}px` } as any) : ({} as any)),
      };
    }

    const margin = 12;
    const vpW = Math.max(1, viewport.w || window.innerWidth || 1);
    const vpH = Math.max(1, viewport.h || window.innerHeight || 1);
    const w = Math.min(980, vpW - margin * 2);
    const h = Math.min(Math.round(vpH * 0.76), vpH - margin * 2);
    return {
      left: (vpW - w) * 0.5,
      top: margin,
      width: w,
      height: h,
      ...(typeof zoom === 'number' ? ({ ['--editor-scale' as any]: zoom, ['--editor-font-size' as any]: `${baseFontSize}px` } as any) : ({} as any)),
    };
  }, [activeAnchorRect, baseFontSizePx, followEnabled, viewport.h, viewport.w, zoom]);

  const statusText = useMemo(() => {
    if (isCompiling) return 'Compiling...';
    if (runtimeCompileError) return runtimeCompileError;
    if (compileError) return compileError;
    if (Number.isFinite(compiledAt) && (compiledAt as number) > 0) {
      return `Compiled ${new Date(compiledAt as number).toLocaleString()}`;
    }
    return 'No compiled PDF yet.';
  }, [compileError, compiledAt, isCompiling, runtimeCompileError]);

  return (
    <div
      ref={rootRef}
      className="editor editor--edit editor--latex"
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

      <div className="editor__topbar">
        <div
          className="editor__title editor__title--draggable"
          onPointerDown={beginDrag}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerEnd}
          onPointerCancel={onDragPointerEnd}
        >
          {title ?? 'LaTeX node'}
        </div>
        <div className="editor__actions">
          <button className="editor__btn editor__btn--primary" type="button" onClick={() => void compile()} disabled={isCompiling}>
            {isCompiling ? 'Compiling...' : 'Compile'}
          </button>
          <button className="editor__btn" type="button" onClick={cancel}>
            Cancel
          </button>
          <button className="editor__btn editor__btn--primary" type="button" onClick={commit}>
            Done
          </button>
        </div>
      </div>

      <div className="editor__body editor__body--preview">
        <div className="editor__pane editor__pane--edit">
          <div className="editor__paneLabel">TeX source</div>
          <textarea
            ref={taRef}
            className="editor__textarea editor__textarea--latex"
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              onDraftChangeRef.current?.(next);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
                return;
              }
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                void compile();
              }
            }}
          />
        </div>
        <div className="editor__pane editor__pane--preview">
          <div className={`editor__paneLabel ${compileError || runtimeCompileError ? 'editor__paneLabel--error' : ''}`}>{statusText}</div>
          <div className="editor__preview editor__preview--pdf">
            {compiledPdfUrl ? (
              <iframe className="editor__pdfPreview" src={compiledPdfUrl} title="Compiled PDF preview" />
            ) : (
              <div className="editor__emptyPreview">Compile the document to preview the PDF.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
