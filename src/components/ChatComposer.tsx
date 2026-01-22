import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import MarkdownMath from './MarkdownMath';
import type { ModelInfo, TextVerbosity } from '../llm/registry';
import type { ChatAttachment } from '../model/chat';
import { getAttachment as getStoredAttachment } from '../storage/attachments';

type ResizeMode =
  | { kind: 'height' }
  | { kind: 'width'; dir: -1 | 1 }
  | { kind: 'corner'; dir: -1 | 1 };

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  modelId: string;
  modelOptions: ModelInfo[];
  onChangeModelId: (next: string) => void;
  verbosity: TextVerbosity;
  onChangeVerbosity: (next: TextVerbosity) => void;
  webSearchEnabled: boolean;
  onChangeWebSearchEnabled: (next: boolean) => void;
  containerRef?: React.Ref<HTMLDivElement>;
  replyPreview?: string | null;
  onCancelReply?: () => void;
  placeholder?: string;
  sendDisabled?: boolean;
  disabled?: boolean;
  draftAttachments?: ChatAttachment[];
  onAddAttachmentFiles?: (files: FileList) => void;
  onRemoveDraftAttachment?: (index: number) => void;
  contextAttachments?: Array<{ key: string; attachment: ChatAttachment }>;
  selectedContextAttachmentKeys?: string[];
  onToggleContextAttachmentKey?: (key: string, included: boolean) => void;
};

type MenuPos = { left: number; top?: number; bottom?: number; maxHeight: number };

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
  const { value, onChange, onSend, modelId, modelOptions, onChangeModelId, verbosity, onChangeVerbosity, webSearchEnabled, onChangeWebSearchEnabled, containerRef, replyPreview, onCancelReply, placeholder, sendDisabled, disabled, draftAttachments, onAddAttachmentFiles, onRemoveDraftAttachment, contextAttachments, selectedContextAttachmentKeys, onToggleContextAttachmentKey } = props;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const onSendRef = useRef(onSend);
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const deferredValue = useDeferredValue(value);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const DEFAULT_COMPOSER_W = 720;
  const MIN_W = 625;
  const MAX_W = 2000;
  const VIEWPORT_MARGIN_X = 20;
  const VIEWPORT_MARGIN_TOP = 24;

  const DEFAULT_PANEL_H = 180;
  const MIN_PANEL_H = 130;
  const AUTO_MAX_PANEL_H = 360;
  const ATTACHMENTS_STRIP_MAX_H = DEFAULT_PANEL_H;
  const ATTACHMENTS_STRIP_W = 74;
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

  const selectedModelLabel = useMemo(() => {
    const match = modelOptions.find((m) => m.id === modelId);
    const label = match?.shortLabel ?? match?.label ?? modelId;
    return String(label).trim();
  }, [modelId, modelOptions]);

  const selectedVerbosityLabel = useMemo(() => {
    switch (verbosity) {
      case 'low':
        return 'Low';
      case 'medium':
        return 'Medium';
      case 'high':
        return 'High';
      default:
        return String(verbosity);
    }
  }, [verbosity]);

  const modelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const verbosityMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [verbosityMenuOpen, setVerbosityMenuOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState<MenuPos | null>(null);
  const [verbosityMenuPos, setVerbosityMenuPos] = useState<MenuPos | null>(null);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  const closeMenus = useCallback(() => {
    setModelMenuOpen(false);
    setVerbosityMenuOpen(false);
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

  const updateVerbosityMenuPosition = useCallback(() => {
    const btn = verbosityMenuButtonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();

    const gap = 8;
    const viewportPadding = 8;
    const estimatedWidth = 80;
    const maxMenuH = 256;
    const desiredH = 132;

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

    setVerbosityMenuPos({ top, bottom, left, maxHeight });
  }, []);

  const openModelMenu = useCallback(() => {
    if (disabled || modelOptions.length === 0) return;
    setVerbosityMenuOpen(false);
    updateModelMenuPosition();
    setModelMenuOpen(true);
  }, [disabled, modelOptions.length, updateModelMenuPosition]);

  const openVerbosityMenu = useCallback(() => {
    if (disabled) return;
    setModelMenuOpen(false);
    updateVerbosityMenuPosition();
    setVerbosityMenuOpen(true);
  }, [disabled, updateVerbosityMenuPosition]);

  const selectModel = useCallback(
    (next: string) => {
      onChangeModelId(next);
      setModelMenuOpen(false);
    },
    [onChangeModelId],
  );

  const selectVerbosity = useCallback(
    (next: TextVerbosity) => {
      onChangeVerbosity(next);
      setVerbosityMenuOpen(false);
    },
    [onChangeVerbosity],
  );

  useEffect(() => {
    if (!disabled) return;
    closeMenus();
  }, [closeMenus, disabled]);

  useEffect(() => {
    if (!modelMenuOpen && !verbosityMenuOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenus();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeMenus, modelMenuOpen, verbosityMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen && !verbosityMenuOpen) return;

    const onReposition = () => {
      if (modelMenuOpen) updateModelMenuPosition();
      if (verbosityMenuOpen) updateVerbosityMenuPosition();
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
    verbosityMenuOpen,
    updateVerbosityMenuPosition,
  ]);

  useEffect(() => {
    if (!replyPreview) return;
    const raf = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [replyPreview]);

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
    const ta = taRef.current;
    if (!ta) return;

    const prevH = ta.style.height;
    ta.style.height = 'auto';
    const sh = ta.scrollHeight;
    ta.style.height = prevH;

    const nextAuto = Math.min(AUTO_MAX_PANEL_H, Math.max(MIN_PANEL_H, sh));
    const baseline = manualHeightEnabled ? manualHeightRef.current : DEFAULT_PANEL_H;
    const next = Math.max(baseline, nextAuto);
    setPanelHeight((prev) => (Math.abs(prev - next) <= 1 ? prev : next));
  }, [value, manualHeightEnabled, previewEnabled, composerWidth]);

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
      if (document && document.body) {
        (document.body as HTMLBodyElement).style.userSelect = '';
      }
    };
  }, []);

  const send = useCallback(() => {
    const block = Boolean(disabled || sendDisabled);
    if (block) return;
    onSendRef.current();
  }, [disabled, sendDisabled]);

  const openAttachments = useCallback(() => {
    if (disabled) return;
    fileRef.current?.click();
  }, [disabled]);

  const selectedContextSet = useMemo(
    () => new Set(Array.isArray(selectedContextAttachmentKeys) ? selectedContextAttachmentKeys : []),
    [selectedContextAttachmentKeys],
  );

  const hasDraftAttachments = Array.isArray(draftAttachments) && draftAttachments.length > 0;
  const composerDockOffsetX = useMemo(() => {
    if (!hasDraftAttachments) return 0;
    const baseMargin = Math.max(0, (viewportW - composerWidth) / 2);
    const need = ATTACHMENTS_STRIP_W + ATTACHMENTS_STRIP_GAP - baseMargin;
    if (need <= 0) return 0;
    const minRightMargin = VIEWPORT_MARGIN_X / 2;
    const maxShift = baseMargin - minRightMargin;
    if (maxShift <= 0) return 0;
    return Math.min(need, maxShift);
  }, [hasDraftAttachments, viewportW, composerWidth]);

  return (
    <div
      className="composerDock"
      ref={containerRef}
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
        <div className="composerDock__attachmentStrip" style={{ maxHeight: ATTACHMENTS_STRIP_MAX_H }}>
          {draftAttachments.map((att, idx) => {
            const thumbUrl = draftThumbUrls[idx] ?? null;
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
              <div className="composerDock__attachmentThumb" key={`${att.kind}-${idx}`} title={label}>
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
                    onClick={() => onRemoveDraftAttachment(idx)}
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
          aria-label="Resize width (left)"
          className="composer__resizeHandle composer__resizeHandle--left"
          onPointerDown={(e) => beginResizePointer(e, { kind: 'width', dir: -1 })}
        />
        <div
          role="separator"
          aria-label="Resize width (right)"
          className="composer__resizeHandle composer__resizeHandle--right"
          onPointerDown={(e) => beginResizePointer(e, { kind: 'width', dir: 1 })}
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
          className={`composer__panel ${previewEnabled ? 'composer__panel--preview' : ''}`}
          style={{ height: panelHeight, minHeight: MIN_PANEL_H }}
        >
          <div className="composer__inputWrap">
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
          </div>
          {previewEnabled ? (
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

            <label className="composer__toggle">
              <span>Preview</span>
              <input
                type="checkbox"
                checked={previewEnabled}
                onChange={(e) => setPreviewEnabled((e.currentTarget as HTMLInputElement).checked)}
              />
            </label>

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

            <label className="composer__setting">
              <span className="composer__settingLabel">Verbosity</span>
              <span className="composer__selectWrap" data-value={selectedVerbosityLabel}>
                <button
                  ref={verbosityMenuButtonRef}
                  className="composer__menuButton"
                  type="button"
                  onClick={() => {
                    if (verbosityMenuOpen) {
                      setVerbosityMenuOpen(false);
                      return;
                    }
                    openVerbosityMenu();
                  }}
                  disabled={disabled}
                  aria-haspopup="menu"
                  aria-expanded={verbosityMenuOpen ? 'true' : 'false'}
                >
                  {selectedVerbosityLabel}
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

      {typeof document !== 'undefined' && verbosityMenuOpen && verbosityMenuPos
        ? createPortal(
            <>
              <div className="composerMenuBackdrop" onPointerDown={closeMenus} aria-hidden="true" />
              <div
                className="composerMenu"
                style={{
                  top: verbosityMenuPos.top,
                  bottom: verbosityMenuPos.bottom,
                  left: verbosityMenuPos.left,
                  width: 80,
                  maxHeight: verbosityMenuPos.maxHeight,
                }}
                role="menu"
              >
                {(['low', 'medium', 'high'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`composerMenu__item ${v === verbosity ? 'composerMenu__item--active' : ''}`}
                    onClick={() => selectVerbosity(v)}
                    role="menuitem"
                  >
                    {v === 'low' ? 'Low' : v === 'medium' ? 'Medium' : 'High'}
                  </button>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
