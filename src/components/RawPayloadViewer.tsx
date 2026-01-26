import React, { useEffect, useMemo, useRef } from 'react';
import type { Rect } from '../engine/types';

type Props = {
  nodeId: string;
  title: string | null;
  kind: 'request' | 'response';
  payload: unknown;
  anchorRect: Rect | null;
  getScreenRect?: () => Rect | null;
  viewport: { w: number; h: number };
  zoom: number;
  onClose: () => void;
};

function isProbablyDataUrl(value: string): boolean {
  return /^data:[^,]+,/.test(value);
}

function truncateDataUrlForDisplay(value: string, maxChars: number): string {
  const s = String(value ?? '');
  if (s.length <= maxChars) return s;
  const comma = s.indexOf(',');
  if (comma === -1) return `${s.slice(0, maxChars)}… (${s.length} chars)`;
  const prefix = s.slice(0, comma + 1);
  const data = s.slice(comma + 1);
  const keep = Math.max(0, maxChars - prefix.length);
  return `${prefix}${data.slice(0, keep)}… (${data.length} chars)`;
}

function stringifyPayload(payload: unknown): string {
  if (payload === undefined) return '';
  try {
    return JSON.stringify(
      payload,
      (_key, value) => {
        if (typeof value !== 'string') return value;
        if (isProbablyDataUrl(value)) return truncateDataUrlForDisplay(value, 220);
        if (value.length > 20000) return `${value.slice(0, 20000)}… (${value.length} chars)`;
        return value;
      },
      2,
    );
  } catch {
    try {
      return String(payload);
    } catch {
      return '';
    }
  }
}

export default function RawPayloadViewer(props: Props) {
  const { nodeId, title, kind, payload, anchorRect, getScreenRect, viewport, zoom, onClose } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const getScreenRectRef = useRef<Props['getScreenRect']>(getScreenRect);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    getScreenRectRef.current = getScreenRect;
  }, [getScreenRect]);

  useEffect(() => {
    const onPointerDownCapture = (e: PointerEvent) => {
      const root = rootRef.current;
      const target = e.target as Node | null;
      if (!root || !target) return;
      if (root.contains(target)) return;
      onCloseRef.current();
    };
    window.addEventListener('pointerdown', onPointerDownCapture, true);
    return () => window.removeEventListener('pointerdown', onPointerDownCapture, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const z = Math.max(0.001, Number.isFinite(zoom) ? zoom : 1);
  const displayTitle = title ?? (kind === 'request' ? 'Raw request' : 'Raw response');
  const text = useMemo(() => stringifyPayload(payload), [payload]);
  const followEnabled = typeof getScreenRect === 'function';

  const style = useMemo<React.CSSProperties>(() => {
    if (followEnabled) {
      const initial = anchorRect;
      return {
        left: 0,
        top: 0,
        width: Math.max(1, Math.round(initial?.w ?? 1)),
        height: Math.max(1, Math.round(initial?.h ?? 1)),
        transform: initial ? `translate3d(${Math.round(initial.x)}px, ${Math.round(initial.y)}px, 0)` : undefined,
        borderRadius: `${14 * z}px`,
        zIndex: 40,
        willChange: 'transform',
      };
    }

    if (anchorRect) {
      return {
        left: anchorRect.x,
        top: anchorRect.y,
        width: anchorRect.w,
        height: anchorRect.h,
        borderRadius: `${18 * z}px`,
        zIndex: 40,
      };
    }

    const margin = 12;
    const vpW = Math.max(1, viewport.w || window.innerWidth || 1);
    const vpH = Math.max(1, viewport.h || window.innerHeight || 1);
    const w = Math.min(820, vpW - margin * 2);
    const h = Math.min(Math.round(vpH * 0.78), vpH - margin * 2);
    return { left: (vpW - w) * 0.5, top: margin, width: w, height: h, zIndex: 40 };
  }, [anchorRect, followEnabled, viewport.h, viewport.w, z]);

  useEffect(() => {
    if (!followEnabled) return;
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      raf = requestAnimationFrame(tick);

      const el = rootRef.current;
      const fn = getScreenRectRef.current;
      if (!el || !fn) return;
      const r = fn();
      if (!r) return;

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

  const copyDisabled = !text;
  const copy = async () => {
    if (copyDisabled) return;
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // ignore
    }
  };

  const close = () => onCloseRef.current();

  return (
    <div
      ref={rootRef}
      className="editor editor--raw"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="editor__topbar">
        <div className="editor__title">{displayTitle}</div>
        <div className="editor__actions">
          <button className="editor__btn" type="button" onClick={copy} disabled={copyDisabled}>
            Copy
          </button>
          <button className="editor__btn editor__btn--primary" type="button" onClick={close}>
            Close
          </button>
        </div>
      </div>

      <div className="editor__body">
        <textarea
          className="editor__textarea"
          value={text || `No raw ${kind} recorded.`}
          readOnly
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            close();
          }}
        />
      </div>
    </div>
  );
}
