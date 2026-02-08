import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadPdfDocument } from '../engine/pdf/pdfjs';
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
  const { pdfUrl, syncTarget, zoom, zoomMode, onInverseSync } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRefByPage = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const wrapperRefByPage = useRef<Map<number, HTMLDivElement>>(new Map());
  const viewportRefByPage = useRef<Map<number, PageViewport>>(new Map());
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const loadedPdfUrlRef = useRef<string | null>(null);
  const renderTokenRef = useRef(0);
  const lastAppliedSyncTokenRef = useRef<number | null>(null);

  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [metas, setMetas] = useState<RenderPageMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marker, setMarker] = useState<{ page: number; left: number; top: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollViewportH, setScrollViewportH] = useState(0);

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
        const widthTarget = Math.max(180, (containerWidth || 680) * zoomFactor);
        const widthFitTarget = Math.max(180, (containerWidth || 680) - 12);
        const heightFitTarget = Math.max(180, (containerHeight || scrollViewportH || 900) - SCROLL_PAD_PX * 2);
        const nextMetas: RenderPageMeta[] = [];
        for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
          const page = await doc.getPage(pageNumber);
          const base = page.getViewport({ scale: 1 });
          const manualScale = clamp((widthTarget - 12) / Math.max(1, base.width), 0.45, 2.4);
          const fitWidthScale = clamp(widthFitTarget / Math.max(1, base.width), 0.45, 2.4);
          const fitPageScale = clamp(
            Math.min(widthFitTarget / Math.max(1, base.width), heightFitTarget / Math.max(1, base.height)),
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
    return Array.from(visiblePageSet).sort((a, b) => a - b).join(',');
  }, [visiblePageSet]);

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

  const handlePageClick = useCallback(
    (pageNumber: number, e: React.MouseEvent<HTMLCanvasElement>) => {
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
      <div ref={containerRef} className="editor__pdfCanvasScroll">
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
  }, [error, handlePageClick, loading, marker, metas, pageCount, showEmpty]);

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
    syncTargetsEqual(prev.syncTarget, next.syncTarget)
  );
});

export default LatexPdfPreview;
