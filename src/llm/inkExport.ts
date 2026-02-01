import type { ChatNode, InkStroke } from '../model/chat';
import { blobToDataUrl } from '../storage/attachments';

export type InkExportOptions = {
  cropEnabled?: boolean;
  cropPaddingPx?: number;
  downscaleEnabled?: boolean;
  maxDimPx?: number;
  maxPixels?: number;
  rasterScale?: number;
};

export type InkExportResult = {
  mimeType: 'image/png';
  base64: string;
  width: number;
  height: number;
};

const clampNumber = (raw: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

const TEXT_NODE_PAD_PX = 14;
const TEXT_NODE_HEADER_H_PX = 44;

function contentSizeForInkNode(node: Extract<ChatNode, { kind: 'ink' }>): { w: number; h: number } {
  const w = Math.max(1, Number(node.rect.w) - TEXT_NODE_PAD_PX * 2);
  const h = Math.max(1, Number(node.rect.h) - TEXT_NODE_HEADER_H_PX - TEXT_NODE_PAD_PX);
  return { w, h };
}

function computeInkBounds(strokes: InkStroke[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const stroke of strokes) {
    const pts = Array.isArray(stroke.points) ? stroke.points : [];
    if (pts.length === 0) continue;
    const width = Number.isFinite(stroke.width) ? Math.max(0, stroke.width) : 0;
    const r = width * 0.5;
    for (const p of pts) {
      const x = Number(p?.x);
      const y = Number(p?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x - r);
      minY = Math.min(minY, y - r);
      maxX = Math.max(maxX, x + r);
      maxY = Math.max(maxY, y + r);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  if (maxX - minX < 0.001 || maxY - minY < 0.001) return null;
  return { minX, minY, maxX, maxY };
}

function drawInkStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke): void {
  const pts = Array.isArray(stroke.points) ? stroke.points : [];
  if (pts.length === 0) return;

  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = Math.max(0.0001, Number.isFinite(stroke.width) ? stroke.width : 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pts.length === 1) {
    const p0 = pts[0]!;
    const x = Number(p0?.x);
    const y = Number(p0?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    ctx.fillStyle = stroke.color;
    ctx.beginPath();
    ctx.arc(x, y, ctx.lineWidth * 0.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const first = pts[0]!;
  const x0 = Number(first?.x);
  const y0 = Number(first?.y);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return;

  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i]!;
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export async function inkNodeToPngBase64(
  node: Extract<ChatNode, { kind: 'ink' }>,
  opts?: InkExportOptions,
): Promise<InkExportResult | null> {
  if (typeof document === 'undefined') return null;

  const strokes = Array.isArray(node.strokes) ? node.strokes : [];
  if (strokes.length === 0) return null;

  const cropEnabled = opts?.cropEnabled !== false;
  const cropPaddingPx = clampNumber(opts?.cropPaddingPx, 0, 200, 24);
  const downscaleEnabled = opts?.downscaleEnabled !== false;
  const rasterScale = clampNumber(opts?.rasterScale, 1, 4, 2);
  const maxDim = Math.round(clampNumber(opts?.maxDimPx, 256, 8192, 4096));
  const maxPixels = Math.round(clampNumber(opts?.maxPixels, 100_000, 40_000_000, 6_000_000));

  const content = contentSizeForInkNode(node);
  const worldW = Math.max(1, content.w);
  const worldH = Math.max(1, content.h);

  const crop = (() => {
    if (!cropEnabled) return { x: 0, y: 0, w: worldW, h: worldH };
    const bounds = computeInkBounds(strokes);
    if (!bounds) return { x: 0, y: 0, w: worldW, h: worldH };

    const x0 = Math.max(0, Math.min(worldW, bounds.minX - cropPaddingPx));
    const y0 = Math.max(0, Math.min(worldH, bounds.minY - cropPaddingPx));
    const x1 = Math.max(0, Math.min(worldW, bounds.maxX + cropPaddingPx));
    const y1 = Math.max(0, Math.min(worldH, bounds.maxY + cropPaddingPx));
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    return { x: x0, y: y0, w, h };
  })();

  let scale = rasterScale;
  let pxW = Math.max(1, Math.round(crop.w * scale));
  let pxH = Math.max(1, Math.round(crop.h * scale));

  if (downscaleEnabled) {
    const scaleByDim = Math.min(1, maxDim / pxW, maxDim / pxH);
    if (scaleByDim < 1) {
      scale *= scaleByDim;
      pxW = Math.max(1, Math.round(crop.w * scale));
      pxH = Math.max(1, Math.round(crop.h * scale));
    }

    const pixels = pxW * pxH;
    if (pixels > maxPixels) {
      const s = Math.sqrt(maxPixels / pixels);
      scale *= s;
      pxW = Math.max(1, Math.round(crop.w * scale));
      pxH = Math.max(1, Math.round(crop.h * scale));
    }
  } else {
    const pixels = pxW * pxH;
    if (pxW > maxDim || pxH > maxDim || pixels > maxPixels) {
      throw new Error(
        `Ink image is ${pxW}×${pxH} (${pixels.toLocaleString()} px), which exceeds the current limits (${maxDim} max dim, ${maxPixels.toLocaleString()} max pixels). Enable scaling or adjust limits in Debug.`,
      );
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, pxW, pxH);

  ctx.setTransform(scale, 0, 0, scale, -crop.x * scale, -crop.y * scale);
  for (const stroke of strokes) drawInkStroke(ctx, stroke);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  if (!blob) return null;
  const dataUrl = await blobToDataUrl(blob, 'image/png');
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const base64 = dataUrl.slice(comma + 1);
  if (!base64) return null;

  return { mimeType: 'image/png', base64, width: pxW, height: pxH };
}

