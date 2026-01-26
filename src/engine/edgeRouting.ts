import { clamp } from './math';
import type { Rect, Vec2 } from './types';

type AnchorSide = 'top' | 'right' | 'bottom' | 'left';

type Anchor = {
  side: AnchorSide;
  point: Vec2;
  outward: Vec2;
};

export type EdgeRouteContext = {
  parent: { id: string; rect: Rect };
  child: { id: string; rect: Rect };
};

export type EdgeRoute =
  | { kind: 'polyline'; points: Vec2[] }
  | { kind: 'bezier'; p0: Vec2; c1: Vec2; c2: Vec2; p3: Vec2 };

export type EdgeRouter = {
  id: string;
  label: string;
  description: string;
  route: (ctx: EdgeRouteContext) => EdgeRoute | null;
};

const rectCenter = (r: Rect): Vec2 => ({ x: r.x + r.w * 0.5, y: r.y + r.h * 0.5 });

function makeAnchor(rect: Rect, side: AnchorSide): Anchor {
  const c = rectCenter(rect);
  switch (side) {
    case 'top':
      return { side, point: { x: c.x, y: rect.y }, outward: { x: 0, y: -1 } };
    case 'bottom':
      return { side, point: { x: c.x, y: rect.y + rect.h }, outward: { x: 0, y: 1 } };
    case 'left':
      return { side, point: { x: rect.x, y: c.y }, outward: { x: -1, y: 0 } };
    case 'right':
      return { side, point: { x: rect.x + rect.w, y: c.y }, outward: { x: 1, y: 0 } };
  }
}

function chooseAutoAnchors(parentRect: Rect, childRect: Rect): { start: Anchor; end: Anchor } {
  const pc = rectCenter(parentRect);
  const cc = rectCenter(childRect);
  const dx = cc.x - pc.x;
  const dy = cc.y - pc.y;

  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx >= 0) return { start: makeAnchor(parentRect, 'right'), end: makeAnchor(childRect, 'left') };
    return { start: makeAnchor(parentRect, 'left'), end: makeAnchor(childRect, 'right') };
  }

  if (dy >= 0) return { start: makeAnchor(parentRect, 'bottom'), end: makeAnchor(childRect, 'top') };
  return { start: makeAnchor(parentRect, 'top'), end: makeAnchor(childRect, 'bottom') };
}

function addPoint(out: Vec2[], p: Vec2): void {
  const last = out[out.length - 1];
  if (last && Math.abs(last.x - p.x) < 0.0001 && Math.abs(last.y - p.y) < 0.0001) return;
  out.push(p);
}

function orthogonalRoute(ctx: EdgeRouteContext): EdgeRoute | null {
  const { start, end } = chooseAutoAnchors(ctx.parent.rect, ctx.child.rect);
  const p0 = start.point;
  const pEnd = end.point;

  const stub = 26;
  const startStub: Vec2 = { x: p0.x + start.outward.x * stub, y: p0.y + start.outward.y * stub };
  const endStub: Vec2 = { x: pEnd.x + end.outward.x * stub, y: pEnd.y + end.outward.y * stub };

  const pts: Vec2[] = [];
  addPoint(pts, p0);
  addPoint(pts, startStub);

  const startIsH = start.side === 'left' || start.side === 'right';
  const endIsH = end.side === 'left' || end.side === 'right';

  if (startIsH && endIsH) {
    const midX = (startStub.x + endStub.x) * 0.5;
    addPoint(pts, { x: midX, y: startStub.y });
    addPoint(pts, { x: midX, y: endStub.y });
  } else if (!startIsH && !endIsH) {
    const midY = (startStub.y + endStub.y) * 0.5;
    addPoint(pts, { x: startStub.x, y: midY });
    addPoint(pts, { x: endStub.x, y: midY });
  } else {
    // L-route.
    addPoint(pts, { x: endStub.x, y: startStub.y });
  }

  addPoint(pts, endStub);
  addPoint(pts, pEnd);

  return pts.length >= 2 ? { kind: 'polyline', points: pts } : null;
}

function curvedRoute(ctx: EdgeRouteContext): EdgeRoute | null {
  const { start, end } = chooseAutoAnchors(ctx.parent.rect, ctx.child.rect);
  const p0 = start.point;
  const p3 = end.point;
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy);
  const control = clamp(dist * 0.5, 60, 320);

  const c1: Vec2 = { x: p0.x + start.outward.x * control, y: p0.y + start.outward.y * control };
  const c2: Vec2 = { x: p3.x + end.outward.x * control, y: p3.y + end.outward.y * control };
  return { kind: 'bezier', p0, c1, c2, p3 };
}

const EDGE_ROUTERS = [
  {
    id: 'straight',
    label: 'Straight (Legacy)',
    description: 'Bottom-center → top-center straight line.',
    route: ({ parent, child }: EdgeRouteContext): EdgeRoute | null => {
      const startX = parent.rect.x + parent.rect.w * 0.5;
      const startY = parent.rect.y + parent.rect.h;
      const endX = child.rect.x + child.rect.w * 0.5;
      const endY = child.rect.y;
      return { kind: 'polyline', points: [{ x: startX, y: startY }, { x: endX, y: endY }] };
    },
  },
  {
    id: 'orthogonal',
    label: 'Orthogonal',
    description: 'Auto-anchors with right-angle routing.',
    route: orthogonalRoute,
  },
  {
    id: 'curved',
    label: 'Curved',
    description: 'Auto-anchors with a smooth Bézier curve.',
    route: curvedRoute,
  },
] as const satisfies readonly EdgeRouter[];

export type EdgeRouterId = (typeof EDGE_ROUTERS)[number]['id'];

export const DEFAULT_EDGE_ROUTER_ID: EdgeRouterId = 'straight';

export function listEdgeRouters(): readonly EdgeRouter[] {
  return EDGE_ROUTERS;
}

export function normalizeEdgeRouterId(value: unknown): EdgeRouterId {
  const raw = typeof value === 'string' ? value.trim() : '';
  const hit = EDGE_ROUTERS.find((r) => r.id === raw);
  return (hit?.id ?? DEFAULT_EDGE_ROUTER_ID) as EdgeRouterId;
}

export function getEdgeRouter(id: unknown): EdgeRouter {
  const normalized = normalizeEdgeRouterId(id);
  return EDGE_ROUTERS.find((r) => r.id === normalized) ?? EDGE_ROUTERS[0];
}

