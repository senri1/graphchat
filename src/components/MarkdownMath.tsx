import React, { memo, useMemo } from 'react';
import { renderMarkdownMath } from '../markdown/renderMarkdownMath';

type Props = {
  source: string;
  className?: string;
  style?: React.CSSProperties;
};

function MarkdownMath({ source, className, style }: Props) {
  const html = useMemo(() => renderMarkdownMath(source ?? ''), [source]);
  return (
    <div
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default memo(MarkdownMath);

