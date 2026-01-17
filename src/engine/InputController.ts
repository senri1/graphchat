import { hypot2 } from './math';
import type { Vec2 } from './types';
import type { Camera } from './Camera';

type PointerInfo = {
  id: number;
  type: string;
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
};

function isPrimaryButton(ev: PointerEvent): boolean {
  if (ev.pointerType === 'mouse') return ev.button === 0;
  return true;
}

function isTwoFingerTouch(pointers: Map<number, PointerInfo>): boolean {
  if (pointers.size !== 2) return false;
  for (const p of pointers.values()) {
    if (p.type !== 'touch') return false;
  }
  return true;
}

export class InputController {
  private readonly el: HTMLElement;
  private readonly camera: Camera;
  private readonly events: InputControllerEvents;

  private pointers = new Map<number, PointerInfo>();
  private pinch: PinchState | null = null;
  private isInteracting = false;
  private wheelIdleTimeout: number | null = null;

  constructor(el: HTMLElement, camera: Camera, events?: InputControllerEvents) {
    this.el = el;
    this.camera = camera;
    this.events = events ?? {};
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

  private onContextMenu = (e: Event) => {
    e.preventDefault();
  };

  private onPointerDown = (ev: PointerEvent) => {
    if (!isPrimaryButton(ev)) return;

    const pos = this.getLocalPos(ev);
    const info: PointerInfo = {
      id: ev.pointerId,
      type: ev.pointerType || 'mouse',
      pos,
      lastPos: pos,
    };
    this.pointers.set(ev.pointerId, info);

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
    info.pos = pos;

    if (this.pinch) {
      this.updatePinch();
    } else if (this.pointers.size === 1) {
      const dx = pos.x - info.lastPos.x;
      const dy = pos.y - info.lastPos.y;
      if (dx || dy) {
        this.camera.panByScreen(dx, dy);
        this.events.onChange?.();
      }
    }

    info.lastPos = pos;
    ev.preventDefault();
  };

  private onPointerUp = (ev: PointerEvent) => {
    const had = this.pointers.delete(ev.pointerId);
    if (!had) return;

    try {
      (this.el as any).releasePointerCapture?.(ev.pointerId);
    } catch { }

    this.recomputePinchState();
    if (this.pointers.size === 0) {
      this.setInteracting(false);
      this.clearWheelIdleTimer();
    }

    ev.preventDefault();
  };

  private recomputePinchState(): void {
    if (!isTwoFingerTouch(this.pointers)) {
      this.pinch = null;
      return;
    }

    const ids = Array.from(this.pointers.keys()).slice(0, 2) as [number, number];
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
