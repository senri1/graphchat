export type Vec2 = { x: number; y: number };

export type Rect = { x: number; y: number; w: number; h: number };

export function rectContainsPoint(rect: Rect, p: Vec2): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
