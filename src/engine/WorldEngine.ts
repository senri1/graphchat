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

type DemoNode = {
  id: string;
  rect: Rect;
  title: string;
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

  private readonly demoNodes: DemoNode[] = [
    { id: 'n1', rect: { x: 80, y: 80, w: 320, h: 180 }, title: 'Text node (raster LOD)' },
    { id: 'n2', rect: { x: 460, y: 140, w: 360, h: 220 }, title: 'PDF node (page bitmaps)' },
    { id: 'n3', rect: { x: 240, y: 340, w: 300, h: 200 }, title: 'Ink node (vector → bitmap)' },
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
    });
  }

  start(): void {
    this.input.start();
    this.requestRender();
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
    for (const node of this.demoNodes) {
      const { x, y, w, h } = node.rect;
      const r = 18;

      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
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
      ctx.fillText(`id: ${node.id}`, x + 14, y + 34);
    }
  }

  private drawScreenHud(): void {
    const ctx = this.ctx;
    this.applyScreenTransform();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.textBaseline = 'bottom';
    ctx.fillText(
      `pan/zoom: drag, pinch; trackpad pinch: ctrl+wheel`,
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
