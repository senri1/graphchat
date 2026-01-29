import { TextLayer } from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist';
import type { Rect } from './types';

export type PdfTextLod2Mode = 'select';

export type HighlightRect = { left: number; top: number; width: number; height: number };
export type PdfSelectionStartAnchor = { pageNumber: number; yPct: number };

type TextContentSource = ReadableStream<unknown> | unknown;
type AnnotatePointerTrigger = { pointerId: number; pointerType: string };

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function caretRangeFromClientPoint(doc: Document, clientX: number, clientY: number): Range | null {
  const anyDoc = doc as any;
  if (typeof anyDoc?.caretRangeFromPoint === 'function') {
    try {
      return anyDoc.caretRangeFromPoint(clientX, clientY) as Range | null;
    } catch {
      return null;
    }
  }
  if (typeof anyDoc?.caretPositionFromPoint === 'function') {
    try {
      const pos = anyDoc.caretPositionFromPoint(clientX, clientY) as { offsetNode?: Node; offset?: number } | null;
      if (!pos?.offsetNode || typeof pos.offset !== 'number') return null;
      const range = doc.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    } catch {
      return null;
    }
  }
  return null;
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
.gc-pdfTextLod2{
  --scale-factor:1;
}
.gc-pdfTextLod2 [data-main-rotation="90"]{
  transform:rotate(90deg) translateY(-100%);
}
.gc-pdfTextLod2 [data-main-rotation="180"]{
  transform:rotate(180deg) translate(-100%, -100%);
}
.gc-pdfTextLod2 [data-main-rotation="270"]{
  transform:rotate(270deg) translateX(-100%);
}
.gc-pdfTextLod2 .textLayer{
  position:absolute;
  text-align:initial;
  inset:0;
  overflow:clip;
  opacity:1;
  line-height:1;
  -webkit-text-size-adjust:none;
  -moz-text-size-adjust:none;
  text-size-adjust:none;
  forced-color-adjust:none;
  transform-origin:0 0;
  caret-color:CanvasText;
  z-index:0;
}
.gc-pdfTextLod2 .textLayer.highlighting{
  touch-action:none;
}
.gc-pdfTextLod2 .textLayer :is(span,br){
  color:transparent;
  position:absolute;
  white-space:pre;
  cursor:text;
  transform-origin:0% 0%;
}
.gc-pdfTextLod2 .textLayer > :not(.markedContent),
.gc-pdfTextLod2 .textLayer .markedContent span:not(.markedContent){
  z-index:1;
}
.gc-pdfTextLod2 .textLayer span.markedContent{
  top:0;
  height:0;
}
.gc-pdfTextLod2 .textLayer span[role="img"]{
  -webkit-user-select:none;
  user-select:none;
  cursor:default;
}
.gc-pdfTextLod2 .textLayer br::selection{
  background:transparent;
}
.gc-pdfTextLod2 .textLayer br::-moz-selection{
  background:transparent;
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
  private readonly menuReplyBtn: HTMLButtonElement;
  private readonly menuAddToContextBtn: HTMLButtonElement;
  private readonly menuAnnotateTextBtn: HTMLButtonElement;
  private readonly menuAnnotateInkBtn: HTMLButtonElement;

  private visibleKey: string | null = null;
  private visibleNodeId: string | null = null;
  private visibleToken: number | null = null;
  private visiblePageNumber: number | null = null;
  private mode: PdfTextLod2Mode | null = null;
  private lastZoom = 1;
  private menuText: string | null = null;
  private menuSelectionStart: PdfSelectionStartAnchor | null = null;
  private interactive = false;
  private selectPointerId: number | null = null;
  private selectAnchor: Range | null = null;
  private selectRange: Range | null = null;
  private selectLastClient: { x: number; y: number } | null = null;
  private selectRaf: number | null = null;
  private suppressAnnotateClick = false;

  private textLayer: TextLayer | null = null;
  private textLayerReadyKey: string | null = null;
  private renderToken = 0;

  onRequestCloseSelection?: () => void;
  onTextLayerReady?: () => void;
  onRequestReplyToSelection?: (nodeId: string, selectionText: string) => void;
  onRequestAddToContext?: (nodeId: string, selectionText: string) => void;
  onRequestAnnotateTextSelection?: (
    nodeId: string,
    selectionText: string,
    anchor: PdfSelectionStartAnchor,
    client?: { x: number; y: number },
    trigger?: AnnotatePointerTrigger | null,
  ) => void;
  onRequestAnnotateInkSelection?: (
    nodeId: string,
    selectionText: string,
    anchor: PdfSelectionStartAnchor,
    client?: { x: number; y: number },
    trigger?: AnnotatePointerTrigger | null,
  ) => void;

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
    e.preventDefault();

    // Custom selection (instead of native DOM selection) to avoid browser "snap"
    // issues when dragging across PDF whitespace.
    this.selectPointerId = e.pointerId;
    this.selectAnchor = null;
    this.selectRange = null;
    this.selectLastClient = { x: e.clientX, y: e.clientY };
    if (this.selectRaf != null) {
      try {
        cancelAnimationFrame(this.selectRaf);
      } catch {
        // ignore
      }
      this.selectRaf = null;
    }
    this.clearHighlights();
    this.closeMenu({ suppressCallback: true });

    try {
      window.getSelection?.()?.removeAllRanges();
    } catch {
      // ignore
    }

    try {
      (this.root as any).setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    try {
      document.addEventListener('pointermove', this.onNativePointerMoveCapture, true);
      document.addEventListener('pointerup', this.onNativePointerUpCapture, true);
      document.addEventListener('pointercancel', this.onNativePointerCancelCapture, true);
    } catch {
      // ignore
    }

    this.schedulePointerSelectionUpdate();
  };

  private updatePointerSelectionFromLastPoint(): void {
    if (typeof document === 'undefined') return;
    const point = this.selectLastClient;
    if (!point) return;

    // Only update when directly over a text span; avoid caret "nearest" snapping in whitespace.
    const hitSpan = (() => {
      try {
        const hit = document.elementFromPoint(point.x, point.y) as Element | null;
        return hit?.closest?.('span[role="presentation"]') ?? null;
      } catch {
        return null;
      }
    })();
    if (!hitSpan || !this.textLayerEl.contains(hitSpan)) return;

    const caret = caretRangeFromClientPoint(document, point.x, point.y);
    if (!caret || !this.textLayerEl.contains(caret.startContainer)) return;

    const caretContainerEl =
      caret.startContainer.nodeType === Node.ELEMENT_NODE
        ? (caret.startContainer as Element)
        : (((caret.startContainer as any).parentElement as Element | null) ?? null);
    const caretSpan = caretContainerEl?.closest?.('span[role="presentation"]') ?? null;
    if (!caretSpan || !this.textLayerEl.contains(caretSpan)) return;

    if (!this.selectAnchor) {
      try {
        this.selectAnchor = caret.cloneRange();
      } catch {
        this.selectAnchor = caret;
      }
      this.selectRange = null;
      this.clearHighlights();
      return;
    }

    let forward = true;
    try {
      forward = this.selectAnchor.compareBoundaryPoints(Range.START_TO_START, caret) <= 0;
    } catch {
      forward = true;
    }

    const range = document.createRange();
    if (forward) {
      range.setStart(this.selectAnchor.startContainer, this.selectAnchor.startOffset);
      range.setEnd(caret.startContainer, caret.startOffset);
    } else {
      range.setStart(caret.startContainer, caret.startOffset);
      range.setEnd(this.selectAnchor.startContainer, this.selectAnchor.startOffset);
    }

    this.selectRange = range;

    const contentRect = this.textLayerEl.getBoundingClientRect();
    const z = Math.max(0.01, this.lastZoom || 1);
    const rects: HighlightRect[] = Array.from(range.getClientRects())
      .map((r) => ({
        left: (r.left - contentRect.left) / z,
        top: (r.top - contentRect.top) / z,
        width: r.width / z,
        height: r.height / z,
      }))
      .filter((r) => r.width > 0.5 && r.height > 0.5);

    this.setHighlightRects(rects);
  }

  private schedulePointerSelectionUpdate(): void {
    if (this.selectRaf != null) return;
    this.selectRaf = requestAnimationFrame(() => {
      this.selectRaf = null;
      this.updatePointerSelectionFromLastPoint();
    });
  }

  private readonly onNativePointerMoveCapture = (e: PointerEvent) => {
    if ((e.pointerType || 'mouse') !== 'mouse') return;
    if (this.selectPointerId == null || this.selectPointerId !== e.pointerId) return;
    e.stopPropagation();
    e.preventDefault();
    this.selectLastClient = { x: e.clientX, y: e.clientY };
    this.schedulePointerSelectionUpdate();
  };

  private readonly onNativePointerUpCapture = (e: PointerEvent) => {
    if ((e.pointerType || 'mouse') !== 'mouse') return;
    if (this.selectPointerId == null || this.selectPointerId !== e.pointerId) return;
    e.stopPropagation();
    e.preventDefault();
    this.selectPointerId = null;

    try {
      document.removeEventListener('pointermove', this.onNativePointerMoveCapture, true);
      document.removeEventListener('pointerup', this.onNativePointerUpCapture, true);
      document.removeEventListener('pointercancel', this.onNativePointerCancelCapture, true);
    } catch {
      // ignore
    }

    try {
      (this.root as any).releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    this.selectLastClient = { x: e.clientX, y: e.clientY };
    if (this.selectRaf != null) {
      try {
        cancelAnimationFrame(this.selectRaf);
      } catch {
        // ignore
      }
      this.selectRaf = null;
    }
    this.updatePointerSelectionFromLastPoint();

    const range = this.selectRange;
    const text = range ? extractPlainTextFromRange(range) : '';
    if (range && text) {
      const selectionStartYPct = (() => {
        try {
          const rects = Array.from(range.getClientRects());
          const first = rects[0];
          if (!first) return null;
          const contentRect = this.textLayerEl.getBoundingClientRect();
          const z = Math.max(0.01, this.lastZoom || 1);
          const localY = (first.top - contentRect.top) / z + first.height / z / 2;
          const worldH = contentRect.height / z;
          if (!Number.isFinite(localY) || !Number.isFinite(worldH) || worldH <= 0.001) return null;
          const yPct = clamp(localY / worldH, 0, 1);
          return Number.isFinite(yPct) ? yPct : null;
        } catch {
          return null;
        }
      })();
      const rect = (() => {
        try {
          const rects = Array.from(range.getClientRects());
          return (rects[rects.length - 1] ?? range.getBoundingClientRect()) || null;
        } catch {
          return null;
        }
      })();
      if (rect) {
        const pageNumber = this.visiblePageNumber;
        if (pageNumber != null && selectionStartYPct != null) {
          this.menuSelectionStart = { pageNumber, yPct: selectionStartYPct };
        } else {
          this.menuSelectionStart = null;
        }
        this.openMenu({ anchorRect: rect, text });
      } else {
        this.clearHighlights();
        this.closeMenu({ suppressCallback: true });
      }
    } else {
      this.clearHighlights();
      this.closeMenu({ suppressCallback: true });
    }

    this.selectAnchor = null;
    this.selectRange = null;
    this.selectLastClient = null;
  };

  private readonly onNativePointerCancelCapture = (e: PointerEvent) => {
    if (this.selectPointerId == null || this.selectPointerId !== e.pointerId) return;
    this.selectPointerId = null;
    try {
      document.removeEventListener('pointermove', this.onNativePointerMoveCapture, true);
      document.removeEventListener('pointerup', this.onNativePointerUpCapture, true);
      document.removeEventListener('pointercancel', this.onNativePointerCancelCapture, true);
    } catch {
      // ignore
    }
    try {
      (this.root as any).releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
    if (this.selectRaf != null) {
      try {
        cancelAnimationFrame(this.selectRaf);
      } catch {
        // ignore
      }
      this.selectRaf = null;
    }
    this.selectAnchor = null;
    this.selectRange = null;
    this.selectLastClient = null;
    this.clearHighlights();
    this.closeMenu({ suppressCallback: true });
  };

  constructor(opts: {
    host: HTMLElement;
    onRequestCloseSelection?: () => void;
    onTextLayerReady?: () => void;
    onRequestReplyToSelection?: (nodeId: string, selectionText: string) => void;
    onRequestAddToContext?: (nodeId: string, selectionText: string) => void;
    onRequestAnnotateTextSelection?: (
      nodeId: string,
      selectionText: string,
      anchor: PdfSelectionStartAnchor,
      client?: { x: number; y: number },
      trigger?: AnnotatePointerTrigger | null,
    ) => void;
    onRequestAnnotateInkSelection?: (
      nodeId: string,
      selectionText: string,
      anchor: PdfSelectionStartAnchor,
      client?: { x: number; y: number },
      trigger?: AnnotatePointerTrigger | null,
    ) => void;
  }) {
    this.host = opts.host;
    this.onRequestCloseSelection = opts.onRequestCloseSelection;
    this.onTextLayerReady = opts.onTextLayerReady;
    this.onRequestReplyToSelection = opts.onRequestReplyToSelection;
    this.onRequestAddToContext = opts.onRequestAddToContext;
    this.onRequestAnnotateTextSelection = opts.onRequestAnnotateTextSelection;
    this.onRequestAnnotateInkSelection = opts.onRequestAnnotateInkSelection;

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
    root.style.zIndex = '10';
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

    const replyBtn = document.createElement('button');
    replyBtn.className = 'gc-selectionMenu__btn';
    replyBtn.type = 'button';
    replyBtn.textContent = 'Reply to';
    replyBtn.addEventListener('click', () => {
      const nodeId = this.visibleNodeId;
      const text = (this.menuText ?? '').trim();
      if (!nodeId || !text) {
        this.closeMenu();
        return;
      }
      try {
        this.onRequestReplyToSelection?.(nodeId, text);
      } catch {
        // ignore
      }
      this.closeMenu();
    });
    this.menuReplyBtn = replyBtn;

    const addToContextBtn = document.createElement('button');
    addToContextBtn.className = 'gc-selectionMenu__btn';
    addToContextBtn.type = 'button';
    addToContextBtn.textContent = 'Add to context';
    addToContextBtn.addEventListener('click', () => {
      const nodeId = this.visibleNodeId;
      const text = (this.menuText ?? '').trim();
      if (!nodeId || !text) {
        this.closeMenu();
        return;
      }
      try {
        this.onRequestAddToContext?.(nodeId, text);
      } catch {
        // ignore
      }
      this.closeMenu();
    });
    this.menuAddToContextBtn = addToContextBtn;

    const annotateTextBtn = document.createElement('button');
    annotateTextBtn.className = 'gc-selectionMenu__btn';
    annotateTextBtn.type = 'button';
    annotateTextBtn.textContent = 'Annotate with text';
    const handleAnnotate = (
      kind: 'text' | 'ink',
      client: { x: number; y: number },
      trigger?: AnnotatePointerTrigger | null,
    ) => {
      const nodeId = this.visibleNodeId;
      const pageNumber = this.visiblePageNumber;
      const anchor = this.menuSelectionStart;
      const text = (this.menuText ?? '').trim();
      if (!nodeId || pageNumber == null || !anchor || anchor.pageNumber !== pageNumber || !text) {
        this.closeMenu();
        return;
      }
      const saved = { nodeId, text, anchor, client, trigger: trigger ?? null };
      this.closeMenu();
      try {
        if (kind === 'text')
          this.onRequestAnnotateTextSelection?.(saved.nodeId, saved.text, saved.anchor, saved.client, saved.trigger);
        else this.onRequestAnnotateInkSelection?.(saved.nodeId, saved.text, saved.anchor, saved.client, saved.trigger);
      } catch {
        // ignore
      }
    };
    annotateTextBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      const pointerType = (e.pointerType || 'mouse') as string;
      if (pointerType === 'mouse') return;
      this.suppressAnnotateClick = true;
      try {
        window.setTimeout(() => {
          this.suppressAnnotateClick = false;
        }, 800);
      } catch {
        // ignore
      }
      e.preventDefault();
      e.stopPropagation();
      handleAnnotate('text', { x: Number(e.clientX), y: Number(e.clientY) }, { pointerId: e.pointerId, pointerType });
    });
    annotateTextBtn.addEventListener('click', (e) => {
      if (this.suppressAnnotateClick) {
        this.suppressAnnotateClick = false;
        return;
      }
      const ev = e as MouseEvent;
      handleAnnotate('text', { x: Number(ev.clientX), y: Number(ev.clientY) }, null);
    });
    this.menuAnnotateTextBtn = annotateTextBtn;

    const annotateInkBtn = document.createElement('button');
    annotateInkBtn.className = 'gc-selectionMenu__btn';
    annotateInkBtn.type = 'button';
    annotateInkBtn.textContent = 'Annotate with ink';
    annotateInkBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      const pointerType = (e.pointerType || 'mouse') as string;
      if (pointerType === 'mouse') return;
      this.suppressAnnotateClick = true;
      try {
        window.setTimeout(() => {
          this.suppressAnnotateClick = false;
        }, 800);
      } catch {
        // ignore
      }
      e.preventDefault();
      e.stopPropagation();
      handleAnnotate('ink', { x: Number(e.clientX), y: Number(e.clientY) }, { pointerId: e.pointerId, pointerType });
    });
    annotateInkBtn.addEventListener('click', (e) => {
      if (this.suppressAnnotateClick) {
        this.suppressAnnotateClick = false;
        return;
      }
      const ev = e as MouseEvent;
      handleAnnotate('ink', { x: Number(ev.clientX), y: Number(ev.clientY) }, null);
    });
    this.menuAnnotateInkBtn = annotateInkBtn;

    menu.appendChild(copyBtn);
    menu.appendChild(replyBtn);
    menu.appendChild(addToContextBtn);
    menu.appendChild(annotateTextBtn);
    menu.appendChild(annotateInkBtn);
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
      document.removeEventListener('pointermove', this.onNativePointerMoveCapture, true);
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

      try {
        this.textLayerEl.style.setProperty('--scale-factor', String(res.viewport.scale || 1));
      } catch {
        // ignore
      }

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
    this.selectPointerId = null;
    this.selectAnchor = null;
    this.selectRange = null;
    this.selectLastClient = null;
    if (this.selectRaf != null) {
      try {
        cancelAnimationFrame(this.selectRaf);
      } catch {
        // ignore
      }
      this.selectRaf = null;
    }
    try {
      document.removeEventListener('pointermove', this.onNativePointerMoveCapture, true);
      document.removeEventListener('pointerup', this.onNativePointerUpCapture, true);
      document.removeEventListener('pointercancel', this.onNativePointerCancelCapture, true);
    } catch {
      // ignore
    }
    this.renderToken += 1;
    this.clearTextLayer();
    this.clearHighlights();
    this.closeMenu({ suppressCallback: true });
    this.menuSelectionStart = null;
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

  openMenu(opts: { anchorRect: DOMRect; text: string; selectionStart?: PdfSelectionStartAnchor | null }): void {
    const t = (opts.text ?? '').trim();
    if (!t) {
      this.closeMenu();
      return;
    }
    this.menuText = t;
    if (opts.selectionStart !== undefined) this.menuSelectionStart = opts.selectionStart;

    const rect = opts.anchorRect;
    const estW = 250;
    const estH = 260;
    const margin = 8;
    let top = rect.top - estH - margin;
    if (top < margin) top = rect.bottom + margin;
    top = clamp(top, margin, window.innerHeight - estH - margin);

    let left = rect.left;
    left = clamp(left, margin, window.innerWidth - estW - margin);

    this.menu.style.display = 'flex';
    this.menu.style.left = `${Math.round(left)}px`;
    this.menu.style.top = `${Math.round(top)}px`;
    this.menu.style.width = `${estW}px`;
  }

  closeMenu(opts?: { suppressCallback?: boolean }): void {
    if (!this.isMenuOpen()) return;
    this.menu.style.display = 'none';
    this.menuText = null;
    this.menuSelectionStart = null;
    if (!opts?.suppressCallback) this.onRequestCloseSelection?.();
  }
}
