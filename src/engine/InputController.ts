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
  onTap?: (p: Vec2, info: { pointerType: string; pointerId: number }) => void;
  onPointerDown?: (p: Vec2, info: { pointerType: string; pointerId: number }) => PointerCaptureMode | null;
  onPointerMove?: (p: Vec2, info: { pointerType: string; pointerId: number }) => void;
  onPointerUp?: (p: Vec2, info: { pointerType: string; pointerId: number; wasDrag: boolean }) => void;
  onPointerCancel?: (info: { pointerType: string; pointerId: number }) => void;
};

export type PointerCaptureMode = 'node' | 'draw' | 'text';

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

  private pointers = new Map<number, PointerInfo>();
  private pinch: PinchState | null = null;
  private dragThresholdPx = 4;
  private dragBegan = new Set<number>();
  private capturedPointers = new Map<number, PointerCaptureMode>();
  private isInteracting = false;
  private wheelIdleTimeout: number | null = null;
  private globalInkDrawingEnabled = false;

  constructor(el: HTMLElement, camera: Camera, events?: InputControllerEvents) {
    this.el = el;
    this.camera = camera;
    this.events = events ?? {};
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

    if (pointerType !== 'touch') {
      // Pen/mouse pointers cannot be concurrently active; force-finish any stale pointers of the same type.
      const stale = Array.from(this.pointers.entries()).filter(([, info]) => info.type === pointerType);
      for (const [id, info] of stale) {
        if (id === pointerId) continue;
        this.finalizePointer(id, info.pos, { suppressTap: true });
      }
    }

    const existing = this.pointers.get(pointerId);
    if (existing) {
      this.finalizePointer(pointerId, existing.pos, { suppressTap: true });
    } else if (this.capturedPointers.has(pointerId) || this.dragBegan.has(pointerId)) {
      this.dragBegan.delete(pointerId);
      this.capturedPointers.delete(pointerId);
      this.updateGlobalInkDrawingEnabled();
      try {
        (this.el as any).releasePointerCapture?.(pointerId);
      } catch { }
    }

    const info: PointerInfo = { id: pointerId, type: pointerType, startPos: pos, pos, lastPos: pos };
    this.pointers.set(pointerId, info);
    this.capturedPointers.set(pointerId, opts.captureMode);
    this.dragBegan.delete(pointerId);
    if (opts.forceDrag || opts.captureMode === 'draw' || opts.captureMode === 'text') this.dragBegan.add(pointerId);
    this.updateGlobalInkDrawingEnabled();

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
    this.el.addEventListener('lostpointercapture', this.onLostPointerCapture);
    this.el.addEventListener('touchstart', this.onTouchPreventDefault, { passive: false });
    this.el.addEventListener('touchmove', this.onTouchPreventDefault, { passive: false });
    this.el.addEventListener('touchend', this.onTouchPreventDefault, { passive: false });
    this.el.addEventListener('touchcancel', this.onTouchPreventDefault, { passive: false });
    this.el.addEventListener('wheel', this.onWheel, { passive: false });
    this.el.addEventListener('contextmenu', this.onContextMenu);
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerup', this.onWindowPointerEnd, true);
      window.addEventListener('pointercancel', this.onWindowPointerEnd, true);
    }
  }

  dispose(): void {
    this.setInteracting(false);
    this.clearWheelIdleTimer();
    this.pointers.clear();
    this.pinch = null;
    this.capturedPointers.clear();
    this.updateGlobalInkDrawingEnabled();
    this.el.removeEventListener('pointerdown', this.onPointerDown as any);
    this.el.removeEventListener('pointermove', this.onPointerMove as any);
    this.el.removeEventListener('pointerup', this.onPointerUp as any);
    this.el.removeEventListener('pointercancel', this.onPointerUp as any);
    this.el.removeEventListener('lostpointercapture', this.onLostPointerCapture as any);
    this.el.removeEventListener('touchstart', this.onTouchPreventDefault as any);
    this.el.removeEventListener('touchmove', this.onTouchPreventDefault as any);
    this.el.removeEventListener('touchend', this.onTouchPreventDefault as any);
    this.el.removeEventListener('touchcancel', this.onTouchPreventDefault as any);
    this.el.removeEventListener('wheel', this.onWheel as any);
    this.el.removeEventListener('contextmenu', this.onContextMenu as any);
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerup', this.onWindowPointerEnd, true);
      window.removeEventListener('pointercancel', this.onWindowPointerEnd, true);
    }
  }

  private setInteracting(next: boolean): void {
    if (this.isInteracting === next) return;
    this.isInteracting = next;
    this.events.onInteractingChange?.(next);
  }

  private updateGlobalInkDrawingEnabled(): void {
    const shouldEnable = Array.from(this.capturedPointers.values()).some((m) => m === 'draw');
    if (this.globalInkDrawingEnabled === shouldEnable) return;
    this.globalInkDrawingEnabled = shouldEnable;
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle('gc-ink-drawing', shouldEnable);
  }

  private debugPointer(event: string, data?: Record<string, unknown>): void {
    if (typeof window === 'undefined') return;
    const w = window as any;
    if (!w.__gcPointerDebug) return;
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const entry = { t, event, ...(data ?? {}) };
    if (!Array.isArray(w.__gcPointerDebugLog)) w.__gcPointerDebugLog = [];
    w.__gcPointerDebugLog.push(entry);
    if (w.__gcPointerDebugLog.length > 300) w.__gcPointerDebugLog.shift();
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

  private onContextMenu = (e: Event) => {
    e.preventDefault();
  };

  // iOS Safari: pointer events alone don't always suppress double-tap/callout behaviors.
  private onTouchPreventDefault = (e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    this.debugPointer('touch', { type: e.type, touches: e.touches?.length ?? null });
  };

  private finalizePointer = (pointerId: number, pos: Vec2, opts?: { suppressTap?: boolean }) => {
    const info = this.pointers.get(pointerId);
    const had = this.pointers.delete(pointerId);

    // Clean up any residual state even if we somehow lost the pointer info.
    const didDrag = this.dragBegan.has(pointerId);
    this.dragBegan.delete(pointerId);

    const wasPinching = this.pinch != null;
    const captureMode = this.capturedPointers.get(pointerId) ?? null;
    this.debugPointer('finalize', {
      pointerId,
      pointerType: info?.type ?? null,
      captureMode,
      didDrag,
      hadPointer: had,
      suppressTap: opts?.suppressTap ?? false,
    });
    if (captureMode && info) {
      this.events.onPointerUp?.(pos, { pointerType: info.type, pointerId, wasDrag: didDrag });
    }
    this.capturedPointers.delete(pointerId);
    this.updateGlobalInkDrawingEnabled();

    try {
      (this.el as any).releasePointerCapture?.(pointerId);
    } catch { }

    if (!had || !info) return;

    this.recomputePinchState();

    const suppressTap = opts?.suppressTap ?? false;
    if (!suppressTap && !wasPinching && !this.pinch && !didDrag) {
      this.events.onTap?.(pos, { pointerType: info.type, pointerId });
    }

    if (this.pointers.size === 0) {
      this.setInteracting(false);
      this.clearWheelIdleTimer();
    }
  };

  private onWindowPointerEnd = (ev: PointerEvent) => {
    if (!this.pointers.has(ev.pointerId)) return;
    this.debugPointer('window-end', { type: ev.type, pointerId: ev.pointerId, pointerType: ev.pointerType || 'mouse' });
    this.finalizePointer(ev.pointerId, this.getLocalPos(ev));
    ev.preventDefault();
  };

  private onLostPointerCapture = (ev: PointerEvent) => {
    const info = this.pointers.get(ev.pointerId);
    if (!info) return;
    this.debugPointer('lostpointercapture', { pointerId: ev.pointerId, pointerType: info.type });
    this.finalizePointer(ev.pointerId, info.pos, { suppressTap: true });
  };

  private onPointerDown = (ev: PointerEvent) => {
    if (!isPrimaryButton(ev)) return;

    const incomingType = ev.pointerType || 'mouse';
    this.debugPointer('pointerdown', { pointerId: ev.pointerId, pointerType: incomingType, pointers: this.pointers.size });
    if (incomingType !== 'touch') {
      // Pen/mouse pointers cannot be concurrently active. If the browser delivers a new down before
      // the previous up (or we missed an end event), force-finish stale pointers so the next stroke
      // doesn't get ignored.
      const stale = Array.from(this.pointers.entries()).filter(([, info]) => info.type === incomingType);
      this.debugPointer('stale-check', { incomingType, staleCount: stale.length });
      for (const [id, info] of stale) {
        if (id === ev.pointerId) continue;
        this.finalizePointer(id, info.pos, { suppressTap: true });
      }
    }

    // Some browsers (notably iOS Safari) can drop/delay end events; if the UA reuses a pointerId,
    // ensure we end any previous interaction before starting a new one.
    const existing = this.pointers.get(ev.pointerId);
    if (existing) {
      this.finalizePointer(ev.pointerId, existing.pos, { suppressTap: true });
    } else if (this.capturedPointers.has(ev.pointerId) || this.dragBegan.has(ev.pointerId)) {
      this.dragBegan.delete(ev.pointerId);
      this.capturedPointers.delete(ev.pointerId);
      this.updateGlobalInkDrawingEnabled();
      try {
        (this.el as any).releasePointerCapture?.(ev.pointerId);
      } catch { }
    }

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
    this.updateGlobalInkDrawingEnabled();

    try {
      (this.el as any).setPointerCapture?.(ev.pointerId);
    } catch { }

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

    this.debugPointer('pointerend', { type: ev.type, pointerId: ev.pointerId, pointerType: info?.type ?? null });
    const wasPinching = this.pinch != null;
    const didDrag = this.dragBegan.has(ev.pointerId);
    this.dragBegan.delete(ev.pointerId);

    const captureMode = this.capturedPointers.get(ev.pointerId) ?? null;
    if (captureMode && info) {
      const pos = this.getLocalPos(ev);
      this.events.onPointerUp?.(pos, { pointerType: info.type, pointerId: ev.pointerId, wasDrag: didDrag });
    }
    this.capturedPointers.delete(ev.pointerId);
    this.updateGlobalInkDrawingEnabled();

    try {
      (this.el as any).releasePointerCapture?.(ev.pointerId);
    } catch { }

    this.recomputePinchState();

    if (!wasPinching && !this.pinch && !didDrag && info) {
      const pos = this.getLocalPos(ev);
      this.events.onTap?.(pos, { pointerType: info.type, pointerId: ev.pointerId });
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
    const isZoom = ev.ctrlKey;

    if (isZoom) {
      const base = 1.0016;
      const factor = base ** (-ev.deltaY);
      const nextZoom = this.camera.zoom * (Number.isFinite(factor) ? factor : 1);
      this.camera.setZoomAtScreen(nextZoom, pos);
      this.events.onChange?.();
      ev.preventDefault();
      return;
    }

    const dx = ev.deltaX;
    const dy = ev.deltaY;
    if (dx || dy) {
      this.camera.panByScreen(dx, dy);
      this.events.onChange?.();
    }
    ev.preventDefault();
  };
}
