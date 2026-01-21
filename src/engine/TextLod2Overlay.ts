import type { Rect } from './types';
import { normalizeMathDelimitersFromCopyTex } from '../markdown/mathDelimiters';

export type TextLod2Mode = 'resize' | 'select';

export type HighlightRect = { left: number; top: number; width: number; height: number };

export type TextLod2Action =
  | { kind: 'summary_toggle'; nodeId: string }
  | { kind: 'summary_chunk_toggle'; nodeId: string; summaryIndex: number };

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

function extractTextFromRange(baseRange: Range): string {
  try {
    const range = baseRange.cloneRange();
    const closestKatex = (node: Node | null): Element | null => {
      if (!node) return null;
      const el =
        node.nodeType === Node.ELEMENT_NODE ? (node as Element) : ((node as any).parentElement as Element | null);
      return el ? el.closest('.katex') : null;
    };
    const startKatex = closestKatex(range.startContainer);
    if (startKatex) range.setStartBefore(startKatex);
    const endKatex = closestKatex(range.endContainer);
    if (endKatex) range.setEndAfter(endKatex);

    const frag = range.cloneContents();
    const katexEls = Array.from(frag.querySelectorAll('.katex'));
    for (const k of katexEls) {
      const ann = k.querySelector('annotation[encoding="application/x-tex"]') as HTMLElement | null;
      const tex = (ann?.textContent ?? '').trim();
      if (!tex) continue;
      const isDisplay = Boolean(k.closest('.katex-display'));
      const open = isDisplay ? '$$' : '$';
      const close = isDisplay ? '$$' : '$';
      k.replaceWith(document.createTextNode(`${open}${tex}${close}`));
    }

    // Use `innerText` to preserve reasonable newlines for block elements / <br>.
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
    return normalizeMathDelimitersFromCopyTex(raw).trim();
  } catch {
    try {
      return baseRange.toString().trim();
    } catch {
      return '';
    }
  }
}

export class TextLod2Overlay {
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly scaled: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly highlights: HTMLDivElement;
  private readonly highlightEls: HTMLDivElement[] = [];

  private readonly menu: HTMLDivElement;
  private readonly menuCopyBtn: HTMLButtonElement;
  private readonly menuCloseBtn: HTMLButtonElement;

  private visibleNodeId: string | null = null;
  private mode: TextLod2Mode | null = null;
  private contentHash: string | null = null;
  private lastZoom = 1;
  private menuText: string | null = null;
  private interactive = false;

  private nativePointerId: number | null = null;

  onRequestCloseSelection?: () => void;
  onRequestAction?: (action: TextLod2Action) => void;

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
    // Prevent world interactions (camera pan / node drag) while allowing native DOM selection.
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

  private readonly onRootClick = (e: MouseEvent) => {
    const nodeId = this.visibleNodeId;
    if (!nodeId) return;
    const target = e.target as Element | null;
    if (!target) return;

    const chunk = target.closest?.('[data-gcv1-summary-chunk-toggle]') as HTMLElement | null;
    if (chunk) {
      const raw = chunk.getAttribute('data-gcv1-summary-chunk-toggle') ?? '';
      const summaryIndex = Number(raw);
      if (!Number.isFinite(summaryIndex)) return;
      e.preventDefault();
      e.stopPropagation();
      this.onRequestAction?.({ kind: 'summary_chunk_toggle', nodeId, summaryIndex });
      return;
    }

    const sum = target.closest?.('[data-gcv1-summary-toggle]') as HTMLElement | null;
    if (sum) {
      e.preventDefault();
      e.stopPropagation();
      this.onRequestAction?.({ kind: 'summary_toggle', nodeId });
    }
  };

  private finishNativeSelection = () => {
    // Defer selection read until after the browser updates it for this pointer-up.
    requestAnimationFrame(() => {
      const sel = window.getSelection?.() ?? null;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

      const anchor = sel.anchorNode;
      const focus = sel.focusNode;
      if (!anchor || !focus) return;
      if (!this.content.contains(anchor) || !this.content.contains(focus)) return;

      const range = (() => {
        try {
          return sel.getRangeAt(0).cloneRange();
        } catch {
          return null;
        }
      })();
      if (!range) return;

      const text = extractTextFromRange(range);
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

  constructor(opts: {
    host: HTMLElement;
    onRequestCloseSelection?: () => void;
    onRequestAction?: (action: TextLod2Action) => void;
    zIndex?: number;
  }) {
    this.host = opts.host;
    this.onRequestCloseSelection = opts.onRequestCloseSelection;
    this.onRequestAction = opts.onRequestAction;

    const root = document.createElement('div');
    root.className = 'gc-textLod2';
    root.style.display = 'none';
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '1px';
    root.style.height = '1px';
    root.style.overflow = 'hidden';
    root.style.pointerEvents = 'none';
    root.style.zIndex = `${Math.max(0, Math.floor(opts.zIndex ?? 10))}`;
    root.style.contain = 'layout paint style';
    this.root = root;

    const scaled = document.createElement('div');
    scaled.className = 'gc-textLod2__scaled';
    scaled.style.position = 'absolute';
    scaled.style.left = '0';
    scaled.style.top = '0';
    scaled.style.transformOrigin = '0 0';
    scaled.style.willChange = 'transform';
    this.scaled = scaled;

    const content = document.createElement('div');
    content.className = 'gc-textLod2__content mdx';
    content.style.position = 'absolute';
    content.style.left = '0';
    content.style.top = '0';
    content.style.right = '0';
    content.style.bottom = '0';
    content.style.overflow = 'hidden';
    content.style.padding = '0';
    content.style.margin = '0';
    content.style.color = 'rgba(255,255,255,0.92)';
    content.style.fontSize = '14px';
    content.style.lineHeight = '1.55';
    content.style.wordBreak = 'break-word';
    content.style.fontFamily =
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
    this.content = content;

    const highlights = document.createElement('div');
    highlights.className = 'gc-textLod2__highlights';
    highlights.style.position = 'absolute';
    highlights.style.left = '0';
    highlights.style.top = '0';
    highlights.style.right = '0';
    highlights.style.bottom = '0';
    highlights.style.pointerEvents = 'none';
    this.highlights = highlights;

    scaled.appendChild(content);
    scaled.appendChild(highlights);
    root.appendChild(scaled);
    this.host.appendChild(root);

    root.addEventListener('pointerdown', this.onRootPointerDown);
    root.addEventListener('click', this.onRootClick);

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

  getNodeId(): string | null {
    return this.visibleNodeId;
  }

  getMode(): TextLod2Mode | null {
    return this.mode;
  }

  getContentElement(): HTMLDivElement {
    return this.content;
  }

  isMenuOpen(): boolean {
    return this.menu.style.display !== 'none';
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

  show(opts: {
    nodeId: string;
    mode: TextLod2Mode;
    interactive?: boolean;
    screenRect: Rect;
    worldW: number;
    worldH: number;
    zoom: number;
    contentHash: string;
    html: string;
  }): void {
    this.visibleNodeId = opts.nodeId;
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

    if (this.contentHash !== opts.contentHash) {
      this.contentHash = opts.contentHash;
      this.content.innerHTML = opts.html;
    }

    if (this.interactive) {
      this.content.style.userSelect = 'text';
      (this.content.style as any).webkitUserSelect = 'text';
      this.content.style.cursor = 'text';
    } else {
      this.content.style.userSelect = 'none';
      (this.content.style as any).webkitUserSelect = 'none';
      this.content.style.cursor = 'default';
    }

    if (opts.mode === 'resize') {
      this.clearHighlights();
      this.closeMenu({ suppressCallback: true });
    }
  }

  hide(): void {
    this.visibleNodeId = null;
    this.mode = null;
    this.contentHash = null;
    this.interactive = false;
    this.nativePointerId = null;
    try {
      document.removeEventListener('pointerup', this.onNativePointerUpCapture, true);
      document.removeEventListener('pointercancel', this.onNativePointerCancelCapture, true);
    } catch {
      // ignore
    }
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
      el.className = 'gc-textLod2__highlightRect';
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

    // Ensure buttons are readable even if global styles change.
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

  getZoom(): number {
    return this.lastZoom;
  }
}
