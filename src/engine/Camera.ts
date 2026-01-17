import { clamp } from './math';
import type { Vec2 } from './types';

export type CameraLimits = {
  minZoom: number;
  maxZoom: number;
};

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  readonly limits: CameraLimits;

  constructor(limits?: Partial<CameraLimits>) {
    this.limits = {
      minZoom: clamp(limits?.minZoom ?? 0.05, 0.001, 10),
      maxZoom: clamp(limits?.maxZoom ?? 4, 0.01, 100),
    };
    if (this.limits.maxZoom < this.limits.minZoom) {
      this.limits.maxZoom = this.limits.minZoom;
    }
  }

  setZoom(nextZoom: number): void {
    this.zoom = clamp(nextZoom, this.limits.minZoom, this.limits.maxZoom);
  }

  screenToWorld(p: Vec2): Vec2 {
    const z = this.zoom || 1;
    return { x: this.x + p.x / z, y: this.y + p.y / z };
  }

  worldToScreen(p: Vec2): Vec2 {
    const z = this.zoom || 1;
    return { x: (p.x - this.x) * z, y: (p.y - this.y) * z };
  }

  panByScreen(dx: number, dy: number): void {
    const z = this.zoom || 1;
    this.x -= dx / z;
    this.y -= dy / z;
  }

  setZoomAtScreen(nextZoom: number, anchorScreen: Vec2): void {
    const before = this.screenToWorld(anchorScreen);
    this.setZoom(nextZoom);
    const z = this.zoom || 1;
    this.x = before.x - anchorScreen.x / z;
    this.y = before.y - anchorScreen.y / z;
  }

  setZoomKeepingWorldPoint(nextZoom: number, worldPoint: Vec2, targetScreen: Vec2): void {
    this.setZoom(nextZoom);
    const z = this.zoom || 1;
    this.x = worldPoint.x - targetScreen.x / z;
    this.y = worldPoint.y - targetScreen.y / z;
  }
}
