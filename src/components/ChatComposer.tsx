import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import MarkdownMath from './MarkdownMath';
import type { ModelInfo } from '../llm/registry';
import type { ChatAttachment, InkStroke } from '../model/chat';
import { getAttachment as getStoredAttachment } from '../storage/attachments';

type ResizeMode =
  | { kind: 'height' }
  | { kind: 'width'; dir: -1 | 1 }
  | { kind: 'corner'; dir: -1 | 1 };

type ComposerMode = 'text' | 'ink';

type InkTool = 'select' | 'draw' | 'erase';

type InkPointerLikeEvent = {
  pointerId: number;
  pointerType?: string;
  button?: number;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
};

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  onSendInk: (payload: { strokes: InkStroke[]; viewport: { w: number; h: number } | null }) => void;
  modelId: string;
  modelOptions: ModelInfo[];
  onChangeModelId: (next: string) => void;
  webSearchEnabled: boolean;
  onChangeWebSearchEnabled: (next: boolean) => void;
  mode: ComposerMode;
  onChangeMode: (next: ComposerMode) => void;
  inkTool: InkTool;
  inkStrokes: InkStroke[];
  onChangeInkStrokes: (next: InkStroke[]) => void;
  containerRef?: React.Ref<HTMLDivElement>;
  replyPreview?: string | null;
  onCancelReply?: () => void;
  contextSelections?: string[];
  onRemoveContextSelection?: (index: number) => void;
  placeholder?: string;
  sendDisabled?: boolean;
  disabled?: boolean;
  draftAttachments?: ChatAttachment[];
  onAddAttachmentFiles?: (files: FileList) => void;
  onRemoveDraftAttachment?: (index: number) => void;
  contextAttachments?: Array<{ key: string; attachment: ChatAttachment }>;
  selectedContextAttachmentKeys?: string[];
  onToggleContextAttachmentKey?: (key: string, included: boolean) => void;
  minimized?: boolean;
  onChangeMinimized?: (next: boolean) => void;
};

type MenuPos = { left: number; top?: number; bottom?: number; maxHeight: number };

type XY = { x: number; y: number };

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

const distPointSq = (a: XY, b: XY): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

const distPointToSegmentSq = (p: XY, a: XY, b: XY): number => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 <= 1e-12) return distPointSq(p, a);
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLen2));
  const proj: XY = { x: a.x + abx * t, y: a.y + aby * t };
  return distPointSq(p, proj);
};

const orient2d = (a: XY, b: XY, c: XY): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const onSegment = (a: XY, p: XY, b: XY, eps: number): boolean =>
  p.x >= Math.min(a.x, b.x) - eps &&
  p.x <= Math.max(a.x, b.x) + eps &&
  p.y >= Math.min(a.y, b.y) - eps &&
  p.y <= Math.max(a.y, b.y) + eps;

const segmentsIntersect = (a: XY, b: XY, c: XY, d: XY): boolean => {
  const o1 = orient2d(a, b, c);
  const o2 = orient2d(a, b, d);
  const o3 = orient2d(c, d, a);
  const o4 = orient2d(c, d, b);

  const eps = 1e-9;
  const z1 = Math.abs(o1) <= eps;
  const z2 = Math.abs(o2) <= eps;
  const z3 = Math.abs(o3) <= eps;
  const z4 = Math.abs(o4) <= eps;

  if (z1 && onSegment(a, c, b, eps)) return true;
  if (z2 && onSegment(a, d, b, eps)) return true;
  if (z3 && onSegment(c, a, d, eps)) return true;
  if (z4 && onSegment(c, b, d, eps)) return true;

  const abStraddles = (o1 > 0) !== (o2 > 0);
  const cdStraddles = (o3 > 0) !== (o4 > 0);
  return abStraddles && cdStraddles;
};

const distSegmentToSegmentSq = (a: XY, b: XY, c: XY, d: XY): number => {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distPointToSegmentSq(a, c, d),
    distPointToSegmentSq(b, c, d),
    distPointToSegmentSq(c, a, b),
    distPointToSegmentSq(d, a, b),
  );
};

const polylineIntersectsCapsule = (points: XY[], a: XY, b: XY, radius: number): boolean => {
  if (!Array.isArray(points) || points.length === 0) return false;
  const r = Math.max(0, radius);
  const r2 = r * r;

  if (points.length === 1) {
    return distPointToSegmentSq(points[0]!, a, b) <= r2;
  }

  for (let i = 1; i < points.length; i += 1) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    if (distSegmentToSegmentSq(a, b, p0, p1) <= r2) return true;
  }
  return false;
};

const cloneInkStrokes = (strokes: InkStroke[]): InkStroke[] =>
  (Array.isArray(strokes) ? strokes : []).map((s) => ({
    width: Number.isFinite(Number((s as any)?.width)) ? Number((s as any).width) : 0,
    color: typeof (s as any)?.color === 'string' ? ((s as any).color as string) : 'rgba(147,197,253,0.92)',
    points: Array.isArray((s as any)?.points)
      ? ((s as any).points as any[]).map((p) => ({
          x: Number.isFinite(Number((p as any)?.x)) ? Number((p as any).x) : 0,
          y: Number.isFinite(Number((p as any)?.y)) ? Number((p as any).y) : 0,
        }))
      : [],
  }));

const isNormalizedInkStroke = (stroke: InkStroke): boolean => {
  const w = Number((stroke as any)?.width);
  if (!Number.isFinite(w) || w < 0 || w > 1.001) return false;
  const pts = Array.isArray((stroke as any)?.points) ? ((stroke as any).points as any[]) : [];
  if (pts.length === 0) return false;
  for (const p of pts) {
    const x = Number((p as any)?.x);
    const y = Number((p as any)?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < -0.001 || x > 1.001 || y < -0.001 || y > 1.001) return false;
  }
  return true;
};

const normalizedInkToPx = (strokes: InkStroke[], viewportW: number, viewportH: number): InkStroke[] => {
  const w = Math.max(1, Math.floor(viewportW));
  const h = Math.max(1, Math.floor(viewportH));
  const minDim = Math.max(1, Math.min(w, h));
  return (Array.isArray(strokes) ? strokes : [])
    .filter((s) => s && Array.isArray((s as any).points) && (s as any).points.length > 0)
    .map((s) => {
      const widthNorm = Number.isFinite(Number((s as any)?.width)) ? Number((s as any).width) : 0;
      const width = Math.max(0, widthNorm) * minDim;
      const color = typeof (s as any)?.color === 'string' ? String((s as any).color) : 'rgba(147,197,253,0.92)';
      const pts = Array.isArray((s as any)?.points) ? ((s as any).points as any[]) : [];
      const points = pts
        .map((p) => {
          const xNorm = Number((p as any)?.x);
          const yNorm = Number((p as any)?.y);
          if (!Number.isFinite(xNorm) || !Number.isFinite(yNorm)) return null;
          return { x: clamp01(xNorm) * w, y: clamp01(yNorm) * h };
        })
        .filter((p): p is XY => Boolean(p));
      return { width, color, points };
    });
};

function formatBytes(bytes?: number): string {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, idx);
  const digits = idx === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[idx]}`;
}

function labelForAttachment(att: ChatAttachment): string {
  const base =
    att.kind === 'image' || att.kind === 'pdf'
      ? att.name?.trim() || (att.kind === 'pdf' ? 'PDF' : 'Image')
      : att.kind === 'ink'
        ? 'Ink'
        : 'Attachment';
  const size = att.kind === 'image' || att.kind === 'pdf' ? formatBytes(att.size) : null;
  return size && size !== '0 B' ? `${base} • ${size}` : base;
}

export default function ChatComposer(props: Props) {
  const { value, onChange, onSend, onSendInk, modelId, modelOptions, onChangeModelId, webSearchEnabled, onChangeWebSearchEnabled, mode, onChangeMode, inkTool, inkStrokes, onChangeInkStrokes, containerRef, replyPreview, onCancelReply, contextSelections, onRemoveContextSelection, placeholder, sendDisabled, disabled, draftAttachments, onAddAttachmentFiles, onRemoveDraftAttachment, contextAttachments, selectedContextAttachmentKeys, onToggleContextAttachmentKey, minimized: minimizedProp, onChangeMinimized } = props;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const onSendRef = useRef(onSend);
  const onSendInkRef = useRef(onSendInk);
  const onChangeModeRef = useRef(onChangeMode);
  const onChangeInkStrokesRef = useRef(onChangeInkStrokes);
  const inkStrokesRef = useRef<InkStroke[]>(Array.isArray(inkStrokes) ? inkStrokes : []);
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const deferredValue = useDeferredValue(value);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const attachmentStripRef = useRef<HTMLDivElement | null>(null);
  const attachmentStripPrevCountRef = useRef(0);
  const attachmentStripPrevScrollHeightRef = useRef(0);
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [inkViewport, setInkViewport] = useState<{ w: number; h: number } | null>(null);
  const inkGestureRef = useRef<
    | null
    | { kind: 'draw'; pointerId: number; pointerType: string; strokeIndex: number; lastX: number; lastY: number }
    | { kind: 'erase'; pointerId: number; pointerType: string; lastX: number; lastY: number }
  >(null);
  const inkDrawRafRef = useRef<number | null>(null);
  const [dockReady, setDockReady] = useState(false);
  const [dockDragging, setDockDragging] = useState(false);
  const [dockResizing, setDockResizing] = useState(false);
  const [internalMinimized, setInternalMinimized] = useState(false);
  const minimized = minimizedProp !== undefined ? Boolean(minimizedProp) : internalMinimized;
  const setMinimized = useCallback(
    (next: boolean) => {
      if (onChangeMinimized) {
        onChangeMinimized(next);
        return;
      }
      setInternalMinimized(next);
    },
    [onChangeMinimized],
  );

  const DEFAULT_COMPOSER_W = 600;
  const MIN_W = 500;
  const MAX_W = 2000;
  const VIEWPORT_MARGIN_X = 20;
  const VIEWPORT_MARGIN_TOP = 24;

  const DEFAULT_PANEL_H = 75;
  const MIN_PANEL_H = 50;
  const AUTO_MAX_PANEL_H = 360;
  const ATTACHMENTS_STRIP_W = 86;
  const ATTACHMENTS_STRIP_GAP = 10;

  const [composerWidth, setComposerWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_COMPOSER_W;
    const maxW = Math.max(0, Math.min(MAX_W, Math.floor(window.innerWidth - VIEWPORT_MARGIN_X)));
    return Math.min(DEFAULT_COMPOSER_W, maxW);
  });
  const [viewportW, setViewportW] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_COMPOSER_W + VIEWPORT_MARGIN_X;
    return window.innerWidth;
  });
  const [manualWidthEnabled, setManualWidthEnabled] = useState(false);
  const [manualHeightEnabled, setManualHeightEnabled] = useState(false);
  const [panelHeight, setPanelHeight] = useState<number>(DEFAULT_PANEL_H);
  const manualHeightRef = useRef<number>(DEFAULT_PANEL_H);
  const [draftThumbUrls, setDraftThumbUrls] = useState<Array<string | null>>([]);
  const hasDraftAttachments = Array.isArray(draftAttachments) && draftAttachments.length > 0;

  const startXRef = useRef<number>(0);
  const startWRef = useRef<number>(0);
  const startYRef = useRef<number>(0);
  const startHRef = useRef<number>(0);
  const resizingRef = useRef<boolean>(false);
  const maxHRef = useRef<number>(0);
  const maxWRef = useRef<number>(0);
  const resizeModeRef = useRef<ResizeMode>({ kind: 'height' });
  const activeMoveListenerRef = useRef<((e: PointerEvent) => void) | null>(null);
  const activeEndListenerRef = useRef<((e: PointerEvent) => void) | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  const minimizationActiveRef = useRef(false);
  const pendingMinimizeRef = useRef(false);
  const minimizeStartXRef = useRef(0);
  const minimizeStartSlideXRef = useRef(0);
  const dockSlideXRef = useRef(0);
  const minimizeMoveListenerRef = useRef<((e: PointerEvent) => void) | null>(null);
  const minimizeEndListenerRef = useRef<((e: PointerEvent) => void) | null>(null);
  const minimizePointerIdRef = useRef<number | null>(null);

  const selectedModelLabel = useMemo(() => {
    const match = modelOptions.find((m) => m.id === modelId);
    const label = match?.shortLabel ?? match?.label ?? modelId;
    return String(label).trim();
  }, [modelId, modelOptions]);

  const modelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState<MenuPos | null>(null);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  useEffect(() => {
    onSendInkRef.current = onSendInk;
  }, [onSendInk]);

  useEffect(() => {
    onChangeModeRef.current = onChangeMode;
  }, [onChangeMode]);

  useEffect(() => {
    onChangeInkStrokesRef.current = onChangeInkStrokes;
  }, [onChangeInkStrokes]);

  useEffect(() => {
    if (inkGestureRef.current) return;
    inkStrokesRef.current = Array.isArray(inkStrokes) ? inkStrokes : [];
  }, [inkStrokes]);

  useEffect(() => {
    setDockReady(true);
  }, []);

  const setDockSlideX = useCallback((nextX: number) => {
    const x = Number.isFinite(nextX) ? nextX : 0;
    dockSlideXRef.current = x;
    const el = dockRef.current;
    if (el) el.style.setProperty('--composer-dock-slide-x', `${x}px`);
  }, []);

  const computeMinimizedDockSlideX = useCallback(() => {
    const el = dockRef.current;
    if (!el) return dockSlideXRef.current;
    const rect = el.getBoundingClientRect();
    const desiredDockRight = hasDraftAttachments ? -ATTACHMENTS_STRIP_GAP : -24;
    return dockSlideXRef.current + (desiredDockRight - rect.right);
  }, [hasDraftAttachments]);

  useLayoutEffect(() => {
    if (dockDragging) return;
    const effectiveMinimized = minimized || pendingMinimizeRef.current;
    setDockSlideX(effectiveMinimized ? computeMinimizedDockSlideX() : 0);
  }, [computeMinimizedDockSlideX, dockDragging, minimized, setDockSlideX, composerWidth, viewportW, hasDraftAttachments]);

  useEffect(() => {
    if (minimized) pendingMinimizeRef.current = false;
  }, [minimized]);

  const closeMenus = useCallback(() => {
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

    const left = Math.min(
      window.innerWidth - viewportPadding - estimatedWidth,
      Math.max(viewportPadding, rect.left),
    );

    setModelMenuPos({ top, bottom, left, maxHeight });
  }, [modelOptions.length]);

  const openModelMenu = useCallback(() => {
    if (disabled || modelOptions.length === 0) return;
    updateModelMenuPosition();
    setModelMenuOpen(true);
  }, [disabled, modelOptions.length, updateModelMenuPosition]);

  const selectModel = useCallback(
    (next: string) => {
      onChangeModelId(next);
      setModelMenuOpen(false);
    },
    [onChangeModelId],
  );

  useEffect(() => {
    if (!disabled) return;
    closeMenus();
  }, [closeMenus, disabled]);

  useEffect(() => {
    if (!modelMenuOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenus();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeMenus, modelMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;

    const onReposition = () => {
      if (modelMenuOpen) updateModelMenuPosition();
    };

    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', onReposition);
    vv?.addEventListener('scroll', onReposition);

    onReposition();
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      vv?.removeEventListener('resize', onReposition);
      vv?.removeEventListener('scroll', onReposition);
    };
  }, [
    modelMenuOpen,
    updateModelMenuPosition,
  ]);

  useEffect(() => {
    if (!replyPreview) return;
    if (mode !== 'text') return;
    const raf = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [mode, replyPreview]);

  const previewSnippet = (text: string, maxLen = 80) => {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > maxLen ? `${t.substring(0, maxLen)}...` : t;
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const clampWidth = () => {
      setViewportW(window.innerWidth);
      const maxW = Math.max(0, Math.min(MAX_W, Math.floor(window.innerWidth - VIEWPORT_MARGIN_X)));
      const minW = Math.min(MIN_W, maxW);
      const nextDefault = Math.min(DEFAULT_COMPOSER_W, maxW);
      setComposerWidth((prev) => {
        const next = manualWidthEnabled ? prev : nextDefault;
        return Math.min(maxW, Math.max(minW, next));
      });
    };

    clampWidth();
    window.addEventListener('resize', clampWidth);
    return () => window.removeEventListener('resize', clampWidth);
  }, [manualWidthEnabled]);

  useEffect(() => {
    if (mode !== 'text') return;
    const ta = taRef.current;
    if (!ta) return;
    if (resizingRef.current && resizeModeRef.current.kind !== 'width') return;

    const prevH = ta.style.height;
    ta.style.height = 'auto';
    const sh = ta.scrollHeight;
    ta.style.height = prevH;

    const nextAuto = Math.min(AUTO_MAX_PANEL_H, Math.max(MIN_PANEL_H, sh));
    const baseline = manualHeightEnabled ? manualHeightRef.current : DEFAULT_PANEL_H;
    const next = Math.max(baseline, nextAuto);
    setPanelHeight((prev) => (Math.abs(prev - next) <= 1 ? prev : next));
  }, [composerWidth, manualHeightEnabled, mode, previewEnabled, value]);

  useLayoutEffect(() => {
    if (mode !== 'ink') {
      setInkViewport(null);
      return;
    }
    const el = inkCanvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      setInkViewport(null);
      return;
    }

    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      setInkViewport((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [composerWidth, mode, panelHeight, previewEnabled]);

  const drawInk = useCallback(() => {
    if (mode !== 'ink') return;
    const canvas = inkCanvasRef.current;
    if (!canvas) return;
    const viewport =
      inkViewport ??
      (() => {
        const rect = canvas.getBoundingClientRect();
        return { w: Math.max(1, Math.floor(rect.width)), h: Math.max(1, Math.floor(rect.height)) };
      })();
    if (!viewport) return;
    const w = Math.max(1, Math.floor(viewport.w));
    const h = Math.max(1, Math.floor(viewport.h));
    if (!inkViewport || inkViewport.w !== w || inkViewport.h !== h) {
      setInkViewport((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    }
    const dpr = typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1;

    const desiredW = Math.max(1, Math.round(w * dpr));
    const desiredH = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== desiredW) canvas.width = desiredW;
    if (canvas.height !== desiredH) canvas.height = desiredH;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const strokes = Array.isArray(inkStrokesRef.current) ? inkStrokesRef.current : [];
    const minDim = Math.max(1, Math.min(w, h));

    for (const stroke of strokes) {
      const ptsRaw = Array.isArray(stroke?.points) ? stroke.points : [];
      if (ptsRaw.length === 0) continue;

      const widthIn = Number.isFinite(Number(stroke?.width)) ? Number(stroke.width) : 0;
      const isNorm = stroke && isNormalizedInkStroke(stroke);
      const widthPx = isNorm ? Math.max(0.0001, widthIn) * minDim : Math.max(0.0001, widthIn);
      ctx.strokeStyle = typeof stroke?.color === 'string' ? stroke.color : 'rgba(147,197,253,0.92)';
      ctx.lineWidth = widthPx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const pts = (isNorm ? ptsRaw.map((p) => ({ x: clamp01(Number((p as any)?.x) || 0) * w, y: clamp01(Number((p as any)?.y) || 0) * h })) : ptsRaw)
        .map((p) => ({ x: Number((p as any)?.x), y: Number((p as any)?.y) }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

      if (pts.length === 1) {
        const p0 = pts[0]!;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, ctx.lineWidth * 0.5, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.stroke();
    }
  }, [inkViewport, mode]);

  const scheduleDrawInk = useCallback(() => {
    if (inkDrawRafRef.current != null) return;
    inkDrawRafRef.current = window.requestAnimationFrame(() => {
      inkDrawRafRef.current = null;
      drawInk();
    });
  }, [drawInk]);

  useEffect(() => {
    scheduleDrawInk();
  }, [inkViewport, mode, scheduleDrawInk]);

  useEffect(() => {
    scheduleDrawInk();
  }, [inkStrokes, scheduleDrawInk]);

  useEffect(() => {
    return () => {
      if (inkDrawRafRef.current != null) {
        const handle = inkDrawRafRef.current;
        inkDrawRafRef.current = null;
        try {
          window.cancelAnimationFrame(handle);
        } catch {
          // ignore
        }
      }
    };
  }, []);

  useEffect(() => {
    const atts = Array.isArray(draftAttachments) ? draftAttachments : [];
    let cancelled = false;
    const objectUrls: string[] = [];

    setDraftThumbUrls([]);

    void (async () => {
      const next: Array<string | null> = new Array(atts.length).fill(null);
      for (let i = 0; i < atts.length; i += 1) {
        const att = atts[i];
        if (!att || att.kind !== 'image') continue;
        if (typeof att.data === 'string' && att.data) {
          const mimeType = typeof att.mimeType === 'string' && att.mimeType ? att.mimeType : 'image/png';
          next[i] = `data:${mimeType};base64,${att.data}`;
          continue;
        }

        const storageKey = typeof att.storageKey === 'string' ? att.storageKey : '';
        if (!storageKey) continue;
        try {
          const rec = await getStoredAttachment(storageKey);
          if (!rec?.blob) continue;
          const url = URL.createObjectURL(rec.blob);
          objectUrls.push(url);
          next[i] = url;
        } catch {
          // ignore
        }
      }
      if (!cancelled) setDraftThumbUrls(next);
    })();

    return () => {
      cancelled = true;
      for (const url of objectUrls) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    };
  }, [draftAttachments]);

  useLayoutEffect(() => {
    const atts = Array.isArray(draftAttachments) ? draftAttachments : [];
    const nextCount = atts.length;
    const el = attachmentStripRef.current;

    if (!el || nextCount === 0) {
      attachmentStripPrevCountRef.current = nextCount;
      attachmentStripPrevScrollHeightRef.current = 0;
      return;
    }

    const prevCount = attachmentStripPrevCountRef.current;
    const prevScrollHeight = attachmentStripPrevScrollHeightRef.current;
    const nextScrollHeight = el.scrollHeight;

    if (nextCount > prevCount && el.scrollTop > 0 && prevScrollHeight > 0) {
      const delta = nextScrollHeight - prevScrollHeight;
      if (delta > 0) el.scrollTop += delta;
    }

    attachmentStripPrevCountRef.current = nextCount;
    attachmentStripPrevScrollHeightRef.current = nextScrollHeight;
  }, [draftAttachments]);

  const draftAttachmentViews = useMemo(() => {
    const atts = Array.isArray(draftAttachments) ? draftAttachments : [];
    return atts.map((attachment, index) => ({ attachment, index })).reverse();
  }, [draftAttachments]);

  const applyResize = (clientX: number, clientY: number) => {
    const mode = resizeModeRef.current;

    if (mode.kind === 'height' || mode.kind === 'corner') {
      const deltaY = startYRef.current - clientY;
      const nextH = Math.min(maxHRef.current, Math.max(MIN_PANEL_H, startHRef.current + deltaY));
      manualHeightRef.current = nextH;
      setPanelHeight(nextH);
    }

    if (mode.kind === 'width' || mode.kind === 'corner') {
      const deltaX = (clientX - startXRef.current) * mode.dir;
      const maxW = maxWRef.current;
      const minW = Math.min(MIN_W, maxW);
      const nextW = Math.min(maxW, Math.max(minW, startWRef.current + deltaX * 2));
      setComposerWidth(nextW);
    }
  };

  const endResize = (ev?: PointerEvent) => {
    const activePointerId = activePointerIdRef.current;
    if (typeof activePointerId === 'number' && ev && ev.pointerId !== activePointerId) return;
    resizingRef.current = false;
    setDockResizing(false);
    const move = activeMoveListenerRef.current ?? onPointerMove;
    const end = activeEndListenerRef.current ?? (endResize as any);
    window.removeEventListener('pointermove', move as any, true);
    window.removeEventListener('pointerup', end as any, true);
    window.removeEventListener('pointercancel', end as any, true);
    activeMoveListenerRef.current = null;
    activeEndListenerRef.current = null;
    activePointerIdRef.current = null;
    if (document && document.body) {
      (document.body as HTMLBodyElement).style.userSelect = '';
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!resizingRef.current) return;
    const activePointerId = activePointerIdRef.current;
    if (typeof activePointerId === 'number' && e.pointerId !== activePointerId) return;
    e.preventDefault();
    applyResize(e.clientX, e.clientY);
  };

  const beginResizePointer = (e: React.PointerEvent, mode: ResizeMode = { kind: 'height' }) => {
    e.preventDefault();
    e.stopPropagation();
    if (resizingRef.current) return;
    resizingRef.current = true;
    setDockResizing(true);
    resizeModeRef.current = mode;

    if (mode.kind !== 'width') setManualHeightEnabled(true);
    if (mode.kind === 'width' || mode.kind === 'corner') setManualWidthEnabled(true);

    activePointerIdRef.current = e.pointerId;
    startXRef.current = e.clientX;
    startWRef.current = composerWidth;
    startYRef.current = e.clientY;
    startHRef.current = panelHeight;

    const boundsEl = panelRef.current ?? taRef.current;
    if (boundsEl) {
      const rect = boundsEl.getBoundingClientRect();
      maxHRef.current = Math.max(MIN_PANEL_H, Math.floor(rect.bottom - VIEWPORT_MARGIN_TOP));
    } else {
      maxHRef.current = AUTO_MAX_PANEL_H;
    }

    maxWRef.current = Math.max(0, Math.min(MAX_W, Math.floor(window.innerWidth - VIEWPORT_MARGIN_X)));

    activeMoveListenerRef.current = onPointerMove;
    activeEndListenerRef.current = endResize as any;
    window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
    window.addEventListener('pointerup', endResize as any, { passive: false, capture: true });
    window.addEventListener('pointercancel', endResize as any, { passive: false, capture: true });
    if (document && document.body) {
      (document.body as HTMLBodyElement).style.userSelect = 'none';
    }
  };

  useEffect(() => {
    return () => {
      const move = activeMoveListenerRef.current;
      const end = activeEndListenerRef.current;
      if (move && end) {
        window.removeEventListener('pointermove', move as any, true);
        window.removeEventListener('pointerup', end as any, true);
        window.removeEventListener('pointercancel', end as any, true);
      }
      const minimizeMove = minimizeMoveListenerRef.current;
      const minimizeEnd = minimizeEndListenerRef.current;
      if (minimizeMove && minimizeEnd) {
        window.removeEventListener('pointermove', minimizeMove as any, true);
        window.removeEventListener('pointerup', minimizeEnd as any, true);
        window.removeEventListener('pointercancel', minimizeEnd as any, true);
      }
      if (document && document.body) {
        (document.body as HTMLBodyElement).style.userSelect = '';
      }
    };
  }, []);

  const endMinimizeDrag = useCallback(
    (ev?: PointerEvent) => {
      const activePointerId = minimizePointerIdRef.current;
      if (typeof activePointerId === 'number' && ev && ev.pointerId !== activePointerId) return;
      minimizationActiveRef.current = false;

      const move = minimizeMoveListenerRef.current;
      const end = minimizeEndListenerRef.current ?? (endMinimizeDrag as any);
      if (move) window.removeEventListener('pointermove', move as any, true);
      window.removeEventListener('pointerup', end as any, true);
      window.removeEventListener('pointercancel', end as any, true);
      minimizeMoveListenerRef.current = null;
      minimizeEndListenerRef.current = null;
      minimizePointerIdRef.current = null;

      if (document && document.body) {
        (document.body as HTMLBodyElement).style.userSelect = '';
      }

      const draggedPx = -dockSlideXRef.current;
      const shouldMinimize = draggedPx >= Math.max(80, Math.min(180, Math.round(composerWidth * 0.25)));
      pendingMinimizeRef.current = shouldMinimize;
      setDockDragging(false);
      if (shouldMinimize) {
        setMinimized(true);
        return;
      }

      setMinimized(false);
    },
    [composerWidth, setDockSlideX, setMinimized],
  );

  const onMinimizePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!minimizationActiveRef.current) return;
      const activePointerId = minimizePointerIdRef.current;
      if (typeof activePointerId === 'number' && e.pointerId !== activePointerId) return;
      e.preventDefault();
      const deltaX = e.clientX - minimizeStartXRef.current;
      const next = Math.min(0, minimizeStartSlideXRef.current + deltaX);
      setDockSlideX(next);
    },
    [setDockSlideX],
  );

  const beginMinimizeDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (minimized) return;
      if (resizingRef.current) return;
      if (minimizationActiveRef.current) return;

      minimizationActiveRef.current = true;
      setDockDragging(true);
      minimizePointerIdRef.current = e.pointerId;
      minimizeStartXRef.current = e.clientX;
      minimizeStartSlideXRef.current = dockSlideXRef.current;

      minimizeMoveListenerRef.current = onMinimizePointerMove;
      minimizeEndListenerRef.current = endMinimizeDrag as any;

      window.addEventListener('pointermove', onMinimizePointerMove, { passive: false, capture: true });
      window.addEventListener('pointerup', endMinimizeDrag as any, { passive: false, capture: true });
      window.addEventListener('pointercancel', endMinimizeDrag as any, { passive: false, capture: true });

      if (document && document.body) {
        (document.body as HTMLBodyElement).style.userSelect = 'none';
      }
    },
    [endMinimizeDrag, minimized, onMinimizePointerMove],
  );

  const setMode = useCallback(
    (next: ComposerMode) => {
      if (disabled) return;
      const v: ComposerMode = next === 'ink' ? 'ink' : 'text';
      if (v === mode) return;
      onChangeModeRef.current(v);
      if (v === 'ink') scheduleDrawInk();
    },
    [disabled, mode, scheduleDrawInk],
  );

  const commitInkStrokes = useCallback(
    (next: InkStroke[]) => {
      const cloned = cloneInkStrokes(next);
      inkStrokesRef.current = cloned;
      onChangeInkStrokesRef.current(cloned);
      scheduleDrawInk();
    },
    [scheduleDrawInk],
  );

  useEffect(() => {
    if (mode !== 'ink') return;
    if (inkGestureRef.current) return;
    if (!inkViewport) return;
    const current = Array.isArray(inkStrokesRef.current) ? inkStrokesRef.current : [];
    if (current.length === 0) return;
    if (!current.every((s) => s && isNormalizedInkStroke(s))) return;
    commitInkStrokes(normalizedInkToPx(current, inkViewport.w, inkViewport.h));
  }, [commitInkStrokes, inkViewport, mode]);

  const onInkPointerDown = useCallback(
    (e: InkPointerLikeEvent) => {
      if (disabled) return;
      if (mode !== 'ink') return;
      if (inkTool !== 'draw' && inkTool !== 'erase') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (inkGestureRef.current) return;

      const canvas = inkCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const existing = Array.isArray(inkStrokesRef.current) ? inkStrokesRef.current : [];
      if (existing.length > 0 && existing.every((s) => s && isNormalizedInkStroke(s))) {
        commitInkStrokes(normalizedInkToPx(existing, rect.width, rect.height));
      }

      const x = clamp(e.clientX - rect.left, 0, rect.width);
      const y = clamp(e.clientY - rect.top, 0, rect.height);

      e.preventDefault();
      e.stopPropagation();

      const pointerType = e.pointerType === 'pen' || e.pointerType === 'touch' || e.pointerType === 'mouse' ? e.pointerType : 'touch';
      const strokes = Array.isArray(inkStrokesRef.current) ? inkStrokesRef.current : [];

      if (inkTool === 'draw') {
        const widthPx = pointerType === 'pen' ? 2.75 : 2.5;
        const stroke: InkStroke = {
          points: [{ x, y }],
          width: widthPx,
          color: 'rgba(147,197,253,0.92)',
        };
        inkStrokesRef.current = [...strokes, stroke];
        inkGestureRef.current = { kind: 'draw', pointerId: e.pointerId, pointerType, strokeIndex: strokes.length, lastX: x, lastY: y };
        scheduleDrawInk();
        return;
      }

      inkGestureRef.current = { kind: 'erase', pointerId: e.pointerId, pointerType, lastX: x, lastY: y };
      scheduleDrawInk();
    },
    [commitInkStrokes, disabled, inkTool, mode, scheduleDrawInk],
  );

  const onInkPointerMove = useCallback(
    (e: InkPointerLikeEvent) => {
      if (mode !== 'ink') return;
      const g = inkGestureRef.current;
      if (!g) return;
      if (e.pointerId !== g.pointerId) return;

      const canvas = inkCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const x = clamp(e.clientX - rect.left, 0, rect.width);
      const y = clamp(e.clientY - rect.top, 0, rect.height);

      e.preventDefault();
      e.stopPropagation();

      if (g.kind === 'draw') {
        const minDistPx = g.pointerType === 'pen' ? 0.45 : 0.9;
        const dxPx = x - g.lastX;
        const dyPx = y - g.lastY;
        if (dxPx * dxPx + dyPx * dyPx < minDistPx * minDistPx) return;

        const strokes = inkStrokesRef.current;
        const stroke = strokes[g.strokeIndex];
        if (!stroke || !Array.isArray(stroke.points)) return;
        stroke.points.push({ x, y });
        g.lastX = x;
        g.lastY = y;
        scheduleDrawInk();
        return;
      }

      const radiusPx = g.pointerType === 'pen' ? 10 : 12;
      const aPx: XY = { x: g.lastX, y: g.lastY };
      const bPx: XY = { x, y };
      g.lastX = x;
      g.lastY = y;

      const strokes = Array.isArray(inkStrokesRef.current) ? inkStrokesRef.current : [];
      if (strokes.length === 0) return;
      const minDim = Math.max(1, Math.min(rect.width, rect.height));
      const next = strokes.filter((s) => {
        const ptsRaw = Array.isArray(s?.points) ? s.points : [];
        if (ptsRaw.length === 0) return false;
        const widthIn = Number.isFinite(Number(s?.width)) ? Number(s.width) : 0;
        const isNorm = s && isNormalizedInkStroke(s);
        const widthPx = isNorm ? widthIn * minDim : widthIn;
        const threshold = Math.max(0, radiusPx) + Math.max(0, widthPx) * 0.5;
        const ptsPx = (
          isNorm
            ? ptsRaw.map((p) => ({ x: clamp01(Number((p as any)?.x) || 0) * rect.width, y: clamp01(Number((p as any)?.y) || 0) * rect.height }))
            : ptsRaw
        )
          .map((p) => ({ x: Number((p as any)?.x), y: Number((p as any)?.y) }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        return !polylineIntersectsCapsule(ptsPx, aPx, bPx, threshold);
      });
      if (next.length !== strokes.length) {
        inkStrokesRef.current = next;
        scheduleDrawInk();
      }
    },
    [mode, scheduleDrawInk],
  );

  const onInkPointerUp = useCallback(
    (e: InkPointerLikeEvent) => {
      if (mode !== 'ink') return;
      const g = inkGestureRef.current;
      if (!g) return;
      if (e.pointerId !== g.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      inkGestureRef.current = null;
      commitInkStrokes(inkStrokesRef.current);
    },
    [commitInkStrokes, mode],
  );

  const onInkPointerCancel = useCallback(
    (e: InkPointerLikeEvent) => {
      if (mode !== 'ink') return;
      const g = inkGestureRef.current;
      if (!g) return;
      if (e.pointerId !== g.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      inkGestureRef.current = null;
      commitInkStrokes(inkStrokesRef.current);
    },
    [commitInkStrokes, mode],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const isInkToolEnabled = () => mode === 'ink' && (inkTool === 'draw' || inkTool === 'erase') && !disabled;

    const onTouchMoveCapture = (e: TouchEvent) => {
      if (!isInkToolEnabled()) return;
      if (!e.cancelable) return;
      const touches = Array.from(e.changedTouches ?? []);
      if (touches.length === 0) return;

      const canvas = inkCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      for (const touch of touches) {
        const touchType = String((touch as any)?.touchType ?? '').toLowerCase();
        if (touchType !== 'stylus') continue;
        const x = touch.clientX;
        const y = touch.clientY;
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          e.preventDefault();
          return;
        }
      }
    };

    document.addEventListener('touchmove', onTouchMoveCapture as any, { capture: true, passive: false } as any);
    return () => {
      document.removeEventListener('touchmove', onTouchMoveCapture as any, true);
    };
  }, [disabled, inkTool, mode]);

  const send = useCallback(() => {
    const block = Boolean(disabled || sendDisabled);
    if (block) return;
    if (mode === 'ink') {
      onSendInkRef.current({ strokes: inkStrokesRef.current, viewport: inkViewport });
      return;
    }
    onSendRef.current();
  }, [disabled, inkViewport, mode, sendDisabled]);

  const openAttachments = useCallback(() => {
    if (disabled) return;
    fileRef.current?.click();
  }, [disabled]);

  const selectedContextSet = useMemo(
    () => new Set(Array.isArray(selectedContextAttachmentKeys) ? selectedContextAttachmentKeys : []),
    [selectedContextAttachmentKeys],
  );

  const composerDockOffsetX = useMemo(() => {
    if (!hasDraftAttachments) return 0;
    const baseMargin = Math.max(0, (viewportW - composerWidth) / 2);
    const need = ATTACHMENTS_STRIP_W + ATTACHMENTS_STRIP_GAP - baseMargin;
    if (need <= 0) return 0;
    const minLeftMargin = VIEWPORT_MARGIN_X / 2;
    const maxShift = baseMargin - minLeftMargin;
    if (maxShift <= 0) return 0;
    return -Math.min(need, maxShift);
  }, [hasDraftAttachments, viewportW, composerWidth]);

  return (
    <>
      <div
        className={`composerDock ${dockReady ? 'composerDock--ready' : ''} ${dockDragging ? 'composerDock--dragging' : ''} ${dockResizing ? 'composerDock--resizing' : ''} ${minimized && !hasDraftAttachments ? 'composerDock--minimized' : ''} ${minimized && hasDraftAttachments ? 'composerDock--minimizedWithAttachments' : ''}`}
        ref={(el) => {
          dockRef.current = el;
          if (!containerRef) return;
          if (typeof containerRef === 'function') {
            containerRef(el);
          } else {
            (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          }
        }}
        style={{
          width: composerWidth,
          maxWidth: `calc(100% - ${VIEWPORT_MARGIN_X}px)`,
          ['--composer-dock-offset-x' as any]: `${composerDockOffsetX}px`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
      {hasDraftAttachments ? (
        <div className="composerDock__attachmentStrip" ref={attachmentStripRef}>
          {draftAttachmentViews.map(({ attachment: att, index }) => {
            const thumbUrl = draftThumbUrls[index] ?? null;
            const isImage = att.kind === 'image';
            const isPdf = att.kind === 'pdf';
            const label = labelForAttachment(att);
            const pdfThumbName = (() => {
              if (!isPdf) return '';
              const raw = typeof att.name === 'string' ? att.name.trim() : '';
              const withoutExt = raw.replace(/\.pdf$/i, '').trim();
              return withoutExt || raw || 'PDF';
            })();
            return (
              <div className="composerDock__attachmentThumb" key={`${att.kind}-${index}`} title={label}>
                {isImage && thumbUrl ? (
                  <img className="composerDock__attachmentThumbImg" src={thumbUrl} alt={att.name?.trim() || 'Attachment'} />
                ) : isPdf ? (
                  <div className="composerDock__attachmentThumbPdf" aria-hidden="true">
                    <div className="composerDock__attachmentThumbPdfIcon">
                      <span className="composerDock__attachmentThumbPdfBadge">PDF</span>
                      <span className="composerDock__attachmentThumbPdfName">{pdfThumbName}</span>
                    </div>
                  </div>
                ) : (
                  <div
                    className={`composerDock__attachmentThumbFallback ${isPdf ? 'composerDock__attachmentThumbFallback--pdf' : ''}`}
                  >
                    <span className="composerDock__attachmentThumbLabel">{isPdf ? 'PDF' : att.kind}</span>
                  </div>
                )}
                {onRemoveDraftAttachment ? (
                  <button
                    className="composerDock__attachmentThumbRemove"
                    type="button"
                    onClick={() => onRemoveDraftAttachment(index)}
                    disabled={disabled}
                    aria-label="Remove attachment"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {replyPreview ? (
        <div className="composerSurface composer__replyBanner">
          <div className="composer__replyText">
            Replying to: "<span className="composer__replySnippet">{replyPreview}</span>"
          </div>
          {onCancelReply ? (
            <button className="composer__replyCancel" type="button" onClick={onCancelReply} aria-label="Cancel reply">
              ✕
            </button>
          ) : null}
        </div>
      ) : null}
      {Array.isArray(contextSelections) && contextSelections.length > 0 ? (
        <div className="composer__contextSelectionList">
          {contextSelections.map((t, i) => (
            <div className="composerSurface composer__replyBanner" key={`${i}-${String(t ?? '').slice(0, 12)}`}>
              <div className="composer__replyText">
                Context {i + 1}: "<span className="composer__replySnippet">{previewSnippet(t)}</span>"
              </div>
              {onRemoveContextSelection ? (
                <button
                  className="composer__replyCancel"
                  type="button"
                  onClick={() => onRemoveContextSelection(i)}
                  aria-label={`Remove context ${i + 1}`}
                  title="Remove context"
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {replyPreview && Array.isArray(contextAttachments) && contextAttachments.length > 0 ? (
        <div className="composerSurface composer__contextAttachments">
          <div className="composer__contextTitle">Context attachments</div>
          <div className="composer__contextList">
            {contextAttachments.map((item) => (
              <label className="composer__contextItem" key={item.key}>
                <input
                  type="checkbox"
                  checked={selectedContextSet.has(item.key)}
                  disabled={disabled}
                  onChange={(e) => onToggleContextAttachmentKey?.(item.key, Boolean((e.currentTarget as HTMLInputElement).checked))}
                />
                <span className="composer__contextLabel">{labelForAttachment(item.attachment)}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <div className="composerSurface composer">
        <div
          role="separator"
          aria-label="Drag left to minimize composer"
          className="composer__resizeHandle composer__resizeHandle--left"
          onPointerDown={beginMinimizeDrag}
        />
        <div
          role="separator"
          aria-label="Drag left to minimize composer"
          className="composer__resizeHandle composer__resizeHandle--right"
          onPointerDown={beginMinimizeDrag}
        />
        <div
          role="separator"
          aria-label="Resize"
          className="composer__resizeHandle composer__resizeHandle--top"
          onPointerDown={(e) => beginResizePointer(e, { kind: 'height' })}
        />
        <div
          role="separator"
          aria-label="Resize (top left)"
          className="composer__resizeHandle composer__resizeHandle--topLeft"
          onPointerDown={(e) => beginResizePointer(e, { kind: 'corner', dir: -1 })}
        />
        <div
          role="separator"
          aria-label="Resize (top right)"
          className="composer__resizeHandle composer__resizeHandle--topRight"
          onPointerDown={(e) => beginResizePointer(e, { kind: 'corner', dir: 1 })}
        />
        <div
          ref={panelRef}
          className={`composer__panel ${mode === 'ink' ? 'composer__panel--ink' : ''} ${mode === 'text' && previewEnabled ? 'composer__panel--preview' : ''}`}
          style={{ height: panelHeight, minHeight: MIN_PANEL_H }}
        >
          <div className="composer__inputWrap">
            {mode === 'ink' ? (
              <div className="composer__inkWrap">
                <canvas
                  ref={inkCanvasRef}
                  className="composer__inkCanvas"
                  onPointerDown={onInkPointerDown}
                  onPointerMove={onInkPointerMove}
                  onPointerUp={onInkPointerUp}
                  onPointerCancel={onInkPointerCancel}
                  onContextMenu={(e) => e.preventDefault()}
                />
                {inkTool !== 'draw' && inkTool !== 'erase' ? (
                  <div className="composer__inkHint">Switch to Draw or Erase tool.</div>
                ) : null}
              </div>
            ) : (
              <textarea
                ref={taRef}
                className="composer__textarea"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder ?? 'Message'}
                disabled={disabled}
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  if (e.shiftKey) return;
                  if ((e.nativeEvent as any)?.isComposing) return;
                  e.preventDefault();
                  send();
                }}
              />
            )}
          </div>
          {mode === 'text' && previewEnabled ? (
            <div className="composer__preview">
              {(deferredValue ?? '').trim().length > 0 ? (
                <MarkdownMath source={deferredValue} className="mdx" />
              ) : (
                <div className="composer__emptyPreview">Nothing to preview.</div>
              )}
            </div>
          ) : null}
        </div>

        <div className="composer__footer">
          <div className="composer__footerLeft">
            <input
              ref={fileRef}
              className="composer__fileInput"
              type="file"
              accept="image/*,application/pdf"
              multiple
              disabled={disabled}
              onChange={(e) => {
                const files = e.currentTarget.files;
                if (!files || files.length === 0) return;
                onAddAttachmentFiles?.(files);
                e.currentTarget.value = '';
              }}
            />
            <button className="composer__attach" type="button" onClick={openAttachments} disabled={disabled}>
              Attach
            </button>

            <div className="composer__modeToggle" role="group" aria-label="Composer mode">
              <button
                type="button"
                className={`composer__modeBtn ${mode === 'text' ? 'composer__modeBtn--active' : ''}`}
                onClick={() => setMode('text')}
                disabled={disabled}
                aria-pressed={mode === 'text'}
              >
                Text
              </button>
              <button
                type="button"
                className={`composer__modeBtn ${mode === 'ink' ? 'composer__modeBtn--active' : ''}`}
                onClick={() => setMode('ink')}
                disabled={disabled}
                aria-pressed={mode === 'ink'}
              >
                Ink
              </button>
            </div>

            {mode === 'text' ? (
              <label className="composer__toggle">
                <span>Preview</span>
                <input
                  type="checkbox"
                  checked={previewEnabled}
                  onChange={(e) => setPreviewEnabled((e.currentTarget as HTMLInputElement).checked)}
                />
              </label>
            ) : null}

            <label className="composer__setting">
              <span className="composer__settingLabel">Model</span>
              <span className="composer__selectWrap" data-value={selectedModelLabel}>
                <button
                  ref={modelMenuButtonRef}
                  className="composer__menuButton"
                  type="button"
                  onClick={() => {
                    if (modelMenuOpen) {
                      setModelMenuOpen(false);
                      return;
                    }
                    openModelMenu();
                  }}
                  disabled={Boolean(disabled || modelOptions.length === 0)}
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen ? 'true' : 'false'}
                >
                  {selectedModelLabel}
                </button>
              </span>
            </label>

            <label className="composer__toggle">
              <span>Web</span>
              <input
                type="checkbox"
                checked={webSearchEnabled}
                onChange={(e) => onChangeWebSearchEnabled(Boolean((e.currentTarget as HTMLInputElement).checked))}
                disabled={disabled}
              />
            </label>
          </div>
          <button className="composer__send" type="button" onClick={send} disabled={Boolean(disabled || sendDisabled)}>
            Send
          </button>
        </div>
      </div>

      {typeof document !== 'undefined' && modelMenuOpen && modelMenuPos
        ? createPortal(
            <>
              <div className="composerMenuBackdrop" onPointerDown={closeMenus} aria-hidden="true" />
              <div
                className="composerMenu"
                style={{
                  top: modelMenuPos.top,
                  bottom: modelMenuPos.bottom,
                  left: modelMenuPos.left,
                  width: 115,
                  maxHeight: modelMenuPos.maxHeight,
                }}
                role="menu"
              >
                {modelOptions.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`composerMenu__item ${m.id === modelId ? 'composerMenu__item--active' : ''}`}
                    onClick={() => selectModel(m.id)}
                    role="menuitem"
                    title={m.label}
                  >
                    {String(m.shortLabel ?? m.label ?? m.id).trim()}
                  </button>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}
      </div>

      {minimized ? (
        <button
          className={`composerToggle ${hasDraftAttachments ? 'composerToggle--withAttachments' : ''}`}
          type="button"
          onClick={() => setMinimized(false)}
          aria-label="Expand message composer"
          title="Expand message composer"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          ›
        </button>
      ) : null}
    </>
  );
}
