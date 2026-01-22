import { renderMarkdownMath } from '../../markdown/renderMarkdownMath';

export type TextRasterResult = {
  image: CanvasImageSource;
  pixelW: number;
  pixelH: number;
  bitmapBytesEstimate: number;
  hasKaTeX: boolean;
  hitZones?: TextHitZone[];
};

export type TextHitZone =
  | { kind: 'summary_toggle'; left: number; top: number; width: number; height: number }
  | { kind: 'summary_chunk_toggle'; summaryIndex: number; left: number; top: number; width: number; height: number };

const DEFAULT_TEXT_COLOR = 'rgba(255,255,255,0.92)';
const DEFAULT_TEXT_FONT_SIZE_PX = 14;
const DEFAULT_TEXT_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const MDX_CSS = `
.mdx {
  line-height: 1.55;
  word-break: break-word;
}
.mdx p { margin: 0.6rem 0; }
.mdx h1, .mdx h2, .mdx h3, .mdx h4, .mdx h5, .mdx h6 {
  margin: 0.9rem 0 0.4rem;
  font-weight: 700;
  line-height: 1.25;
}
.mdx h1 { font-size: 1.25em; }
.mdx h2 { font-size: 1.125em; }
.mdx h3 { font-size: 1.0625em; }
.mdx ul, .mdx ol { padding-left: 1.25rem; margin: 0.6rem 0; }
.mdx code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.9em;
  background: rgba(255,255,255,0.08);
  padding: 0.15rem 0.3rem;
  border-radius: 0.25rem;
}
.mdx pre {
  background: rgba(255,255,255,0.08);
  padding: 0.75rem;
  border-radius: 0.5rem;
  overflow: auto;
}
.mdx pre code { background: transparent; padding: 0; }
.mdx a { color: #93c5fd; text-decoration: underline; }
`.trim();

type KaTeXCssParts = { rules: string; fontFaces: string };
let cachedKaTeXCssParts: KaTeXCssParts | null = null;
const katexFontUrlToDataUrl = new Map<string, string>();
let katexFontWarmupAttempt: Promise<void> | null = null;

function stripInvalidXmlChars(input: string): string {
  if (!input) return input;
  const out: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const cp = input.codePointAt(i);
    if (cp == null) continue;
    if (cp > 0xffff) i++;
    if (
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff)
    ) {
      out.push(String.fromCodePoint(cp));
    }
  }
  return out.join('');
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sheetBaseHref(sheet: CSSStyleSheet): string {
  if (typeof document === 'undefined') return '';
  const href = (sheet as any)?.href;
  if (typeof href === 'string' && href) return href;

  const owner: any = (sheet as any)?.ownerNode;
  if (owner && typeof owner.getAttribute === 'function') {
    const devId = owner.getAttribute('data-vite-dev-id');
    if (typeof devId === 'string' && devId) {
      const normalized = (() => {
        if (devId.startsWith('/@fs/') || devId.startsWith('/@id/')) return devId;
        if (/^\/(?:Users|home|private|var|Volumes)\//.test(devId)) return `/@fs${devId}`;
        if (/^[A-Za-z]:[\\/]/.test(devId)) return `/@fs/${devId.replace(/\\/g, '/')}`;
        return devId;
      })();
      try {
        return new URL(normalized, document.baseURI).toString();
      } catch {
        // ignore
      }
    }
    const hrefAttr = owner.getAttribute('href');
    if (typeof hrefAttr === 'string' && hrefAttr) {
      try {
        return new URL(hrefAttr, document.baseURI).toString();
      } catch {
        // ignore
      }
    }
  }

  return document.baseURI;
}

function rewriteCssUrls(cssText: string, baseHref: string): string {
  if (!cssText || !baseHref) return cssText;
  return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _q, rawUrl) => {
    const u = String(rawUrl || '').trim();
    if (!u) return match;
    if (/^(data:|blob:|https?:|file:|about:|chrome:|javascript:)/i.test(u)) return match;
    if (u.startsWith('#') || u.startsWith('//')) return match;
    try {
      const abs = new URL(u, baseHref).toString();
      return `url("${abs}")`;
    } catch {
      return match;
    }
  });
}

function getKaTeXCssParts(): KaTeXCssParts {
  if (cachedKaTeXCssParts) return cachedKaTeXCssParts;
  if (typeof document === 'undefined') return { rules: '', fontFaces: '' };

  const rulesParts: string[] = [];
  const fontFaceParts: string[] = [];
  const sheets = Array.from(document.styleSheets || []);
  for (const sheet of sheets) {
    const baseHref = sheetBaseHref(sheet as CSSStyleSheet);
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      const rawText = (rule as any)?.cssText ? String((rule as any).cssText) : '';
      const text = rewriteCssUrls(rawText, baseHref);
      if (!text) continue;
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        if (/KaTeX/i.test(text)) fontFaceParts.push(text);
        continue;
      }
      if (/\.katex/i.test(text) || /KaTeX_/i.test(text) || /katex-/i.test(text)) {
        rulesParts.push(text);
      }
    }
  }

  cachedKaTeXCssParts = { rules: rulesParts.join('\n'), fontFaces: fontFaceParts.join('\n') };
  return cachedKaTeXCssParts;
}

function extractWoff2Urls(cssText: string): string[] {
  if (!cssText) return [];
  const urls: string[] = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText))) {
    const raw = String(m[2] ?? '').trim();
    if (!raw) continue;
    if (/^(data:|blob:)/i.test(raw)) continue;
    if (!/\.woff2(?:[?#].*)?$/i.test(raw)) continue;
    urls.push(raw);
  }
  return Array.from(new Set(urls));
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function warmKaTeXFontDataUrls(fontFacesCss: string): Promise<void> {
  if (!fontFacesCss) return;
  if (typeof fetch !== 'function' || typeof btoa !== 'function') return;

  const urls = extractWoff2Urls(fontFacesCss);
  if (urls.length === 0) return;

  const missing = urls.filter((u) => !katexFontUrlToDataUrl.has(u));
  if (missing.length === 0) return;

  await Promise.allSettled(
    missing.map(async (u) => {
      try {
        const res = await fetch(u, { cache: 'force-cache' });
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        katexFontUrlToDataUrl.set(u, `data:font/woff2;base64,${b64}`);
      } catch {
        // ignore; fall back to URL
      }
    }),
  );
}

async function getKaTeXFontFacesCssForSvg(rawFontFacesCss: string): Promise<string> {
  if (!rawFontFacesCss) return '';
  if (!katexFontWarmupAttempt) {
    katexFontWarmupAttempt = warmKaTeXFontDataUrls(rawFontFacesCss).finally(() => {
      katexFontWarmupAttempt = null;
    });
  }
  try {
    await katexFontWarmupAttempt;
  } catch {
    // ignore
  }

  if (katexFontUrlToDataUrl.size === 0) return rawFontFacesCss;
  let out = rawFontFacesCss;
  for (const [srcUrl, dataUrl] of katexFontUrlToDataUrl.entries()) {
    if (!out.includes(srcUrl)) continue;
    out = out.split(srcUrl).join(dataUrl);
  }
  return out;
}

async function svgToImage(blob: Blob, opts?: { postDecodeWait?: boolean; postDecodeWaitMs?: number }): Promise<CanvasImageSource> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;

  const postDecodeWait = opts?.postDecodeWait !== false;
  const postDecodeWaitMs = Math.max(0, Math.round(opts?.postDecodeWaitMs ?? 32));

  try {
    if (typeof (img as any).decode === 'function') {
      await (img as any).decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (e) => reject(e);
      });
    }

    if (postDecodeWait && postDecodeWaitMs > 0) {
      try {
        await Promise.race([
          nextFrame(),
          new Promise<void>((resolve) => window.setTimeout(resolve, postDecodeWaitMs)),
        ]);
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }

  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(img);
    } catch {
      // ignore
    }
  }
  return img;
}

let measureRoot: HTMLDivElement | null = null;
function ensureMeasureRoot(): HTMLDivElement {
  if (measureRoot) return measureRoot;
  const el = document.createElement('div');
  el.setAttribute('data-gcv1-raster-root', 'true');
  el.style.position = 'fixed';
  el.style.left = '-10000px';
  el.style.top = '-10000px';
  el.style.visibility = 'hidden';
  el.style.pointerEvents = 'none';
  el.style.contain = 'layout paint style';
  el.style.zIndex = '-1';
  document.body.appendChild(el);
  measureRoot = el;
  return el;
}

function measureHitZones(card: HTMLDivElement): TextHitZone[] {
  try {
    const zones: TextHitZone[] = [];
    const cardRect = card.getBoundingClientRect();

    const sum = card.querySelector('[data-gcv1-summary-toggle]') as HTMLElement | null;
    if (sum) {
      const r = sum.getBoundingClientRect();
      zones.push({
        kind: 'summary_toggle',
        left: r.left - cardRect.left,
        top: r.top - cardRect.top,
        width: r.width,
        height: r.height,
      });
    }

    const chunkBtns = Array.from(card.querySelectorAll('[data-gcv1-summary-chunk-toggle]')) as HTMLElement[];
    for (const el of chunkBtns) {
      const raw = el.getAttribute('data-gcv1-summary-chunk-toggle') ?? '';
      const idx = Number(raw);
      if (!Number.isFinite(idx)) continue;
      const r = el.getBoundingClientRect();
      zones.push({
        kind: 'summary_chunk_toggle',
        summaryIndex: idx,
        left: r.left - cardRect.left,
        top: r.top - cardRect.top,
        width: r.width,
        height: r.height,
      });
    }

    return zones;
  } catch {
    return [];
  }
}

export async function rasterizeHtmlToImage(
  html: string,
  opts: {
    width: number;
    height: number;
    rasterScale: number;
    fontFamily?: string;
    fontSizePx?: number;
    color?: string;
  },
): Promise<TextRasterResult> {
  if (typeof document === 'undefined') {
    throw new Error('rasterizeHtmlToImage: document is not available');
  }

  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  const rasterScale = Math.max(0.25, Math.min(4, Number(opts.rasterScale) || 1));
  const pixelW = Math.max(1, Math.ceil(width * rasterScale));
  const pixelH = Math.max(1, Math.ceil(height * rasterScale));

  const root = ensureMeasureRoot();
  root.innerHTML = '';

  try {
    const card = document.createElement('div');
    card.className = 'mdx';
    card.style.width = `${width}px`;
    card.style.height = `${height}px`;
    card.style.overflow = 'hidden';
    card.style.padding = '0';
    card.style.margin = '0';
    card.style.background = 'transparent';
    //card.style.setProperty('-webkit-font-smoothing', 'antialiased');
    //card.style.setProperty('-moz-osx-font-smoothing', 'grayscale');
    card.style.color = typeof opts.color === 'string' && opts.color.trim() ? opts.color : DEFAULT_TEXT_COLOR;
    card.style.fontSize = `${Math.max(1, Math.round(Number(opts.fontSizePx) || DEFAULT_TEXT_FONT_SIZE_PX))}px`;
    card.style.fontFamily =
      typeof opts.fontFamily === 'string' && opts.fontFamily.trim() ? opts.fontFamily : DEFAULT_TEXT_FONT_FAMILY;
    card.innerHTML = html ?? '';
    root.appendChild(card);

    const hasKaTeX = Boolean(card.querySelector('.katex'));
    const katexCss = hasKaTeX ? getKaTeXCssParts() : { rules: '', fontFaces: '' };
    const fontCssRaw = hasKaTeX ? stripInvalidXmlChars(katexCss.fontFaces || '') : '';
    const fontCss = hasKaTeX ? stripInvalidXmlChars(await getKaTeXFontFacesCssForSvg(fontCssRaw)) : '';
    const css = stripInvalidXmlChars([MDX_CSS, katexCss.rules].filter(Boolean).join('\n'));

    const hitZones = measureHitZones(card);

    const cardXml = (() => {
      try {
        return stripInvalidXmlChars(new XMLSerializer().serializeToString(card));
      } catch {
        return stripInvalidXmlChars(card.outerHTML);
      }
    })();

    const svg = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelW}" height="${pixelH}" viewBox="0 0 ${pixelW} ${pixelH}">`,
      fontCss ? `<style>${fontCss}</style>` : '',
      '<foreignObject x="0" y="0" width="100%" height="100%">',
      '<div xmlns="http://www.w3.org/1999/xhtml">',
      `<style>${css}</style>`,
      `<div style="transform: scale(${rasterScale}); transform-origin: 0 0; width: ${width}px; height: ${height}px;">`,
      cardXml,
      '</div>',
      '</div>',
      '</foreignObject>',
      '</svg>',
    ].join('');

    const svgBlob = new Blob([svg], { type: 'image/svg+xml' });
    const bitmapBytesEstimate = pixelW * pixelH * 4;
    const image = await svgToImage(svgBlob, {
      postDecodeWait: hasKaTeX,
      postDecodeWaitMs: 32,
    });

    return { image, pixelW, pixelH, bitmapBytesEstimate, hasKaTeX, hitZones };
  } finally {
    root.innerHTML = '';
  }
}

export async function rasterizeMarkdownMathToImage(
  source: string,
  opts: { width: number; height: number; rasterScale: number },
): Promise<TextRasterResult> {
  return rasterizeHtmlToImage(renderMarkdownMath(source ?? ''), opts);
}
