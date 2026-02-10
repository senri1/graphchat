import { hypot2 } from './math';
import type { Vec2 } from './types';
import type { Camera } from './Camera';

type PointerInfo = {
  id: number;
  type: string;
  startPos: Vec2;
  pos: Vec2;
  lastPos: Vec2;
};

type PinchState = {
  ids: [number, number];
  startDist: number;
  startZoom: number;
  worldAnchor: Vec2;
};

export type InputControllerEvents = {
  onChange?: () => void;
  onInteractingChange?: (isInteracting: boolean) => void;
  onTap?: (p: Vec2, info: { pointerType: string; pointerId: number; wheelInput: WheelInputResolved }) => void;
  onPointerDown?: (p: Vec2, info: { pointerType: string; pointerId: number }) => PointerCaptureMode | null;
  onPointerMove?: (p: Vec2, info: { pointerType: string; pointerId: number }) => void;
  onPointerUp?: (p: Vec2, info: { pointerType: string; pointerId: number; wasDrag: boolean }) => void;
  onPointerCancel?: (info: { pointerType: string; pointerId: number }) => void;
};

export type PointerCaptureMode = 'node' | 'draw' | 'text';
export type WheelInputPreference = 'auto' | 'mouse' | 'trackpad';
export type WheelInputResolved = 'mouse' | 'trackpad' | 'unknown';

function normalizeWheelInputPreference(value: unknown): WheelInputPreference {
  if (value === 'mouse') return 'mouse';
  if (value === 'trackpad') return 'trackpad';
  return 'auto';
}

function isPrimaryButton(ev: PointerEvent): boolean {
  if (ev.pointerType === 'mouse') return ev.button === 0;
  return true;
}

function getTouchPointerIds(pointers: Map<number, PointerInfo>): number[] {
  const ids: number[] = [];
  for (const [id, info] of pointers) {
    if (info.type === 'touch') ids.push(id);
  }
  return ids;
}

export class InputController {
  private readonly el: HTMLElement;
  private readonly camera: Camera;
  private readonly events: InputControllerEvents;
  private readonly enablePointerCapture: boolean;

  private pointers = new Map<number, PointerInfo>();
  private pinch: PinchState | null = null;
  private dragThresholdPx = 4;
  private dragBegan = new Set<number>();
  private capturedPointers = new Map<number, PointerCaptureMode>();
  private isInteracting = false;
  private wheelIdleTimeout: number | null = null;
  private wheelInputPreference: WheelInputPreference = 'auto';
  private lastAutoWheelInput: WheelInputResolved = 'unknown';

  constructor(
    el: HTMLElement,
    camera: Camera,
    events?: InputControllerEvents,
    opts?: { enablePointerCapture?: boolean; wheelInputPreference?: WheelInputPreference },
  ) {
    this.el = el;
    this.camera = camera;
    this.events = events ?? {};
    this.enablePointerCapture = opts?.enablePointerCapture !== false;
    this.wheelInputPreference = normalizeWheelInputPreference(opts?.wheelInputPreference);
  }

  setWheelInputPreference(next: WheelInputPreference): void {
    this.wheelInputPreference = normalizeWheelInputPreference(next);
  }

  adoptPointer(opts: {
    pointerId: number;
    pointerType: string;
    pos: Vec2;
    captureMode: PointerCaptureMode;
    forceDrag?: boolean;
  }): void {
    const pointerId = opts.pointerId;
    const pointerType = opts.pointerType || 'mouse';
    const pos = opts.pos;

    const cancelPointer = (id: number) => {
      const info = this.pointers.get(id) ?? null;
      const hadAny = this.pointers.has(id) || this.capturedPointers.has(id) || this.dragBegan.has(id);
      if (!hadAny) return;
      this.pointers.delete(id);
      this.dragBegan.delete(id);
      this.capturedPointers.delete(id);
      try {
        (this.el as any).releasePointerCapture?.(id);
      } catch { }
      this.events.onPointerCancel?.({ pointerType: info?.type ?? 'touch', pointerId: id });
    };

    if (pointerType !== 'touch') {
      // Pen/mouse pointers cannot be concurrently active; cancel any stale pointers of the same type.
      const stale = Array.from(this.pointers.entries()).filter(([, info]) => info.type === pointerType);
      for (const [id, info] of stale) {
        if (id === pointerId) continue;
        cancelPointer(id);
      }
    }

    cancelPointer(pointerId);

    const info: PointerInfo = { id: pointerId, type: pointerType, startPos: pos, pos, lastPos: pos };
    this.pointers.set(pointerId, info);
    this.capturedPointers.set(pointerId, opts.captureMode);
    this.dragBegan.delete(pointerId);
    if (opts.forceDrag || opts.captureMode === 'draw' || opts.captureMode === 'text') this.dragBegan.add(pointerId);

    try {
      (this.el as any).setPointerCapture?.(pointerId);
    } catch { }

    this.setInteracting(true);
    this.recomputePinchState();
  }

  start(): void {
    this.el.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    this.el.addEventListener('pointermove', this.onPointerMove, { passive: false });
    this.el.addEventListener('pointerup', this.onPointerUp, { passive: false });
    this.el.addEventListener('pointercancel', this.onPointerUp, { passive: false });
    this.el.addEventListener('wheel', this.onWheel, { passive: false });
    this.el.addEventListener('contextmenu', this.onContextMenu);
  }

  dispose(): void {
    this.setInteracting(false);
    this.clearWheelIdleTimer();
    this.pointers.clear();
    this.pinch = null;
    this.capturedPointers.clear();
    this.el.removeEventListener('pointerdown', this.onPointerDown as any);
    this.el.removeEventListener('pointermove', this.onPointerMove as any);
    this.el.removeEventListener('pointerup', this.onPointerUp as any);
    this.el.removeEventListener('pointercancel', this.onPointerUp as any);
    this.el.removeEventListener('wheel', this.onWheel as any);
    this.el.removeEventListener('contextmenu', this.onContextMenu as any);
  }

  private setInteracting(next: boolean): void {
    if (this.isInteracting === next) return;
    this.isInteracting = next;
    this.events.onInteractingChange?.(next);
  }

  private clearWheelIdleTimer(): void {
    if (this.wheelIdleTimeout == null) return;
    try {
      window.clearTimeout(this.wheelIdleTimeout);
    } catch { }
    this.wheelIdleTimeout = null;
  }

  private markWheelActivity(): void {
    this.setInteracting(true);
    this.clearWheelIdleTimer();
    this.wheelIdleTimeout = window.setTimeout(() => {
      this.wheelIdleTimeout = null;
      if (this.pointers.size === 0) this.setInteracting(false);
    }, 140);
  }

  private getLocalPos(ev: PointerEvent | WheelEvent): Vec2 {
    const rect = this.el.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private classifyWheelInput(ev: WheelEvent): WheelInputResolved {
    const absX = Math.abs(ev.deltaX);
    const absY = Math.abs(ev.deltaY);
    const dominant = Math.max(absX, absY);

    if (ev.ctrlKey) return 'trackpad';
    if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE || ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) return 'mouse';

    const fractional = !Number.isInteger(ev.deltaX) || !Number.isInteger(ev.deltaY);
    const hasHorizontal = absX > 0.01;
    const verySmall = dominant > 0 && dominant < 14;
    const stepped =
      dominant > 0 &&
      (Math.abs(dominant % 120) < 0.01 || Math.abs(dominant % 100) < 0.01 || Math.abs(dominant % 53) < 0.01);

    if (fractional || hasHorizontal || verySmall) return 'trackpad';
    if (stepped || dominant >= 60) return 'mouse';
    return 'unknown';
  }

  private resolveWheelInput(ev: WheelEvent): WheelInputResolved {
    if (this.wheelInputPreference === 'mouse') return 'mouse';
    if (this.wheelInputPreference === 'trackpad') return 'trackpad';

    const inferred = this.classifyWheelInput(ev);
    if (inferred !== 'unknown') {
      this.lastAutoWheelInput = inferred;
      return inferred;
    }
    return this.lastAutoWheelInput === 'unknown' ? 'trackpad' : this.lastAutoWheelInput;
  }

  private resolveTapWheelInput(pointerType: string): WheelInputResolved {
    const type = pointerType || 'mouse';
    if (type !== 'mouse') return 'unknown';
    if (this.wheelInputPreference === 'mouse') return 'mouse';
    if (this.wheelInputPreference === 'trackpad') return 'trackpad';
    return this.lastAutoWheelInput;
  }

  private normalizeWheelDeltaForZoom(delta: number, deltaMode: number): number {
    if (!Number.isFinite(delta)) return 0;
    if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 16;
    if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * 160;
    return delta;
  }

  private onContextMenu = (e: Event) => {
    e.preventDefault();
  };

  private onPointerDown = (ev: PointerEvent) => {
    if (!isPrimaryButton(ev)) return;

    const pos = this.getLocalPos(ev);
    const info: PointerInfo = {
      id: ev.pointerId,
      type: ev.pointerType || 'mouse',
      startPos: pos,
      pos,
      lastPos: pos,
    };
    this.pointers.set(ev.pointerId, info);
    this.dragBegan.delete(ev.pointerId);
    this.capturedPointers.delete(ev.pointerId);

    const mode = this.events.onPointerDown?.(pos, { pointerType: info.type, pointerId: ev.pointerId }) ?? null;
    if (mode) {
      this.capturedPointers.set(ev.pointerId, mode);
      if (mode === 'draw' || mode === 'text') this.dragBegan.add(ev.pointerId);
    }

    if (this.enablePointerCapture) {
      try {
        const target = ev.target instanceof Element ? (ev.target as any) : null;
        if (target?.setPointerCapture) target.setPointerCapture(ev.pointerId);
        else (this.el as any).setPointerCapture?.(ev.pointerId);
      } catch { }
    }

    this.setInteracting(true);
    this.recomputePinchState();
    ev.preventDefault();
  };

  private onPointerMove = (ev: PointerEvent) => {
    const info = this.pointers.get(ev.pointerId);
    if (!info) return;

    const pos = this.getLocalPos(ev);
    const dx = pos.x - info.lastPos.x;
    const dy = pos.y - info.lastPos.y;
    info.pos = pos;

    if (this.pinch) {
      this.updatePinch();
      const captureMode = this.capturedPointers.get(ev.pointerId) ?? null;
      if (captureMode && (dx || dy) && (captureMode === 'draw' || captureMode === 'text' || this.dragBegan.has(ev.pointerId))) {
        this.events.onPointerMove?.(pos, { pointerType: info.type, pointerId: ev.pointerId });
      }
    } else {
      const captureMode = this.capturedPointers.get(ev.pointerId) ?? null;

      if (captureMode) {
        if (captureMode !== 'draw' && captureMode !== 'text' && !this.dragBegan.has(ev.pointerId)) {
          const fromStart = hypot2(pos.x - info.startPos.x, pos.y - info.startPos.y);
          if (fromStart >= this.dragThresholdPx) this.dragBegan.add(ev.pointerId);
        }
        if ((dx || dy) && (captureMode === 'draw' || captureMode === 'text' || this.dragBegan.has(ev.pointerId))) {
          this.events.onPointerMove?.(pos, { pointerType: info.type, pointerId: ev.pointerId });
        }
      } else if (this.pointers.size === 1) {
        const hasDrag = this.dragBegan.has(ev.pointerId);
        if (!hasDrag) {
          const fromStart = hypot2(pos.x - info.startPos.x, pos.y - info.startPos.y);
          if (fromStart >= this.dragThresholdPx) this.dragBegan.add(ev.pointerId);
        }
        if (this.dragBegan.has(ev.pointerId) && (dx || dy)) {
          this.camera.panByScreen(dx, dy);
          this.events.onChange?.();
        }
      }
    }

    info.lastPos = pos;
    ev.preventDefault();
  };

  private onPointerUp = (ev: PointerEvent) => {
    const info = this.pointers.get(ev.pointerId);
    const had = this.pointers.delete(ev.pointerId);
    if (!had) return;

    const wasPinching = this.pinch != null;
    const didDrag = this.dragBegan.has(ev.pointerId);
    this.dragBegan.delete(ev.pointerId);

    const captureMode = this.capturedPointers.get(ev.pointerId) ?? null;
    if (captureMode && info) {
      const pos = this.getLocalPos(ev);
      this.events.onPointerUp?.(pos, { pointerType: info.type, pointerId: ev.pointerId, wasDrag: didDrag });
    }
    this.capturedPointers.delete(ev.pointerId);

    if (this.enablePointerCapture) {
      try {
        const target = ev.target instanceof Element ? (ev.target as any) : null;
        if (target?.releasePointerCapture) target.releasePointerCapture(ev.pointerId);
        else (this.el as any).releasePointerCapture?.(ev.pointerId);
      } catch { }
    }

    this.recomputePinchState();

    if (!wasPinching && !this.pinch && !didDrag && info) {
      const pos = this.getLocalPos(ev);
      this.events.onTap?.(pos, {
        pointerType: info.type,
        pointerId: ev.pointerId,
        wheelInput: this.resolveTapWheelInput(info.type),
      });
    }

    if (this.pointers.size === 0) {
      this.setInteracting(false);
      this.clearWheelIdleTimer();
    }

    ev.preventDefault();
  };

  private recomputePinchState(): void {
    const touchIds = getTouchPointerIds(this.pointers);
    const isPinching = touchIds.length >= 2;
    if (!isPinching) {
      this.pinch = null;
      return;
    }

    const ids = (() => {
      const pinch = this.pinch;
      if (pinch) {
        const a = this.pointers.get(pinch.ids[0]);
        const b = this.pointers.get(pinch.ids[1]);
        if (a?.type === 'touch' && b?.type === 'touch') return pinch.ids;
      }
      return [touchIds[0]!, touchIds[1]!] as [number, number];
    })();
    const a = this.pointers.get(ids[0])!;
    const b = this.pointers.get(ids[1])!;
    const center: Vec2 = { x: (a.pos.x + b.pos.x) * 0.5, y: (a.pos.y + b.pos.y) * 0.5 };
    const dx = a.pos.x - b.pos.x;
    const dy = a.pos.y - b.pos.y;
    const dist = hypot2(dx, dy);

    this.pinch = {
      ids,
      startDist: Math.max(1, dist),
      startZoom: this.camera.zoom,
      worldAnchor: this.camera.screenToWorld(center),
    };
  }

  private updatePinch(): void {
    const pinch = this.pinch;
    if (!pinch) return;

    const a = this.pointers.get(pinch.ids[0]);
    const b = this.pointers.get(pinch.ids[1]);
    if (!a || !b) {
      this.pinch = null;
      return;
    }

    const center: Vec2 = { x: (a.pos.x + b.pos.x) * 0.5, y: (a.pos.y + b.pos.y) * 0.5 };
    const dx = a.pos.x - b.pos.x;
    const dy = a.pos.y - b.pos.y;
    const dist = hypot2(dx, dy);
    const factor = dist / pinch.startDist;
    const nextZoom = pinch.startZoom * (Number.isFinite(factor) ? factor : 1);

    this.camera.setZoomKeepingWorldPoint(nextZoom, pinch.worldAnchor, center);
    this.events.onChange?.();
  }

  private onWheel = (ev: WheelEvent) => {
    this.markWheelActivity();

    const pos = this.getLocalPos(ev);
    const wheelInput = this.resolveWheelInput(ev);

    if (wheelInput === 'mouse') {
      const primaryDelta = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
      const delta = this.normalizeWheelDeltaForZoom(primaryDelta, ev.deltaMode);
      const base = 1.0016;
      const factor = base ** (-delta);
      const nextZoom = this.camera.zoom * (Number.isFinite(factor) ? factor : 1);
      this.camera.setZoomAtScreen(nextZoom, pos);
      this.events.onChange?.();
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey) {
      const base = 1.0016;
      const factor = base ** (-ev.deltaY);
      const nextZoom = this.camera.zoom * (Number.isFinite(factor) ? factor : 1);
      this.camera.setZoomAtScreen(nextZoom, pos);
      this.events.onChange?.();
      ev.preventDefault();
      return;
    }

    const panX = ev.deltaX;
    const panY = ev.deltaY;
    if (panX || panY) {
      this.camera.panByScreen(panX, panY);
      this.events.onChange?.();
    }
    ev.preventDefault();
  };
}
