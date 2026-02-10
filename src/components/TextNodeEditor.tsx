import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import MarkdownMath from './MarkdownMath';
import { renderMarkdownMathInline } from '../markdown/renderMarkdownMath';
import type { Rect } from '../engine/types';
import type { ModelInfo } from '../llm/registry';

type TextNodeUserPreface = { replyTo: string; contexts: string[]; collapsedPrefaceContexts: Record<number, boolean> };
type SendPlacementClientPoint = { clientX: number; clientY: number };
type SendOptions = { modelIdOverride?: string | null; placementClient?: SendPlacementClientPoint | null };

type Props = {
  nodeId: string;
  title: string | null;
  initialValue: string;
  userPreface?: TextNodeUserPreface | null;
  modelId: string;
  modelOptions: ModelInfo[];
  anchorRect: Rect | null;
  getScreenRect?: () => Rect | null;
  getZoom?: () => number;
  viewport: { w: number; h: number };
  zoom: number;
  baseFontSizePx: number;
  onDraftChange?: (next: string) => void;
  onResize: (nextRect: Rect) => void;
  onResizeEnd: () => void;
  onTogglePrefaceContext?: (contextIndex: number) => void;
  onCommit: (next: string) => void;
  onCancel: () => void;
  onSend: (text: string, opts?: SendOptions) => void;
  onReply?: (text: string) => void;
  onSelectModel?: (modelId: string) => void;
  onSendPreview?: (opts?: { placementClient?: SendPlacementClientPoint | null }) => void;
};

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

type MenuPos = { left: number; top?: number; bottom?: number; maxHeight: number };

export default function TextNodeEditor(props: Props) {
  const { nodeId, title, initialValue, userPreface, modelId, modelOptions, anchorRect, getScreenRect, getZoom, viewport, zoom, baseFontSizePx, onDraftChange, onResize, onResizeEnd, onTogglePrefaceContext, onCommit, onCancel, onSend, onReply, onSelectModel, onSendPreview } = props;
  const [draft, setDraft] = useState(() => initialValue ?? '');
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [collapsedPrefaceContexts, setCollapsedPrefaceContexts] = useState<Record<number, boolean>>(() => userPreface?.collapsedPrefaceContexts ?? {});
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorRectRef = useRef<Rect | null>(anchorRect ?? null);
  const committedRef = useRef(false);
  const draftRef = useRef(draft);
  const onCommitRef = useRef(onCommit);
  const onCancelRef = useRef(onCancel);
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  const onSendRef = useRef(onSend);
  const onReplyRef = useRef<Props['onReply']>(onReply);
  const onSelectModelRef = useRef<Props['onSelectModel']>(onSelectModel);
  const onSendPreviewRef = useRef<Props['onSendPreview']>(onSendPreview);
  const onDraftChangeRef = useRef<Props['onDraftChange']>(onDraftChange);
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
  const getScreenRectRef = useRef<Props['getScreenRect']>(getScreenRect);
  const getZoomRef = useRef<Props['getZoom']>(getZoom);

  const [liveRect, setLiveRect] = useState<Rect | null>(() => anchorRect ?? null);
  const liveRectRef = useRef<Rect | null>(anchorRect ?? null);
  const sendDragRef = useRef<{
    pointerId: number;
    modelIdOverride: string | null;
    startClient: { x: number; y: number };
    lastClient: { x: number; y: number };
    moved: boolean;
    source: 'main' | 'model_menu';
  } | null>(null);
  const suppressSendClickRef = useRef(false);
  const deferredDraft = useDeferredValue(draft);

  useEffect(() => {
    onCommitRef.current = onCommit;
    onCancelRef.current = onCancel;
    onResizeRef.current = onResize;
    onResizeEndRef.current = onResizeEnd;
    onSendRef.current = onSend;
    onReplyRef.current = onReply;
    onSelectModelRef.current = onSelectModel;
    onSendPreviewRef.current = onSendPreview;
    onDraftChangeRef.current = onDraftChange;
  }, [onCancel, onCommit, onDraftChange, onReply, onResize, onResizeEnd, onSend, onSelectModel, onSendPreview]);

  useEffect(() => {
    committedRef.current = false;
    setDraft(initialValue ?? '');
    draftRef.current = initialValue ?? '';
    onDraftChangeRef.current?.(initialValue ?? '');
    const raf = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [nodeId, initialValue]);

  useEffect(() => {
    setCollapsedPrefaceContexts(userPreface?.collapsedPrefaceContexts ?? {});
  }, [nodeId]);

  useEffect(() => {
    setPreviewEnabled(false);
  }, [nodeId]);

  const modelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState<MenuPos | null>(null);
  const [modelMenuPointerLock, setModelMenuPointerLock] = useState(false);

  useEffect(() => {
    setModelMenuOpen(false);
    setModelMenuPos(null);
    setModelMenuPointerLock(false);
  }, [nodeId]);

  const closeModelMenu = useCallback(() => {
    setModelMenuPointerLock(false);
    setModelMenuOpen(false);
  }, []);

  const updateModelMenuPosition = useCallback(() => {
    const btn = modelMenuButtonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();

    const gap = 8;
    const viewportPadding = 8;
    const estimatedWidth = 115;
    const maxMenuH = 256;
    const itemH = 34;
    const paddingY = 14;
    const desiredH = Math.min(maxMenuH, Math.max(56, modelOptions.length * itemH + paddingY));

    const spaceAbove = rect.top - gap - viewportPadding;
    const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
    const openAbove = spaceAbove >= desiredH || spaceAbove >= spaceBelow;
    const top = openAbove ? undefined : rect.bottom + gap;
    const bottom = openAbove ? window.innerHeight - rect.top + gap : undefined;
    const maxHeight = Math.max(0, Math.min(maxMenuH, openAbove ? spaceAbove : spaceBelow));

    const left = Math.min(window.innerWidth - viewportPadding - estimatedWidth, Math.max(viewportPadding, rect.left));
    setModelMenuPos({ top, bottom, left, maxHeight });
  }, [modelOptions.length]);

  const openModelMenu = useCallback(() => {
    if (modelOptions.length === 0) return;
    updateModelMenuPosition();
    setModelMenuOpen(true);
  }, [modelOptions.length, updateModelMenuPosition]);

  useEffect(() => {
    if (!modelMenuOpen) setModelMenuPointerLock(false);
  }, [modelMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModelMenu();
    };

    const onReposition = () => {
      if (modelMenuOpen) updateModelMenuPosition();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', onReposition);
    vv?.addEventListener('scroll', onReposition);

    onReposition();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      vv?.removeEventListener('resize', onReposition);
      vv?.removeEventListener('scroll', onReposition);
    };
  }, [closeModelMenu, modelMenuOpen, updateModelMenuPosition]);

  useEffect(() => {
    if (resizeRef.current || dragRef.current) return;
    setLiveRect(anchorRect ?? null);
    anchorRectRef.current = anchorRect ?? null;
  }, [anchorRect?.x, anchorRect?.y, anchorRect?.w, anchorRect?.h, nodeId]);

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
    sendDragRef.current = null;
    suppressSendClickRef.current = false;
    setModelMenuPointerLock(false);
    onSendPreviewRef.current?.({ placementClient: null });
  }, [nodeId]);

  useEffect(
    () => () => {
      onSendPreviewRef.current?.({ placementClient: null });
    },
    [],
  );

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
      liveRectRef.current = r;

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

  // Note: We intentionally do not auto-commit/close when clicking outside the editor.
  // Edit mode should only end via explicit user actions (Done/Cancel).

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

  const onDragPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - active.startClient.x;
    const dy = e.clientY - active.startClient.y;
    const next: Rect = {
      x: active.startRect.x + dx,
      y: active.startRect.y + dy,
      w: active.startRect.w,
      h: active.startRect.h,
    };

    setLiveRect(next);
    onResizeRef.current(next);
  };

  const onDragPointerEnd = (e: React.PointerEvent<HTMLElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = null;
    onResizeEndRef.current();
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const beginResize = (corner: ResizeCorner) => (e: React.PointerEvent<HTMLElement>) => {
    if (resizeRef.current) return;
    const startRect = followEnabled
      ? (anchorRectRef.current ?? liveRectRef.current)
      : (liveRectRef.current ?? anchorRectRef.current);
    if (!startRect) return;
    e.preventDefault();
    e.stopPropagation();

    resizeRef.current = {
      pointerId: e.pointerId,
      corner,
      startClient: { x: e.clientX, y: e.clientY },
      startRect,
      startZoom: Math.max(0.001, Number.isFinite((getZoomRef.current?.() ?? zoom) as number) ? Number(getZoomRef.current?.() ?? zoom) : 1),
    };

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const beginDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current || resizeRef.current) return;
    const startRect = followEnabled
      ? (anchorRectRef.current ?? liveRectRef.current)
      : (liveRectRef.current ?? anchorRectRef.current);
    if (!startRect) return;
    e.preventDefault();
    e.stopPropagation();

    dragRef.current = {
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      startRect,
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

  const send = (modelIdOverride?: string | null) => {
    onSendRef.current(draftRef.current, { modelIdOverride: modelIdOverride ?? null });
  };

  const reply = () => {
    onReplyRef.current?.(draftRef.current);
  };

  const setSendPreviewClient = (placementClient: SendPlacementClientPoint | null) => {
    onSendPreviewRef.current?.({ placementClient });
  };

  const beginSendDrag =
    (modelIdOverride?: string | null, source: 'main' | 'model_menu' = 'main') =>
    (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    if (source === 'model_menu') e.preventDefault();
    e.stopPropagation();
    sendDragRef.current = {
      pointerId: e.pointerId,
      modelIdOverride: modelIdOverride ?? null,
      startClient: { x: e.clientX, y: e.clientY },
      lastClient: { x: e.clientX, y: e.clientY },
      moved: false,
      source,
    };
    if (source === 'model_menu') setModelMenuPointerLock(true);
    setSendPreviewClient(null);

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    };

  const onSendDragPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const active = sendDragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;

    active.lastClient = { x: e.clientX, y: e.clientY };
    if (!active.moved) {
      const dx = active.lastClient.x - active.startClient.x;
      const dy = active.lastClient.y - active.startClient.y;
      if (dx * dx + dy * dy >= 16) active.moved = true;
    }
    if (!active.moved) {
      setSendPreviewClient(null);
      return;
    }
    setSendPreviewClient({ clientX: active.lastClient.x, clientY: active.lastClient.y });
    e.preventDefault();
    e.stopPropagation();
  };

  const onSendDragPointerEnd = (e: React.PointerEvent<HTMLButtonElement>) => {
    const active = sendDragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    sendDragRef.current = null;
    setSendPreviewClient(null);

    active.lastClient = { x: e.clientX, y: e.clientY };
    if (!active.moved) {
      if (active.source === 'model_menu') {
        e.preventDefault();
        e.stopPropagation();
        closeModelMenu();
        const modelId = String(active.modelIdOverride ?? '').trim();
        if (modelId) onSelectModelRef.current?.(modelId);
        return;
      }
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (active.source === 'model_menu') {
      closeModelMenu();
    } else {
      suppressSendClickRef.current = true;
    }

    const rect = liveRectRef.current ?? anchorRectRef.current;
    if (!rect) return;

    const inside =
      active.lastClient.x >= rect.x &&
      active.lastClient.x <= rect.x + rect.w &&
      active.lastClient.y >= rect.y &&
      active.lastClient.y <= rect.y + rect.h;
    if (inside) return;

    onSendRef.current(draftRef.current, {
      modelIdOverride: active.modelIdOverride ?? null,
      placementClient: { clientX: active.lastClient.x, clientY: active.lastClient.y },
    });
  };

  const onSendDragPointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    const active = sendDragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    sendDragRef.current = null;
    setSendPreviewClient(null);
    if (active.source === 'model_menu') {
      setModelMenuPointerLock(false);
      return;
    }
    if (active.moved) suppressSendClickRef.current = true;
  };

  const onSendMainClick = () => {
    setSendPreviewClient(null);
    if (suppressSendClickRef.current) {
      suppressSendClickRef.current = false;
      return;
    }
    send(null);
  };

  const onModelMenuItemClick = (nextModelId: string) => {
    closeModelMenu();
    onSelectModelRef.current?.(nextModelId);
  };

  const baseFontSize = Math.max(1, Math.round(Number.isFinite(baseFontSizePx) ? baseFontSizePx : 14));
  const activeAnchorRect = liveRect ?? anchorRect;

  const style = useMemo<React.CSSProperties>(() => {
    if (activeAnchorRect) {
      if (followEnabled) {
        return {
          left: 0,
          top: 0,
          width: activeAnchorRect.w,
          height: activeAnchorRect.h,
          transform: `translate3d(${activeAnchorRect.x}px, ${activeAnchorRect.y}px, 0)`,
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
    const w = Math.min(740, vpW - margin * 2);
    const h = Math.min(Math.round(vpH * 0.72), vpH - margin * 2);
    return {
      left: (vpW - w) * 0.5,
      top: margin,
      width: w,
      height: h,
      ...(typeof zoom === 'number' ? ({ ['--editor-scale' as any]: zoom, ['--editor-font-size' as any]: `${baseFontSize}px` } as any) : ({} as any)),
    };
  }, [activeAnchorRect, baseFontSize, followEnabled, viewport.h, viewport.w, zoom]);

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

  const prefaceEl = useMemo(() => {
    const preface = userPreface ?? null;
    if (!preface) return null;
    const replyTo = String(preface.replyTo ?? '').trim();
    const ctx = Array.isArray(preface.contexts) ? preface.contexts.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
    if (!replyTo && ctx.length === 0) return null;

    const summarizeFirstLine = (text: string): string => {
      const t = String(text ?? '');
      const firstLine = t.split('\n')[0] ?? '';
      return firstLine.trimEnd();
    };

    const containerStyle: React.CSSProperties = {
      margin: 'calc(8px * var(--editor-scale, 1)) 0 calc(10px * var(--editor-scale, 1))',
      padding: 'calc(8px * var(--editor-scale, 1)) calc(10px * var(--editor-scale, 1))',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 'calc(12px * var(--editor-scale, 1))',
      background: 'rgba(0,0,0,0.18)',
      fontSize: 'calc(var(--editor-font-size) * var(--editor-scale, 1) * 0.85)',
      color: 'rgba(255,255,255,0.88)',
    };

    return (
      <div style={containerStyle} className="mdx">
        {replyTo ? (
          <div style={{ margin: `0 0 calc(10px * var(--editor-scale, 1))` }}>
            <div style={{ opacity: 0.75, margin: `0 0 calc(4px * var(--editor-scale, 1))` }}>Replying to:</div>
            <MarkdownMath source={replyTo} className="gc-preface__mdx" />
          </div>
        ) : null}

        {ctx.map((text, i) => {
          const collapsed = Boolean(collapsedPrefaceContexts?.[i]);
          const chevron = collapsed ? '▸' : '▾';
          const rowAlign = collapsed ? 'center' : 'flex-start';
          const chevronMarginTop = collapsed ? '0' : '0.15em';

          if (collapsed) {
            const summaryText = summarizeFirstLine(text);
            const summaryHtml = renderMarkdownMathInline(summaryText).replace(/<br\s*\/?\s*>/gi, ' ');
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: rowAlign,
                  gap: `calc(6px * var(--editor-scale, 1))`,
                  margin: `0 0 calc(6px * var(--editor-scale, 1))`,
                }}
              >
                <span
                  aria-hidden="true"
                  onClick={() => {
                    setCollapsedPrefaceContexts((prev) => {
                      const next = { ...(prev ?? {}) };
                      if (next[i]) delete next[i];
                      else next[i] = true;
                      return next;
                    });
                    try {
                      onTogglePrefaceContext?.(i);
                    } catch {
                      // ignore
                    }
                  }}
                  style={{
                    width: '1em',
                    flex: '0 0 1em',
                    marginTop: chevronMarginTop,
                    display: 'inline-flex',
                    justifyContent: 'center',
                    color: 'rgba(255,255,255,0.55)',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  {chevron}
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
                  <span style={{ opacity: 0.75, flex: '0 0 auto', marginRight: `calc(6px * var(--editor-scale, 1))` }}>
                    Context {i + 1}:
                  </span>
                  <span
                    className="gc-preface__inline"
                    style={{ flex: 1, minWidth: 0, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    dangerouslySetInnerHTML={{ __html: summaryHtml }}
                  />
                </div>
              </div>
            );
          }

          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: rowAlign,
                gap: `calc(6px * var(--editor-scale, 1))`,
                margin: `0 0 calc(10px * var(--editor-scale, 1))`,
              }}
            >
              <span
                aria-hidden="true"
                onClick={() => {
                  setCollapsedPrefaceContexts((prev) => {
                    const next = { ...(prev ?? {}) };
                    if (next[i]) delete next[i];
                    else next[i] = true;
                    return next;
                  });
                  try {
                    onTogglePrefaceContext?.(i);
                  } catch {
                    // ignore
                  }
                }}
                style={{
                  width: '1em',
                  flex: '0 0 1em',
                  marginTop: chevronMarginTop,
                  display: 'inline-flex',
                  justifyContent: 'center',
                  color: 'rgba(255,255,255,0.55)',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                {chevron}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ opacity: 0.75, margin: `0 0 calc(4px * var(--editor-scale, 1))` }}>Context {i + 1}:</div>
                <MarkdownMath source={text} className="gc-preface__mdx" />
              </div>
            </div>
          );
        })}
      </div>
    );
  }, [collapsedPrefaceContexts, onTogglePrefaceContext, userPreface]);

  return (
    <div
      ref={rootRef}
      className="editor editor--edit"
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
          {title ?? 'Edit node'}
        </div>
        <div className="editor__actions">
          <button
            className={`editor__btn ${previewEnabled ? 'editor__btn--toggleOn' : ''}`}
            type="button"
            aria-pressed={previewEnabled}
            onClick={() => setPreviewEnabled((v) => !v)}
          >
            Preview
          </button>
          <button className="editor__btn" type="button" onClick={reply}>
            Reply
          </button>
          <div className="editor__btnGroup" role="group" aria-label="Send">
            <button
              className="editor__btn editor__btn--primary editor__btn--splitMain"
              type="button"
              onPointerDown={beginSendDrag(null)}
              onPointerMove={onSendDragPointerMove}
              onPointerUp={onSendDragPointerEnd}
              onPointerCancel={onSendDragPointerCancel}
              onClick={onSendMainClick}
            >
              Send
            </button>
            <button
              ref={modelMenuButtonRef}
              className="editor__btn editor__btn--primary editor__btn--splitArrow"
              type="button"
              onClick={() => {
                if (modelMenuOpen) {
                  closeModelMenu();
                  return;
                }
                openModelMenu();
              }}
              disabled={modelOptions.length === 0}
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen ? 'true' : 'false'}
              aria-label="Send with model"
            >
              ▾
            </button>
          </div>
          <button className="editor__btn" type="button" onClick={cancel}>
            Cancel
          </button>
          <button className="editor__btn editor__btn--primary" type="button" onClick={commit}>
            Done
          </button>
        </div>
      </div>

      <div className={`editor__body ${previewEnabled ? 'editor__body--preview' : ''}`}>
        <div className="editor__pane editor__pane--edit">
          {prefaceEl}
          <textarea
            ref={taRef}
            className="editor__textarea"
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              onDraftChangeRef.current?.(next);
            }}
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
            <div className="editor__preview">
              {prefaceEl}
              <div className="editor__previewScaled">
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

      {typeof document !== 'undefined' && modelMenuOpen && modelMenuPos
        ? createPortal(
            <>
              <div className="composerMenuBackdrop" onPointerDown={closeModelMenu} aria-hidden="true" />
              <div
                className="composerMenu"
                style={{
                  top: modelMenuPos.top,
                  bottom: modelMenuPos.bottom,
                  left: modelMenuPos.left,
                  width: 115,
                  maxHeight: modelMenuPos.maxHeight,
                  overflowY: modelMenuPointerLock ? 'hidden' : undefined,
                  touchAction: modelMenuPointerLock ? 'none' : undefined,
                }}
                role="menu"
              >
                {modelOptions.map((m) => {
                  const active = m.id === modelId;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`composerMenu__item composerMenu__item--withCheck ${active ? 'composerMenu__item--active' : ''}`}
                      onPointerDown={beginSendDrag(m.id, 'model_menu')}
                      onPointerMove={onSendDragPointerMove}
                      onPointerUp={onSendDragPointerEnd}
                      onPointerCancel={onSendDragPointerCancel}
                      onClick={() => onModelMenuItemClick(m.id)}
                      role="menuitem"
                      title={m.label}
                    >
                      <span className="composerMenu__check" aria-hidden="true">
                        {active ? '✓' : ''}
                      </span>
                      <span className="composerMenu__label">{String(m.shortLabel ?? m.label ?? m.id).trim()}</span>
                    </button>
                  );
                })}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
