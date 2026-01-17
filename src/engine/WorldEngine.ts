import { chooseNiceStep, clamp } from './math';
import { Camera } from './Camera';
import { InputController } from './InputController';
import type { Rect, Vec2 } from './types';

export type WorldEngineDebug = {
  cssW: number;
  cssH: number;
  dpr: number;
  cameraX: number;
  cameraY: number;
  zoom: number;
  interacting: boolean;
};

type DemoNodeBase = {
  id: string;
  title: string;
};

type TextNode = DemoNodeBase & {
  kind: 'text';
  rect: Rect;
  content: string;
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
        this.emitDebug({ force: true });
      },
      onPointerDown: (p, info) => this.handlePointerDown(p, info),
      onPointerMove: (p, info) => this.handlePointerMove(p, info),
      onPointerUp: (p, info) => this.handlePointerUp(p, info),
      onPointerCancel: (info) => this.handlePointerCancel(info),
      onTap: (p, info) => this.handleTap(p, info),
    });
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
      if (node.kind === 'text') {
        const line = node.content.split('\n')[0] ?? '';
        const preview = line.replace(/^#+\s*/, '').slice(0, 46);
        ctx.fillText(preview ? preview : `id: ${node.id}`, x + 14, y + 34);
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

    this.drawScreenHud();
    this.emitDebug();
  }
}
