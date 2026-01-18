import { TextLayer } from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist';
import type { Rect } from './types';

export type PdfTextLod2Mode = 'select';

export type HighlightRect = { left: number; top: number; width: number; height: number };

type TextContentSource = ReadableStream<unknown> | unknown;

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

async function writeClipboardText(text: string): Promise<boolean> {
  const t = (text ?? '').toString();
  if (!t) return false;

  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    // Fallback for older browsers / stricter clipboard permissions.
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.left = '-99999px';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function extractPlainTextFromRange(baseRange: Range): string {
  try {
    const range = baseRange.cloneRange();
    const frag = range.cloneContents();

    const tmp = document.createElement('div');
    tmp.style.position = 'fixed';
    tmp.style.left = '-99999px';
    tmp.style.top = '0';
    tmp.style.whiteSpace = 'pre-wrap';
    tmp.style.pointerEvents = 'none';
    tmp.appendChild(frag);
    document.body.appendChild(tmp);
    const raw = tmp.innerText;
    tmp.remove();
    return raw.trim();
  } catch {
    try {
      return baseRange.toString().trim();
    } catch {
      return '';
    }
  }
}

const PDF_TEXT_LAYER_CSS = `
.gc-pdfTextLod2 .textLayer{
  position:absolute;
  text-align:initial;
  inset:0;
  overflow:clip;
  opacity:1;
  line-height:1;
  -webkit-text-size-adjust:none;
  text-size-adjust:none;
  forced-color-adjust:none;
  transform-origin:0 0;
  caret-color:CanvasText;
  z-index:0;
}
.gc-pdfTextLod2 .textLayer :is(span,br){
  color:transparent;
  position:absolute;
  white-space:pre;
  cursor:text;
  transform-origin:0% 0%;
}
.gc-pdfTextLod2 .textLayer span[role="img"]{
  -webkit-user-select:none;
  user-select:none;
  cursor:default;
}
.gc-pdfTextLod2 .textLayer ::selection{
  background:rgba(0, 0, 255, 0.25);
}
.gc-pdfTextLod2 .textLayer ::-moz-selection{
  background:rgba(0, 0, 255, 0.25);
}
`.trim();

export class PdfTextLod2Overlay {
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly scaled: HTMLDivElement;
  private readonly textLayerEl: HTMLDivElement;
  private readonly highlights: HTMLDivElement;
  private readonly highlightEls: HTMLDivElement[] = [];

  private readonly menu: HTMLDivElement;
  private readonly menuCopyBtn: HTMLButtonElement;
  private readonly menuCloseBtn: HTMLButtonElement;

  private visibleKey: string | null = null;
  private visibleNodeId: string | null = null;
  private visibleToken: number | null = null;
  private visiblePageNumber: number | null = null;
  private mode: PdfTextLod2Mode | null = null;
  private lastZoom = 1;
  private menuText: string | null = null;
  private interactive = false;
  private nativePointerId: number | null = null;

  private textLayer: TextLayer | null = null;
  private textLayerReadyKey: string | null = null;
  private renderToken = 0;

  onRequestCloseSelection?: () => void;
  onTextLayerReady?: () => void;

  private readonly onDocPointerDownCapture = (e: Event) => {
    if (!this.isMenuOpen()) return;
    const target = e.target as Node | null;
    if (target && this.menu.contains(target)) return;
    this.closeMenu();
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.isMenuOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeMenu();
    }
  };

  private readonly onRootPointerDown = (e: PointerEvent) => {
    if (!this.interactive) return;
    if ((e.pointerType || 'mouse') !== 'mouse') return;
    if (e.button !== 0) return;
    e.stopPropagation();
    this.nativePointerId = e.pointerId;
    this.clearHighlights();
    this.closeMenu({ suppressCallback: true });

    try {
      document.addEventListener('pointerup', this.onNativePointerUpCapture, true);
      document.addEventListener('pointercancel', this.onNativePointerCancelCapture, true);
    } catch {
      // ignore
    }
  };

  private finishNativeSelection = () => {
    requestAnimationFrame(() => {
      const sel = window.getSelection?.() ?? null;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

      const anchor = sel.anchorNode;
      const focus = sel.focusNode;
      if (!anchor || !focus) return;
      if (!this.textLayerEl.contains(anchor) || !this.textLayerEl.contains(focus)) return;

      const range = (() => {
        try {
          return sel.getRangeAt(0).cloneRange();
        } catch {
          return null;
        }
      })();
      if (!range) return;

      const text = extractPlainTextFromRange(range);
      if (!text) return;

      const rect = (() => {
        try {
          const rects = Array.from(range.getClientRects());
          return (rects[rects.length - 1] ?? range.getBoundingClientRect()) || null;
        } catch {
          return null;
        }
      })();
      if (!rect) return;

      this.openMenu({ anchorRect: rect, text });
    });
  };

  private readonly onNativePointerUpCapture = (e: PointerEvent) => {
    if (!this.interactive) return;
    if ((e.pointerType || 'mouse') !== 'mouse') return;
    if (this.nativePointerId == null || this.nativePointerId !== e.pointerId) return;
    this.nativePointerId = null;

    try {
      document.removeEventListener('pointerup', this.onNativePointerUpCapture, true);
      document.removeEventListener('pointercancel', this.onNativePointerCancelCapture, true);
    } catch {
      // ignore
    }

    this.finishNativeSelection();
  };

  private readonly onNativePointerCancelCapture = (e: PointerEvent) => {
    if (this.nativePointerId == null || this.nativePointerId !== e.pointerId) return;
    this.nativePointerId = null;
    try {
      document.removeEventListener('pointerup', this.onNativePointerUpCapture, true);
      document.removeEventListener('pointercancel', this.onNativePointerCancelCapture, true);
    } catch {
      // ignore
    }
  };

  constructor(opts: { host: HTMLElement; onRequestCloseSelection?: () => void; onTextLayerReady?: () => void }) {
    this.host = opts.host;
    this.onRequestCloseSelection = opts.onRequestCloseSelection;
    this.onTextLayerReady = opts.onTextLayerReady;

    const root = document.createElement('div');
    root.className = 'gc-pdfTextLod2';
    root.style.display = 'none';
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '1px';
    root.style.height = '1px';
    root.style.overflow = 'hidden';
    root.style.pointerEvents = 'none';
    root.style.contain = 'layout paint style';
    this.root = root;

    const style = document.createElement('style');
    style.textContent = PDF_TEXT_LAYER_CSS;
    root.appendChild(style);

    const scaled = document.createElement('div');
    scaled.className = 'gc-pdfTextLod2__scaled';
    scaled.style.position = 'absolute';
    scaled.style.left = '0';
    scaled.style.top = '0';
    scaled.style.transformOrigin = '0 0';
    scaled.style.willChange = 'transform';
    this.scaled = scaled;

    const textLayerEl = document.createElement('div');
    textLayerEl.className = 'gc-pdfTextLod2__textLayer textLayer';
    textLayerEl.style.position = 'absolute';
    textLayerEl.style.left = '0';
    textLayerEl.style.top = '0';
    textLayerEl.style.right = '0';
    textLayerEl.style.bottom = '0';
    this.textLayerEl = textLayerEl;

    const highlights = document.createElement('div');
    highlights.className = 'gc-pdfTextLod2__highlights';
    highlights.style.position = 'absolute';
    highlights.style.left = '0';
    highlights.style.top = '0';
    highlights.style.right = '0';
    highlights.style.bottom = '0';
    highlights.style.pointerEvents = 'none';
    this.highlights = highlights;

    scaled.appendChild(textLayerEl);
    scaled.appendChild(highlights);
    root.appendChild(scaled);
    this.host.appendChild(root);

    root.addEventListener('pointerdown', this.onRootPointerDown);

    const menu = document.createElement('div');
    menu.className = 'gc-selectionMenu';
    menu.style.position = 'fixed';
    menu.style.display = 'none';
    menu.style.zIndex = '40';
    menu.style.pointerEvents = 'auto';
    menu.style.userSelect = 'none';
    this.menu = menu;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'gc-selectionMenu__btn';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      void (async () => {
        const text = this.menuText ?? '';
        if (!text) {
          this.closeMenu();
          return;
        }
        await writeClipboardText(text);
        this.closeMenu();
      })();
    });
    this.menuCopyBtn = copyBtn;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'gc-selectionMenu__btn';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.closeMenu());
    this.menuCloseBtn = closeBtn;

    menu.appendChild(copyBtn);
    menu.appendChild(closeBtn);
    this.host.appendChild(menu);

    const stopMenuPointer = (e: Event) => e.stopPropagation();
    menu.addEventListener('pointerdown', stopMenuPointer);
    menu.addEventListener('pointermove', stopMenuPointer);
    menu.addEventListener('pointerup', stopMenuPointer);
    menu.addEventListener('pointercancel', stopMenuPointer);
    menu.addEventListener('wheel', stopMenuPointer, { passive: true } as any);

    document.addEventListener('pointerdown', this.onDocPointerDownCapture, true);
    window.addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    try {
      document.removeEventListener('pointerdown', this.onDocPointerDownCapture, true);
      window.removeEventListener('keydown', this.onKeyDown);
      document.removeEventListener('pointerup', this.onNativePointerUpCapture, true);
      document.removeEventListener('pointercancel', this.onNativePointerCancelCapture, true);
    } catch {
      // ignore
    }
    try {
      this.textLayer?.cancel();
    } catch {
      // ignore
    }
    try {
      this.root.remove();
    } catch {
      // ignore
    }
    try {
      this.menu.remove();
    } catch {
      // ignore
    }
  }

  isMenuOpen(): boolean {
    return this.menu.style.display !== 'none';
  }

  getNodeId(): string | null {
    return this.visibleNodeId;
  }

  getToken(): number | null {
    return this.visibleToken;
  }

  getPageNumber(): number | null {
    return this.visiblePageNumber;
  }

  getMode(): PdfTextLod2Mode | null {
    return this.mode;
  }

  getZoom(): number {
    return this.lastZoom;
  }

  getTextLayerElement(): HTMLDivElement {
    return this.textLayerEl;
  }

  isTextLayerReadyForKey(key: string): boolean {
    return this.textLayerReadyKey === key;
  }

  withPointerEventsEnabled<T>(fn: () => T): T {
    const prev = this.root.style.pointerEvents;
    try {
      this.root.style.pointerEvents = 'auto';
    } catch {
      // ignore
    }
    try {
      return fn();
    } finally {
      try {
        this.root.style.pointerEvents = prev || 'none';
      } catch {
        // ignore
      }
    }
  }

  private clearTextLayer(): void {
    this.textLayerReadyKey = null;
    try {
      this.textLayer?.cancel();
    } catch {
      // ignore
    }
    this.textLayer = null;
    try {
      this.textLayerEl.replaceChildren();
    } catch {
      // ignore
    }
  }

  private startTextLayerRender(
    key: string,
    ensure: () => Promise<{ viewport: PageViewport; textContentSource: TextContentSource } | null>,
  ): void {
    const token = ++this.renderToken;
    this.textLayerReadyKey = null;
    this.clearTextLayer();

    void (async () => {
      const res = await ensure();
      if (!res) return;
      if (this.renderToken !== token) return;

      const tl = new TextLayer({
        textContentSource: res.textContentSource,
        container: this.textLayerEl,
        viewport: res.viewport,
      } as any);
      this.textLayer = tl;

      try {
        await tl.render();
      } catch {
        return;
      }
      if (this.renderToken !== token) {
        try {
          tl.cancel();
        } catch {
          // ignore
        }
        return;
      }

      this.textLayerReadyKey = key;
      this.onTextLayerReady?.();
    })();
  }

  show(opts: {
    nodeId: string;
    token: number;
    pageNumber: number;
    mode: PdfTextLod2Mode;
    interactive?: boolean;
    screenRect: Rect;
    worldW: number;
    worldH: number;
    zoom: number;
    pageKey: string;
    ensureTextLayer: () => Promise<{ viewport: PageViewport; textContentSource: TextContentSource } | null>;
  }): void {
    const keyChanged = this.visibleKey !== opts.pageKey;
    this.visibleNodeId = opts.nodeId;
    this.visibleToken = opts.token;
    this.visiblePageNumber = opts.pageNumber;
    this.mode = opts.mode;
    this.interactive = Boolean(opts.interactive);

    const z = Math.max(0.001, Number.isFinite(opts.zoom) ? opts.zoom : 1);
    this.lastZoom = z;

    this.root.style.display = 'block';
    this.root.style.pointerEvents = this.interactive ? 'auto' : 'none';
    this.root.style.left = `${Math.round(opts.screenRect.x)}px`;
    this.root.style.top = `${Math.round(opts.screenRect.y)}px`;
    this.root.style.width = `${Math.max(1, Math.round(opts.screenRect.w))}px`;
    this.root.style.height = `${Math.max(1, Math.round(opts.screenRect.h))}px`;

    const worldW = Math.max(1, opts.worldW);
    const worldH = Math.max(1, opts.worldH);
    this.scaled.style.width = `${worldW}px`;
    this.scaled.style.height = `${worldH}px`;
    this.scaled.style.transform = `scale(${z})`;

    if (keyChanged) {
      this.visibleKey = opts.pageKey;
      this.startTextLayerRender(opts.pageKey, opts.ensureTextLayer);
    }

    if (this.interactive) {
      this.textLayerEl.style.userSelect = 'text';
      (this.textLayerEl.style as any).webkitUserSelect = 'text';
      this.textLayerEl.style.cursor = 'text';
    } else {
      this.textLayerEl.style.userSelect = 'none';
      (this.textLayerEl.style as any).webkitUserSelect = 'none';
      this.textLayerEl.style.cursor = 'default';
    }
  }

  hide(): void {
    this.visibleKey = null;
    this.visibleNodeId = null;
    this.visibleToken = null;
    this.visiblePageNumber = null;
    this.mode = null;
    this.interactive = false;
    this.nativePointerId = null;
    this.renderToken += 1;
    this.clearTextLayer();
    this.clearHighlights();
    this.closeMenu({ suppressCallback: true });
    this.root.style.display = 'none';
  }

  clearHighlights(): void {
    this.highlightEls.length = 0;
    try {
      this.highlights.replaceChildren();
    } catch {
      // ignore
    }
  }

  setHighlightRects(rects: HighlightRect[]): void {
    const layer = this.highlights;
    const els = this.highlightEls;

    while (els.length < rects.length) {
      const el = document.createElement('div');
      el.className = 'gc-pdfTextLod2__highlightRect';
      el.style.position = 'absolute';
      el.style.pointerEvents = 'none';
      el.style.borderRadius = '3px';
      el.style.background = 'rgba(99, 102, 241, 0.28)';
      el.style.boxShadow = '0 0 0 1px rgba(99, 102, 241, 0.22) inset';
      el.style.willChange = 'transform,width,height';
      layer.appendChild(el);
      els.push(el);
    }
    while (els.length > rects.length) {
      const el = els.pop();
      try {
        el?.remove();
      } catch {
        // ignore
      }
    }

    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]!;
      const el = els[i]!;
      el.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    }
  }

  openMenu(opts: { anchorRect: DOMRect; text: string }): void {
    const t = (opts.text ?? '').trim();
    if (!t) {
      this.closeMenu();
      return;
    }
    this.menuText = t;

    const rect = opts.anchorRect;
    const estW = 192;
    const estH = 44;
    const margin = 8;
    let top = rect.top - estH - margin;
    if (top < margin) top = rect.bottom + margin;
    top = clamp(top, margin, window.innerHeight - estH - margin);

    let left = rect.left;
    left = clamp(left, margin, window.innerWidth - estW - margin);

    this.menu.style.display = 'flex';
    this.menu.style.flexDirection = 'row';
    this.menu.style.gap = '8px';
    this.menu.style.padding = '8px';
    this.menu.style.borderRadius = '12px';
    this.menu.style.background = 'rgba(11, 13, 18, 0.92)';
    this.menu.style.border = '1px solid rgba(255,255,255,0.14)';
    (this.menu.style as any).backdropFilter = 'blur(10px)';
    this.menu.style.boxShadow = '0 16px 50px rgba(0,0,0,0.45)';
    this.menu.style.left = `${Math.round(left)}px`;
    this.menu.style.top = `${Math.round(top)}px`;

    this.menuCopyBtn.style.fontSize = '12px';
    this.menuCopyBtn.style.padding = '6px 10px';
    this.menuCopyBtn.style.borderRadius = '10px';
    this.menuCopyBtn.style.border = '1px solid rgba(255,255,255,0.16)';
    this.menuCopyBtn.style.background = 'rgba(0,0,0,0.25)';
    this.menuCopyBtn.style.color = 'rgba(255,255,255,0.9)';

    this.menuCloseBtn.style.fontSize = '12px';
    this.menuCloseBtn.style.padding = '6px 10px';
    this.menuCloseBtn.style.borderRadius = '10px';
    this.menuCloseBtn.style.border = '1px solid rgba(255,255,255,0.16)';
    this.menuCloseBtn.style.background = 'rgba(0,0,0,0.25)';
    this.menuCloseBtn.style.color = 'rgba(255,255,255,0.9)';
  }

  closeMenu(opts?: { suppressCallback?: boolean }): void {
    if (!this.isMenuOpen()) return;
    this.menu.style.display = 'none';
    this.menuText = null;
    if (!opts?.suppressCallback) this.onRequestCloseSelection?.();
  }
}
