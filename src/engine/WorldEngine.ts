import { chooseNiceStep, clamp } from './math';
import { Camera } from './Camera';
import { InputController } from './InputController';
import { rectsIntersect, type Rect, type Vec2 } from './types';
import { rasterizeMarkdownMathToImage } from './raster/textRaster';

export type WorldEngineDebug = {
  cssW: number;
  cssH: number;
  dpr: number;
  cameraX: number;
  cameraY: number;
  zoom: number;
  interacting: boolean;
};

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fingerprintText(input: string): string {
  const s = input ?? '';
  return `${s.length.toString(36)}.${fnv1a32(s).toString(36)}`;
}

type DemoNodeBase = {
  id: string;
  title: string;
};

type TextNode = DemoNodeBase & {
  kind: 'text';
  rect: Rect;
  content: string;
  contentHash: string;
};

type PlaceholderNode = DemoNodeBase & {
  kind: 'pdf' | 'ink';
  rect: Rect;
};

type WorldNode = TextNode | PlaceholderNode;

export type WorldEngineUiState = {
  selectedNodeId: string | null;
  editingNodeId: string | null;
  editingText: string;
};

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

type ActiveNodeGesture =
  | {
      kind: 'drag';
      pointerId: number;
      nodeId: string;
      startWorld: Vec2;
      startRect: Rect;
    }
  | {
      kind: 'resize';
      pointerId: number;
      nodeId: string;
      corner: ResizeCorner;
      startWorld: Vec2;
      startRect: Rect;
    };

export class WorldEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  readonly camera = new Camera({ minZoom: 0.05, maxZoom: 6 });
  private readonly input: InputController;

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;

  private raf: number | null = null;
  private interacting = false;

  private lastDebugEmitAt = 0;
  onDebug?: (state: WorldEngineDebug) => void;

  onUiState?: (state: WorldEngineUiState) => void;

  private selectedNodeId: string | null = 'n1';
  private editingNodeId: string | null = 'n1';
  private activeGesture: ActiveNodeGesture | null = null;
  private suppressTapPointerIds = new Set<number>();

  private readonly resizeHandleDrawPx = 12;
  private readonly resizeHandleHitPx = 22;
  private readonly minNodeW = 160;
  private readonly minNodeH = 110;

  private readonly textRasterQueue: Array<{
    key: string;
    sig: string;
    rasterScale: number;
    width: number;
    height: number;
    source: string;
  }> = [];
  private textRasterQueuedKeys = new Set<string>();
  private textRasterRunning = false;
  private textRasterGeneration = 0;

  private readonly textRasterCache = new Map<
    string,
    {
      key: string;
      sig: string;
      rasterScale: number;
      width: number;
      height: number;
      image: CanvasImageSource;
      bitmapBytesEstimate: number;
      readyAt: number;
    }
  >();
  private textRasterCacheBytes = 0;
  private readonly bestTextRasterKeyBySig = new Map<string, { key: string; rasterScale: number }>();
  private readonly textRasterCacheMaxEntries = 2500;
  private readonly textRasterCacheMaxBytes = 256 * 1024 * 1024;

  private readonly nodes: WorldNode[] = [
    {
      kind: 'text',
      id: 'n1',
      rect: { x: 80, y: 80, w: 420, h: 260 },
      title: 'Text node (Markdown + LaTeX)',
      content:
        '# Markdown + LaTeX\n\n' +
        'Inline: \\(e^{i\\pi} + 1 = 0\\)\n\n' +
        'Display:\n\n' +
        '\\[\n' +
        '\\int_0^1 x^2\\,dx = \\frac{1}{3}\n' +
        '\\]\n\n' +
        '- list item\n' +
        '- emoji: :rocket:\n',
      contentHash: '',
    },
    {
      kind: 'pdf',
      id: 'n2',
      rect: { x: 540, y: 140, w: 360, h: 220 },
      title: 'PDF node (page bitmaps)',
    },
    {
      kind: 'ink',
      id: 'n3',
      rect: { x: 240, y: 390, w: 360, h: 240 },
      title: 'Ink node (vector → bitmap)',
    },
  ];

  private nodeSeq = 1;

  constructor(opts: { canvas: HTMLCanvasElement }) {
    this.canvas = opts.canvas;
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Missing 2D canvas context');
    this.ctx = ctx;

    this.input = new InputController(this.canvas, this.camera, {
      onChange: () => this.requestRender(),
      onInteractingChange: (v) => {
        this.interacting = v;
        this.requestRender();
        if (!v) this.kickTextRasterQueue();
        this.emitDebug({ force: true });
      },
      onPointerDown: (p, info) => this.handlePointerDown(p, info),
      onPointerMove: (p, info) => this.handlePointerMove(p, info),
      onPointerUp: (p, info) => this.handlePointerUp(p, info),
      onPointerCancel: (info) => this.handlePointerCancel(info),
      onTap: (p, info) => this.handleTap(p, info),
    });

    // Initialize hashes for seeded nodes.
    for (const n of this.nodes) {
      if (n.kind === 'text') n.contentHash = fingerprintText(n.content);
    }
  }

  spawnLatexStressTest(count: number): void {
    const n = Math.max(0, Math.min(5000, Math.floor(count)));
    if (n === 0) return;

    const center = this.camera.screenToWorld({ x: this.cssW * 0.5, y: this.cssH * 0.5 });
    const cols = Math.max(1, Math.min(30, Math.ceil(Math.sqrt(n))));
    const spacingX = 460;
    const spacingY = 320;
    const startX = center.x - (cols - 1) * 0.5 * spacingX;
    const startY = center.y - Math.ceil(n / cols) * 0.5 * spacingY;

    const heavy = (i: number) =>
      `# Test node ${i + 1}\n\n` +
      `Inline: \\(e^{i\\pi}+1=0\\), \\(\\sum_{k=1}^n k = \\frac{n(n+1)}{2}\\)\n\n` +
      `\\[\n` +
      `\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0},\\qquad\n` +
      `\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}\n` +
      `\\]\n\n` +
      `\\[\n` +
      `\\int_0^1 x^2\\,dx = \\frac{1}{3},\\qquad\n` +
      `\\prod_{j=1}^{m} (1 + x_j)\\n` +
      `\\]\n\n` +
      `- emoji: :rocket:\n` +
      `- code: \`const x = 1;\`\n`;

    for (let i = 0; i < n; i++) {
      const id = `t${Date.now().toString(36)}-${(this.nodeSeq++).toString(36)}`;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const content = heavy(i);
      const node: TextNode = {
        kind: 'text',
        id,
        rect: { x: startX + col * spacingX, y: startY + row * spacingY, w: 420, h: 260 },
        title: 'Text node (Markdown + LaTeX)',
        content,
        contentHash: fingerprintText(content),
      };
      this.nodes.push(node);
    }

    // Close editor so the canvas is the thing being tested.
    this.selectedNodeId = null;
    this.editingNodeId = null;
    this.textRasterGeneration += 1;

    this.requestRender();
    this.emitUiState();
  }

  clearStressNodes(): void {
    const keepIds = new Set(['n1', 'n2', 'n3']);
    const before = this.nodes.length;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i]!;
      if (keepIds.has(node.id)) continue;
      this.nodes.splice(i, 1);
    }
    if (this.nodes.length === before) return;
    this.selectedNodeId = 'n1';
    this.editingNodeId = 'n1';
    this.requestRender();
    this.emitUiState();
  }

  private closeImage(image: CanvasImageSource | null | undefined): void {
    try {
      (image as any)?.close?.();
    } catch {
      // ignore
    }
  }

  private evictOldTextRasters(): void {
    while (
      this.textRasterCache.size > this.textRasterCacheMaxEntries ||
      this.textRasterCacheBytes > this.textRasterCacheMaxBytes
    ) {
      const oldestKey = this.textRasterCache.keys().next().value as string | undefined;
      if (!oldestKey) return;
      const entry = this.textRasterCache.get(oldestKey);
      if (entry) {
        this.textRasterCacheBytes -= entry.bitmapBytesEstimate || 0;
        this.closeImage(entry.image);
      }
      this.textRasterCache.delete(oldestKey);
    }
  }

  private touchTextRaster(key: string): void {
    const entry = this.textRasterCache.get(key);
    if (!entry) return;
    this.textRasterCache.delete(key);
    this.textRasterCache.set(key, entry);
  }

  private enqueueTextRaster(job: {
    key: string;
    sig: string;
    rasterScale: number;
    width: number;
    height: number;
    source: string;
  }): void {
    if (!job.key) return;
    if (this.textRasterCache.has(job.key)) return;
    if (this.textRasterQueuedKeys.has(job.key)) return;
    this.textRasterQueuedKeys.add(job.key);
    this.textRasterQueue.push(job);
  }

  private kickTextRasterQueue(): void {
    if (this.textRasterRunning) return;
    if (this.interacting) return;
    if (this.textRasterQueue.length === 0) return;
    void this.runTextRasterQueue();
  }

  private async runTextRasterQueue(): Promise<void> {
    if (this.textRasterRunning) return;
    this.textRasterRunning = true;
    const gen = this.textRasterGeneration;

    try {
      while (this.textRasterQueue.length > 0) {
        if (this.interacting) return;
        if (this.textRasterGeneration !== gen) return;

        const job = this.textRasterQueue.shift();
        if (!job) return;
        this.textRasterQueuedKeys.delete(job.key);

        if (this.textRasterCache.has(job.key)) continue;

        try {
          const res = await rasterizeMarkdownMathToImage(job.source, {
            width: job.width,
            height: job.height,
            rasterScale: job.rasterScale,
          });
          if (this.textRasterGeneration !== gen) {
            this.closeImage(res.image);
            return;
          }

          const readyAt = performance.now();
          this.textRasterCache.set(job.key, {
            key: job.key,
            sig: job.sig,
            rasterScale: job.rasterScale,
            width: job.width,
            height: job.height,
            image: res.image,
            bitmapBytesEstimate: res.bitmapBytesEstimate,
            readyAt,
          });
          this.textRasterCacheBytes += res.bitmapBytesEstimate || 0;

          const prevBest = this.bestTextRasterKeyBySig.get(job.sig);
          if (!prevBest || job.rasterScale >= prevBest.rasterScale) {
            this.bestTextRasterKeyBySig.set(job.sig, { key: job.key, rasterScale: job.rasterScale });
          }

          this.evictOldTextRasters();
          this.requestRender();
        } catch {
          // ignore; leave missing (LOD0 will display)
        }

        // Yield between jobs to keep the UI responsive.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    } finally {
      this.textRasterRunning = false;
      if (!this.interacting && this.textRasterQueue.length > 0) {
        // If work remains, schedule another burst.
        this.kickTextRasterQueue();
      }
    }
  }

  start(): void {
    this.input.start();
    this.requestRender();
    this.emitUiState();
  }

  dispose(): void {
    this.input.dispose();
    if (this.raf != null) {
      try {
        cancelAnimationFrame(this.raf);
      } catch { }
      this.raf = null;
    }
  }

  resize(cssW: number, cssH: number, dpr?: number): void {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    const nextDpr = clamp(dpr ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1), 1, 3);

    const changed = w !== this.cssW || h !== this.cssH || nextDpr !== this.dpr;
    this.cssW = w;
    this.cssH = h;
    this.dpr = nextDpr;

    const pxW = Math.max(1, Math.round(w * nextDpr));
    const pxH = Math.max(1, Math.round(h * nextDpr));
    if (this.canvas.width !== pxW) this.canvas.width = pxW;
    if (this.canvas.height !== pxH) this.canvas.height = pxH;

    if (changed) {
      this.requestRender();
      this.emitDebug({ force: true });
    }
  }

  getUiState(): WorldEngineUiState {
    const editingText =
      this.editingNodeId && this.nodes.find((n) => n.id === this.editingNodeId && n.kind === 'text')
        ? (this.nodes.find((n) => n.id === this.editingNodeId && n.kind === 'text') as TextNode).content
        : '';
    return {
      selectedNodeId: this.selectedNodeId,
      editingNodeId: this.editingNodeId,
      editingText,
    };
  }

  setEditingText(next: string): void {
    const nodeId = this.editingNodeId;
    if (!nodeId) return;
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== 'text') return;
    const text = typeof next === 'string' ? next : String(next ?? '');
    if (node.content === text) return;
    node.content = text;
    node.contentHash = fingerprintText(text);
    this.textRasterGeneration += 1;
    this.requestRender();
    this.emitUiState();
  }

  clearSelection(): void {
    const changed = this.selectedNodeId != null || this.editingNodeId != null;
    this.selectedNodeId = null;
    this.editingNodeId = null;
    if (changed) {
      this.requestRender();
      this.emitUiState();
    }
  }

  private emitUiState(): void {
    this.onUiState?.(this.getUiState());
  }

  private textContentRect(nodeRect: Rect): Rect {
    const PAD = 14;
    const HEADER_H = 50;
    const x = nodeRect.x + PAD;
    const y = nodeRect.y + HEADER_H;
    const w = Math.max(1, nodeRect.w - PAD * 2);
    const h = Math.max(1, nodeRect.h - HEADER_H - PAD);
    return { x, y, w, h };
  }

  private chooseTextRasterScale(): number {
    const ideal = (this.camera.zoom || 1) * (this.dpr || 1);
    const cap = this.interacting ? 1 : 2;
    const target = Math.max(0.5, Math.min(cap, ideal));
    if (target < 0.75) return 0.5;
    if (target < 1.5) return 1;
    return 2;
  }

  private getBestTextRaster(sig: string): { key: string; image: CanvasImageSource } | null {
    const best = this.bestTextRasterKeyBySig.get(sig);
    if (!best) return null;
    const entry = this.textRasterCache.get(best.key);
    if (!entry) {
      this.bestTextRasterKeyBySig.delete(sig);
      return null;
    }
    this.touchTextRaster(best.key);
    return { key: best.key, image: entry.image };
  }

  private updateTextRastersForViewport(): void {
    const view = this.worldViewportRect({ overscan: 320 });
    const desiredScale = this.chooseTextRasterScale();

    for (const n of this.nodes) {
      if (n.kind !== 'text') continue;
      if (n.id === this.editingNodeId) continue;
      if (!rectsIntersect(n.rect, view)) continue;

      const contentRect = this.textContentRect(n.rect);
      const sig = `${n.contentHash}|${Math.round(contentRect.w)}x${Math.round(contentRect.h)}`;
      const best = this.bestTextRasterKeyBySig.get(sig);
      const hasBest = !!best && this.textRasterCache.has(best.key);
      if (hasBest && best!.rasterScale >= desiredScale) continue;

      const key = `${sig}|s${desiredScale}`;
      if (this.textRasterCache.has(key)) {
        this.bestTextRasterKeyBySig.set(sig, { key, rasterScale: desiredScale });
        continue;
      }

      this.enqueueTextRaster({
        key,
        sig,
        rasterScale: desiredScale,
        width: contentRect.w,
        height: contentRect.h,
        source: n.content,
      });
    }

    this.kickTextRasterQueue();
  }

  private worldViewportRect(opts?: { overscan?: number }): Rect {
    const over = Math.max(0, Math.round(opts?.overscan ?? 0));
    const a = this.camera.screenToWorld({ x: -over, y: -over });
    const b = this.camera.screenToWorld({ x: this.cssW + over, y: this.cssH + over });
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  private bringNodeToFront(nodeId: string): void {
    const idx = this.nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0 || idx === this.nodes.length - 1) return;
    const [node] = this.nodes.splice(idx, 1);
    if (node) this.nodes.push(node);
  }

  private findTopmostNodeAtWorld(world: Vec2): WorldNode | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]!;
      const r = n.rect;
      if (world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h) {
        return n;
      }
    }
    return null;
  }

  private hitResizeHandle(world: Vec2, rect: Rect): ResizeCorner | null {
    const z = Math.max(0.01, this.camera.zoom || 1);
    const hw = this.resizeHandleHitPx / z;
    if (hw <= 0) return null;

    const { x, y, w, h } = rect;
    const hitNW = world.x >= x && world.x <= x + hw && world.y >= y && world.y <= y + hw;
    if (hitNW) return 'nw';

    const hitNE = world.x >= x + w - hw && world.x <= x + w && world.y >= y && world.y <= y + hw;
    if (hitNE) return 'ne';

    const hitSW = world.x >= x && world.x <= x + hw && world.y >= y + h - hw && world.y <= y + h;
    if (hitSW) return 'sw';

    const hitSE = world.x >= x + w - hw && world.x <= x + w && world.y >= y + h - hw && world.y <= y + h;
    if (hitSE) return 'se';

    return null;
  }

  private handlePointerDown(p: Vec2, info: { pointerType: string; pointerId: number }): boolean {
    // Only capture when starting a node drag/resize. Otherwise let InputController pan the camera.
    if (this.activeGesture) return false;
    const world = this.camera.screenToWorld(p);
    const hit = this.findTopmostNodeAtWorld(world);
    if (!hit) return false;

    const nextSelected = hit.id;
    const selectionChanged = nextSelected !== this.selectedNodeId;
    this.selectedNodeId = nextSelected;
    this.bringNodeToFront(hit.id);

    const corner = this.hitResizeHandle(world, hit.rect);
    const startRect: Rect = { ...hit.rect };
    if (corner) {
      this.activeGesture = {
        kind: 'resize',
        pointerId: info.pointerId,
        nodeId: hit.id,
        corner,
        startWorld: world,
        startRect,
      };
      this.suppressTapPointerIds.add(info.pointerId);
    } else {
      this.activeGesture = {
        kind: 'drag',
        pointerId: info.pointerId,
        nodeId: hit.id,
        startWorld: world,
        startRect,
      };
    }

    this.requestRender();
    if (selectionChanged) this.emitUiState();
    return true;
  }

  private handlePointerMove(p: Vec2, info: { pointerType: string; pointerId: number }): void {
    const g = this.activeGesture;
    if (!g || g.pointerId !== info.pointerId) return;

    const node = this.nodes.find((n) => n.id === g.nodeId);
    if (!node) return;

    const world = this.camera.screenToWorld(p);
    const dx = world.x - g.startWorld.x;
    const dy = world.y - g.startWorld.y;

    if (g.kind === 'drag') {
      node.rect = {
        x: g.startRect.x + dx,
        y: g.startRect.y + dy,
        w: g.startRect.w,
        h: g.startRect.h,
      };
      this.requestRender();
      return;
    }

    const right = g.startRect.x + g.startRect.w;
    const bottom = g.startRect.y + g.startRect.h;

    let next: Rect;
    switch (g.corner) {
      case 'nw': {
        next = {
          x: g.startRect.x + dx,
          y: g.startRect.y + dy,
          w: g.startRect.w - dx,
          h: g.startRect.h - dy,
        };
        if (next.w < this.minNodeW) {
          next.w = this.minNodeW;
          next.x = right - next.w;
        }
        if (next.h < this.minNodeH) {
          next.h = this.minNodeH;
          next.y = bottom - next.h;
        }
        break;
      }
      case 'ne': {
        next = {
          x: g.startRect.x,
          y: g.startRect.y + dy,
          w: g.startRect.w + dx,
          h: g.startRect.h - dy,
        };
        if (next.w < this.minNodeW) next.w = this.minNodeW;
        if (next.h < this.minNodeH) {
          next.h = this.minNodeH;
          next.y = bottom - next.h;
        }
        break;
      }
      case 'sw': {
        next = {
          x: g.startRect.x + dx,
          y: g.startRect.y,
          w: g.startRect.w - dx,
          h: g.startRect.h + dy,
        };
        if (next.w < this.minNodeW) {
          next.w = this.minNodeW;
          next.x = right - next.w;
        }
        if (next.h < this.minNodeH) next.h = this.minNodeH;
        break;
      }
      case 'se': {
        next = {
          x: g.startRect.x,
          y: g.startRect.y,
          w: g.startRect.w + dx,
          h: g.startRect.h + dy,
        };
        if (next.w < this.minNodeW) next.w = this.minNodeW;
        if (next.h < this.minNodeH) next.h = this.minNodeH;
        break;
      }
    }

    node.rect = next;
    this.requestRender();
  }

  private handlePointerUp(p: Vec2, info: { pointerType: string; pointerId: number; wasDrag: boolean }): void {
    const g = this.activeGesture;
    if (!g || g.pointerId !== info.pointerId) return;
    this.activeGesture = null;
    if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
    this.requestRender();
  }

  private handlePointerCancel(info: { pointerType: string; pointerId: number }): void {
    const g = this.activeGesture;
    if (g && g.pointerId === info.pointerId) this.activeGesture = null;
    this.suppressTapPointerIds.delete(info.pointerId);
    this.requestRender();
  }

  private handleTap(p: Vec2, info: { pointerType: string; pointerId: number }): void {
    if (this.suppressTapPointerIds.has(info.pointerId)) {
      this.suppressTapPointerIds.delete(info.pointerId);
      return;
    }
    const world = this.camera.screenToWorld(p);
    const hit = this.findTopmostNodeAtWorld(world);

    const nextSelected = hit ? hit.id : null;
    const nextEditing = hit && hit.kind === 'text' ? hit.id : null;
    const changed = nextSelected !== this.selectedNodeId || nextEditing !== this.editingNodeId;
    this.selectedNodeId = nextSelected;
    this.editingNodeId = nextEditing;
    if (hit) this.bringNodeToFront(hit.id);
    if (changed) {
      this.requestRender();
      this.emitUiState();
    }
  }

  requestRender(): void {
    if (this.raf != null) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.draw();
    });
  }

  private emitDebug(opts?: { force?: boolean }): void {
    const cb = this.onDebug;
    if (!cb) return;
    const now = performance.now();
    if (!opts?.force && now - this.lastDebugEmitAt < 90) return;
    this.lastDebugEmitAt = now;
    cb({
      cssW: this.cssW,
      cssH: this.cssH,
      dpr: this.dpr,
      cameraX: this.camera.x,
      cameraY: this.camera.y,
      zoom: this.camera.zoom,
      interacting: this.interacting,
    });
  }

  private applyWorldTransform(): void {
    const z = this.camera.zoom || 1;
    const s = this.dpr * z;
    const tx = -this.camera.x * z * this.dpr;
    const ty = -this.camera.y * z * this.dpr;
    this.ctx.setTransform(s, 0, 0, s, tx, ty);
  }

  private applyScreenTransform(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const topLeft = this.camera.screenToWorld({ x: 0, y: 0 });
    const botRight = this.camera.screenToWorld({ x: this.cssW, y: this.cssH });

    const targetStepWorld = 120 / (this.camera.zoom || 1);
    const step = chooseNiceStep(targetStepWorld);

    const x0 = Math.floor(topLeft.x / step) * step;
    const y0 = Math.floor(topLeft.y / step) * step;
    const x1 = Math.ceil(botRight.x / step) * step;
    const y1 = Math.ceil(botRight.y / step) * step;

    ctx.lineWidth = 1 / (this.camera.zoom || 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.beginPath();
    for (let x = x0; x <= x1; x += step) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = y0; y <= y1; y += step) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(0, y1);
    ctx.moveTo(x0, 0);
    ctx.lineTo(x1, 0);
    ctx.stroke();
  }

  private drawDemoNodes(): void {
    const ctx = this.ctx;
    for (const node of this.nodes) {
      const { x, y, w, h } = node.rect;
      const r = 18;

      const isSelected = node.id === this.selectedNodeId;
      ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.085)' : 'rgba(255,255,255,0.06)';
      ctx.strokeStyle = isSelected ? 'rgba(147,197,253,0.65)' : 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1.2 / (this.camera.zoom || 1);

      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.arcTo(x + w, y, x + w, y + r, r);
      ctx.lineTo(x + w, y + h - r);
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `${14 / (this.camera.zoom || 1)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
      ctx.textBaseline = 'top';
      ctx.fillText(node.title, x + 14, y + 12);

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `${12 / (this.camera.zoom || 1)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;

      // Header separator.
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1 / (this.camera.zoom || 1);
      ctx.beginPath();
      ctx.moveTo(x + 12, y + 48);
      ctx.lineTo(x + w - 12, y + 48);
      ctx.stroke();

      if (node.kind === 'text') {
        const contentRect = this.textContentRect(node.rect);
        const sig = `${node.contentHash}|${Math.round(contentRect.w)}x${Math.round(contentRect.h)}`;
        const raster = this.getBestTextRaster(sig);
        if (raster) {
          try {
            ctx.drawImage(raster.image, contentRect.x, contentRect.y, contentRect.w, contentRect.h);
          } catch {
            // ignore; fall back to placeholder
          }
        } else {
          const line = node.content.split('\n').find((s) => s.trim()) ?? '';
          const preview = line.replace(/^#+\s*/, '').slice(0, 120);
          ctx.fillText(preview ? preview : '…', x + 14, y + 34);
          ctx.fillStyle = 'rgba(255,255,255,0.45)';
          ctx.fillText('Rendering…', contentRect.x, contentRect.y);
        }
      } else {
        ctx.fillText(`id: ${node.id}`, x + 14, y + 34);
      }

      if (isSelected) {
        this.drawResizeHandles(node.rect);
      }
    }
  }

  private drawResizeHandles(rect: Rect): void {
    const ctx = this.ctx;
    const z = Math.max(0.01, this.camera.zoom || 1);
    const size = this.resizeHandleDrawPx / z;
    if (size <= 0) return;

    const pad = 2 / z;
    const x0 = rect.x + pad;
    const y0 = rect.y + pad;
    const x1 = rect.x + rect.w - size - pad;
    const y1 = rect.y + rect.h - size - pad;

    ctx.fillStyle = 'rgba(147,197,253,0.85)';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1 / z;

    const drawHandle = (x: number, y: number) => {
      ctx.beginPath();
      ctx.rect(x, y, size, size);
      ctx.fill();
      ctx.stroke();
    };

    drawHandle(x0, y0); // nw
    drawHandle(x1, y0); // ne
    drawHandle(x0, y1); // sw
    drawHandle(x1, y1); // se
  }

  private drawScreenHud(): void {
    const ctx = this.ctx;
    this.applyScreenTransform();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.textBaseline = 'bottom';
    ctx.fillText(
      `pan: drag background • move: drag node • resize: drag corners • zoom: pinch / ctrl+wheel`,
      10,
      this.cssH - 10,
    );
  }

  draw(): void {
    const ctx = this.ctx;
    this.applyScreenTransform();
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    this.applyWorldTransform();
    this.drawGrid();
    this.drawDemoNodes();

    this.updateTextRastersForViewport();
    this.drawScreenHud();
    this.emitDebug();
  }
}
