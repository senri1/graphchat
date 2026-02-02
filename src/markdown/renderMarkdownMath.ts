import MarkdownIt from 'markdown-it';
import { full as emoji } from 'markdown-it-emoji';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import footnote from 'markdown-it-footnote';
import katex from 'katex';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

function mdMathBrackets(md: any) {
  const renderInline = (tex: string) => {
    try {
      const isDisplayEnv =
        /\\begin\{(?:aligned|align|align\*|alignedat|gather|gather\*|equation|equation\*|multline|multline\*|split|cases)\}/.test(
          tex,
        );
      return katex.renderToString(tex, {
        throwOnError: false,
        strict: 'warn',
        displayMode: isDisplayEnv,
      });
    } catch {
      return tex;
    }
  };

  const renderBlock = (tex: string) => {
    try {
      return katex.renderToString(tex, {
        throwOnError: false,
        strict: 'warn',
        displayMode: true,
      });
    } catch {
      return tex;
    }
  };

  // Inline \( ... \)
  md.inline.ruler.before('escape', 'math_inline_brackets', (state: any, silent: any) => {
    const pos = state.pos;
    const src = state.src;
    if (src.charCodeAt(pos) !== 0x5c /* \\ */) return false;
    if (src[pos + 1] !== '(') return false;
    const start = pos + 2;
    const end = src.indexOf('\\)', start);
    if (end === -1) return false;
    if (!silent) {
      const token = state.push('math_inline_brackets', 'math', 0);
      token.content = src.slice(start, end);
      token.markup = '\\( \\)';
      state.pos = end + 2;
    } else {
      state.pos = end + 2;
    }
    return true;
  });
  md.renderer.rules['math_inline_brackets'] = (tokens: any, idx: any) => renderInline(tokens[idx].content);

  // Inline \[ ... \]
  md.inline.ruler.before('escape', 'math_display_brackets_inline', (state: any, silent: any) => {
    const pos = state.pos;
    const src = state.src;
    if (src.charCodeAt(pos) !== 0x5c /* \\ */) return false;
    if (src[pos + 1] !== '[') return false;
    const start = pos + 2;
    const end = src.indexOf('\\]', start);
    if (end === -1) return false;
    if (!silent) {
      const token = state.push('math_display_brackets_inline', 'math', 0);
      token.content = src.slice(start, end);
      token.markup = '\\[ \\]';
      state.pos = end + 2;
    } else {
      state.pos = end + 2;
    }
    return true;
  });
  md.renderer.rules['math_display_brackets_inline'] = (tokens: any, idx: any) => renderBlock(tokens[idx].content);

  // Block \[ ... \]
  md.block.ruler.before(
    'fence',
    'math_block_brackets',
    (state: any, startLine: any, endLine: any, silent: any) => {
      const src = state.src;
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      if (pos + 2 > max) return false;
      if (src.charCodeAt(pos) !== 0x5c /* \\ */ || src[pos + 1] !== '[') return false;

      let line = startLine;
      let endPos = -1;
      let searchFrom = pos + 2;
      while (line < endLine) {
        const lineEnd = state.eMarks[line];
        const segment = src.slice(searchFrom, lineEnd);
        const idxClose = segment.indexOf('\\]');
        if (idxClose !== -1) {
          endPos = searchFrom + idxClose;
          break;
        }
        line++;
        searchFrom = state.bMarks[line] + state.tShift[line];
      }
      if (endPos === -1) return false;
      if (silent) return true;

      const content = src.slice(pos + 2, endPos);
      const token = state.push('math_block_brackets', 'math', 0);
      token.block = true;
      token.content = content;
      token.map = [startLine, line + 1];
      state.line = line + 1;
      return true;
    },
    { alt: ['paragraph'] },
  );
  md.renderer.rules['math_block_brackets'] = (tokens: any, idx: any) =>
    `<section><eqn>${renderBlock(tokens[idx].content)}</eqn></section>`;
}

md.use(mdMathBrackets);
md.use(emoji);
md.use(sub);
md.use(sup);
md.use(footnote);

const RENDER_CACHE_MAX = 250;
const renderCache = new Map<string, string>();
const renderInlineCache = new Map<string, string>();

export function renderMarkdownMath(input: string): string {
  const key = input ?? '';
  const cached = renderCache.get(key);
  if (cached !== undefined) return cached;

  let out: string;
  try {
    out = md.render(key);
  } catch {
    const safe = key.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    out = `<pre>${safe}</pre>`;
  }

  renderCache.set(key, out);
  if (renderCache.size > RENDER_CACHE_MAX) {
    const firstKey = renderCache.keys().next().value as string | undefined;
    if (firstKey !== undefined) renderCache.delete(firstKey);
  }
  return out;
}

export function renderMarkdownMathInline(input: string): string {
  const key = input ?? '';
  const cached = renderInlineCache.get(key);
  if (cached !== undefined) return cached;

  let out: string;
  try {
    out = md.renderInline(key);
  } catch {
    out = key.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  }

  renderInlineCache.set(key, out);
  if (renderInlineCache.size > RENDER_CACHE_MAX) {
    const firstKey = renderInlineCache.keys().next().value as string | undefined;
    if (firstKey !== undefined) renderInlineCache.delete(firstKey);
  }
  return out;
}
