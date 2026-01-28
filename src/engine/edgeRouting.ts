import { clamp } from './math';
import type { Rect, Vec2 } from './types';

export type AnchorSide = 'top' | 'right' | 'bottom' | 'left';
type ArrowAnchor = 'tip' | 'base';

type Anchor = {
  side: AnchorSide;
  point: Vec2;
  outward: Vec2;
};

export type EdgeRouteAnchor = {
  side: AnchorSide;
  point: Vec2;
};

export type EdgeRouteStyle = {
  arrowHeadLength: number; // world units
  controlPointMin: number; // world units
  controlPointMax: number; // world units
  straightAlignThreshold: number; // world units
};

export type EdgeRouteContext = {
  parent: { id: string; rect: Rect };
  child: { id: string; rect: Rect };
  style: EdgeRouteStyle;
  anchors?: { start?: EdgeRouteAnchor; end?: EdgeRouteAnchor };
};

export type EdgeRoute =
  | { kind: 'polyline'; points: Vec2[]; arrow?: { anchor: ArrowAnchor } }
  | { kind: 'bezier'; p0: Vec2; c1: Vec2; c2: Vec2; p3: Vec2; arrow?: { anchor: ArrowAnchor } };

export type EdgeRouter = {
  id: string;
  label: string;
  description: string;
  route: (ctx: EdgeRouteContext) => EdgeRoute | null;
};

const rectCenter = (r: Rect): Vec2 => ({ x: r.x + r.w * 0.5, y: r.y + r.h * 0.5 });

function intersectRectPerimeter(rect: Rect, toward: Vec2): { point: Vec2; side: AnchorSide } {
  const cx = rect.x + rect.w * 0.5;
  const cy = rect.y + rect.h * 0.5;
  const dx = toward.x - cx;
  const dy = toward.y - cy;

  // Handle degenerate vector
  if (dx === 0 && dy === 0) return { point: { x: cx, y: rect.y }, side: 'top' };

  const hw = rect.w * 0.5;
  const hh = rect.h * 0.5;
  const scale = 1 / Math.max(Math.abs(dx) / Math.max(1e-9, hw), Math.abs(dy) / Math.max(1e-9, hh));
  const ix = cx + dx * scale;
  const iy = cy + dy * scale;

  const eps = 1e-6;
  let side: AnchorSide;
  if (Math.abs(ix - rect.x) < eps) side = 'left';
  else if (Math.abs(ix - (rect.x + rect.w)) < eps) side = 'right';
  else if (Math.abs(iy - rect.y) < eps) side = 'top';
  else side = 'bottom';

  return { point: { x: ix, y: iy }, side };
}

function outwardForSide(side: AnchorSide): Vec2 {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
  }
}

function makeAnchor(rect: Rect, side: AnchorSide): Anchor {
  const c = rectCenter(rect);
  switch (side) {
    case 'top':
      return { side, point: { x: c.x, y: rect.y }, outward: outwardForSide(side) };
    case 'bottom':
      return { side, point: { x: c.x, y: rect.y + rect.h }, outward: outwardForSide(side) };
    case 'left':
      return { side, point: { x: rect.x, y: c.y }, outward: outwardForSide(side) };
    case 'right':
      return { side, point: { x: rect.x + rect.w, y: c.y }, outward: outwardForSide(side) };
  }
}

function makeAnchorAtPoint(side: AnchorSide, point: Vec2): Anchor {
  return { side, point, outward: outwardForSide(side) };
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
  const auto = chooseAutoAnchors(ctx.parent.rect, ctx.child.rect);
  const start = ctx.anchors?.start ? makeAnchorAtPoint(ctx.anchors.start.side, ctx.anchors.start.point) : auto.start;
  const end = ctx.anchors?.end
    ? makeAnchorAtPoint(ctx.anchors.end.side, ctx.anchors.end.point)
    : ctx.anchors?.start
      ? (() => {
          const hit = intersectRectPerimeter(ctx.child.rect, ctx.anchors!.start!.point);
          return makeAnchorAtPoint(hit.side, hit.point);
        })()
      : auto.end;
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
  const auto = chooseAutoAnchors(ctx.parent.rect, ctx.child.rect);
  const start = ctx.anchors?.start ? makeAnchorAtPoint(ctx.anchors.start.side, ctx.anchors.start.point) : auto.start;
  const end = ctx.anchors?.end
    ? makeAnchorAtPoint(ctx.anchors.end.side, ctx.anchors.end.point)
    : ctx.anchors?.start
      ? (() => {
          const hit = intersectRectPerimeter(ctx.child.rect, ctx.anchors!.start!.point);
          return makeAnchorAtPoint(hit.side, hit.point);
        })()
      : auto.end;
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

function gemRoute(ctx: EdgeRouteContext): EdgeRoute | null {
  const pRect = ctx.parent.rect;
  const cRect = ctx.child.rect;
  const pCenter = rectCenter(pRect);
  const cCenter = rectCenter(cRect);

  const { point: start, side: startSide } = ctx.anchors?.start
    ? { point: ctx.anchors.start.point, side: ctx.anchors.start.side }
    : intersectRectPerimeter(pRect, cCenter);
  const { point: endTip, side: endSide } = ctx.anchors?.end
    ? { point: ctx.anchors.end.point, side: ctx.anchors.end.side }
    : ctx.anchors?.start
      ? intersectRectPerimeter(cRect, ctx.anchors.start.point)
      : intersectRectPerimeter(cRect, pCenter);

  const endBase = { ...endTip };
  const arrowLen = Math.max(0, ctx.style.arrowHeadLength);
  switch (endSide) {
    case 'left':
      endBase.x -= arrowLen;
      break;
    case 'right':
      endBase.x += arrowLen;
      break;
    case 'top':
      endBase.y -= arrowLen;
      break;
    case 'bottom':
      endBase.y += arrowLen;
      break;
  }

  // Control point distance based on anchor separation (clamped)
  const axisDistance = Math.hypot(endBase.x - start.x, endBase.y - start.y);
  const cp = clamp(axisDistance * 0.5, ctx.style.controlPointMin, ctx.style.controlPointMax);

  // Push control points outward along the normal of each side
  let c1x = start.x;
  let c1y = start.y;
  let c2x = endBase.x;
  let c2y = endBase.y;
  if (startSide === 'left') c1x = start.x - cp;
  if (startSide === 'right') c1x = start.x + cp;
  if (startSide === 'top') c1y = start.y - cp;
  if (startSide === 'bottom') c1y = start.y + cp;

  if (endSide === 'left') c2x = endBase.x - cp;
  if (endSide === 'right') c2x = endBase.x + cp;
  if (endSide === 'top') c2y = endBase.y - cp;
  if (endSide === 'bottom') c2y = endBase.y + cp;

  // Draw straight if nearly horizontal or vertical
  const nearHoriz = Math.abs(endBase.y - start.y) <= ctx.style.straightAlignThreshold;
  const nearVert = Math.abs(endBase.x - start.x) <= ctx.style.straightAlignThreshold;

  return nearHoriz || nearVert
    ? { kind: 'polyline', points: [start, endBase], arrow: { anchor: 'base' } }
    : {
        kind: 'bezier',
        p0: start,
        c1: { x: c1x, y: c1y },
        c2: { x: c2x, y: c2y },
        p3: endBase,
        arrow: { anchor: 'base' },
      };
}

const EDGE_ROUTERS = [
  {
    id: 'straight',
    label: 'Straight (Legacy)',
    description: 'Bottom-center → top-center straight line.',
    route: ({ parent, child, anchors }: EdgeRouteContext): EdgeRoute | null => {
      const start = anchors?.start?.point ?? { x: parent.rect.x + parent.rect.w * 0.5, y: parent.rect.y + parent.rect.h };
      const end =
        anchors?.end?.point ??
        (anchors?.start ? intersectRectPerimeter(child.rect, start).point : { x: child.rect.x + child.rect.w * 0.5, y: child.rect.y });
      return { kind: 'polyline', points: [start, end] };
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
  {
    id: 'gem',
    label: 'Gem (Perimeter Curve)',
    description: 'Anchors at box perimeter with a cubic Bézier (graphchatgem-style).',
    route: gemRoute,
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
