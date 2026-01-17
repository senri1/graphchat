import React, { useEffect, useMemo, useRef } from 'react';
import MarkdownMath from './MarkdownMath';

type Props = {
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
};

export default function TextNodeEditor(props: Props) {
  const { value, onChange, onClose } = props;
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const previewStyle = useMemo<React.CSSProperties>(
    () => ({
      fontSize: 14,
      color: 'rgba(255,255,255,0.92)',
      lineHeight: 1.55,
      wordBreak: 'break-word',
    }),
    [],
  );

  return (
    <div className="editor">
      <div className="editor__topbar">
        <div className="editor__title">Edit node</div>
        <button className="editor__btn" type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="editor__body">
        <textarea
          ref={taRef}
          className="editor__textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />

        <div className="editor__preview">
          <div className="editor__previewLabel">Preview</div>
          <MarkdownMath source={value} className="mdx" style={previewStyle} />
        </div>
      </div>
    </div>
  );
}

