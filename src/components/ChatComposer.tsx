import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownMath from './MarkdownMath';
import type { ModelInfo, TextVerbosity } from '../llm/registry';
import type { ChatAttachment } from '../model/chat';

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

  const [composerWidth, setComposerWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_COMPOSER_W;
    const maxW = Math.max(0, Math.min(MAX_W, Math.floor(window.innerWidth - VIEWPORT_MARGIN_X)));
    return Math.min(DEFAULT_COMPOSER_W, maxW);
  });
  const [manualWidthEnabled, setManualWidthEnabled] = useState(false);
  const [manualHeightEnabled, setManualHeightEnabled] = useState(false);
  const [panelHeight, setPanelHeight] = useState<number>(DEFAULT_PANEL_H);

  const startXRef = useRef<number>(0);
  const startWRef = useRef<number>(0);
  const startYRef = useRef<number>(0);
  const startHRef = useRef<number>(0);
  const resizingRef = useRef<boolean>(false);
  const maxHRef = useRef<number>(0);
  const maxWRef = useRef<number>(0);
  const resizeModeRef = useRef<ResizeMode>({ kind: 'height' });
  const activeMoveListenerRef = useRef<((e: PointerEvent) => void) | null>(null);
  const activeEndListenerRef = useRef<(() => void) | null>(null);

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

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  useEffect(() => {
    if (!replyPreview) return;
    const raf = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [replyPreview]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const clampWidth = () => {
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
    if (manualHeightEnabled) return;

    const prevH = ta.style.height;
    ta.style.height = 'auto';
    const sh = ta.scrollHeight;
    ta.style.height = prevH;

    const nextAuto = Math.min(AUTO_MAX_PANEL_H, Math.max(DEFAULT_PANEL_H, sh));
    setPanelHeight((prev) => (Math.abs(prev - nextAuto) <= 1 ? prev : nextAuto));
  }, [value, manualHeightEnabled, previewEnabled, composerWidth]);

  const applyResize = (clientX: number, clientY: number) => {
    const mode = resizeModeRef.current;

    if (mode.kind === 'height' || mode.kind === 'corner') {
      const deltaY = startYRef.current - clientY;
      const nextH = Math.min(maxHRef.current, Math.max(MIN_PANEL_H, startHRef.current + deltaY));
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

  const endResize = () => {
    resizingRef.current = false;
    const move = activeMoveListenerRef.current ?? onPointerMove;
    const end = activeEndListenerRef.current ?? endResize;
    window.removeEventListener('pointermove', move as any);
    window.removeEventListener('pointerup', end as any);
    window.removeEventListener('pointercancel', end as any);
    activeMoveListenerRef.current = null;
    activeEndListenerRef.current = null;
    if (document && document.body) {
      (document.body as HTMLBodyElement).style.userSelect = '';
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!resizingRef.current) return;
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
    activeEndListenerRef.current = endResize;
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', endResize, { passive: false });
    window.addEventListener('pointercancel', endResize, { passive: false });
    if (document && document.body) {
      (document.body as HTMLBodyElement).style.userSelect = 'none';
    }
  };

  useEffect(() => {
    return () => {
      const move = activeMoveListenerRef.current;
      const end = activeEndListenerRef.current;
      if (move && end) {
        window.removeEventListener('pointermove', move as any);
        window.removeEventListener('pointerup', end as any);
        window.removeEventListener('pointercancel', end as any);
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

  return (
    <div
      className="composerDock"
      ref={containerRef}
      style={{ width: composerWidth, maxWidth: `calc(100% - ${VIEWPORT_MARGIN_X}px)` }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
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

        {Array.isArray(draftAttachments) && draftAttachments.length > 0 ? (
          <div className="composer__attachments">
            {draftAttachments.map((att, idx) => (
              <div className="composer__attachmentChip" key={`${att.kind}-${idx}`}>
                <span className={`composer__attachmentKind composer__attachmentKind--${att.kind}`}>{att.kind}</span>
                <span className="composer__attachmentLabel">{labelForAttachment(att)}</span>
                {onRemoveDraftAttachment ? (
                  <button
                    className="composer__attachmentRemove"
                    type="button"
                    onClick={() => onRemoveDraftAttachment(idx)}
                    disabled={disabled}
                    aria-label="Remove attachment"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

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
                e.currentTarget.value = '';
                if (!files || files.length === 0) return;
                onAddAttachmentFiles?.(files);
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
                <select
                  className="composer__select"
                  value={modelId}
                  onChange={(e) => onChangeModelId(e.currentTarget.value)}
                  disabled={disabled}
                >
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {(m.shortLabel ?? m.label).trim()}
                    </option>
                  ))}
                </select>
              </span>
            </label>

            <label className="composer__setting">
              <span className="composer__settingLabel">Verbosity</span>
              <span className="composer__selectWrap" data-value={selectedVerbosityLabel}>
                <select
                  className="composer__select"
                  value={verbosity}
                  onChange={(e) => onChangeVerbosity(e.currentTarget.value as TextVerbosity)}
                  disabled={disabled}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
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
    </div>
  );
}
