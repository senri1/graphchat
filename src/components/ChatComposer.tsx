import React, { useCallback, useEffect, useRef } from 'react';

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  placeholder?: string;
  sendDisabled?: boolean;
  disabled?: boolean;
};

export default function ChatComposer(props: Props) {
  const { value, onChange, onSend, placeholder, sendDisabled, disabled } = props;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const onSendRef = useRef(onSend);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  const send = useCallback(() => {
    const block = Boolean(disabled || sendDisabled);
    if (block) return;
    onSendRef.current();
  }, [disabled, sendDisabled]);

  return (
    <div
      className="composer"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
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
      <button className="composer__send" type="button" onClick={send} disabled={Boolean(disabled || sendDisabled)}>
        Send
      </button>
    </div>
  );
}
