import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadPdfDocument } from '../engine/pdf/pdfjs';
import {
  PdfTextLod2Overlay,
  type PdfOverlayWheelPayload,
  type PdfSelectionStartAnchor,
} from '../engine/PdfTextLod2Overlay';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';

type SyncTarget = {
  token: number;
  page: number;
  x?: number | null;
  y?: number | null;
};

type Props = {
  pdfUrl: string | null;
  syncTarget: SyncTarget | null;
  zoom?: number;
  zoomMode?: 'manual' | 'fit-width' | 'fit-page';
  onInverseSync?: (payload: { page: number; x: number; y: number }) => void;
  onReplyToSelection?: (selectionText: string) => void;
  onAddToContextSelection?: (selectionText: string) => void;
  onAnnotateTextSelection?: (payload: {
    selectionText: string;
    anchor: PdfSelectionStartAnchor | null;
    client?: { x: number; y: number } | null;
  }) => void;
  onAnnotateInkSelection?: (payload: {
    selectionText: string;
    anchor: PdfSelectionStartAnchor | null;
    client?: { x: number; y: number } | null;
  }) => void;
};

type RenderPageMeta = {
  pageNumber: number;
  width: number;
  height: number;
  scale: number;
};

const PAGE_GAP_PX = 10;
const SCROLL_PAD_PX = 8;
const VISIBLE_OVERSCAN_PX = 1200;

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function LatexPdfPreviewImpl(props: Props) {
  const {
    pdfUrl,
    syncTarget,
    zoom,
    zoomMode,
    onInverseSync,
    onReplyToSelection,
    onAddToContextSelection,
    onAnnotateTextSelection,
    onAnnotateInkSelection,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRefByPage = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const wrapperRefByPage = useRef<Map<number, HTMLDivElement>>(new Map());
  const viewportRefByPage = useRef<Map<number, PageViewport>>(new Map());
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const loadedPdfUrlRef = useRef<string | null>(null);
  const renderTokenRef = useRef(0);
  const lastAppliedSyncTokenRef = useRef<number | null>(null);
  const pdfTextOverlayRef = useRef<PdfTextLod2Overlay | null>(null);

  const onInverseSyncRef = useRef<Props['onInverseSync']>(onInverseSync);
  const onReplyToSelectionRef = useRef<Props['onReplyToSelection']>(onReplyToSelection);
  const onAddToContextSelectionRef = useRef<Props['onAddToContextSelection']>(onAddToContextSelection);
  const onAnnotateTextSelectionRef = useRef<Props['onAnnotateTextSelection']>(onAnnotateTextSelection);
  const onAnnotateInkSelectionRef = useRef<Props['onAnnotateInkSelection']>(onAnnotateInkSelection);

  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [metas, setMetas] = useState<RenderPageMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marker, setMarker] = useState<{ page: number; left: number; top: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollViewportH, setScrollViewportH] = useState(0);
  const [activeTextLayerPage, setActiveTextLayerPage] = useState<number | null>(null);
  const isFitZoomMode = zoomMode === 'fit-width' || zoomMode === 'fit-page';

  useEffect(() => {
    onInverseSyncRef.current = onInverseSync;
  }, [onInverseSync]);

  useEffect(() => {
    onReplyToSelectionRef.current = onReplyToSelection;
  }, [onReplyToSelection]);

  useEffect(() => {
    onAddToContextSelectionRef.current = onAddToContextSelection;
  }, [onAddToContextSelection]);

  useEffect(() => {
    onAnnotateTextSelectionRef.current = onAnnotateTextSelection;
  }, [onAnnotateTextSelection]);

  useEffect(() => {
    onAnnotateInkSelectionRef.current = onAnnotateInkSelection;
  }, [onAnnotateInkSelection]);

  const inverseSyncAtClient = useCallback((pageNumber: number, client: { x: number; y: number }) => {
    const onInverse = onInverseSyncRef.current;
    if (!onInverse) return;

    const page = Math.max(1, Math.floor(Number(pageNumber) || 1));
    const viewport = viewportRefByPage.current.get(page);
    const wrapper = wrapperRefByPage.current.get(page);
    if (!viewport || !wrapper) return;

    const rect = wrapper.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0.5 || rect.height <= 0.5) return;

    const localX = clamp(Number(client.x) - rect.left, 0, rect.width);
    const localY = clamp(Number(client.y) - rect.top, 0, rect.height);
    const pxX = (localX * Math.max(1, Number(viewport.width) || 1)) / Math.max(1, rect.width);
    const pxY = (localY * Math.max(1, Number(viewport.height) || 1)) / Math.max(1, rect.height);
    try {
      const point = viewport.convertToPdfPoint(pxX, pxY);
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      onInverse({ page, x, y });
    } catch {
      // ignore
    }
  }, []);

  const handleOverlayWheel = useCallback(
    (payload: PdfOverlayWheelPayload): boolean => {
      const el = containerRef.current;
      if (!el) return false;
      if (payload.ctrlKey) return false;

      const hasHorizontal = !isFitZoomMode && el.scrollWidth > el.clientWidth + 1;
      const hasVertical = el.scrollHeight > el.clientHeight + 1;
      if (!hasHorizontal && !hasVertical) return false;

      const mode = Number(payload.deltaMode) || 0;
      const unit = mode === 1 ? 16 : mode === 2 ? Math.max(1, el.clientHeight) : 1;
      let dx = (Number(payload.deltaX) || 0) * unit;
      let dy = (Number(payload.deltaY) || 0) * unit;

      if (isFitZoomMode) {
        dx = 0;
      } else if (payload.shiftKey && Math.abs(dx) < 0.01 && Math.abs(dy) >= 0.01) {
        dx = dy;
        dy = 0;
      }

      const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const nextLeft = hasHorizontal ? clamp(el.scrollLeft + dx, 0, maxLeft) : el.scrollLeft;
      const nextTop = hasVertical ? clamp(el.scrollTop + dy, 0, maxTop) : el.scrollTop;
      if (Math.abs(nextLeft - el.scrollLeft) >= 0.01) el.scrollLeft = nextLeft;
      if (Math.abs(nextTop - el.scrollTop) >= 0.01) el.scrollTop = nextTop;
      return true;
    },
    [isFitZoomMode],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const overlay = new PdfTextLod2Overlay({
      host: document.body,
      positionMode: 'fixed',
      zIndex: 30,
    });

    overlay.onRequestReplyToSelection = (_nodeId, selectionText) => {
      const fn = onReplyToSelectionRef.current;
      if (!fn) return;
      fn(selectionText);
    };

    overlay.onRequestAddToContext = (_nodeId, selectionText) => {
      const fn = onAddToContextSelectionRef.current;
      if (!fn) return;
      fn(selectionText);
    };

    overlay.onRequestAnnotateTextSelection = (_nodeId, selectionText, anchor, client) => {
      const fn = onAnnotateTextSelectionRef.current;
      if (!fn) return;
      fn({
        selectionText,
        anchor: anchor ?? null,
        client: client ?? null,
      });
    };

    overlay.onRequestAnnotateInkSelection = (_nodeId, selectionText, anchor, client) => {
      const fn = onAnnotateInkSelectionRef.current;
      if (!fn) return;
      fn({
        selectionText,
        anchor: anchor ?? null,
        client: client ?? null,
      });
    };

    overlay.onRequestClickWithoutSelection = (pageNumber, client) => {
      inverseSyncAtClient(pageNumber, client);
    };

    overlay.onRequestWheel = (payload) => {
      return handleOverlayWheel(payload);
    };

    pdfTextOverlayRef.current = overlay;
    return () => {
      try {
        overlay.dispose();
      } catch {
        // ignore
      }
      if (pdfTextOverlayRef.current === overlay) pdfTextOverlayRef.current = null;
    };
  }, [handleOverlayWheel, inverseSyncAtClient]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const applySize = () => {
      const rect = el.getBoundingClientRect();
      const nextW = Math.max(1, Math.floor(rect.width));
      const nextH = Math.max(1, Math.floor(rect.height));
      setContainerWidth((prev) => (Math.abs(prev - nextW) >= 2 ? nextW : prev));
      setContainerHeight((prev) => (Math.abs(prev - nextH) >= 2 ? nextH : prev));
    };
    applySize();
    const ro = new ResizeObserver(() => applySize());
    ro.observe(el);
    return () => {
      try {
        ro.disconnect();
      } catch {
        // ignore
      }
    };
  }, [pdfUrl, metas.length]);

  useEffect(() => {
    return () => {
      if (!docRef.current) return;
      try {
        void docRef.current.destroy();
      } catch {
        // ignore
      }
      docRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf = 0;
    const syncFromDom = () => {
      raf = 0;
      setScrollTop(Math.max(0, Math.floor(el.scrollTop)));
      setScrollViewportH(Math.max(1, Math.floor(el.clientHeight)));
    };
    const scheduleSync = () => {
      if (raf) return;
      raf = requestAnimationFrame(syncFromDom);
    };

    syncFromDom();
    el.addEventListener('scroll', scheduleSync, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => scheduleSync());
      ro.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', scheduleSync);
      if (ro) {
        try {
          ro.disconnect();
        } catch {
          // ignore
        }
      }
      if (raf) {
        try {
          cancelAnimationFrame(raf);
        } catch {
          // ignore
        }
      }
    };
  }, [metas.length, pdfUrl, loading, error]);

  useEffect(() => {
    const token = ++renderTokenRef.current;
    setError(null);

    if (!pdfUrl) {
      setMarker(null);
      setActiveTextLayerPage(null);
      viewportRefByPage.current.clear();
      setMetas([]);
      setLoading(false);
      loadedPdfUrlRef.current = null;
      if (docRef.current) {
        try {
          void docRef.current.destroy();
        } catch {
          // ignore
        }
      }
      docRef.current = null;
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        let doc = docRef.current;
        const shouldLoadDoc = !doc || loadedPdfUrlRef.current !== pdfUrl;
        if (shouldLoadDoc) {
          setLoading(true);
          setMarker(null);
          viewportRefByPage.current.clear();
          const res = await fetch(pdfUrl);
          if (!res.ok) throw new Error(`Failed to load PDF (${res.status}).`);
          const buf = await res.arrayBuffer();
          if (cancelled || token !== renderTokenRef.current) return;
          const loadedDoc = await loadPdfDocument(buf);
          if (cancelled || token !== renderTokenRef.current) {
            try {
              await loadedDoc.destroy();
            } catch {
              // ignore
            }
            return;
          }
          if (docRef.current && docRef.current !== loadedDoc) {
            try {
              await docRef.current.destroy();
            } catch {
              // ignore
            }
          }
          docRef.current = loadedDoc;
          loadedPdfUrlRef.current = pdfUrl;
          doc = loadedDoc;
        }

        if (!doc) {
          setMetas([]);
          setLoading(false);
          return;
        }

        const count = Math.max(0, Number(doc.numPages) || 0);
        const effectiveMode: 'manual' | 'fit-width' | 'fit-page' =
          zoomMode === 'fit-page' ? 'fit-page' : zoomMode === 'fit-width' ? 'fit-width' : 'manual';
        const zoomRaw = Number(zoom);
        const zoomFactor = Number.isFinite(zoomRaw) ? clamp(zoomRaw, 0.35, 4) : 1;
        const viewportWidth = Math.max(1, containerWidth || 680);
        // Leave a small buffer so fit-width mode never oscillates around a 1px overflow.
        const fitWidthTarget = Math.max(180, viewportWidth - SCROLL_PAD_PX * 2 - 2);
        const manualWidthTarget = Math.max(180, fitWidthTarget * zoomFactor);
        const heightFitTarget = Math.max(180, (containerHeight || scrollViewportH || 900) - SCROLL_PAD_PX * 2);
        const nextMetas: RenderPageMeta[] = [];
        for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
          const page = await doc.getPage(pageNumber);
          const base = page.getViewport({ scale: 1 });
          const manualScale = clamp(manualWidthTarget / Math.max(1, base.width), 0.45, 2.4);
          const fitWidthScale = clamp(fitWidthTarget / Math.max(1, base.width), 0.45, 2.4);
          const fitPageScale = clamp(
            Math.min(fitWidthTarget / Math.max(1, base.width), heightFitTarget / Math.max(1, base.height)),
            0.45,
            2.4,
          );
          const scale =
            effectiveMode === 'fit-page' ? fitPageScale : effectiveMode === 'fit-width' ? fitWidthScale : manualScale;
          const viewport = page.getViewport({ scale });
          nextMetas.push({
            pageNumber,
            width: Math.max(1, Math.floor(viewport.width)),
            height: Math.max(1, Math.floor(viewport.height)),
            scale,
          });
        }
        if (cancelled || token !== renderTokenRef.current) return;
        setMetas(nextMetas);
        if (shouldLoadDoc) setLoading(false);
      } catch (err: any) {
        if (cancelled || token !== renderTokenRef.current) return;
        const msg = err ? String(err?.message ?? err) : 'Failed to render PDF preview.';
        setError(msg);
        setLoading(false);
        setMetas([]);
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [pdfUrl, containerWidth, containerHeight, scrollViewportH, zoom, zoomMode]);

  const visiblePageSet = useMemo(() => {
    if (metas.length === 0) return new Set<number>();
    const out = new Set<number>();
    const vpH = Math.max(1, scrollViewportH || 1);
    const yMin = Math.max(0, scrollTop - VISIBLE_OVERSCAN_PX);
    const yMax = scrollTop + vpH + VISIBLE_OVERSCAN_PX;
    let cursor = SCROLL_PAD_PX;
    for (const meta of metas) {
      const top = cursor;
      const bottom = top + meta.height + PAGE_GAP_PX;
      if (bottom >= yMin && top <= yMax) out.add(meta.pageNumber);
      cursor = bottom;
    }
    if (marker && Number.isFinite(marker.page)) out.add(marker.page);
    return out;
  }, [marker, metas, scrollTop, scrollViewportH]);

  const visiblePageKey = useMemo(() => {
    if (visiblePageSet.size === 0) return '';
    return Array.from(visiblePageSet)
      .sort((a, b) => a - b)
      .join(',');
  }, [visiblePageSet]);

  useEffect(() => {
    if (!pdfUrl) {
      setActiveTextLayerPage(null);
      return;
    }
    if (!metas.length) return;
    if (activeTextLayerPage != null && metas.some((m) => m.pageNumber === activeTextLayerPage)) return;
    const next = metas.find((m) => visiblePageSet.has(m.pageNumber))?.pageNumber ?? metas[0]?.pageNumber ?? null;
    if (next != null) setActiveTextLayerPage(next);
  }, [activeTextLayerPage, metas, pdfUrl, visiblePageKey, visiblePageSet]);

  useEffect(() => {
    const token = ++renderTokenRef.current;
    const doc = docRef.current;
    if (!doc || metas.length === 0 || visiblePageSet.size === 0) return;

    let cancelled = false;
    const run = async () => {
      for (const meta of metas) {
        if (!visiblePageSet.has(meta.pageNumber)) continue;
        const canvas = canvasRefByPage.current.get(meta.pageNumber);
        if (!canvas) continue;
        const renderSig = `${loadedPdfUrlRef.current ?? ''}:${meta.width}x${meta.height}@${meta.scale.toFixed(5)}`;
        if (canvas.dataset.renderSig === renderSig && viewportRefByPage.current.has(meta.pageNumber)) continue;

        const page = await doc.getPage(meta.pageNumber);
        if (cancelled || token !== renderTokenRef.current) return;
        const viewport = page.getViewport({ scale: meta.scale });
        viewportRefByPage.current.set(meta.pageNumber, viewport);

        const width = Math.max(1, Math.floor(viewport.width));
        const height = Math.max(1, Math.floor(viewport.height));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) continue;
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.restore();

        await page.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled || token !== renderTokenRef.current) return;
        canvas.dataset.renderSig = renderSig;
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [metas, visiblePageKey, visiblePageSet]);

  const syncTextLayerOverlay = useCallback(() => {
    const overlay = pdfTextOverlayRef.current;
    if (!overlay) return;

    if (!pdfUrl || loading || !!error || metas.length === 0) {
      overlay.hide();
      return;
    }

    const pageNumber =
      activeTextLayerPage != null && metas.some((m) => m.pageNumber === activeTextLayerPage)
        ? activeTextLayerPage
        : metas[0]?.pageNumber ?? null;
    if (!pageNumber) {
      overlay.hide();
      return;
    }

    const meta = metas.find((m) => m.pageNumber === pageNumber) ?? null;
    const wrapper = wrapperRefByPage.current.get(pageNumber) ?? null;
    if (!meta || !wrapper) {
      overlay.hide();
      return;
    }

    const rect = wrapper.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0.5 || rect.height <= 0.5) {
      overlay.hide();
      return;
    }
    const clipRectRaw = containerRef.current?.getBoundingClientRect() ?? null;
    const clipRect =
      clipRectRaw &&
      Number.isFinite(clipRectRaw.width) &&
      Number.isFinite(clipRectRaw.height) &&
      clipRectRaw.width > 0.5 &&
      clipRectRaw.height > 0.5
        ? {
            x: clipRectRaw.left,
            y: clipRectRaw.top,
            w: clipRectRaw.width,
            h: clipRectRaw.height,
          }
        : null;

    const pageKey = `${loadedPdfUrlRef.current ?? ''}|${pageNumber}|${meta.width}x${meta.height}@${meta.scale.toFixed(5)}`;
    const zoomX = rect.width / Math.max(1, meta.width);
    const zoomY = rect.height / Math.max(1, meta.height);
    const overlayZoom = (() => {
      const zx = Number.isFinite(zoomX) && zoomX > 0 ? zoomX : 1;
      const zy = Number.isFinite(zoomY) && zoomY > 0 ? zoomY : 1;
      return (zx + zy) * 0.5;
    })();

    overlay.show({
      nodeId: 'latex-preview',
      token: 1,
      pageNumber,
      mode: 'select',
      interactive: true,
      screenRect: {
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
      },
      clipRect,
      worldW: meta.width,
      worldH: meta.height,
      zoom: overlayZoom,
      pageKey,
      ensureTextLayer: async () => {
        const doc = docRef.current;
        if (!doc) return null;
        let page: any;
        try {
          page = await doc.getPage(pageNumber);
        } catch {
          return null;
        }

        const viewport: PageViewport = page.getViewport({ scale: meta.scale });
        let textContentSource: any;
        try {
          textContentSource = page.streamTextContent();
        } catch {
          try {
            textContentSource = await page.getTextContent();
          } catch {
            return null;
          }
        }
        return { viewport, textContentSource };
      },
    });
  }, [activeTextLayerPage, error, loading, metas, pdfUrl]);

  useEffect(() => {
    syncTextLayerOverlay();
  }, [syncTextLayerOverlay]);

  const shouldTrackOverlay = Boolean(pdfUrl && !loading && !error && metas.length > 0);

  useEffect(() => {
    if (!shouldTrackOverlay) return;
    let raf = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      syncTextLayerOverlay();
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (raf) {
        try {
          cancelAnimationFrame(raf);
        } catch {
          // ignore
        }
      }
    };
  }, [shouldTrackOverlay, syncTextLayerOverlay]);

  useEffect(() => {
    const t = syncTarget;
    if (!t) return;
    if (lastAppliedSyncTokenRef.current === t.token) return;

    const wrapper = wrapperRefByPage.current.get(t.page);
    if (!wrapper) return;
    try {
      wrapper.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    } catch {
      wrapper.scrollIntoView();
    }

    setActiveTextLayerPage(t.page);

    const viewport = viewportRefByPage.current.get(t.page);
    if (!viewport || !Number.isFinite(t.x as number) || !Number.isFinite(t.y as number)) {
      lastAppliedSyncTokenRef.current = t.token;
      setMarker(null);
      return;
    }
    try {
      const point = viewport.convertToViewportPoint(Number(t.x), Number(t.y));
      const left = Number(point[0]);
      const top = Number(point[1]);
      if (!Number.isFinite(left) || !Number.isFinite(top)) {
        lastAppliedSyncTokenRef.current = t.token;
        setMarker(null);
        return;
      }
      lastAppliedSyncTokenRef.current = t.token;
      setMarker({ page: t.page, left, top });
    } catch {
      lastAppliedSyncTokenRef.current = t.token;
      setMarker(null);
    }
  }, [syncTarget, metas]);

  const pageCount = metas.length;
  const showEmpty = !loading && !error && !pdfUrl;

  const activateTextLayerPage = useCallback((pageNumber: number) => {
    if (!Number.isFinite(pageNumber) || pageNumber < 1) return;
    const next = Math.floor(pageNumber);
    setActiveTextLayerPage((prev) => (prev === next ? prev : next));
  }, []);

  const handlePageClick = useCallback(
    (pageNumber: number, e: React.MouseEvent<HTMLCanvasElement>) => {
      setActiveTextLayerPage(pageNumber);
      if (!onInverseSync) return;
      const canvas = e.currentTarget;
      const viewport = viewportRefByPage.current.get(pageNumber);
      if (!viewport) return;

      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const pxX = ((e.clientX - rect.left) * canvas.width) / rect.width;
      const pxY = ((e.clientY - rect.top) * canvas.height) / rect.height;
      try {
        const point = viewport.convertToPdfPoint(pxX, pxY);
        const x = Number(point[0]);
        const y = Number(point[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        onInverseSync({ page: pageNumber, x, y });
      } catch {
        // ignore
      }
    },
    [onInverseSync],
  );

  const content = useMemo(() => {
    if (showEmpty) return <div className="editor__emptyPreview">Compile the document to preview the PDF.</div>;
    if (loading) return <div className="editor__emptyPreview">Loading PDF preview...</div>;
    if (error) return <div className="editor__emptyPreview">{error}</div>;
    if (!pageCount) return <div className="editor__emptyPreview">PDF has no pages.</div>;
    return (
      <div ref={containerRef} className={`editor__pdfCanvasScroll ${isFitZoomMode ? 'editor__pdfCanvasScroll--fit' : ''}`}>
        {metas.map((meta) => {
          const showMarker = marker && marker.page === meta.pageNumber;
          return (
            <div
              key={meta.pageNumber}
              className="editor__pdfCanvasPageWrap"
              ref={(el) => {
                if (!el) {
                  wrapperRefByPage.current.delete(meta.pageNumber);
                  return;
                }
                wrapperRefByPage.current.set(meta.pageNumber, el);
              }}
              style={{ width: `${meta.width}px`, minHeight: `${meta.height}px` }}
              onPointerEnter={(e) => {
                if ((e.pointerType || 'mouse') !== 'mouse') return;
                activateTextLayerPage(meta.pageNumber);
              }}
              onPointerMove={(e) => {
                if ((e.pointerType || 'mouse') !== 'mouse') return;
                if ((e.buttons ?? 0) !== 0) return;
                activateTextLayerPage(meta.pageNumber);
              }}
              onPointerDown={(e) => {
                if ((e.pointerType || 'mouse') !== 'mouse') return;
                if (e.button !== 0) return;
                activateTextLayerPage(meta.pageNumber);
              }}
            >
              <canvas
                className="editor__pdfCanvasPage"
                ref={(el) => {
                  if (!el) {
                    canvasRefByPage.current.delete(meta.pageNumber);
                    return;
                  }
                  canvasRefByPage.current.set(meta.pageNumber, el);
                }}
                onClick={(e) => handlePageClick(meta.pageNumber, e)}
              />
              {showMarker ? (
                <div
                  className="editor__pdfSyncMarker"
                  style={{
                    left: `${Math.max(0, marker.left)}px`,
                    top: `${Math.max(0, marker.top)}px`,
                  }}
                />
              ) : null}
              <div className="editor__pdfPageNum">{meta.pageNumber}</div>
            </div>
          );
        })}
      </div>
    );
  }, [activateTextLayerPage, error, handlePageClick, isFitZoomMode, loading, marker, metas, pageCount, showEmpty]);

  return <>{content}</>;
}

function syncTargetsEqual(a: SyncTarget | null, b: SyncTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.token === b.token && a.page === b.page && a.x === b.x && a.y === b.y;
}

const LatexPdfPreview = React.memo(LatexPdfPreviewImpl, (prev, next) => {
  return (
    prev.pdfUrl === next.pdfUrl &&
    prev.zoom === next.zoom &&
    prev.zoomMode === next.zoomMode &&
    prev.onInverseSync === next.onInverseSync &&
    prev.onReplyToSelection === next.onReplyToSelection &&
    prev.onAddToContextSelection === next.onAddToContextSelection &&
    prev.onAnnotateTextSelection === next.onAnnotateTextSelection &&
    prev.onAnnotateInkSelection === next.onAnnotateInkSelection &&
    syncTargetsEqual(prev.syncTarget, next.syncTarget)
  );
});

export default LatexPdfPreview;
