import React, { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import MarkdownMath from './MarkdownMath';

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  replyPreview?: string | null;
  onCancelReply?: () => void;
  placeholder?: string;
  sendDisabled?: boolean;
  disabled?: boolean;
};

export default function ChatComposer(props: Props) {
  const { value, onChange, onSend, replyPreview, onCancelReply, placeholder, sendDisabled, disabled } = props;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const onSendRef = useRef(onSend);
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const deferredValue = useDeferredValue(value);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  useEffect(() => {
    if (!replyPreview) return;
    const raf = requestAnimationFrame(() => taRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [replyPreview]);

  const send = useCallback(() => {
    const block = Boolean(disabled || sendDisabled);
    if (block) return;
    onSendRef.current();
  }, [disabled, sendDisabled]);

  return (
    <div
      className="composerDock"
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
      <div className="composerSurface composer">
        <div className={`composer__panel ${previewEnabled ? 'composer__panel--preview' : ''}`}>
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
          <label className="composer__toggle">
            <span>Preview</span>
            <input
              type="checkbox"
              checked={previewEnabled}
              onChange={(e) => setPreviewEnabled((e.currentTarget as HTMLInputElement).checked)}
            />
          </label>
          <button className="composer__send" type="button" onClick={send} disabled={Boolean(disabled || sendDisabled)}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
