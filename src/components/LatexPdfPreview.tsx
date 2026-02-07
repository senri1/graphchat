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
  onInverseSync?: (payload: { page: number; x: number; y: number }) => void;
};

type RenderPageMeta = {
  pageNumber: number;
  width: number;
  height: number;
  scale: number;
};

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export default function LatexPdfPreview(props: Props) {
  const { pdfUrl, syncTarget, zoom, onInverseSync } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRefByPage = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const wrapperRefByPage = useRef<Map<number, HTMLDivElement>>(new Map());
  const viewportRefByPage = useRef<Map<number, PageViewport>>(new Map());
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const loadedPdfUrlRef = useRef<string | null>(null);
  const renderTokenRef = useRef(0);
  const lastAppliedSyncTokenRef = useRef<number | null>(null);

  const [containerWidth, setContainerWidth] = useState(0);
  const [metas, setMetas] = useState<RenderPageMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marker, setMarker] = useState<{ page: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const applyWidth = () => {
      const next = Math.max(1, Math.floor(el.getBoundingClientRect().width));
      setContainerWidth((prev) => (Math.abs(prev - next) >= 2 ? next : prev));
    };
    applyWidth();
    const ro = new ResizeObserver(() => applyWidth());
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
        const zoomRaw = Number(zoom);
        const zoomFactor = Number.isFinite(zoomRaw) ? clamp(zoomRaw, 0.35, 4) : 1;
        const widthTarget = Math.max(180, (containerWidth || 680) * zoomFactor);
        const nextMetas: RenderPageMeta[] = [];
        for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
          const page = await doc.getPage(pageNumber);
          const base = page.getViewport({ scale: 1 });
          const scale = clamp((widthTarget - 12) / Math.max(1, base.width), 0.45, 2.4);
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
  }, [pdfUrl, containerWidth, zoom]);

  useEffect(() => {
    const token = ++renderTokenRef.current;
    const doc = docRef.current;
    if (!doc || metas.length === 0) return;

    let cancelled = false;
    const run = async () => {
      for (const meta of metas) {
        const canvas = canvasRefByPage.current.get(meta.pageNumber);
        if (!canvas) continue;
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
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [metas]);

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
