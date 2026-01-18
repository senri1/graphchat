// Normalizes KaTeX copy-tex `$...$` / `$$...$$` delimiters into strict `\(...\)` / `\[...\]`.
// This lets us keep the renderer strict (no `$` parsing) while still supporting copy/paste.

function isEscaped(src: string, idx: number): boolean {
  // True if character at idx is preceded by an odd number of backslashes.
  let backslashes = 0;
  for (let i = idx - 1; i >= 0 && src[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

function countUnescaped(src: string, needle: '$' | '$$'): number {
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '$') continue;
    if (isEscaped(src, i)) continue;
    if (needle === '$$') {
      if (src[i + 1] === '$') {
        count++;
        i++; // consume both
      }
      continue;
    }
    // needle === '$'
    if (src[i + 1] === '$') {
      i++; // skip double; counted elsewhere
      continue;
    }
    count++;
  }
  return count;
}

export function normalizeMathDelimitersFromCopyTex(input: string): string {
  if (!input) return input;

  // Quick exit: avoid work unless it looks like KaTeX copy-tex output.
  const unescapedDouble = countUnescaped(input, '$$');
  const unescapedSingle = countUnescaped(input, '$');
  if (unescapedDouble === 0 && unescapedSingle < 2) return input;

  type Mode = 'text' | 'inline' | 'display';
  let mode: Mode = 'text';

  const out: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (ch !== '$' || isEscaped(input, i)) {
      out.push(ch);
      continue;
    }

    const isDouble = input[i + 1] === '$';

    if (isDouble) {
      // Only toggle display math when in text/display. Inside inline math treat as literal.
      if (mode === 'text') {
        out.push('\\[');
        mode = 'display';
        i++; // consume second $
        continue;
      }
      if (mode === 'display') {
        out.push('\\]');
        mode = 'text';
        i++; // consume second $
        continue;
      }

      out.push('$$');
      i++; // consume second $
      continue;
    }

    // Single $
    if (mode === 'text') {
      out.push('\\(');
      mode = 'inline';
      continue;
    }
    if (mode === 'inline') {
      out.push('\\)');
      mode = 'text';
      continue;
    }

    // In display mode, keep literal $
    out.push('$');
  }

  // If delimiters were unbalanced, avoid returning broken `\(` / `\[`.
  if (mode !== 'text') return input;

  return out.join('');
}

