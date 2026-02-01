import { chooseNiceStep, clamp } from './math';
import { Camera } from './Camera';
import { InputController, type PointerCaptureMode } from './InputController';
import { rectsIntersect, type Rect, type Vec2 } from './types';
import { rasterizeHtmlToImage, type TextHitZone } from './raster/textRaster';
import { renderMarkdownMath } from '../markdown/renderMarkdownMath';
import { normalizeMathDelimitersFromCopyTex } from '../markdown/mathDelimiters';
import { TextLod2Overlay, type HighlightRect, type TextLod2Action, type TextLod2Mode } from './TextLod2Overlay';
import { PdfTextLod2Overlay, type HighlightRect as PdfHighlightRect, type PdfSelectionStartAnchor } from './PdfTextLod2Overlay';
import { WebGLPreblur } from './WebGLPreblur';
import { DEFAULT_EDGE_ROUTER_ID, getEdgeRouter, normalizeEdgeRouterId, type EdgeRoute, type EdgeRouterId } from './edgeRouting';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { loadPdfDocument } from './pdf/pdfjs';
import { getAttachment as getStoredAttachment } from '../storage/attachments';
import type {
  CanonicalAssistantMessage,
  ChatAttachment,
  ChatAuthor,
  ChatLlmTask,
  ChatLlmParams,
  ChatNode,
  InkPoint,
  InkStroke,
  ThinkingSummaryChunk,
} from '../model/chat';

export type WorldEngineDebug = {
  cssW: number;
  cssH: number;
  dpr: number;
  cameraX: number;
  cameraY: number;
  zoom: number;
  interacting: boolean;
};

export type GlassBlurBackend = 'webgl' | 'canvas';

export type CanonicalizeLayoutAlgorithm = 'layered' | 'reingold-tilford';

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fingerprintText(input: string): string {
  const s = input ?? '';
  return `${s.length.toString(36)}.${fnv1a32(s).toString(36)}`;
}

function escapeHtml(text: string): string {
  const t = (text ?? '').toString();
  if (!t) return '';
  return t.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

function stripStrong(text: string): string {
  return (text ?? '').toString().replace(/\*\*(.+?)\*\*/g, '$1');
}

function summarizeFirstLine(text: string): string {
  const t = (text ?? '').toString();
  if (!t) return '';
  const firstLine = t.split('\n')[0] ?? '';
  return stripStrong(firstLine);
}

type XY = { x: number; y: number };

function distPointToSegmentSq(p: XY, a: XY, b: XY): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;

  const vv = vx * vx + vy * vy;
  if (vv <= 1e-12) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    return dx * dx + dy * dy;
  }

  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
  const projX = a.x + vx * t;
  const projY = a.y + vy * t;
  const dx = p.x - projX;
  const dy = p.y - projY;
  return dx * dx + dy * dy;
}

function orient2d(a: XY, b: XY, c: XY): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: XY, p: XY, b: XY, eps = 1e-9): boolean {
  return (
    p.x >= Math.min(a.x, b.x) - eps &&
    p.x <= Math.max(a.x, b.x) + eps &&
    p.y >= Math.min(a.y, b.y) - eps &&
    p.y <= Math.max(a.y, b.y) + eps
  );
}

function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orient2d(a, b, c);
  const o2 = orient2d(a, b, d);
  const o3 = orient2d(c, d, a);
  const o4 = orient2d(c, d, b);

  const eps = 1e-9;
  const z1 = Math.abs(o1) <= eps;
  const z2 = Math.abs(o2) <= eps;
  const z3 = Math.abs(o3) <= eps;
  const z4 = Math.abs(o4) <= eps;

  if (z1 && onSegment(a, c, b, eps)) return true;
  if (z2 && onSegment(a, d, b, eps)) return true;
  if (z3 && onSegment(c, a, d, eps)) return true;
  if (z4 && onSegment(c, b, d, eps)) return true;

  const abStraddles = (o1 > 0) !== (o2 > 0);
  const cdStraddles = (o3 > 0) !== (o4 > 0);
  return abStraddles && cdStraddles;
}

function distSegmentToSegmentSq(a: XY, b: XY, c: XY, d: XY): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distPointToSegmentSq(a, c, d),
    distPointToSegmentSq(b, c, d),
    distPointToSegmentSq(c, a, b),
    distPointToSegmentSq(d, a, b),
  );
}

function polylineIntersectsCapsule(points: XY[], a: XY, b: XY, radius: number): boolean {
  if (!Array.isArray(points) || points.length === 0) return false;
  const r = Math.max(0, radius);
  const r2 = r * r;

  if (points.length === 1) {
    return distPointToSegmentSq(points[0]!, a, b) <= r2;
  }

  for (let i = 1; i < points.length; i += 1) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    if (distSegmentToSegmentSq(a, b, p0, p1) <= r2) return true;
  }
  return false;
}

const TEXT_NODE_PAD_PX = 14;
const TEXT_NODE_HEADER_H_PX = 44;
const TEXT_NODE_HEADER_GAP_PX = 8;
const TEXT_NODE_SEND_BUTTON_SPLIT_GAP_PX = 3;

// Spawn + streaming auto-grow bounds (manual resizing can exceed these).
const TEXT_NODE_SPAWN_MIN_W_PX = 260;
const TEXT_NODE_SPAWN_MAX_W_PX = 800;
const TEXT_NODE_SPAWN_MIN_H_PX = 120;
const TEXT_NODE_SPAWN_MAX_H_PX = 1200;

// Manual resize bounds for ink nodes (prevents huge in-memory rasters).
const INK_NODE_MAX_W_PX = 2400;
const INK_NODE_MAX_H_PX = 1800;

// Layout tuning for Debug → Canonicalize layout.
// Values match the GraphChatGem "Canonicalize layout" defaults.
const CANONICALIZE_LAYOUT_NODE_SPACING_X = 1000;
const CANONICALIZE_LAYOUT_NODE_SPACING_Y = 235;
const CANONICALIZE_LAYOUT_NODE_HEIGHT_ESTIMATE = 160;
const CANONICALIZE_LAYOUT_PARENT_CHILD_GAP_Y = Math.max(
  0,
  CANONICALIZE_LAYOUT_NODE_SPACING_Y - CANONICALIZE_LAYOUT_NODE_HEIGHT_ESTIMATE,
);

type ReasoningSummaryBlock = { type: 'summary_text'; text: string };

function readReasoningSummaryBlocks(canonicalMeta: unknown): ReasoningSummaryBlock[] {
  try {
    const anyMeta = canonicalMeta as any;
    const blocks = anyMeta?.reasoningSummaryBlocks;
    if (!Array.isArray(blocks)) return [];
    const out: ReasoningSummaryBlock[] = [];
    for (const b of blocks) {
      const text = typeof b?.text === 'string' ? b.text : String(b?.text ?? '');
      if (!text.trim()) continue;
      out.push({ type: 'summary_text', text });
    }
    return out;
  } catch {
    return [];
  }
}

function caretRangeFromClientPoint(doc: Document, clientX: number, clientY: number): Range | null {
  const anyDoc = doc as any;
  if (typeof anyDoc?.caretRangeFromPoint === 'function') {
    try {
      return anyDoc.caretRangeFromPoint(clientX, clientY) as Range | null;
    } catch {
      return null;
    }
  }
  if (typeof anyDoc?.caretPositionFromPoint === 'function') {
    try {
      const pos = anyDoc.caretPositionFromPoint(clientX, clientY) as { offsetNode?: Node; offset?: number } | null;
      if (!pos?.offsetNode || typeof pos.offset !== 'number') return null;
      const range = doc.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    } catch {
      return null;
    }
  }
  return null;
}

function extractTextFromRange(baseRange: Range): string {
  try {
    const range = baseRange.cloneRange();
    const closestKatex = (node: Node | null): Element | null => {
      if (!node) return null;
      const el =
        node.nodeType === Node.ELEMENT_NODE ? (node as Element) : ((node as any).parentElement as Element | null);
      return el ? el.closest('.katex') : null;
    };
    const startKatex = closestKatex(range.startContainer);
    if (startKatex) range.setStartBefore(startKatex);
    const endKatex = closestKatex(range.endContainer);
    if (endKatex) range.setEndAfter(endKatex);

    const frag = range.cloneContents();
    const katexEls = Array.from(frag.querySelectorAll('.katex'));
    for (const k of katexEls) {
      const ann = k.querySelector('annotation[encoding="application/x-tex"]') as HTMLElement | null;
      const tex = (ann?.textContent ?? '').trim();
      if (!tex) continue;
      const isDisplay = Boolean(k.closest('.katex-display'));
      const open = isDisplay ? '$$' : '$';
      const close = isDisplay ? '$$' : '$';
      k.replaceWith(document.createTextNode(`${open}${tex}${close}`));
    }

    // Use `innerText` to preserve reasonable newlines for block elements / <br>.
    const tmp = document.createElement('div');
    tmp.style.position = 'fixed';
    tmp.style.left = '-99999px';
    tmp.style.top = '0';
    tmp.style.whiteSpace = 'pre-wrap';
    tmp.style.pointerEvents = 'none';
    tmp.appendChild(frag);
    document.body.appendChild(tmp);
    const raw = tmp.innerText;
    tmp.remove();
    return normalizeMathDelimitersFromCopyTex(raw).trim();
  } catch {
    try {
      return baseRange.toString().trim();
    } catch {
      return '';
    }
  }
}

type DemoNodeBase = {
  id: string;
  title: string;
  parentId: string | null;
  parentAnchor?: ParentAnchor;
};

type ParentAnchor =
  | {
      kind: 'pdf-selection';
      pageNumber: number;
      yPct: number;
    };

type TextNode = DemoNodeBase & {
  kind: 'text';
  isEditNode?: boolean;
  author: ChatAuthor;
  rect: Rect;
  content: string;
  userPreface?: { replyTo?: string; contexts?: string[] };
  collapsedPrefaceContexts?: Record<number, boolean>;
  contentHash: string;
  displayHash: string;
  isGenerating?: boolean;
  modelId?: string | null;
  llmParams?: ChatLlmParams;
  llmError?: string | null;
  llmTask?: ChatLlmTask;
  apiRequest?: unknown;
  apiResponse?: unknown;
  canonicalMessage?: CanonicalAssistantMessage;
  canonicalMeta?: unknown;
  thinkingSummary?: ThinkingSummaryChunk[];
  summaryExpanded?: boolean;
  expandedSummaryChunks?: Record<number, boolean>;
  contentScrollY?: number;
  attachments?: ChatAttachment[];
  selectedAttachmentKeys?: string[];
};

type PdfNode = DemoNodeBase & {
  kind: 'pdf';
  rect: Rect;
  fileName: string | null;
  storageKey?: string | null;
  pageCount: number;
  status: 'empty' | 'loading' | 'ready' | 'error';
  error: string | null;
};

type InkNode = DemoNodeBase & {
  kind: 'ink';
  rect: Rect;
  strokes: InkStroke[];
  raster: InkRaster | null;
};

type WorldNode = TextNode | PdfNode | InkNode;

type TextRasterJob = {
  nodeId: string;
  key: string;
  sig: string;
  rasterScale: number;
  width: number;
  height: number;
  html: string;
  scrollY: number;
};

export type PdfPageMeta = {
  pageNumber: number;
  viewportW: number;
  viewportH: number;
  aspect: number;
};

export type PdfNodeState = {
  token: number;
  doc: PDFDocumentProxy;
  pageCount: number;
  metas: Array<PdfPageMeta | null>;
  defaultAspect: number;
};

type PdfPageRenderJob = {
  nodeId: string;
  token: number;
  pageNumber: number;
  key: string;
  pageWorldW: number;
  pageWorldH: number;
  rasterScale: number;
};

export type WorldEngineUiState = {
  selectedNodeId: string | null;
  editingNodeId: string | null;
  editingText: string;
  tool: Tool;
};

export type WorldEngineCameraState = { x: number; y: number; zoom: number };

export type WorldEngineChatState = {
  camera: WorldEngineCameraState;
  nodes: ChatNode[];
  worldInkStrokes: InkStroke[];
  pdfStates: Array<{ nodeId: string; state: PdfNodeState }>;
};

export function createEmptyChatState(): WorldEngineChatState {
  return { camera: { x: 0, y: 0, zoom: 1 }, nodes: [], worldInkStrokes: [], pdfStates: [] };
}

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

type Tool = 'select' | 'draw' | 'erase';

type PendingSpawnByDraw =
  | {
      kind: 'text';
      opts?: { title?: string; content?: string; author?: ChatAuthor };
    }
  | { kind: 'ink' };

type PdfAnnotationPlacement = {
  kind: 'text' | 'ink';
  pdfNodeId: string;
  selectionText: string;
  anchor: PdfSelectionStartAnchor;
  hoverWorld: Vec2 | null;
  outlineRect: Rect | null;
};

type TextAnnotationPlacement = {
  kind: 'text' | 'ink';
  textNodeId: string;
  selectionText: string;
  hoverWorld: Vec2 | null;
  outlineRect: Rect | null;
};

type InkRaster = {
  scale: number;
  worldW: number;
  worldH: number;
  canvas: HTMLCanvasElement;
  drawnStrokeCount: number;
};

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

type ActiveInkGesture =
  | {
      kind: 'ink-world';
      pointerId: number;
      pointerType: string;
      stroke: InkStroke;
    }
  | {
      kind: 'ink-node';
      pointerId: number;
      pointerType: string;
      nodeId: string;
      stroke: InkStroke;
    };

type ActiveEraseGesture =
  | {
      kind: 'erase-world';
      pointerId: number;
      pointerType: string;
      radiusWorld: number;
      lastWorld: Vec2;
    }
  | {
      kind: 'erase-node';
      pointerId: number;
      pointerType: string;
      nodeId: string;
      radiusWorld: number;
      lastLocal: InkPoint;
    };

type ActiveTextSelectGesture = {
  kind: 'text-select';
  pointerId: number;
  nodeId: string;
};

type ActivePdfTextSelectGesture = {
  kind: 'pdf-text-select';
  pointerId: number;
  nodeId: string;
  token: number;
  pageNumber: number;
};

type ActiveSpawnByDrawGesture = {
  kind: 'spawn-by-draw';
  pointerId: number;
  spawn: PendingSpawnByDraw;
  startWorld: Vec2;
  currentWorld: Vec2;
  hasDrag: boolean;
  pdfAnnotation?: PdfAnnotationPlacement;
  textAnnotation?: TextAnnotationPlacement;
};

type ActivePdfAnnotationPlaceGesture = {
  kind: 'pdf-annotation-place';
  pointerId: number;
  pointerType: string;
  hadHover: boolean;
};

type ActivePdfAnnotationOutlineResizeGesture = {
  kind: 'pdf-annotation-outline-resize';
  pointerId: number;
  corner: ResizeCorner;
  startWorld: Vec2;
  startRect: Rect;
};

type ActiveTextAnnotationPlaceGesture = {
  kind: 'text-annotation-place';
  pointerId: number;
  pointerType: string;
  hadHover: boolean;
};

type ActiveTextAnnotationOutlineResizeGesture = {
  kind: 'text-annotation-outline-resize';
  pointerId: number;
  corner: ResizeCorner;
  startWorld: Vec2;
  startRect: Rect;
};

type ActiveGesture =
  | ActiveNodeGesture
  | ActiveInkGesture
  | ActiveEraseGesture
  | ActiveTextSelectGesture
  | ActivePdfTextSelectGesture
  | ActiveSpawnByDrawGesture
  | ActivePdfAnnotationPlaceGesture
  | ActivePdfAnnotationOutlineResizeGesture
  | ActiveTextAnnotationPlaceGesture
  | ActiveTextAnnotationOutlineResizeGesture;

export class WorldEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  readonly camera = new Camera({ minZoom: 0.05, maxZoom: 6 });
  private readonly input: InputController;

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;

  private glassNodesEnabled = false;
  private glassBlurCssPx = 10;
  private glassSaturatePct = 140;
  private glassUnderlayAlpha = 0.95;
  private glassBlurBackend: GlassBlurBackend = 'webgl';
  private edgeRouterId: EdgeRouterId = DEFAULT_EDGE_ROUTER_ID;
  private replyArrowColor = '#93c5fd';
  private replyArrowOpacity = 1;
  private webglPreblur: WebGLPreblur | null = null;
  private webglPreblurDisabled = false;

  private backgroundImage: CanvasImageSource | null = null;
  private backgroundImageW = 0;
  private backgroundImageH = 0;
  private backgroundLoadToken = 0;
  private backgroundVersion = 0;
  private backgroundCache: {
    version: number;
    pxW: number;
    pxH: number;
    blurPx: number;
    saturatePct: number;
    blurBackend: GlassBlurBackend;
    sharp: HTMLCanvasElement;
    blurred: HTMLCanvasElement;
  } | null = null;

  private raf: number | null = null;
  private interacting = false;

  private lastDebugEmitAt = 0;
  onDebug?: (state: WorldEngineDebug) => void;

  onUiState?: (state: WorldEngineUiState) => void;
  onRequestReply?: (nodeId: string) => void;
  onRequestReplyToSelection?: (nodeId: string, selectionText: string) => void;
  onRequestAddToContextSelection?: (nodeId: string, selectionText: string) => void;
  onRequestRaw?: (nodeId: string) => void;
  onRequestNodeMenu?: (nodeId: string) => void;
  onRequestSendEditNode?: (nodeId: string) => void;
  onRequestSendEditNodeModelMenu?: (nodeId: string) => void;
  onRequestCancelGeneration?: (nodeId: string) => void;
  onRequestPersist?: () => void;

  private selectedNodeId: string | null = null;
  private editingNodeId: string | null = null;
  private rawViewerNodeId: string | null = null;
  private allowEditingAllTextNodes = false;
  private tool: Tool = 'select';
  private pendingSpawnByDraw: PendingSpawnByDraw | null = null;
  private activeGesture: ActiveGesture | null = null;
  private suppressTapPointerIds = new Set<number>();
  private readonly touchUi: boolean;
  private spawnEditNodeByDrawEnabled = false;
  private spawnInkNodeByDrawEnabled = false;
  private pdfAnnotationPlacement: PdfAnnotationPlacement | null = null;
  private textAnnotationPlacement: TextAnnotationPlacement | null = null;

  private readonly overlayHost: HTMLElement | null;
  private textLod2: TextLod2Overlay | null = null;
  private textLod2Target: { nodeId: string; mode: TextLod2Mode } | null = null;
  private textResizeHold: { nodeId: string; sig: string; expiresAt: number } | null = null;
  private textLod2HtmlCache: { nodeId: string; displayHash: string; html: string } | null = null;
  private textLod2HitZones: { nodeId: string; displayHash: string; zones: TextHitZone[] } | null = null;
  private textStreamLod2: TextLod2Overlay | null = null;
  private textStreamLod2Target: { nodeId: string; mode: TextLod2Mode } | null = null;
  private textStreamLod2HtmlCache: { nodeId: string; displayHash: string; html: string } | null = null;
  private nodeTextFontFamily =
    'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
  private nodeTextFontSizePx = 14;
  private nodeTextColor = 'rgba(255,255,255,0.92)';
  private nodeTextLineHeight = 1.55;
  private textScrollGutterPx: number | null = null;
  private textMeasureRoot: HTMLDivElement | null = null;
  private textStreamingAutoResizeRaf: number | null = null;
  private readonly textStreamingAutoResizeNodeIds = new Set<string>();

  private textSelectNodeId: string | null = null;
  private textSelectPointerId: number | null = null;
  private textSelectAnchor: Range | null = null;
  private textSelectRange: Range | null = null;
  private textSelectLastClient: { x: number; y: number } | null = null;
  private textSelectRaf: number | null = null;

  private hoverTextNodeId: string | null = null;
  private hoverPdfPage: { nodeId: string; token: number; pageNumber: number } | null = null;
  private hoverNodeHeaderButton: { nodeId: string; kind: 'menu' | 'reply' | 'stop' | 'send' | 'send_menu' } | null = null;

  private pdfTextLod2: PdfTextLod2Overlay | null = null;
  private pdfLod2Target: { nodeId: string; token: number; pageNumber: number } | null = null;

  private pdfSelectTarget: { nodeId: string; token: number; pageNumber: number } | null = null;
  private pdfSelectPointerId: number | null = null;
  private pdfSelectAnchor: Range | null = null;
  private pdfSelectRange: Range | null = null;
  private pdfSelectLastClient: { x: number; y: number } | null = null;
  private pdfSelectRaf: number | null = null;

  private readonly resizeHandleDrawPx = 12;
  private readonly resizeHandleHitPx = 22;
  private readonly resizeHandleHitPxTouch = 38;
  private readonly minNodeW = 160;
  private readonly minNodeH = 110;

  private lastTapAt = 0;
  private lastTapPos: Vec2 | null = null;
  private lastTapNodeId: string | null = null;

  private readonly textRasterQueueByNodeId = new Map<string, TextRasterJob>();
  private textRasterRunning = false;
  private textRasterGeneration = 0;

  private readonly attachmentThumbDataUrlByKey = new Map<
    string,
    { key: string; dataUrl: string; rev: number; size: number }
  >();
  private attachmentThumbDataUrlBytes = 0;
  private readonly attachmentThumbDataUrlInFlight = new Set<string>();
  private readonly attachmentThumbDataUrlFailed = new Set<string>();
  private readonly attachmentThumbDataUrlRevByKey = new Map<string, number>();
  private readonly attachmentThumbDataUrlMaxEntries = 220;
  private readonly attachmentThumbDataUrlMaxBytes = 32 * 1024 * 1024;

  private readonly textRasterCache = new Map<
    string,
    {
      key: string;
      sig: string;
      rasterScale: number;
      width: number;
      height: number;
      image: CanvasImageSource;
      bitmapBytesEstimate: number;
      hitZones?: TextHitZone[];
      readyAt: number;
    }
  >();
  private textRasterCacheBytes = 0;
  private readonly bestTextRasterKeyBySig = new Map<string, { key: string; rasterScale: number }>();
  private readonly textRasterCacheMaxEntries = 2500;
  private readonly textRasterCacheMaxBytes = 256 * 1024 * 1024;

  private pdfTokenSeq = 1;
  private readonly pdfStateByNodeId = new Map<string, PdfNodeState>();
  private readonly pdfPageRenderQueue = new Map<string, PdfPageRenderJob>();
  private pdfPageRenderRunning = false;
  private pdfDesiredRasterScale = 1;

  private readonly pdfPageCache = new Map<
    string,
    {
      key: string;
      nodeId: string;
      token: number;
      pageNumber: number;
      image: CanvasImageSource;
      pixelW: number;
      pixelH: number;
      bytesEstimate: number;
      readyAt: number;
    }
  >();
  private pdfPageCacheBytes = 0;
  private readonly pdfPageCacheMaxEntries = 220;
  private readonly pdfPageCacheMaxBytes = 192 * 1024 * 1024;
  private readonly pdfRasterScaleSteps = [0.25, 0.5, 1, 2] as const;

  private worldInkStrokes: InkStroke[] = [];

  private readonly nodes: WorldNode[] = [
    {
      kind: 'text',
      id: 'n1',
      parentId: null,
      rect: { x: 80, y: 80, w: 420, h: 260 },
      title: 'Text node (Markdown + LaTeX)',
      author: 'assistant',
      content: String.raw`Yes—here is the “one diagram” version, with the currying/product–exponential isomorphism made explicit.
I’ll write \(T:=\mathrm{Form}^\#_P\) (the \(\to\)-free term algebra) and \(X:=\mathrm{NNF}_P\). Let \(\mathrm{Pol}:=\{+,-\}\).

1) Two target algebras: pairs vs functions-of-polarity
(A) The pair algebra \(X\times X\)
This is Option A: interpret each formula \(\psi\) as a pair \((\psi^+,\psi^-)\).
Operations on \(X\times X\):

constants/literals (for \(A\in P\)):\[
  A \mapsto (A,\neg A),\quad
  \top\mapsto(\top,\bot),\quad
  \bot\mapsto(\bot,\top)
  \]
negation:\[
  \neg_{\times}(u,v) := (v,u)
  \]
conjunction/disjunction:\[
  (u_1,v_1)\wedge_{\times}(u_2,v_2) := (u_1\wedge u_2,\ v_1\vee v_2),
  \]\[
  (u_1,v_1)\vee_{\times}(u_2,v_2) := (u_1\vee u_2,\ v_1\wedge v_2).
  \]

(B) The function (exponential) algebra \(X^{\mathrm{Pol}}\)
This is Option B “in fold form”: interpret each formula \(\psi\) as a function \(\mathrm{Pol}\to X\), i.e. “given a polarity, produce the right NNF”.
Operations on \(X^{\mathrm{Pol}}\) (for \(f,g:\mathrm{Pol}\to X\)):

constants/literals (for \(A\in P\)):\[
  A \mapsto f_A\text{ where }f_A(+)=A,\ f_A(-)=\neg A,
  \]and similarly for \(\top,\bot\).
negation flips polarity:\[
  (\neg_{\exp} f)(\epsilon) := f(\overline{\epsilon})
  \]
conjunction/disjunction depend on polarity (De Morgan “built in”):\[
  (f\wedge_{\exp} g)(+):=f(+)\wedge g(+),\qquad (f\wedge_{\exp} g)(-):=f(-)\vee g(-),
  \]\[
  (f\vee_{\exp} g)(+):=f(+)\vee g(+),\qquad (f\vee_{\exp} g)(-):=f(-)\wedge g(-).
  \]


2) The isomorphism \(X^{\mathrm{Pol}}\cong X\times X\) (product–exponential)
Define
\[
\theta: X^{\mathrm{Pol}}\to X\times X,\qquad \theta(f):=(f(+),f(-)).
\]with inverse
\[
\theta^{-1}:X\times X\to X^{\mathrm{Pol}},\qquad
\theta^{-1}(u,v)(+)=u,\ \theta^{-1}(u,v)(-)=v.
\]Key fact: \(\theta\) is not just a bijection of sets; it is an isomorphism of \(\{\neg,\wedge,\vee\}\)-algebras, i.e. it respects the interpretations above:
\[
\theta(\neg_{\exp} f)=\neg_{\times}(\theta(f)),
\quad
\theta(f\wedge_{\exp} g)=\theta(f)\wedge_{\times}\theta(g),
\quad
\theta(f\vee_{\exp} g)=\theta(f)\vee_{\times}\theta(g),
\]and similarly for constants. (Each is a one-line check by evaluating at \(+\) and \(-\).)
This is the “transport across the isomorphism” part.

3) The commuting diagram (folds + currying in one place)
Because \(T=\mathrm{Form}^\#_P\) is initial for this signature, there are unique homomorphisms (folds)

\(k:T\to X^{\mathrm{Pol}}\) (Option B-as-fold), and
\(h:T\to X\times X\) (Option A).

And because \(\theta\) is an algebra homomorphism, \(\theta\circ k:T\to X\times X\) is also a homomorphism. By uniqueness of the fold into \(X\times X\), it must equal \(h\). That is exactly the commutativity:
\[
\boxed{h \;=\; \theta\circ k.}
\]To include currying/uncurrying explicitly, introduce the evaluation/selection maps

\(\mathrm{ev}:X^{\mathrm{Pol}}\times \mathrm{Pol}\to X\), \(\mathrm{ev}(f,\epsilon)=f(\epsilon)\),
\(\mathrm{choose}:(X\times X)\times \mathrm{Pol}\to X\), \(\mathrm{choose}((u,v),+)=u,\ \mathrm{choose}((u,v),-)=v\).

Then \(\mathrm{ev}\) corresponds to \(\mathrm{choose}\) through \(\theta\):
\[
\mathrm{ev} \;=\; \mathrm{choose}\circ(\theta\times \mathrm{id}_{\mathrm{Pol}}).
\]Now the single big commutative diagram is:
\[
\begin{array}{ccccc}
T\times \mathrm{Pol}
& \xrightarrow{\ k\times \mathrm{id}\ }
& X^{\mathrm{Pol}}\times \mathrm{Pol}
& \xrightarrow{\ \mathrm{ev}\ }
& X
\\
\Big\| & & \Big\downarrow{\ \theta\times \mathrm{id}\ } & & \Big\|
\\
T\times \mathrm{Pol}
& \xrightarrow{\ h\times \mathrm{id}\ }
& (X\times X)\times \mathrm{Pol}
& \xrightarrow{\ \mathrm{choose}\ }
& X
\end{array}
\]Reading it:

Top route: compute the fold \(k(\varphi)\in X^{\mathrm{Pol}}\), then uncurry by feeding a polarity \(\epsilon\) via \(\mathrm{ev}\).
Bottom route: compute the fold \(h(\varphi)\in X\times X\), then select a component via \(\mathrm{choose}\).
The square says these are the same computation because \(X^{\mathrm{Pol}}\cong X\times X\).

In particular, the actual NNF you want is
\[
\mathrm{NNF}(\varphi) = \mathrm{ev}(k(\varphi),+) = \mathrm{choose}(h(\varphi),+)=\pi_1(h(\varphi)).
\]
What this shows conceptually

“Option B” is the curried view: a fold into an exponential \(X^{\mathrm{Pol}}\).
“Option A” is the same fold after transporting along the canonical isomorphism \(X^{\{+,-\}}\cong X\times X\).
The fact you observed about identical traces is exactly this diagram: demanding only the \(+\) output corresponds to evaluating at \(+\) after currying, or projecting the first component after the product isomorphism.

If you want, I can also write the hom-set adjunction statement explicitly here:
\[
\mathrm{Hom}(T\times \mathrm{Pol},X)\ \cong\ \mathrm{Hom}(T,X^{\mathrm{Pol}})
\]and show that the uncurried map \((\varphi,\epsilon)\mapsto \mathrm{nnf}(\varphi,\epsilon)\) corresponds under this bijection to the fold \(k:T\to X^{\mathrm{Pol}}\)."
      `,
      contentHash: '',
      displayHash: '',
    },
    {
      kind: 'pdf',
      id: 'n2',
      parentId: null,
      rect: { x: 540, y: 140, w: 680, h: 220 },
      title: 'PDF node',
      fileName: null,
      pageCount: 0,
      status: 'empty',
      error: null,
    },
    {
      kind: 'ink',
      id: 'n3',
      parentId: null,
      rect: { x: 240, y: 390, w: 360, h: 240 },
      title: 'Ink node (vector → bitmap)',
      strokes: [],
      raster: null,
    },
  ];

  private readonly stressTestSeedContent: string =
    this.nodes.find((node): node is TextNode => node.kind === 'text' && node.id === 'n1')?.content ??
    '# Demo\n\nSome *markdown* + emoji :sparkles:\n\nInline math $E=mc^2$ and display:\n\n$$\\int_0^1 x^2\\,dx=\\frac{1}{3}$$\n';

  private nodeSeq = 1;

  constructor(opts: {
    canvas: HTMLCanvasElement;
    overlayHost?: HTMLElement | null;
    inputEl?: HTMLElement | null;
    inputController?: { enablePointerCapture?: boolean };
  }) {
    this.canvas = opts.canvas;
    this.overlayHost = opts.overlayHost ?? this.canvas.parentElement;
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Missing 2D canvas context');
    this.ctx = ctx;

    // Mobile detection (used to enable "tap-to-read/scroll" DOM overlays).
    this.touchUi = (() => {
      if (typeof window === 'undefined') return false;
      if (typeof window.matchMedia !== 'function') return false;
      try {
        return (
          window.matchMedia('(pointer: coarse)').matches ||
          window.matchMedia('(hover: none)').matches ||
          window.matchMedia('(any-hover: none)').matches
        );
      } catch {
        return false;
      }
    })();

    const inputEl = opts.inputEl ?? this.canvas;
    this.input = new InputController(inputEl, this.camera, {
      onChange: () => this.requestRender(),
      onInteractingChange: (v) => {
        this.interacting = v;
        this.requestRender();
        if (!v) {
          this.kickTextRasterQueue();
          this.kickPdfPageRenderQueue();
        }
        this.emitDebug({ force: true });
      },
      onPointerDown: (p, info) => this.handlePointerDown(p, info),
      onPointerMove: (p, info) => this.handlePointerMove(p, info),
      onPointerUp: (p, info) => this.handlePointerUp(p, info),
      onPointerCancel: (info) => this.handlePointerCancel(info),
      onTap: (p, info) => this.handleTap(p, info),
    }, opts.inputController);

    // Initialize hashes for seeded nodes.
    for (const n of this.nodes) {
      if (n.kind === 'text') {
        n.contentHash = fingerprintText(n.content);
        this.recomputeTextNodeDisplayHash(n);
      }
    }
  }

  exportChatState(): WorldEngineChatState {
    const nodes: ChatNode[] = this.nodes.map((n) => {
      if (n.kind === 'text') {
        return {
          kind: 'text',
          id: n.id,
          title: n.title,
          parentId: n.parentId,
          ...(n.parentAnchor ? { parentAnchor: { ...n.parentAnchor } } : {}),
          rect: { ...n.rect },
          ...(n.isEditNode ? { isEditNode: true } : {}),
          author: n.author,
          content: n.content,
          ...(n.userPreface ? { userPreface: n.userPreface } : {}),
          ...(n.collapsedPrefaceContexts ? { collapsedPrefaceContexts: n.collapsedPrefaceContexts } : {}),
          isGenerating: n.isGenerating,
          modelId: n.modelId ?? null,
          llmParams: n.llmParams,
          llmError: n.llmError ?? null,
          llmTask: n.llmTask,
          apiRequest: n.apiRequest,
          apiResponse: n.apiResponse,
          canonicalMessage: n.canonicalMessage,
          canonicalMeta: n.canonicalMeta,
          thinkingSummary: n.thinkingSummary,
          summaryExpanded: n.summaryExpanded,
          expandedSummaryChunks: n.expandedSummaryChunks,
          contentScrollY: n.contentScrollY,
          attachments: Array.isArray(n.attachments) ? n.attachments : undefined,
          selectedAttachmentKeys: Array.isArray(n.selectedAttachmentKeys) ? n.selectedAttachmentKeys : undefined,
        };
      }
      if (n.kind === 'pdf') {
        return {
          kind: 'pdf',
          id: n.id,
          title: n.title,
          parentId: n.parentId,
          ...(n.parentAnchor ? { parentAnchor: { ...n.parentAnchor } } : {}),
          rect: { ...n.rect },
          fileName: n.fileName,
          storageKey: (n as any).storageKey ?? null,
          pageCount: n.pageCount,
          status: n.status,
          error: n.error,
        };
      }
      return {
        kind: 'ink',
        id: n.id,
        title: n.title,
        parentId: n.parentId,
        ...(n.parentAnchor ? { parentAnchor: { ...n.parentAnchor } } : {}),
        rect: { ...n.rect },
        strokes: n.strokes.map((s) => ({
          width: s.width,
          color: s.color,
          points: s.points.map((p) => ({ x: p.x, y: p.y })),
        })),
      };
    });

    const worldInkStrokes = this.worldInkStrokes.map((s) => ({
      width: s.width,
      color: s.color,
      points: s.points.map((p) => ({ x: p.x, y: p.y })),
    }));

    const pdfNodeIds = new Set<string>();
    for (const n of nodes) if (n.kind === 'pdf') pdfNodeIds.add(n.id);
    const pdfStates = Array.from(this.pdfStateByNodeId.entries())
      .filter(([nodeId]) => pdfNodeIds.has(nodeId))
      .map(([nodeId, state]) => ({ nodeId, state }));

    return {
      camera: { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom },
      nodes,
      worldInkStrokes,
      pdfStates,
    };
  }

  loadChatState(next: WorldEngineChatState): void {
    // Tear down any active interactions/overlays first to avoid dangling DOM selection.
    this.editingNodeId = null;
    this.selectedNodeId = null;
    this.activeGesture = null;
    this.textResizeHold = null;
    this.textLod2HtmlCache = null;
    this.textStreamLod2HtmlCache = null;
    this.hoverTextNodeId = null;
    this.hoverPdfPage = null;
    this.textLod2Target = null;
    this.textStreamLod2Target = null;
    this.pdfLod2Target = null;

    this.clearTextSelection({ suppressOverlayCallback: true });
    this.clearPdfTextSelection({ suppressOverlayCallback: true });
    try {
      this.textLod2?.hide();
      this.textStreamLod2?.hide();
      this.pdfTextLod2?.hide();
    } catch {
      // ignore
    }

    // Cancel queued work from the previous chat.
    this.textRasterGeneration += 1;
    this.textRasterQueueByNodeId.clear();
    this.pdfPageRenderQueue.clear();

    // Replace runtime PDF state map (docs/metas) for the new chat.
    this.pdfStateByNodeId.clear();
    for (const entry of next.pdfStates) {
      if (!entry?.nodeId || !entry.state) continue;
      this.pdfStateByNodeId.set(entry.nodeId, entry.state);
    }

    // Replace node list.
    this.nodes.length = 0;
    for (const n of next.nodes) {
      const parentId = ((n as any)?.parentId as string | null | undefined) ?? null;
      const parentAnchor = (() => {
        const raw = (n as any)?.parentAnchor as any;
        if (!raw || typeof raw !== 'object') return undefined;
        if (raw.kind !== 'pdf-selection') return undefined;
        const pageNumberRaw = Number(raw.pageNumber);
        const yPctRaw = Number(raw.yPct);
        if (!Number.isFinite(pageNumberRaw) || !Number.isFinite(yPctRaw)) return undefined;
        const pageNumber = Math.max(1, Math.floor(pageNumberRaw));
        const yPct = clamp(yPctRaw, 0, 1);
        return { kind: 'pdf-selection', pageNumber, yPct } as ParentAnchor;
      })();
      if (n.kind === 'text') {
        const content = typeof n.content === 'string' ? n.content : String(n.content ?? '');
        const isEditNode = Boolean((n as any)?.isEditNode) || n.id.startsWith('n');
        const rawAuthor = (n as any)?.author;
        const author: ChatAuthor =
          rawAuthor === 'user' || rawAuthor === 'assistant'
            ? rawAuthor
            : (() => {
                const t = String((n as any)?.title ?? '');
                const lt = t.toLowerCase();
                if (lt.includes('user')) return 'user';
                if (lt.includes('assistant')) return 'assistant';
                return 'assistant';
                  })();
        const userPreface = (() => {
          const raw = (n as any)?.userPreface;
          if (!raw || typeof raw !== 'object') return undefined;
          const replyTo = typeof (raw as any)?.replyTo === 'string' ? String((raw as any).replyTo).trim() : '';
          const ctxRaw = Array.isArray((raw as any)?.contexts) ? ((raw as any).contexts as any[]) : [];
          const contexts = ctxRaw.map((t) => String(t ?? '').trim()).filter(Boolean);
          if (!replyTo && contexts.length === 0) return undefined;
          return {
            ...(replyTo ? { replyTo } : {}),
            ...(contexts.length ? { contexts } : {}),
          };
        })();
        const collapsedPrefaceContexts = (() => {
          const raw = (n as any)?.collapsedPrefaceContexts;
          if (!raw || typeof raw !== 'object') return undefined;
          const out: Record<number, boolean> = {};
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            const idx = Number(k);
            if (!Number.isFinite(idx)) continue;
            if (v) out[idx] = true;
          }
          return Object.keys(out).length ? out : undefined;
        })();
        const thinkingSummary = (() => {
          const raw = (n as any)?.thinkingSummary;
          if (!Array.isArray(raw)) return undefined;
          const out: ThinkingSummaryChunk[] = [];
          for (const item of raw) {
            const summaryIndex = Number((item as any)?.summaryIndex);
            const text = typeof (item as any)?.text === 'string' ? (item as any).text : String((item as any)?.text ?? '');
            const done = Boolean((item as any)?.done);
            if (!Number.isFinite(summaryIndex)) continue;
            out.push({ summaryIndex, text, done });
          }
          return out.length ? out : undefined;
        })();
        const expandedSummaryChunks = (() => {
          const raw = (n as any)?.expandedSummaryChunks;
          if (!raw || typeof raw !== 'object') return undefined;
          const out: Record<number, boolean> = {};
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            const idx = Number(k);
            if (!Number.isFinite(idx)) continue;
            if (v) out[idx] = true;
          }
          return Object.keys(out).length ? out : undefined;
        })();
        const contentScrollY = (() => {
          const raw = Number((n as any)?.contentScrollY);
          if (!Number.isFinite(raw)) return undefined;
          const v = Math.max(0, Math.round(raw));
          return v > 0 ? v : undefined;
        })();
	        const canonicalMessage = (() => {
	          const raw = (n as any)?.canonicalMessage;
	          if (!raw || typeof raw !== 'object') return undefined;
	          if ((raw as any).role !== 'assistant') return undefined;
	          const text = typeof (raw as any).text === 'string' ? (raw as any).text : '';
	          return text ? ({ role: 'assistant', text } as CanonicalAssistantMessage) : undefined;
	        })();
	        const llmTask = (() => {
	          const raw = (n as any)?.llmTask;
	          if (!raw || typeof raw !== 'object') return undefined;
	          const provider = typeof (raw as any).provider === 'string' ? (raw as any).provider : '';
	          const kind = typeof (raw as any).kind === 'string' ? (raw as any).kind : '';
	          if (!provider || !kind) return undefined;
	          const taskId = typeof (raw as any).taskId === 'string' ? (raw as any).taskId : undefined;
	          const cancelable = typeof (raw as any).cancelable === 'boolean' ? (raw as any).cancelable : undefined;
	          const background = typeof (raw as any).background === 'boolean' ? (raw as any).background : undefined;
	          const lastEventSeqRaw = (raw as any).lastEventSeq;
	          const lastEventSeq = typeof lastEventSeqRaw === 'number' && Number.isFinite(lastEventSeqRaw) ? lastEventSeqRaw : undefined;
	          return {
	            provider,
	            kind,
	            ...(taskId ? { taskId } : {}),
	            ...(cancelable !== undefined ? { cancelable } : {}),
	            ...(background !== undefined ? { background } : {}),
	            ...(lastEventSeq !== undefined ? { lastEventSeq } : {}),
	          } as ChatLlmTask;
	        })();
	        const node: TextNode = {
	          kind: 'text',
	          id: n.id,
	          parentId,
	          ...(parentAnchor ? { parentAnchor } : {}),
          rect: { ...n.rect },
          title: n.title,
          ...(isEditNode ? { isEditNode: true } : {}),
	          author,
	          content,
	          ...(userPreface ? { userPreface } : {}),
          collapsedPrefaceContexts,
          contentHash: fingerprintText(content),
          displayHash: '',
          isGenerating: Boolean((n as any)?.isGenerating),
	          modelId: typeof (n as any)?.modelId === 'string' ? ((n as any).modelId as string) : null,
	          llmParams:
	            (n as any)?.llmParams && typeof (n as any).llmParams === 'object'
	              ? ((n as any).llmParams as ChatLlmParams)
	              : undefined,
	          llmError: typeof (n as any)?.llmError === 'string' ? ((n as any).llmError as string) : null,
	          llmTask,
	          apiRequest: (n as any)?.apiRequest,
	          apiResponse: (n as any)?.apiResponse,
	          canonicalMessage,
	          canonicalMeta: (n as any)?.canonicalMeta,
          thinkingSummary,
          summaryExpanded: Boolean((n as any)?.summaryExpanded),
          expandedSummaryChunks,
          contentScrollY,
          attachments: Array.isArray((n as any)?.attachments) ? ((n as any).attachments as ChatAttachment[]) : undefined,
          selectedAttachmentKeys: Array.isArray((n as any)?.selectedAttachmentKeys)
            ? ((n as any).selectedAttachmentKeys as string[])
            : undefined,
        };
        this.recomputeTextNodeDisplayHash(node);
        this.nodes.push(node);
        continue;
      }
      if (n.kind === 'pdf') {
        this.nodes.push({
          kind: 'pdf',
          id: n.id,
          parentId,
          ...(parentAnchor ? { parentAnchor } : {}),
          rect: { ...n.rect },
          title: n.title,
          fileName: n.fileName ?? null,
          storageKey: (n as any)?.storageKey ?? null,
          pageCount: n.pageCount ?? 0,
          status: n.status,
          error: n.error ?? null,
        });
        continue;
      }
      this.nodes.push({
        kind: 'ink',
        id: n.id,
        parentId,
        ...(parentAnchor ? { parentAnchor } : {}),
        rect: { ...n.rect },
        title: n.title,
        strokes: (n.strokes ?? []).map((s) => ({
          width: s.width,
          color: s.color,
          points: s.points.map((p) => ({ x: p.x, y: p.y })),
        })),
        raster: null,
      });
    }

    // Replace world ink strokes (not tied to a node).
    this.worldInkStrokes = (next.worldInkStrokes ?? []).map((s) => ({
      width: s.width,
      color: s.color,
      points: s.points.map((p) => ({ x: p.x, y: p.y })),
    }));

    // Replace camera.
    const cam = next.camera ?? { x: 0, y: 0, zoom: 1 };
    this.camera.x = Number.isFinite(cam.x) ? cam.x : 0;
    this.camera.y = Number.isFinite(cam.y) ? cam.y : 0;
    this.camera.setZoom(Number.isFinite(cam.zoom) ? cam.zoom : 1);

    this.requestRender();
    this.emitUiState();
  }

  spawnLatexStressTest(count: number): void {
    const n = Math.max(0, Math.min(5000, Math.floor(count)));
    if (n === 0) return;

    const center = this.camera.screenToWorld({ x: this.cssW * 0.5, y: this.cssH * 0.5 });
    const cols = Math.max(1, Math.min(30, Math.ceil(Math.sqrt(n))));
    const rows = Math.max(1, Math.ceil(n / cols));

    // Node dimensions for the stress test grid.
    // If you change these, spacing updates automatically to prevent overlap.
    const nodeW = 1000;
    const nodeH = 1000;
    const gapX = 40;
    const gapY = 40;
    const spacingX = nodeW + gapX;
    const spacingY = nodeH + gapY;
    const startX = center.x - (cols - 1) * 0.5 * spacingX;
    const startY = center.y - (rows - 1) * 0.5 * spacingY;

    const content = this.stressTestSeedContent;

    for (let i = 0; i < n; i++) {
      const id = `t${Date.now().toString(36)}-${(this.nodeSeq++).toString(36)}`;
      const col = i % cols;
      const row = Math.floor(i / cols);
	      const node: TextNode = {
	        kind: 'text',
	        id,
	        parentId: null,
	        rect: { x: startX + col * spacingX, y: startY + row * spacingY, w: nodeW, h: nodeH },
	        title: 'Text node (Markdown + LaTeX)',
	        author: 'assistant',
	        content,
	        contentHash: fingerprintText(content),
	        displayHash: '',
	      };
	      this.recomputeTextNodeDisplayHash(node);
	      this.nodes.push(node);
	    }

    // Close editor so the canvas is the thing being tested.
    this.selectedNodeId = null;
    this.editingNodeId = null;
    this.textRasterGeneration += 1;

    this.requestRender();
    this.emitUiState();
  }

  clearStressNodes(): void {
    this.clearSelection();
    for (const node of this.nodes) {
      if (node.kind === 'pdf') this.disposePdfNode(node.id);
    }
    this.nodes.length = 0;
    this.worldInkStrokes = [];
    this.requestRender();
    this.emitUiState();
  }

  autoResizeAllTextNodes(): void {
    if (this.nodes.length === 0) return;

    let anyResized = false;
    for (const node of this.nodes) {
      if (node.kind !== 'text') continue;

      const cx = node.rect.x + node.rect.w * 0.5;
      const cy = node.rect.y + node.rect.h * 0.5;

      const changed = this.applySpawnAutoSizeToTextNode(node, { mode: 'set_exact' });
      if (!changed) continue;

      node.rect.x = cx - node.rect.w * 0.5;
      node.rect.y = cy - node.rect.h * 0.5;
      anyResized = true;
    }

    if (anyResized) this.requestRender();
  }

  canonicalizeLayout(algorithm: CanonicalizeLayoutAlgorithm): void {
    const alg: CanonicalizeLayoutAlgorithm = algorithm === 'reingold-tilford' ? 'reingold-tilford' : 'layered';
    if (this.nodes.length === 0) return;

    const byId = new Map<string, ChatNode>();
    const childrenById = new Map<string, string[]>();

    for (const node of this.nodes) {
      byId.set(node.id, node);
      childrenById.set(node.id, []);
    }

    for (const node of this.nodes) {
      const parentId = node.parentId;
      if (!parentId) continue;
      const children = childrenById.get(parentId);
      if (children) children.push(node.id);
    }

    const visited = new Set<string>();
    const groups: Array<{ ids: string[]; minX: number; minY: number; maxX: number; maxY: number }> = [];

    for (const node of this.nodes) {
      const id = node.id;
      if (visited.has(id)) continue;

      const queue: string[] = [id];
      const groupIds: string[] = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (let qi = 0; qi < queue.length; qi++) {
        const curId = queue[qi]!;
        if (visited.has(curId)) continue;
        const cur = byId.get(curId);
        if (!cur) continue;

        visited.add(curId);
        groupIds.push(curId);

        const r = cur.rect;
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w);
        maxY = Math.max(maxY, r.y + r.h);

        const parentId = cur.parentId;
        if (parentId && byId.has(parentId)) queue.push(parentId);

        const children = childrenById.get(curId);
        if (children && children.length) {
          for (const cid of children) queue.push(cid);
        }
      }

      if (groupIds.length) groups.push({ ids: groupIds, minX, minY, maxX, maxY });
    }

    if (groups.length === 0) return;

    const commit = (nid: string, x: number, y: number) => {
      const n = byId.get(nid);
      if (!n) return;
      n.rect.x = x;
      n.rect.y = y;
    };

    for (const g of groups) {
      const groupSet = new Set(g.ids);
      const rootCandidates = g.ids.filter((nid) => {
        const n = byId.get(nid);
        if (!n) return false;
        const pid = n.parentId;
        return !pid || !groupSet.has(pid);
      });
      const rootId = rootCandidates[0] ?? g.ids[0];

      const baseTop = g.minY;
      const baseLeft = g.minX;
      const parentChildGapY = CANONICALIZE_LAYOUT_PARENT_CHILD_GAP_Y;

      if (alg === 'layered') {
        const nodeWidth = new Map<string, number>();
        const nodeHeight = new Map<string, number>();
        const subtreeWidth = new Map<string, number>();

        const measure = (nid: string): number => {
          const n = byId.get(nid);
          if (!n) return 0;

          const w = Math.max(1, n.rect.w);
          const h = Math.max(1, n.rect.h);
          nodeWidth.set(nid, w);
          nodeHeight.set(nid, h);

          const children = (childrenById.get(nid) ?? []).filter((cid) => groupSet.has(cid));
          if (children.length === 0) {
            subtreeWidth.set(nid, w);
            return w;
          }

          let totalChildren = 0;
          for (const cid of children) totalChildren += measure(cid);
          const spacing = CANONICALIZE_LAYOUT_NODE_SPACING_X * (children.length - 1);
          const total = Math.max(w, totalChildren + spacing);
          subtreeWidth.set(nid, total);
          return total;
        };

        measure(rootId);

        const place = (nid: string, left: number, y: number) => {
          const n = byId.get(nid);
          if (!n) return;

          const w = nodeWidth.get(nid) ?? Math.max(1, n.rect.w);
          const h = nodeHeight.get(nid) ?? Math.max(1, n.rect.h);
          const W = subtreeWidth.get(nid) ?? w;

          const x = left + (W - w) / 2;
          commit(nid, x, y);

          const children = (childrenById.get(nid) ?? []).filter((cid) => groupSet.has(cid));
          if (children.length === 0) return;

          const childWidths = children.map((cid) => subtreeWidth.get(cid) ?? 0);
          const childrenSpan =
            childWidths.reduce((a, b) => a + b, 0) + CANONICALIZE_LAYOUT_NODE_SPACING_X * (children.length - 1);
          let childLeft = left + (W - childrenSpan) / 2;
          const childY = y + h + parentChildGapY;

          for (let i = 0; i < children.length; i++) {
            const cid = children[i]!;
            const cw = subtreeWidth.get(cid) ?? 0;
            place(cid, childLeft, childY);
            childLeft += cw + CANONICALIZE_LAYOUT_NODE_SPACING_X;
          }
        };

        place(rootId, baseLeft, baseTop);
        continue;
      }

      // Reingold-Tilford tidy tree drawing (Buchheim et al.)
      const nodeWidth = new Map<string, number>();
      const nodeHeight = new Map<string, number>();

      const measured = new Set<string>();
      const measure = (nid: string) => {
        if (measured.has(nid)) return;
        measured.add(nid);
        const n = byId.get(nid);
        if (!n) return;
        nodeWidth.set(nid, Math.max(1, n.rect.w));
        nodeHeight.set(nid, Math.max(1, n.rect.h));
        const children = (childrenById.get(nid) ?? []).filter((cid) => groupSet.has(cid));
        for (const cid of children) measure(cid);
      };

      measure(rootId);

      type LayoutNode = {
        id: string;
        width: number;
        parent: LayoutNode | null;
        children: LayoutNode[];
        prelim: number;
        mod: number;
        shift: number;
        change: number;
        thread: LayoutNode | null;
        ancestor: LayoutNode;
        number: number;
      };

      const built = new Set<string>();
      const build = (nid: string, parent: LayoutNode | null, number: number): LayoutNode => {
        const width = nodeWidth.get(nid) ?? Math.max(1, byId.get(nid)?.rect.w ?? 1);
        const v: LayoutNode = {
          id: nid,
          width,
          parent,
          children: [],
          prelim: 0,
          mod: 0,
          shift: 0,
          change: 0,
          thread: null,
          ancestor: null as any,
          number,
        };
        v.ancestor = v;
        if (built.has(nid)) return v;
        built.add(nid);
        const children = (childrenById.get(nid) ?? []).filter((cid) => groupSet.has(cid));
        v.children = children.map((cid, idx) => build(cid, v, idx + 1));
        return v;
      };

      const leftSibling = (v: LayoutNode): LayoutNode | null => {
        if (!v.parent) return null;
        if (v.number <= 1) return null;
        return v.parent.children[v.number - 2] ?? null;
      };

      const leftMostSibling = (v: LayoutNode): LayoutNode | null => {
        if (!v.parent || v.parent.children.length === 0) return null;
        return v.parent.children[0];
      };

      const nextLeft = (v: LayoutNode): LayoutNode | null => {
        if (v.children.length > 0) return v.children[0]!;
        return v.thread;
      };

      const nextRight = (v: LayoutNode): LayoutNode | null => {
        if (v.children.length > 0) return v.children[v.children.length - 1]!;
        return v.thread;
      };

      const distance = (a: LayoutNode, b: LayoutNode) =>
        (a.width + b.width) / 2 + CANONICALIZE_LAYOUT_NODE_SPACING_X;

      const moveSubtree = (wl: LayoutNode, wr: LayoutNode, shift: number) => {
        const subtrees = wr.number - wl.number;
        if (subtrees <= 0) return;
        wr.change -= shift / subtrees;
        wr.shift += shift;
        wl.change += shift / subtrees;
        wr.prelim += shift;
        wr.mod += shift;
      };

      const executeShifts = (v: LayoutNode) => {
        let shift = 0;
        let change = 0;
        for (let i = v.children.length - 1; i >= 0; i--) {
          const w = v.children[i]!;
          w.prelim += shift;
          w.mod += shift;
          change += w.change;
          shift += w.shift + change;
        }
      };

      const ancestor = (vil: LayoutNode, v: LayoutNode, defaultAncestor: LayoutNode): LayoutNode => {
        if (vil.ancestor.parent === v.parent) return vil.ancestor;
        return defaultAncestor;
      };

      const apportion = (v: LayoutNode, defaultAncestor: LayoutNode): LayoutNode => {
        const w = leftSibling(v);
        if (!w) return defaultAncestor;

        let vir: LayoutNode = v;
        let vor: LayoutNode = v;
        let vil: LayoutNode = w;
        let vol: LayoutNode = leftMostSibling(v) ?? v;

        let sir = vir.mod;
        let sor = vor.mod;
        let sil = vil.mod;
        let sol = vol.mod;

        while (true) {
          const vilNext = nextRight(vil);
          const virNext = nextLeft(vir);
          if (!vilNext || !virNext) break;

          const volNext = nextLeft(vol);
          const vorNext = nextRight(vor);
          if (!volNext || !vorNext) break;

          vil = vilNext;
          vir = virNext;
          vol = volNext;
          vor = vorNext;
          vor.ancestor = v;

          const shift = (vil.prelim + sil) - (vir.prelim + sir) + distance(vil, vir);
          if (shift > 0) {
            const a = ancestor(vil, v, defaultAncestor);
            moveSubtree(a, v, shift);
            sir += shift;
            sor += shift;
          }

          sil += vil.mod;
          sir += vir.mod;
          sol += vol.mod;
          sor += vor.mod;
        }

        const vilNext = nextRight(vil);
        const vorNext = nextRight(vor);
        if (vilNext && !vorNext) {
          vor.thread = vilNext;
          vor.mod += sil - sor;
        }

        const virNext = nextLeft(vir);
        const volNext = nextLeft(vol);
        if (virNext && !volNext) {
          vol.thread = virNext;
          vol.mod += sir - sol;
          defaultAncestor = v;
        }

        return defaultAncestor;
      };

      const firstWalk = (v: LayoutNode) => {
        if (v.children.length === 0) {
          const w = leftSibling(v);
          v.prelim = w ? w.prelim + distance(v, w) : 0;
          return;
        }

        let defaultAncestor = v.children[0]!;
        for (const w of v.children) {
          firstWalk(w);
          defaultAncestor = apportion(w, defaultAncestor);
        }

        executeShifts(v);

        const first = v.children[0]!;
        const last = v.children[v.children.length - 1]!;
        const mid = (first.prelim + last.prelim) / 2;
        const w = leftSibling(v);
        if (w) {
          v.prelim = w.prelim + distance(v, w);
          v.mod = v.prelim - mid;
        } else {
          v.prelim = mid;
        }
      };

      const xCenterById = new Map<string, number>();
      const secondWalk = (v: LayoutNode, m: number) => {
        xCenterById.set(v.id, v.prelim + m);
        for (const w of v.children) secondWalk(w, m + v.mod);
      };

      const root = build(rootId, null, 1);
      firstWalk(root);
      secondWalk(root, 0);

      let minLeft = Infinity;
      for (const [nid, xCenter] of xCenterById) {
        const w = nodeWidth.get(nid) ?? Math.max(1, byId.get(nid)?.rect.w ?? 1);
        minLeft = Math.min(minLeft, xCenter - w / 2);
      }

      const shiftX = baseLeft - (Number.isFinite(minLeft) ? minLeft : 0);

      const yById = new Map<string, number>();
      const placedY = new Set<string>();
      const assignY = (nid: string, y: number) => {
        if (placedY.has(nid)) return;
        placedY.add(nid);
        yById.set(nid, y);
        const n = byId.get(nid);
        if (!n) return;
        const h = nodeHeight.get(nid) ?? Math.max(1, n.rect.h);
        const children = (childrenById.get(nid) ?? []).filter((cid) => groupSet.has(cid));
        const childY = y + h + parentChildGapY;
        for (const cid of children) assignY(cid, childY);
      };

      assignY(rootId, baseTop);
      for (const [nid, xCenter] of xCenterById) {
        const n = byId.get(nid);
        if (!n) continue;
        const w = nodeWidth.get(nid) ?? Math.max(1, n.rect.w);
        const y = yById.get(nid) ?? baseTop;
        commit(nid, xCenter - w / 2 + shiftX, y);
      }
    }

    this.requestRender();
  }

  setTool(tool: Tool): void {
    const next: Tool = tool === 'draw' ? 'draw' : tool === 'erase' ? 'erase' : 'select';
    if (this.tool === next) return;
    this.tool = next;
    this.requestRender();
    this.emitUiState();
  }

  setAllowEditingAllTextNodes(enabled: boolean): void {
    this.allowEditingAllTextNodes = Boolean(enabled);
  }

  setSpawnEditNodeByDrawEnabled(enabled: boolean): void {
    this.spawnEditNodeByDrawEnabled = Boolean(enabled);
  }

  setSpawnInkNodeByDrawEnabled(enabled: boolean): void {
    this.spawnInkNodeByDrawEnabled = Boolean(enabled);
  }

  cancelPdfAnnotationPlacement(): boolean {
    const hadPlacement = this.pdfAnnotationPlacement != null;
    const g = this.activeGesture;
    const hadActive =
      (g && g.kind === 'spawn-by-draw' && g.pdfAnnotation) ||
      (g && (g.kind === 'pdf-annotation-place' || g.kind === 'pdf-annotation-outline-resize'));
    if (!hadPlacement && !hadActive) return false;
    if (hadActive) this.activeGesture = null;
    this.pdfAnnotationPlacement = null;
    this.requestRender();
    return true;
  }

  cancelTextAnnotationPlacement(): boolean {
    const hadPlacement = this.textAnnotationPlacement != null;
    const g = this.activeGesture;
    const hadActive =
      (g && g.kind === 'spawn-by-draw' && g.textAnnotation) ||
      (g && (g.kind === 'text-annotation-place' || g.kind === 'text-annotation-outline-resize'));
    if (!hadPlacement && !hadActive) return false;
    if (hadActive) this.activeGesture = null;
    this.textAnnotationPlacement = null;
    this.requestRender();
    return true;
  }

  setRawViewerNodeId(nodeId: string | null): void {
    const next = typeof nodeId === 'string' ? nodeId : null;
    if (this.rawViewerNodeId === next) return;
    this.rawViewerNodeId = next;

    // Close any text selection / menus on the node being covered.
    if (next && this.textSelectNodeId === next) this.clearTextSelection({ suppressOverlayCallback: true });

    this.requestRender();
  }

  setEdgeRouter(id: unknown): void {
    const next = normalizeEdgeRouterId(id);
    if (this.edgeRouterId === next) return;
    this.edgeRouterId = next;
    this.requestRender();
  }

  setReplyArrowColor(color: string): void {
    const raw = typeof color === 'string' ? color.trim() : '';
    if (!raw) return;
    let next = '';
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
      next = raw.toLowerCase();
    } else if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
      next = `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
    } else {
      return;
    }
    if (this.replyArrowColor === next) return;
    this.replyArrowColor = next;
    this.requestRender();
  }

  setReplyArrowOpacity(opacity: number): void {
    const raw = Number(opacity);
    const next = clamp(Number.isFinite(raw) ? raw : 1, 0, 1);
    if (Math.abs(next - this.replyArrowOpacity) < 0.001) return;
    this.replyArrowOpacity = next;
    this.requestRender();
  }

  setGlassNodesEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.glassNodesEnabled === next) return;
    this.glassNodesEnabled = next;
    this.requestRender();
  }

  setGlassNodesBlurCssPx(blurCssPx: number): void {
    const raw = Number(blurCssPx);
    const next = clamp(Number.isFinite(raw) ? raw : 0, 0, 30);
    if (Math.abs(next - this.glassBlurCssPx) < 0.001) return;
    this.glassBlurCssPx = next;
    this.requestRender();
  }

  setGlassNodesSaturatePct(saturatePct: number): void {
    const raw = Number(saturatePct);
    const next = clamp(Number.isFinite(raw) ? raw : 100, 100, 200);
    if (Math.abs(next - this.glassSaturatePct) < 0.001) return;
    this.glassSaturatePct = next;
    this.requestRender();
  }

  setGlassNodesUnderlayAlpha(alpha: number): void {
    const raw = Number(alpha);
    const next = clamp(Number.isFinite(raw) ? raw : 0, 0, 1);
    if (Math.abs(next - this.glassUnderlayAlpha) < 0.001) return;
    this.glassUnderlayAlpha = next;
    this.requestRender();
  }

  setGlassNodesBlurBackend(backend: GlassBlurBackend): void {
    const next: GlassBlurBackend = backend === 'canvas' ? 'canvas' : 'webgl';
    if (this.glassBlurBackend === next) return;
    this.glassBlurBackend = next;
    if (next === 'webgl') this.webglPreblurDisabled = false;
    this.backgroundCache = null;
    this.requestRender();
  }

  private nodeTextStyle(): { fontFamily: string; fontSizePx: number; lineHeight: number; color: string } {
    return {
      fontFamily: this.nodeTextFontFamily,
      fontSizePx: this.nodeTextFontSizePx,
      lineHeight: this.nodeTextLineHeight,
      color: this.nodeTextColor,
    };
  }

  private invalidateNodeTextRendering(): void {
    this.textRasterGeneration += 1;
    this.textRasterQueueByNodeId.clear();
    this.clearTextRasters();
    this.textResizeHold = null;
    this.textLod2HitZones = null;
    try {
      const style = this.nodeTextStyle();
      this.textLod2?.setBaseTextStyle(style);
      this.textStreamLod2?.setBaseTextStyle(style);
    } catch {
      // ignore
    }
    this.requestRender();
  }

  setNodeTextFontFamily(fontFamily: string): void {
    const next = typeof fontFamily === 'string' && fontFamily.trim() ? fontFamily.trim() : this.nodeTextFontFamily;
    if (next === this.nodeTextFontFamily) return;
    this.nodeTextFontFamily = next;
    this.invalidateNodeTextRendering();
  }

  setNodeTextFontSizePx(fontSizePx: number): void {
    const raw = Number(fontSizePx);
    const next = clamp(Number.isFinite(raw) ? raw : this.nodeTextFontSizePx, 6, 40);
    if (Math.abs(next - this.nodeTextFontSizePx) < 0.001) return;
    this.nodeTextFontSizePx = next;
    this.invalidateNodeTextRendering();
  }

  clearBackground(): void {
    this.backgroundLoadToken += 1;
    if (this.backgroundImage) this.closeImage(this.backgroundImage);
    this.backgroundImage = null;
    this.backgroundImageW = 0;
    this.backgroundImageH = 0;
    this.backgroundCache = null;
    this.backgroundVersion += 1;
    this.requestRender();
  }

  async setBackgroundFromBlob(blob: Blob): Promise<void> {
    const b = blob;
    if (!b) {
      this.clearBackground();
      return;
    }

    const token = (this.backgroundLoadToken += 1);
    const decoded = await this.decodeCanvasImageSourceFromBlob(b);
    if (token !== this.backgroundLoadToken) {
      if (decoded?.image) this.closeImage(decoded.image);
      return;
    }
    if (!decoded) {
      this.clearBackground();
      return;
    }

    if (this.backgroundImage) this.closeImage(this.backgroundImage);
    this.backgroundImage = decoded.image;
    this.backgroundImageW = decoded.w;
    this.backgroundImageH = decoded.h;
    this.backgroundCache = null;
    this.backgroundVersion += 1;
    this.requestRender();
  }

  private async decodeCanvasImageSourceFromBlob(
    blob: Blob,
  ): Promise<{ image: CanvasImageSource; w: number; h: number } | null> {
    const b = blob;
    if (!b) return null;

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(b);
        const w = Number.isFinite(bitmap.width) ? bitmap.width : 0;
        const h = Number.isFinite(bitmap.height) ? bitmap.height : 0;
        if (w > 0 && h > 0) return { image: bitmap, w, h };
        this.closeImage(bitmap);
      } catch {
        // fall back to HTMLImageElement
      }
    }

    if (typeof document === 'undefined') return null;
    const url = URL.createObjectURL(b);
    try {
      const img = new Image();
      (img as any).decoding = 'async';
      img.src = url;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load background image.'));
      });
      const w = Number.isFinite(img.naturalWidth) ? img.naturalWidth : 0;
      const h = Number.isFinite(img.naturalHeight) ? img.naturalHeight : 0;
      if (w > 0 && h > 0) return { image: img, w, h };
      return null;
    } finally {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
  }

  beginSpawnTextNodeByDraw(opts?: { title?: string; content?: string; author?: ChatAuthor }): void {
    const title = typeof opts?.title === 'string' ? opts.title : undefined;
    const content = typeof opts?.content === 'string' ? opts.content : undefined;
    const author: ChatAuthor | undefined = opts?.author === 'assistant' ? 'assistant' : opts?.author === 'user' ? 'user' : undefined;
    const normalized =
      title !== undefined || content !== undefined || author !== undefined
        ? { ...(title !== undefined ? { title } : {}), ...(content !== undefined ? { content } : {}), ...(author !== undefined ? { author } : {}) }
        : undefined;

    this.pendingSpawnByDraw = { kind: 'text', ...(normalized ? { opts: normalized } : {}) };
  }

  beginSpawnInkNodeByDraw(): void {
    this.pendingSpawnByDraw = { kind: 'ink' };
  }

  cancelSpawnByDraw(): boolean {
    const hadPending = this.pendingSpawnByDraw != null;
    const hadActive = this.activeGesture?.kind === 'spawn-by-draw';
    if (!hadPending && !hadActive) return false;
    this.pendingSpawnByDraw = null;
    if (hadActive) this.activeGesture = null;
    this.requestRender();
    return true;
  }

  spawnTextNode(opts?: { title?: string; content?: string; author?: ChatAuthor; rect?: Rect }): string {
    const title = typeof opts?.title === 'string' ? opts.title.trim() : '';
    const content = typeof opts?.content === 'string' ? opts.content : String(opts?.content ?? '');
    const author: ChatAuthor = opts?.author === 'assistant' ? 'assistant' : 'user';

    const id = `n${Date.now().toString(36)}-${(this.nodeSeq++).toString(36)}`;
    const nodeW = 460;
    const nodeH = 240;
    const explicitRect = this.normalizeSpawnRect(opts?.rect);
    const center = this.camera.screenToWorld({ x: this.cssW * 0.5, y: this.cssH * 0.5 });

    const node: TextNode = {
      kind: 'text',
      id,
      parentId: null,
      rect: explicitRect ?? { x: center.x - nodeW * 0.5, y: center.y - nodeH * 0.5, w: nodeW, h: nodeH },
      title: title || 'Text',
      isEditNode: true,
      author,
      content,
      contentHash: fingerprintText(content),
      displayHash: '',
    };

    // Avoid spawning directly on top of existing nodes in the current view.
    const gapY = 26;
    const gapX = 26;
    const candidate: Rect = { ...node.rect };

    // Keep new nodes visible (prevents off-screen editors, especially when a tall PDF node is present).
    const view = this.worldViewportRect();

    const tryPlaceBesidePdf = (pdfRect: Rect): Rect | null => {
      const stepY = nodeH + gapY;
      const yOffsets = [0, -stepY, stepY, -2 * stepY, 2 * stepY, -3 * stepY, 3 * stepY];
      const spaceLeft = pdfRect.x - view.x;
      const spaceRight = view.x + view.w - (pdfRect.x + pdfRect.w);
      const preferRight = spaceRight >= spaceLeft;
      const sides = preferRight
        ? [
            { name: 'right' as const, x: pdfRect.x + pdfRect.w + gapX },
            { name: 'left' as const, x: pdfRect.x - gapX - candidate.w },
          ]
        : [
            { name: 'left' as const, x: pdfRect.x - gapX - candidate.w },
            { name: 'right' as const, x: pdfRect.x + pdfRect.w + gapX },
          ];

      let best: { rect: Rect; overlapCount: number } | null = null;
      const countOverlaps = (r: Rect): number => {
        let count = 0;
        for (const n of this.nodes) {
          if (n.kind === 'pdf') continue;
          if (rectsIntersect(n.rect, r)) count += 1;
        }
        return count;
      };

      for (const side of sides) {
        for (const dy of yOffsets) {
          const raw: Rect = { x: side.x, y: candidate.y + dy, w: candidate.w, h: candidate.h };
          const clamped = this.clampRectToView(raw);

          // If we had to clamp horizontally, this side doesn't actually fit in view.
          if (Math.abs(clamped.x - raw.x) > 0.5) continue;

          if (this.nodes.some((n) => n.kind === 'pdf' && rectsIntersect(n.rect, clamped))) continue;

          const overlapCount = countOverlaps(clamped);
          if (overlapCount === 0) return clamped;

          if (!best || overlapCount < best.overlapCount) best = { rect: clamped, overlapCount };
        }
      }

      // If we can't fit beside, try above (keeps the node visible without ending up hidden under the PDF).
      const rawAbove: Rect = {
        x: candidate.x,
        y: pdfRect.y - gapY - candidate.h,
        w: candidate.w,
        h: candidate.h,
      };
      const above = this.clampRectToView(rawAbove);
      if (!this.nodes.some((n) => n.kind === 'pdf' && rectsIntersect(n.rect, above))) {
        const overlapCount = countOverlaps(above);
        if (overlapCount === 0) return above;
        if (!best || overlapCount < best.overlapCount) best = { rect: above, overlapCount };
      }

      return best?.rect ?? null;
    };

    if (!explicitRect) {
      for (let i = 0; i < 60; i += 1) {
        const pdfOverlap =
          (this.nodes.find((n) => n.kind === 'pdf' && rectsIntersect(n.rect, candidate)) as PdfNode | undefined) ?? null;
        const overlap = pdfOverlap ?? this.nodes.find((n) => rectsIntersect(n.rect, candidate)) ?? null;
        if (!overlap) break;
        if (overlap.kind === 'pdf') {
          const placed = tryPlaceBesidePdf(overlap.rect);
          if (placed) {
            candidate.x = placed.x;
            candidate.y = placed.y;
          }
          break;
        }
        candidate.y = overlap.rect.y + overlap.rect.h + gapY;
      }
    }

    const clamped = this.clampRectToView(candidate);
    node.rect = clamped;

    this.recomputeTextNodeDisplayHash(node);
    this.nodes.push(node);

    const changed = this.selectedNodeId !== id || this.editingNodeId !== id;
    this.selectedNodeId = id;
    this.editingNodeId = id;
    this.bringNodeToFront(id);
    this.requestRender();
    if (changed) this.emitUiState();
    try {
      this.onRequestPersist?.();
    } catch {
      // ignore
    }

    return id;
  }

  spawnInkNode(opts?: { rect?: Rect }): string {
    const id = `i${Date.now().toString(36)}-${(this.nodeSeq++).toString(36)}`;
    const center = this.camera.screenToWorld({ x: this.cssW * 0.5, y: this.cssH * 0.5 });
    const nodeW = 420;
    const nodeH = 280;
    const explicitRect = this.normalizeSpawnRect(opts?.rect, { maxW: INK_NODE_MAX_W_PX, maxH: INK_NODE_MAX_H_PX });
    const node: InkNode = {
      kind: 'ink',
      id,
      parentId: null,
      rect: explicitRect ?? { x: center.x - nodeW * 0.5, y: center.y - nodeH * 0.5, w: nodeW, h: nodeH },
      title: 'Ink node',
      strokes: [],
      raster: null,
    };
    if (explicitRect) node.rect = this.clampRectToView(node.rect);
    this.nodes.push(node);
    const changed = this.selectedNodeId !== id || this.editingNodeId !== null;
    this.selectedNodeId = id;
    this.editingNodeId = null;
    this.bringNodeToFront(id);
    this.requestRender();
    if (changed) this.emitUiState();
    try {
      this.onRequestPersist?.();
    } catch {
      // ignore
    }
    return id;
  }

  spawnChatTurn(args: {
    userText: string;
    parentNodeId: string | null;
    userPreface?: { replyTo?: string; contexts?: string[] };
    userAttachments?: ChatAttachment[];
    selectedAttachmentKeys?: string[];
    assistantTitle?: string;
    assistantModelId?: string | null;
  }): { userNodeId: string; assistantNodeId: string } {
    const userText = String(args.userText ?? '');
    const parentNodeId = args.parentNodeId ?? null;
    const userPreface = args.userPreface ?? undefined;
    const userAttachments = Array.isArray(args.userAttachments) ? args.userAttachments : [];
    const selectedAttachmentKeys = Array.isArray(args.selectedAttachmentKeys) ? args.selectedAttachmentKeys : [];
    const assistantTitle = typeof args.assistantTitle === 'string' ? args.assistantTitle : '';
    const assistantModelId = typeof args.assistantModelId === 'string' ? args.assistantModelId : null;

    const parent = parentNodeId ? this.nodes.find((n) => n.id === parentNodeId) ?? null : null;
    const resolvedParentId = parent ? parent.id : null;

    const now = Date.now().toString(36);
    const userNodeId = `u${now}-${(this.nodeSeq++).toString(36)}`;
    const assistantNodeId = `a${now}-${(this.nodeSeq++).toString(36)}`;

    const gapY = 26;

    const normalizedPreface = (() => {
      if (!userPreface || typeof userPreface !== 'object') return undefined;
      const replyTo = typeof userPreface.replyTo === 'string' ? userPreface.replyTo.trim() : '';
      const ctxRaw = Array.isArray(userPreface.contexts) ? userPreface.contexts : [];
      const contexts = ctxRaw.map((t) => String(t ?? '').trim()).filter(Boolean);
      if (!replyTo && contexts.length === 0) return undefined;
      return {
        ...(replyTo ? { replyTo } : {}),
        ...(contexts.length ? { contexts } : {}),
      };
    })();

    const userNode: TextNode = {
      kind: 'text',
      id: userNodeId,
      parentId: resolvedParentId,
      rect: { x: 0, y: 0, w: TEXT_NODE_SPAWN_MAX_W_PX, h: TEXT_NODE_SPAWN_MIN_H_PX },
      title: 'User',
      author: 'user',
      content: userText,
      ...(normalizedPreface ? { userPreface: normalizedPreface } : {}),
      contentHash: fingerprintText(userText),
      displayHash: '',
      attachments: userAttachments.length ? userAttachments : undefined,
      selectedAttachmentKeys: selectedAttachmentKeys.length ? selectedAttachmentKeys : undefined,
    };

    // Size the user node to content, clamped to spawn max (manual resizing can exceed later).
    this.applySpawnAutoSizeToTextNode(userNode, { mode: 'set_exact' });

    const assistantNode: TextNode = {
      kind: 'text',
      id: assistantNodeId,
      parentId: userNodeId,
      rect: { x: 0, y: 0, w: userNode.rect.w, h: TEXT_NODE_SPAWN_MIN_H_PX },
      title: assistantTitle.trim() || 'Assistant',
      author: 'assistant',
      content: '',
      contentHash: fingerprintText(''),
      displayHash: '',
      summaryExpanded: false,
      modelId: assistantModelId,
    };

    const nodeW = Math.max(userNode.rect.w, assistantNode.rect.w);
    const totalH = userNode.rect.h + gapY + assistantNode.rect.h;

    let x = 0;
    let userY = 0;
    if (parent) {
      x = parent.rect.x;
      userY = parent.rect.y + parent.rect.h + gapY;
    } else {
      const center = this.camera.screenToWorld({ x: this.cssW * 0.5, y: this.cssH * 0.5 });
      x = center.x - nodeW * 0.5;
      userY = center.y - totalH * 0.5;
    }

    // Avoid spawning directly on top of existing nodes in the current view.
    // This keeps "new tree" sends usable without layout work yet.
    const candidate: Rect = { x, y: userY, w: nodeW, h: totalH };
    for (let i = 0; i < 60; i += 1) {
      const overlap = this.nodes.find((n) => rectsIntersect(n.rect, candidate)) ?? null;
      if (!overlap) break;
      userY = overlap.rect.y + overlap.rect.h + gapY;
      candidate.y = userY;
    }

    userNode.rect.x = x;
    userNode.rect.y = userY;
    assistantNode.rect.x = x;
    assistantNode.rect.y = userY + userNode.rect.h + gapY;

    this.recomputeTextNodeDisplayHash(userNode);
    this.recomputeTextNodeDisplayHash(assistantNode);

    this.nodes.push(userNode, assistantNode);
    this.bringNodeToFront(assistantNodeId);

    const changed = this.selectedNodeId !== assistantNodeId || this.editingNodeId !== null;
    this.selectedNodeId = assistantNodeId;
    this.editingNodeId = null;

    this.textRasterGeneration += 1;
    this.requestRender();
    if (changed) this.emitUiState();

    return { userNodeId, assistantNodeId };
  }

  spawnAssistantTurn(args: {
    userNodeId: string;
    assistantTitle?: string;
    assistantModelId?: string | null;
  }): { assistantNodeId: string } | null {
    const userNodeId = typeof args.userNodeId === 'string' ? args.userNodeId : String(args.userNodeId ?? '');
    if (!userNodeId) return null;
    const assistantTitle = typeof args.assistantTitle === 'string' ? args.assistantTitle : '';
    const assistantModelId = typeof args.assistantModelId === 'string' ? args.assistantModelId : null;

    const userNode =
      this.nodes.find((n): n is TextNode | InkNode => (n.kind === 'text' || n.kind === 'ink') && n.id === userNodeId) ??
      null;
    if (!userNode) return null;

    const now = Date.now().toString(36);
    const assistantNodeId = `a${now}-${(this.nodeSeq++).toString(36)}`;
    const gapY = 26;

    const assistantNode: TextNode = {
      kind: 'text',
      id: assistantNodeId,
      parentId: userNodeId,
      rect: { x: userNode.rect.x, y: userNode.rect.y + userNode.rect.h + gapY, w: userNode.rect.w, h: TEXT_NODE_SPAWN_MIN_H_PX },
      title: assistantTitle.trim() || 'Assistant',
      author: 'assistant',
      content: '',
      contentHash: fingerprintText(''),
      displayHash: '',
      summaryExpanded: false,
      modelId: assistantModelId,
    };

    // Avoid spawning directly on top of existing nodes in the current view.
    const candidate: Rect = { ...assistantNode.rect };
    for (let i = 0; i < 60; i += 1) {
      const overlap = this.nodes.find((n) => rectsIntersect(n.rect, candidate)) ?? null;
      if (!overlap) break;
      candidate.y = overlap.rect.y + overlap.rect.h + gapY;
      assistantNode.rect.y = candidate.y;
    }

    this.recomputeTextNodeDisplayHash(assistantNode);
    this.nodes.push(assistantNode);
    this.bringNodeToFront(assistantNodeId);

    const changed = this.selectedNodeId !== assistantNodeId || this.editingNodeId !== null;
    this.selectedNodeId = assistantNodeId;
    this.editingNodeId = null;

    this.textRasterGeneration += 1;
    this.requestRender();
    if (changed) this.emitUiState();

    return { assistantNodeId };
  }

  clearWorldInk(): void {
    if (this.worldInkStrokes.length === 0) return;
    this.worldInkStrokes = [];
    this.requestRender();
  }

  async importPdfFromFile(file: File, opts?: { storageKey?: string | null }): Promise<void> {
    const f = file;
    if (!f) return;

    const storageKey = opts?.storageKey ?? null;
    const id = `p${Date.now().toString(36)}-${(this.nodeSeq++).toString(36)}`;
    const center = this.camera.screenToWorld({ x: this.cssW * 0.5, y: this.cssH * 0.5 });
    const nodeW = 680;
    const nodeH = 220;
    const node: PdfNode = {
      kind: 'pdf',
      id,
      parentId: null,
      rect: { x: center.x - nodeW * 0.5, y: center.y - 120, w: nodeW, h: nodeH },
      title: f.name || 'PDF',
      fileName: f.name || null,
      storageKey,
      pageCount: 0,
      status: 'loading',
      error: null,
    };

    this.nodes.push(node);
    const selectionChanged = this.selectedNodeId !== id || this.editingNodeId !== null;
    this.selectedNodeId = id;
    this.editingNodeId = null;
    this.bringNodeToFront(id);
    this.requestRender();
    if (selectionChanged) this.emitUiState();

    const token = this.pdfTokenSeq++;
    try {
      const buf = await f.arrayBuffer();
      const doc = await loadPdfDocument(buf);

      const state: PdfNodeState = {
        token,
        doc,
        pageCount: doc.numPages,
        metas: new Array(doc.numPages).fill(null),
        defaultAspect: 1.414,
      };
      this.pdfStateByNodeId.set(id, state);

      node.pageCount = doc.numPages;
      node.status = 'ready';
      node.error = null;
      node.title = `${node.fileName ?? 'PDF'} (${doc.numPages}p)`;

      this.requestRender();
      void this.prefetchPdfMetas(id, token);
    } catch (err: any) {
      node.status = 'error';
      node.error = err ? String(err?.message ?? err) : 'Failed to load PDF';
      this.requestRender();
    }
  }

  async hydratePdfNodeFromArrayBuffer(args: {
    nodeId: string;
    buffer: ArrayBuffer;
    fileName?: string | null;
    storageKey?: string | null;
  }): Promise<void> {
    const node = this.nodes.find((n): n is PdfNode => n.kind === 'pdf' && n.id === args.nodeId);
    if (!node) return;

    if (args.fileName !== undefined) node.fileName = args.fileName ?? null;
    if (args.storageKey !== undefined) node.storageKey = args.storageKey ?? null;

    // Reset any existing runtime state first.
    this.disposePdfNode(node.id);
    node.pageCount = 0;
    node.status = 'loading';
    node.error = null;
    this.requestRender();

    const token = this.pdfTokenSeq++;
    try {
      const doc = await loadPdfDocument(args.buffer);
      const state: PdfNodeState = {
        token,
        doc,
        pageCount: doc.numPages,
        metas: new Array(doc.numPages).fill(null),
        defaultAspect: 1.414,
      };
      this.pdfStateByNodeId.set(node.id, state);

      node.pageCount = doc.numPages;
      node.status = 'ready';
      node.error = null;
      node.title = `${node.fileName ?? 'PDF'} (${doc.numPages}p)`;

      this.requestRender();
      void this.prefetchPdfMetas(node.id, token);
    } catch (err: any) {
      node.status = 'error';
      node.error = err ? String(err?.message ?? err) : 'Failed to load PDF';
      this.requestRender();
    }
  }

  private closeImage(image: CanvasImageSource | null | undefined): void {
    try {
      (image as any)?.close?.();
    } catch {
      // ignore
    }
  }

  private disposePdfNode(nodeId: string): void {
    const state = this.pdfStateByNodeId.get(nodeId);
    if (state) {
      try {
        void state.doc.destroy();
      } catch {
        // ignore
      }
      this.pdfStateByNodeId.delete(nodeId);
    }

    for (const key of this.pdfPageRenderQueue.keys()) {
      if (key.startsWith(`${nodeId}|`)) this.pdfPageRenderQueue.delete(key);
    }

    if (this.pdfPageCache.size > 0) {
      for (const [key, entry] of this.pdfPageCache.entries()) {
        if (entry.nodeId !== nodeId) continue;
        this.pdfPageCacheBytes -= entry.bytesEstimate || 0;
        this.closeImage(entry.image);
        this.pdfPageCache.delete(key);
      }
    }
  }

  private clearTextRasters(): void {
    if (this.textRasterCache.size > 0) {
      for (const entry of this.textRasterCache.values()) this.closeImage(entry.image);
    }
    this.textRasterCache.clear();
    this.bestTextRasterKeyBySig.clear();
    this.textRasterCacheBytes = 0;
  }

  private evictOldTextRasters(): void {
    while (
      this.textRasterCache.size > this.textRasterCacheMaxEntries ||
      this.textRasterCacheBytes > this.textRasterCacheMaxBytes
    ) {
      const oldestKey = this.textRasterCache.keys().next().value as string | undefined;
      if (!oldestKey) return;
      const entry = this.textRasterCache.get(oldestKey);
      if (entry) {
        this.textRasterCacheBytes -= entry.bitmapBytesEstimate || 0;
        this.closeImage(entry.image);
      }
      this.textRasterCache.delete(oldestKey);
    }
  }

  private evictOldPdfPages(): void {
    while (this.pdfPageCache.size > this.pdfPageCacheMaxEntries || this.pdfPageCacheBytes > this.pdfPageCacheMaxBytes) {
      const oldestKey = this.pdfPageCache.keys().next().value as string | undefined;
      if (!oldestKey) return;
      const entry = this.pdfPageCache.get(oldestKey);
      if (entry) {
        this.pdfPageCacheBytes -= entry.bytesEstimate || 0;
        this.closeImage(entry.image);
      }
      this.pdfPageCache.delete(oldestKey);
    }
  }

  private touchPdfPage(key: string): void {
    const entry = this.pdfPageCache.get(key);
    if (!entry) return;
    this.pdfPageCache.delete(key);
    this.pdfPageCache.set(key, entry);
  }

  private touchTextRaster(key: string): void {
    const entry = this.textRasterCache.get(key);
    if (!entry) return;
    this.textRasterCache.delete(key);
    this.textRasterCache.set(key, entry);
  }

  private enqueueTextRaster(job: TextRasterJob): void {
    if (!job.nodeId || !job.key) return;
    if (this.textRasterCache.has(job.key)) return;
    const prev = this.textRasterQueueByNodeId.get(job.nodeId);
    if (prev && prev.key === job.key) return;
    this.textRasterQueueByNodeId.set(job.nodeId, job);
  }

  private enqueuePdfPageRender(job: PdfPageRenderJob): void {
    if (!job.key) return;
    if (this.pdfPageCache.has(job.key)) return;
    if (this.pdfPageRenderQueue.has(job.key)) return;
    this.pdfPageRenderQueue.set(job.key, job);
  }

  private kickTextRasterQueue(): void {
    if (this.textRasterRunning) return;
    if (this.interacting) return;
    if (this.textRasterQueueByNodeId.size === 0) return;
    void this.runTextRasterQueue();
  }

  private kickPdfPageRenderQueue(): void {
    if (this.pdfPageRenderRunning) return;
    if (this.interacting) return;
    if (this.pdfPageRenderQueue.size === 0) return;
    void this.runPdfPageRenderQueue();
  }

  private async runTextRasterQueue(): Promise<void> {
    if (this.textRasterRunning) return;
    this.textRasterRunning = true;
    const gen = this.textRasterGeneration;

    try {
      while (this.textRasterQueueByNodeId.size > 0) {
        if (this.interacting) return;
        if (this.textRasterGeneration !== gen) return;

        const next = this.textRasterQueueByNodeId.entries().next();
        if (next.done) return;
        const [nodeId, job] = next.value;
        this.textRasterQueueByNodeId.delete(nodeId);

	        if (this.textRasterCache.has(job.key)) continue;

	        try {
            const stillWanted = (() => {
              const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === job.nodeId) ?? null;
              if (!node) return false;
              if (node.id === this.editingNodeId) return false;
              if (node.isGenerating) return false;
              const contentRect = this.textContentRect(node.rect);
              const sig = this.textRasterSigForNode(node, contentRect).sig;
              return sig === job.sig;
            })();
            if (!stillWanted) continue;

	          const res = await rasterizeHtmlToImage(job.html, {
	            width: job.width,
	            height: job.height,
	            rasterScale: job.rasterScale,
              fontFamily: this.nodeTextFontFamily,
              fontSizePx: this.nodeTextFontSizePx,
              lineHeight: this.nodeTextLineHeight,
              color: this.nodeTextColor,
              scrollY: job.scrollY,
              scrollGutterPx: this.getTextScrollGutterPx(),
	          });
	          if (this.textRasterGeneration !== gen) {
            this.closeImage(res.image);
            return;
          }

          const stillCurrent = (() => {
            const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === job.nodeId) ?? null;
            if (!node) return false;
            if (node.id === this.editingNodeId) return false;
            if (node.isGenerating) return false;
            const contentRect = this.textContentRect(node.rect);
            const sig = this.textRasterSigForNode(node, contentRect).sig;
            return sig === job.sig;
          })();
          if (!stillCurrent) {
            this.closeImage(res.image);
            continue;
          }

          const readyAt = performance.now();
	          this.textRasterCache.set(job.key, {
	            key: job.key,
	            sig: job.sig,
	            rasterScale: job.rasterScale,
	            width: job.width,
	            height: job.height,
	            image: res.image,
	            bitmapBytesEstimate: res.bitmapBytesEstimate,
	            hitZones: res.hitZones,
	            readyAt,
	          });
          this.textRasterCacheBytes += res.bitmapBytesEstimate || 0;

          const prevBest = this.bestTextRasterKeyBySig.get(job.sig);
          if (!prevBest || job.rasterScale >= prevBest.rasterScale) {
            this.bestTextRasterKeyBySig.set(job.sig, { key: job.key, rasterScale: job.rasterScale });
          }

          this.evictOldTextRasters();
          this.requestRender();
        } catch {
          // ignore; leave missing (LOD0 will display)
        }

        // Yield between rasterizations to keep the UI responsive.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    } finally {
      this.textRasterRunning = false;
      if (!this.interacting && this.textRasterQueueByNodeId.size > 0) {
        // If work remains, schedule another burst.
        this.kickTextRasterQueue();
      }
    }
  }

  private async runPdfPageRenderQueue(): Promise<void> {
    if (this.pdfPageRenderRunning) return;
    this.pdfPageRenderRunning = true;

    try {
      while (this.pdfPageRenderQueue.size > 0) {
        if (this.interacting) return;

        const next = this.pdfPageRenderQueue.entries().next();
        if (next.done) return;
        const [key, job] = next.value;
        this.pdfPageRenderQueue.delete(key);
        if (this.pdfPageCache.has(key)) continue;

        try {
          await this.renderPdfPage(job);
          this.evictOldPdfPages();
          this.requestRender();
        } catch {
          // ignore; fall back to placeholder
        }

        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    } finally {
      this.pdfPageRenderRunning = false;
      if (!this.interacting && this.pdfPageRenderQueue.size > 0) {
        this.kickPdfPageRenderQueue();
      }
    }
  }

  private async ensurePdfPageMeta(nodeId: string, token: number, pageNumber: number): Promise<PdfPageMeta | null> {
    const state = this.pdfStateByNodeId.get(nodeId);
    if (!state || state.token !== token) return null;
    if (pageNumber < 1 || pageNumber > state.pageCount) return null;
    const idx = pageNumber - 1;
    const existing = state.metas[idx];
    if (existing) return existing;

    try {
      const page = await state.doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const viewportW = viewport.width;
      const viewportH = viewport.height;
      const aspect = viewportW > 0 ? viewportH / viewportW : state.defaultAspect;
      const meta: PdfPageMeta = {
        pageNumber,
        viewportW,
        viewportH,
        aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : state.defaultAspect,
      };

      const latest = this.pdfStateByNodeId.get(nodeId);
      if (!latest || latest.token !== token) return null;
      latest.metas[idx] = meta;
      if (pageNumber === 1) latest.defaultAspect = meta.aspect;
      this.requestRender();
      return meta;
    } catch {
      return null;
    }
  }

  private async prefetchPdfMetas(nodeId: string, token: number): Promise<void> {
    const state = this.pdfStateByNodeId.get(nodeId);
    if (!state || state.token !== token) return;

    for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) {
      const latest = this.pdfStateByNodeId.get(nodeId);
      if (!latest || latest.token !== token) return;

      await this.ensurePdfPageMeta(nodeId, token, pageNumber);
      if (pageNumber % 4 === 0) {
        this.requestRender();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }

    this.requestRender();
  }

  private getPdfPageFromCache(key: string, opts?: { touch?: boolean }): CanvasImageSource | null {
    const entry = this.pdfPageCache.get(key);
    if (!entry) return null;
    if (opts?.touch ?? true) this.touchPdfPage(key);
    return entry.image;
  }

  private async renderPdfPage(job: PdfPageRenderJob): Promise<void> {
    const state = this.pdfStateByNodeId.get(job.nodeId);
    if (!state || state.token !== job.token) return;
    if (this.pdfPageCache.has(job.key)) return;

    const meta =
      state.metas[job.pageNumber - 1] ?? (await this.ensurePdfPageMeta(job.nodeId, job.token, job.pageNumber));
    if (!meta) return;

    const page = await state.doc.getPage(job.pageNumber);
    const pdfScale = (job.pageWorldW * job.rasterScale) / Math.max(1, meta.viewportW);
    const viewport = page.getViewport({ scale: pdfScale });

    const pixelW = Math.max(1, Math.floor(viewport.width));
    const pixelH = Math.max(1, Math.floor(viewport.height));
    const bytesEstimate = pixelW * pixelH * 4;

    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = pixelW;
    pageCanvas.height = pixelH;
    const pageCtx = pageCanvas.getContext('2d', { alpha: false });
    if (!pageCtx) return;

    await page.render({ canvasContext: pageCtx as any, viewport }).promise;

    let image: CanvasImageSource = pageCanvas;
    if (typeof createImageBitmap === 'function') {
      try {
        image = await createImageBitmap(pageCanvas);
      } catch {
        image = pageCanvas;
      }
    }

    const latest = this.pdfStateByNodeId.get(job.nodeId);
    if (!latest || latest.token !== job.token) {
      this.closeImage(image);
      return;
    }
    if (this.pdfPageCache.has(job.key)) {
      this.closeImage(image);
      return;
    }

    this.pdfPageCache.set(job.key, {
      key: job.key,
      nodeId: job.nodeId,
      token: job.token,
      pageNumber: job.pageNumber,
      image,
      pixelW,
      pixelH,
      bytesEstimate,
      readyAt: performance.now(),
    });
    this.pdfPageCacheBytes += bytesEstimate;
  }

  start(): void {
    this.input.start();
    this.requestRender();
    this.emitUiState();

    // Hover detection for mouse/trackpad text selection:
    // show a LOD2 DOM overlay over the text content rect so native selection works.
    this.canvas.addEventListener('pointermove', this.onHoverPointerMove, { passive: true });
  }

  dispose(): void {
    try {
      this.canvas.removeEventListener('pointermove', this.onHoverPointerMove as any);
    } catch {
      // ignore
    }

    this.input.dispose();
    this.clearTextSelection({ suppressOverlayCallback: true });
    this.clearPdfTextSelection({ suppressOverlayCallback: true });
    this.textResizeHold = null;
    this.textLod2Target = null;
    this.textStreamLod2Target = null;
    this.pdfLod2Target = null;
    if (this.textLod2) {
      this.textLod2.dispose();
      this.textLod2 = null;
    }
    if (this.textStreamLod2) {
      this.textStreamLod2.dispose();
      this.textStreamLod2 = null;
    }
    if (this.pdfTextLod2) {
      this.pdfTextLod2.dispose();
      this.pdfTextLod2 = null;
    }
    for (const state of this.pdfStateByNodeId.values()) {
      try {
        void state.doc.destroy();
      } catch {
        // ignore
      }
    }
    this.pdfStateByNodeId.clear();
    this.pdfPageRenderQueue.clear();
    for (const entry of this.pdfPageCache.values()) this.closeImage(entry.image);
    this.pdfPageCache.clear();
    this.pdfPageCacheBytes = 0;

    this.backgroundLoadToken += 1;
    if (this.backgroundImage) this.closeImage(this.backgroundImage);
    this.backgroundImage = null;
    this.backgroundImageW = 0;
    this.backgroundImageH = 0;
    this.backgroundCache = null;
    if (this.webglPreblur) {
      try {
        this.webglPreblur.dispose();
      } catch {
        // ignore
      }
      this.webglPreblur = null;
    }

    if (this.raf != null) {
      try {
        cancelAnimationFrame(this.raf);
      } catch { }
      this.raf = null;
    }
  }

  private onHoverPointerMove = (ev: PointerEvent) => {
    // Only for mouse/trackpad (hover without buttons pressed).
    if (this.editingNodeId) return;
    if (this.activeGesture) return;

    const t = ev.pointerType || 'mouse';
    if (t !== 'mouse') return;
    if ((ev.buttons ?? 0) !== 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const p: Vec2 = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (p.x < 0 || p.y < 0 || p.x > rect.width || p.y > rect.height) return;

    const pdfAnn = this.pdfAnnotationPlacement;
    if (pdfAnn) {
      this.setCanvasCursor('crosshair');
      const hadHover = this.hoverTextNodeId !== null || this.hoverPdfPage !== null || this.hoverNodeHeaderButton !== null;
      if (hadHover) {
        this.hoverTextNodeId = null;
        this.hoverPdfPage = null;
        this.hoverNodeHeaderButton = null;
      }

      const world = this.camera.screenToWorld(p);
      const prev = pdfAnn.hoverWorld;
      const changed = !prev || Math.abs(prev.x - world.x) > 0.25 || Math.abs(prev.y - world.y) > 0.25;
      if (changed) pdfAnn.hoverWorld = world;
      if (changed || hadHover) this.requestRender();
      return;
    }

    const textAnn = this.textAnnotationPlacement;
    if (textAnn) {
      this.setCanvasCursor('crosshair');
      const hadHover = this.hoverTextNodeId !== null || this.hoverPdfPage !== null || this.hoverNodeHeaderButton !== null;
      if (hadHover) {
        this.hoverTextNodeId = null;
        this.hoverPdfPage = null;
        this.hoverNodeHeaderButton = null;
      }

      const world = this.camera.screenToWorld(p);
      const prev = textAnn.hoverWorld;
      const changed = !prev || Math.abs(prev.x - world.x) > 0.25 || Math.abs(prev.y - world.y) > 0.25;
      if (changed) textAnn.hoverWorld = world;
      if (changed || hadHover) this.requestRender();
      return;
    }

    if (this.pendingSpawnByDraw) {
      const hadHover = this.hoverTextNodeId !== null || this.hoverPdfPage !== null || this.hoverNodeHeaderButton !== null;
      this.setCanvasCursor('crosshair');
      if (hadHover) {
        this.hoverTextNodeId = null;
        this.hoverPdfPage = null;
        this.hoverNodeHeaderButton = null;
        this.requestRender();
      }
      return;
    }

    if (this.tool !== 'select') return;

    const world = this.camera.screenToWorld(p);
    const hit = this.findTopmostNodeAtWorld(world);
    this.updateHoverCursor(world, hit);
    let nextTextHover: string | null = null;
    let nextPdfHover: { nodeId: string; token: number; pageNumber: number } | null = null;
    let nextHeaderHover: { nodeId: string; kind: 'menu' | 'reply' | 'stop' | 'send' | 'send_menu' } | null = null;

    if (hit) {
      const menuBtn = this.menuButtonRect(hit.rect);
      const inMenu =
        world.x >= menuBtn.x &&
        world.x <= menuBtn.x + menuBtn.w &&
        world.y >= menuBtn.y &&
        world.y <= menuBtn.y + menuBtn.h;
      if (inMenu) {
        nextHeaderHover = { nodeId: hit.id, kind: 'menu' };
      } else {
        const replyBtn = this.replyButtonRect(hit.rect);
        const inReply =
          world.x >= replyBtn.x &&
          world.x <= replyBtn.x + replyBtn.w &&
          world.y >= replyBtn.y &&
          world.y <= replyBtn.y + replyBtn.h;
        if (inReply) {
          nextHeaderHover = { nodeId: hit.id, kind: 'reply' };
        } else if ((hit.kind === 'text' && hit.isEditNode) || hit.kind === 'ink') {
          const mainBtn = this.sendButtonMainRect(hit.rect);
          const arrowBtn = this.sendButtonArrowRect(hit.rect);
          const inMain =
            world.x >= mainBtn.x &&
            world.x <= mainBtn.x + mainBtn.w &&
            world.y >= mainBtn.y &&
            world.y <= mainBtn.y + mainBtn.h;
          const inArrow =
            world.x >= arrowBtn.x &&
            world.x <= arrowBtn.x + arrowBtn.w &&
            world.y >= arrowBtn.y &&
            world.y <= arrowBtn.y + arrowBtn.h;
          if (inMain || inArrow) {
            nextHeaderHover = { nodeId: hit.id, kind: inArrow ? 'send_menu' : 'send' };
          }
        } else if (hit.kind === 'text' && this.canCancelNode(hit)) {
          const stopBtn = this.stopButtonRect(hit);
          const inStop =
            world.x >= stopBtn.x &&
            world.x <= stopBtn.x + stopBtn.w &&
            world.y >= stopBtn.y &&
            world.y <= stopBtn.y + stopBtn.h;
          if (inStop) nextHeaderHover = { nodeId: hit.id, kind: 'stop' };
        }
      }
    }

    if (hit && hit.kind === 'text') {
      const contentRect = this.textContentRect(hit.rect);
      const inContent =
        world.x >= contentRect.x &&
        world.x <= contentRect.x + contentRect.w &&
        world.y >= contentRect.y &&
        world.y <= contentRect.y + contentRect.h;
      if (inContent) nextTextHover = hit.id;
    } else if (hit && hit.kind === 'pdf') {
      const state = this.pdfStateByNodeId.get(hit.id);
      if (hit.status === 'ready' && state && state.token) {
        const contentRect = this.textContentRect(hit.rect);
        const inContent =
          world.x >= contentRect.x &&
          world.x <= contentRect.x + contentRect.w &&
          world.y >= contentRect.y &&
          world.y <= contentRect.y + contentRect.h;
        if (inContent) {
          const pageHit = this.findPdfPageAtWorld(hit, state, world);
          if (pageHit) nextPdfHover = { nodeId: hit.id, token: state.token, pageNumber: pageHit.pageNumber };
        }
      }
    }

    const headerChanged =
      nextHeaderHover?.nodeId !== this.hoverNodeHeaderButton?.nodeId ||
      nextHeaderHover?.kind !== this.hoverNodeHeaderButton?.kind;
    const changed =
      headerChanged ||
      nextTextHover !== this.hoverTextNodeId ||
      nextPdfHover?.pageNumber !== this.hoverPdfPage?.pageNumber ||
      nextPdfHover?.nodeId !== this.hoverPdfPage?.nodeId ||
      nextPdfHover?.token !== this.hoverPdfPage?.token;
    if (changed) {
      this.hoverTextNodeId = nextTextHover;
      this.hoverPdfPage = nextPdfHover;
      this.hoverNodeHeaderButton = nextHeaderHover;
      this.requestRender();
    }
  };

  private setCanvasCursor(cursor: string): void {
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
  }

  private cursorForResizeCorner(corner: ResizeCorner): string {
    return corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';
  }

  private updateHoverCursor(world: Vec2, hit: WorldNode | null): void {
    if (hit) {
      const menuBtn = this.menuButtonRect(hit.rect);
      const inMenu =
        world.x >= menuBtn.x &&
        world.x <= menuBtn.x + menuBtn.w &&
        world.y >= menuBtn.y &&
        world.y <= menuBtn.y + menuBtn.h;
      if (inMenu) {
        this.setCanvasCursor('pointer');
        return;
      }

      const replyBtn = this.replyButtonRect(hit.rect);
      const inReply =
        world.x >= replyBtn.x &&
        world.x <= replyBtn.x + replyBtn.w &&
        world.y >= replyBtn.y &&
        world.y <= replyBtn.y + replyBtn.h;
      if (inReply) {
        this.setCanvasCursor('pointer');
        return;
      }

      if ((hit.kind === 'text' && hit.isEditNode) || hit.kind === 'ink') {
        const sendBtn = this.sendButtonRect(hit.rect);
        const inSend =
          world.x >= sendBtn.x &&
          world.x <= sendBtn.x + sendBtn.w &&
          world.y >= sendBtn.y &&
          world.y <= sendBtn.y + sendBtn.h;
        if (inSend) {
          this.setCanvasCursor('pointer');
          return;
        }
      }

      if (hit.kind === 'text' && this.canCancelNode(hit)) {
        const stopBtn = this.stopButtonRect(hit);
        const inStop =
          world.x >= stopBtn.x &&
          world.x <= stopBtn.x + stopBtn.w &&
          world.y >= stopBtn.y &&
          world.y <= stopBtn.y + stopBtn.h;
        if (inStop) {
          this.setCanvasCursor('pointer');
          return;
        }
      }
    }

    const corner = hit && (hit.kind === 'text' || hit.kind === 'ink') ? this.hitResizeHandle(world, hit.rect) : null;
    if (corner) this.setCanvasCursor(this.cursorForResizeCorner(corner));
    else this.setCanvasCursor('default');
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
      this.backgroundCache = null;
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
      tool: this.tool,
    };
  }

  getNodeTitle(nodeId: string): string | null {
    const node = this.nodes.find((n) => n.id === nodeId);
    return node?.title ?? null;
  }

  getTextNodeUserPreface(nodeId: string): { replyTo: string; contexts: string[]; collapsedPrefaceContexts: Record<number, boolean> } | null {
    const id = typeof nodeId === 'string' ? nodeId : String(nodeId ?? '');
    if (!id) return null;
    const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === id) ?? null;
    if (!node || node.author !== 'user') return null;

    const replyTo = (node.userPreface?.replyTo ?? '').trim();
    const ctxRaw = Array.isArray(node.userPreface?.contexts) ? node.userPreface!.contexts! : [];
    const contexts = ctxRaw.map((t) => String(t ?? '').trim()).filter(Boolean);
    if (!replyTo && contexts.length === 0) return null;

    return { replyTo, contexts, collapsedPrefaceContexts: { ...(node.collapsedPrefaceContexts ?? {}) } };
  }

  setTextNodeUserPreface(
    nodeId: string,
    userPreface: { replyTo?: string; contexts?: string[] } | null | undefined,
    opts?: { collapseNewContexts?: boolean },
  ): void {
    const id = typeof nodeId === 'string' ? nodeId : String(nodeId ?? '');
    if (!id) return;
    const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === id) ?? null;
    if (!node || node.author !== 'user') return;

    const prevReplyTo = (node.userPreface?.replyTo ?? '').trim();
    const prevCtxRaw = Array.isArray(node.userPreface?.contexts) ? node.userPreface!.contexts! : [];
    const prevContexts = prevCtxRaw.map((t) => String(t ?? '').trim()).filter(Boolean);

    const nextReplyTo = typeof userPreface?.replyTo === 'string' ? userPreface.replyTo.trim() : '';
    const nextCtxRaw = Array.isArray(userPreface?.contexts) ? userPreface.contexts : [];
    const nextContexts = nextCtxRaw.map((t) => String(t ?? '').trim()).filter(Boolean);

    const nextNormalized =
      nextReplyTo || nextContexts.length > 0
        ? {
            ...(nextReplyTo ? { replyTo: nextReplyTo } : {}),
            ...(nextContexts.length ? { contexts: nextContexts } : {}),
          }
        : undefined;

    const unchanged =
      prevReplyTo === nextReplyTo &&
      prevContexts.length === nextContexts.length &&
      prevContexts.every((t, i) => t === nextContexts[i]);
    if (unchanged) return;

    node.userPreface = nextNormalized;

    const prevCollapsed = node.collapsedPrefaceContexts ?? {};
    let nextCollapsed: Record<number, boolean> = prevCollapsed;
    const prevLen = prevContexts.length;
    const nextLen = nextContexts.length;
    if (opts?.collapseNewContexts && nextLen > prevLen) {
      nextCollapsed = { ...prevCollapsed };
      for (let i = prevLen; i < nextLen; i += 1) nextCollapsed[i] = true;
    }
    if (Object.keys(nextCollapsed).length > 0) {
      const filtered: Record<number, boolean> = {};
      for (const [k, v] of Object.entries(nextCollapsed)) {
        const idx = Number(k);
        if (!Number.isFinite(idx)) continue;
        if (idx < 0 || idx >= nextLen) continue;
        if (v) filtered[idx] = true;
      }
      node.collapsedPrefaceContexts = Object.keys(filtered).length ? filtered : undefined;
    } else {
      node.collapsedPrefaceContexts = undefined;
    }

    this.recomputeTextNodeDisplayHash(node);
    this.textRasterGeneration += 1;
    const contentRect = this.textContentRect(node.rect);
    const sig = this.textRasterSigForNode(node, contentRect).sig;
    this.textResizeHold = { nodeId: node.id, sig, expiresAt: performance.now() + 2200 };
    this.requestRender();
    try {
      this.onRequestPersist?.();
    } catch {
      // ignore
    }
  }

  toggleTextNodePrefaceContextCollapsed(nodeId: string, contextIndex: number): void {
    const id = typeof nodeId === 'string' ? nodeId : String(nodeId ?? '');
    if (!id) return;
    const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === id) ?? null;
    if (!node || node.author !== 'user') return;

    const idx = Number(contextIndex);
    if (!Number.isFinite(idx)) return;

    const prev = node.collapsedPrefaceContexts ?? {};
    const next: Record<number, boolean> = { ...prev };
    if (next[idx]) delete next[idx];
    else next[idx] = true;
    node.collapsedPrefaceContexts = Object.keys(next).length ? next : undefined;

    this.recomputeTextNodeDisplayHash(node);
    this.textRasterGeneration += 1;
    const contentRect = this.textContentRect(node.rect);
    const sig = this.textRasterSigForNode(node, contentRect).sig;
    this.textResizeHold = { nodeId: node.id, sig, expiresAt: performance.now() + 2200 };
    this.requestRender();
    try {
      this.onRequestPersist?.();
    } catch {
      // ignore
    }
  }

  hasNode(nodeId: string): boolean {
    if (!nodeId) return false;
    return this.nodes.some((n) => n.id === nodeId);
  }

  getNodeReplyPreview(nodeId: string): string {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return '...';
    if (node.kind !== 'text') return '...';

    const raw = String(node.content ?? '');
    const line =
      raw
        .split('\n')
        .map((s) => s.trim())
        .find((s) => s) ?? '';
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (!collapsed) return '...';

    const m = collapsed.match(/^(.+?[.!?])(\s|$)/);
    const firstSentence = (m?.[1] ?? collapsed).trim();
    const max = 90;
    if (firstSentence.length <= max) return firstSentence;
    return `${firstSentence.slice(0, max - 1).trimEnd()}…`;
  }

  getNodeScreenRect(nodeId: string): Rect | null {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const tl = this.camera.worldToScreen({ x: node.rect.x, y: node.rect.y });
    const br = this.camera.worldToScreen({ x: node.rect.x + node.rect.w, y: node.rect.y + node.rect.h });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  getTextNodeContentScreenRect(nodeId: string): Rect | null {
    const node =
      this.nodes.find((n): n is TextNode | InkNode => (n.kind === 'text' || n.kind === 'ink') && n.id === nodeId) ??
      null;
    if (!node) return null;
    const content = this.textContentRect(node.rect);
    const tl = this.camera.worldToScreen({ x: content.x, y: content.y });
    const br = this.camera.worldToScreen({ x: content.x + content.w, y: content.y + content.h });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  getNodeMenuButtonScreenRect(nodeId: string): Rect | null {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const btn = this.menuButtonRect(node.rect);
    const tl = this.camera.worldToScreen({ x: btn.x, y: btn.y });
    const br = this.camera.worldToScreen({ x: btn.x + btn.w, y: btn.y + btn.h });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  getNodeSendButtonScreenRect(nodeId: string): Rect | null {
    const node =
      this.nodes.find((n): n is TextNode | InkNode => (n.kind === 'text' || n.kind === 'ink') && n.id === nodeId) ??
      null;
    if (!node) return null;
    if (node.kind === 'text' && !node.isEditNode) return null;
    const btn = this.sendButtonRect(node.rect);
    const tl = this.camera.worldToScreen({ x: btn.x, y: btn.y });
    const br = this.camera.worldToScreen({ x: btn.x + btn.w, y: btn.y + btn.h });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  getNodeSendButtonArrowScreenRect(nodeId: string): Rect | null {
    const node =
      this.nodes.find((n): n is TextNode | InkNode => (n.kind === 'text' || n.kind === 'ink') && n.id === nodeId) ??
      null;
    if (!node) return null;
    if (node.kind === 'text' && !node.isEditNode) return null;
    const btn = this.sendButtonArrowRect(node.rect);
    const tl = this.camera.worldToScreen({ x: btn.x, y: btn.y });
    const br = this.camera.worldToScreen({ x: btn.x + btn.w, y: btn.y + btn.h });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  setNodeScreenRect(nodeId: string, screenRect: Rect): void {
    const id = typeof nodeId === 'string' ? nodeId : String(nodeId ?? '');
    if (!id) return;

    const node = this.nodes.find((n) => n.id === id);
    if (!node) return;

    const r = screenRect;
    const sx = Number(r?.x);
    const sy = Number(r?.y);
    const sw = Number(r?.w);
    const sh = Number(r?.h);
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sw) || !Number.isFinite(sh)) return;

    const z = Math.max(0.001, Number.isFinite(this.camera.zoom) ? this.camera.zoom : 1);
    const nextWorld: Rect = {
      x: this.camera.x + sx / z,
      y: this.camera.y + sy / z,
      w: sw / z,
      h: sh / z,
    };

    if (nextWorld.w < this.minNodeW) nextWorld.w = this.minNodeW;
    if (nextWorld.h < this.minNodeH) nextWorld.h = this.minNodeH;

    node.rect = nextWorld;
    this.requestRender();
  }

  beginEditingSelectedNode(): void {
    if (this.editingNodeId) return;
    const nodeId = this.selectedNodeId;
    if (!nodeId) return;
    this.tryBeginEditingNode(nodeId);
  }

  beginEditingNode(nodeId: string): void {
    this.tryBeginEditingNode(nodeId);
  }

  private canEditTextNode(node: TextNode): boolean {
    if (this.allowEditingAllTextNodes) return true;
    if (node.isEditNode) return true;
    // Back-compat: notes created before we tagged them use an `n...` id prefix.
    return typeof node.id === 'string' && node.id.startsWith('n');
  }

  private tryBeginEditingNode(nodeId: string): boolean {
    const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === nodeId) ?? null;
    if (!node) return false;
    if (!this.canEditTextNode(node)) return false;
    const changed = this.editingNodeId !== nodeId || this.selectedNodeId !== nodeId;
    this.selectedNodeId = nodeId;
    this.editingNodeId = nodeId;
    this.bringNodeToFront(nodeId);
    this.requestRender();
    if (changed) this.emitUiState();
    return true;
  }

  commitEditing(next: string): void {
    const nodeId = this.editingNodeId;
    if (!nodeId) return;

    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== 'text') {
      this.editingNodeId = null;
      this.requestRender();
      this.emitUiState();
      return;
    }

	    const text = typeof next === 'string' ? next : String(next ?? '');
	    if (node.content !== text) {
	      node.content = text;
	      node.contentHash = fingerprintText(text);
	      this.recomputeTextNodeDisplayHash(node);
	      this.textRasterGeneration += 1;
	    }

    this.editingNodeId = null;
    this.requestRender();
    this.emitUiState();
  }

  cancelEditing(): void {
    if (!this.editingNodeId) return;
    this.editingNodeId = null;
    this.requestRender();
    this.emitUiState();
  }

  setEditingText(next: string): void {
    const nodeId = this.editingNodeId;
    if (!nodeId) return;
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== 'text') return;
    const text = typeof next === 'string' ? next : String(next ?? '');
	    if (node.content === text) return;
	    node.content = text;
	    node.contentHash = fingerprintText(text);
	    this.recomputeTextNodeDisplayHash(node);
	    this.textRasterGeneration += 1;
	    this.requestRender();
	    this.emitUiState();
  }

  setTextNodeContent(nodeId: string, next: string, opts?: { streaming?: boolean }): void {
    const id = nodeId;
    if (!id) return;
    const node = this.nodes.find((n): n is TextNode => n.id === id && n.kind === 'text');
    if (!node) return;

	    const text = typeof next === 'string' ? next : String(next ?? '');
	    if (node.content === text) return;
	    node.content = text;
	    node.contentHash = fingerprintText(text);
	    this.recomputeTextNodeDisplayHash(node);

	    if (node.author === 'assistant') {
	      if (opts?.streaming) {
	        this.scheduleTextNodeStreamingAutoGrow(node.id);
	      } else {
	        this.applySpawnAutoSizeToTextNode(node, { mode: 'grow_only' });
	      }
	    }

	    // Avoid churn while streaming; finalize with a re-raster + short LOD2 hold.
	    if (!opts?.streaming) {
	      this.textRasterGeneration += 1;
	      const contentRect = this.textContentRect(node.rect);
	      const sig = this.textRasterSigForNode(node, contentRect).sig;
	      this.textResizeHold = { nodeId: node.id, sig, expiresAt: performance.now() + 2200 };
	    }

    this.requestRender();
  }

	setTextNodeLlmState(
	  nodeId: string,
	  patch: {
	    isGenerating?: boolean;
	    modelId?: string | null;
	    llmParams?: ChatLlmParams | null;
	    llmError?: string | null;
	    llmTask?: ChatLlmTask | null;
	  },
	): void {
	  const id = nodeId;
	  if (!id) return;
	  const node = this.nodes.find((n): n is TextNode => n.id === id && n.kind === 'text');
	  if (!node) return;

    let changed = false;
    if (typeof patch.isGenerating === 'boolean' && Boolean(node.isGenerating) !== patch.isGenerating) {
      node.isGenerating = patch.isGenerating;
      changed = true;
    }
    if (patch.modelId !== undefined && (node.modelId ?? null) !== (patch.modelId ?? null)) {
      node.modelId = patch.modelId ?? null;
      changed = true;
    }
    if (patch.llmParams !== undefined) {
      const next = patch.llmParams ?? undefined;
      if (node.llmParams !== next) {
        node.llmParams = next;
        changed = true;
      }
    }
	  if (patch.llmError !== undefined && (node.llmError ?? null) !== (patch.llmError ?? null)) {
	    node.llmError = patch.llmError ?? null;
	    changed = true;
	  }
	  if (patch.llmTask !== undefined) {
	    const next = patch.llmTask ?? undefined;
	    if (node.llmTask !== next) {
	      node.llmTask = next;
	      changed = true;
	    }
	  }

	  if (!changed) return;
	  this.recomputeTextNodeDisplayHash(node);
	  this.requestRender();
	}

  setTextNodeApiPayload(nodeId: string, patch: { apiRequest?: unknown; apiResponse?: unknown }): void {
    const id = nodeId;
    if (!id) return;
    const node = this.nodes.find((n): n is TextNode => n.id === id && n.kind === 'text');
    if (!node) return;

    let changed = false;
    if (patch.apiRequest !== undefined && node.apiRequest !== patch.apiRequest) {
      node.apiRequest = patch.apiRequest;
      changed = true;
    }
    if (patch.apiResponse !== undefined && node.apiResponse !== patch.apiResponse) {
      node.apiResponse = patch.apiResponse;
      changed = true;
    }

    if (changed) this.requestRender();
  }

  setTextNodeThinkingSummary(nodeId: string, next: ThinkingSummaryChunk[] | null | undefined): void {
    const id = nodeId;
    if (!id) return;
    const node = this.nodes.find((n): n is TextNode => n.id === id && n.kind === 'text');
    if (!node) return;

    const normalized = Array.isArray(next) ? next : undefined;
    node.thinkingSummary = normalized && normalized.length ? normalized : undefined;
    this.recomputeTextNodeDisplayHash(node);
    if (node.author === 'assistant' && node.isGenerating) this.scheduleTextNodeStreamingAutoGrow(node.id);
    this.requestRender();
  }

  setTextNodeCanonical(nodeId: string, patch: { canonicalMessage?: unknown; canonicalMeta?: unknown }): void {
    const id = nodeId;
    if (!id) return;
    const node = this.nodes.find((n): n is TextNode => n.id === id && n.kind === 'text');
    if (!node) return;

    const nextCanonicalMessage = (() => {
      if (patch.canonicalMessage === undefined) return node.canonicalMessage;
      if (patch.canonicalMessage == null) return undefined;
      const raw = patch.canonicalMessage as any;
      if (!raw || typeof raw !== 'object') return undefined;
      if (raw.role !== 'assistant') return undefined;
      const text = typeof raw.text === 'string' ? raw.text : '';
      return text ? ({ role: 'assistant', text } as CanonicalAssistantMessage) : undefined;
    })();

    let changed = false;
    if (patch.canonicalMessage !== undefined && node.canonicalMessage !== nextCanonicalMessage) {
      node.canonicalMessage = nextCanonicalMessage;
      changed = true;
    }
    if (patch.canonicalMeta !== undefined && node.canonicalMeta !== patch.canonicalMeta) {
      node.canonicalMeta = patch.canonicalMeta;
      changed = true;
    }

    if (!changed) return;

    this.recomputeTextNodeDisplayHash(node);

    // Ensure a fresh raster for non-streaming nodes since summary visibility can change.
    if (!node.isGenerating && node.id !== this.editingNodeId) {
      this.textRasterGeneration += 1;
      const contentRect = this.textContentRect(node.rect);
      const sig = this.textRasterSigForNode(node, contentRect).sig;
      this.textResizeHold = { nodeId: node.id, sig, expiresAt: performance.now() + 2200 };
    }

    this.requestRender();
  }

  clearSelection(): void {
    const changed = this.selectedNodeId != null || this.editingNodeId != null;
    this.selectedNodeId = null;
    this.editingNodeId = null;
    this.clearTextSelection({ suppressOverlayCallback: true });
    this.clearPdfTextSelection({ suppressOverlayCallback: true });
    if (changed) {
      this.requestRender();
      this.emitUiState();
    }
  }

  deleteSelectedNode(): void {
    const nodeId = this.selectedNodeId;
    if (!nodeId) return;
    this.deleteNode(nodeId);
  }

  deleteNode(nodeId: string): void {
    const id = nodeId;
    if (!id) return;

    const idx = this.nodes.findIndex((n) => n.id === id);
    if (idx < 0) return;

    const node = this.nodes[idx];

    if (node.kind === 'text' && node.isGenerating) {
      try {
        this.onRequestCancelGeneration?.(id);
      } catch {
        // ignore
      }
    }
    const deletedParentId = node.parentId ?? null;

    // Reparent direct children to this node's parent (splice out of thread/tree).
    for (const n of this.nodes) {
      if (n.parentId === id) n.parentId = deletedParentId;
    }

    // Clean up any node-specific resources.
    if (node.kind === 'pdf') this.disposePdfNode(id);
    this.textRasterQueueByNodeId.delete(id);

    // Remove from list.
    this.nodes.splice(idx, 1);

    // Clear any active interactions/overlays pointing at the deleted node.
    const g = this.activeGesture as any;
    if (g?.nodeId === id) this.activeGesture = null;

    if (this.selectedNodeId === id) this.selectedNodeId = null;
    if (this.editingNodeId === id) this.editingNodeId = null;
    if (this.rawViewerNodeId === id) this.rawViewerNodeId = null;
    if (this.hoverTextNodeId === id) this.hoverTextNodeId = null;
    if (this.hoverPdfPage?.nodeId === id) this.hoverPdfPage = null;
    if (this.textLod2Target?.nodeId === id) this.textLod2Target = null;
    if (this.textStreamLod2Target?.nodeId === id) this.textStreamLod2Target = null;
    if (this.pdfLod2Target?.nodeId === id) this.pdfLod2Target = null;
    if (this.textSelectNodeId === id) this.clearTextSelection({ suppressOverlayCallback: true });
    if (this.pdfSelectTarget?.nodeId === id) this.clearPdfTextSelection({ suppressOverlayCallback: true });

    this.requestRender();
    this.emitUiState();
  }

  private emitUiState(): void {
    this.onUiState?.(this.getUiState());
  }

  private textContentRect(nodeRect: Rect): Rect {
    const x = nodeRect.x + TEXT_NODE_PAD_PX;
    const y = nodeRect.y + TEXT_NODE_HEADER_H_PX;
    const w = Math.max(1, nodeRect.w - TEXT_NODE_PAD_PX * 2);
    const h = Math.max(1, nodeRect.h - TEXT_NODE_HEADER_H_PX - TEXT_NODE_PAD_PX);
    return { x, y, w, h };
  }

  private getTextNodeScrollY(node: TextNode): number {
    const raw = Number(node.contentScrollY);
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.round(raw));
  }

  private getTextScrollGutterPx(): number {
    if (this.textScrollGutterPx != null) return this.textScrollGutterPx;
    if (typeof document === 'undefined') {
      this.textScrollGutterPx = 0;
      return 0;
    }

    let el: HTMLDivElement | null = null;
    try {
      el = document.createElement('div');
      el.className = 'gc-textLod2__content';
      el.style.position = 'absolute';
      el.style.left = '-99999px';
      el.style.top = '0';
      el.style.width = '100px';
      el.style.height = '100px';
      el.style.overflowY = 'scroll';
      el.style.overflowX = 'hidden';
      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';
      document.body.appendChild(el);

      const gutter = Math.max(0, (el.offsetWidth || 0) - (el.clientWidth || 0));
      const v = Math.max(0, Math.round(gutter));
      this.textScrollGutterPx = v;
      return v;
    } catch {
      this.textScrollGutterPx = 0;
      return 0;
    } finally {
      try {
        el?.remove();
      } catch {
        // ignore
      }
    }
  }

  private ensureTextMeasureRoot(): HTMLDivElement | null {
    if (typeof document === 'undefined') return null;
    if (this.textMeasureRoot && document.body.contains(this.textMeasureRoot)) return this.textMeasureRoot;
    try {
      const el = document.createElement('div');
      el.setAttribute('data-gcv1-text-measure', 'true');
      el.style.position = 'fixed';
      el.style.left = '-10000px';
      el.style.top = '-10000px';
      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';
      el.style.contain = 'layout paint style';
      el.style.zIndex = '-1';
      document.body.appendChild(el);
      this.textMeasureRoot = el;
      return el;
    } catch {
      return null;
    }
  }

  private measureTextNodeContentSize(html: string, bounds: { minW: number; maxW: number; minH: number; maxH: number }): { w: number; h: number } {
    const minW = Math.max(1, Math.round(bounds.minW));
    const maxW = Math.max(minW, Math.round(bounds.maxW));
    const minH = Math.max(1, Math.round(bounds.minH));
    const maxH = Math.max(minH, Math.round(bounds.maxH));

    const root = this.ensureTextMeasureRoot();
    if (!root) return { w: maxW, h: minH };

    try {
      root.innerHTML = '';
      const el = document.createElement('div');
      el.className = 'gc-textLod2__content mdx';
      el.style.display = 'inline-block';
      el.style.boxSizing = 'border-box';
      el.style.minWidth = `${minW}px`;
      el.style.maxWidth = `${maxW}px`;
      el.style.padding = '0';
      el.style.margin = '0';
      el.style.overflow = 'visible';
      el.style.overflowWrap = 'break-word';
      (el.style as any).wordWrap = 'break-word';
      (el.style as any).scrollbarGutter = 'stable';

      const gutter = this.getTextScrollGutterPx();
      if (gutter > 0) el.style.paddingRight = `${gutter}px`;

      const style = this.nodeTextStyle();
      el.style.color = style.color;
      el.style.fontFamily = style.fontFamily;
      el.style.fontSize = `${Math.max(1, Math.round(style.fontSizePx))}px`;
      el.style.lineHeight = `${Math.max(0.1, style.lineHeight)}`;

      el.innerHTML = html ?? '';
      root.appendChild(el);

      const r = el.getBoundingClientRect();
      const w = Math.round(clamp(Math.ceil(r.width || 0), minW, maxW));
      const h = Math.round(clamp(Math.ceil(r.height || 0), minH, maxH));
      return { w, h };
    } catch {
      return { w: maxW, h: minH };
    } finally {
      try {
        root.innerHTML = '';
      } catch {
        // ignore
      }
    }
  }

  private applySpawnAutoSizeToTextNode(node: TextNode, opts: { mode: 'set_exact' | 'grow_only' }): boolean {
    const minNodeW = TEXT_NODE_SPAWN_MIN_W_PX;
    const maxNodeW = TEXT_NODE_SPAWN_MAX_W_PX;
    const minNodeH = TEXT_NODE_SPAWN_MIN_H_PX;
    const maxNodeH = TEXT_NODE_SPAWN_MAX_H_PX;

    const minContentW = Math.max(1, minNodeW - TEXT_NODE_PAD_PX * 2);
    const maxContentW = Math.max(minContentW, maxNodeW - TEXT_NODE_PAD_PX * 2);
    const minContentH = Math.max(1, minNodeH - TEXT_NODE_HEADER_H_PX - TEXT_NODE_PAD_PX);
    const maxContentH = Math.max(minContentH, maxNodeH - TEXT_NODE_HEADER_H_PX - TEXT_NODE_PAD_PX);

    const html = this.renderTextNodeHtml(node);
    const contentSize = this.measureTextNodeContentSize(html, {
      minW: minContentW,
      maxW: maxContentW,
      minH: minContentH,
      maxH: maxContentH,
    });

    const desiredW = clamp(contentSize.w + TEXT_NODE_PAD_PX * 2, minNodeW, maxNodeW);
    const desiredH = clamp(contentSize.h + TEXT_NODE_HEADER_H_PX + TEXT_NODE_PAD_PX, minNodeH, maxNodeH);

    let changed = false;
    if (opts.mode === 'set_exact') {
      if (Math.abs(node.rect.w - desiredW) > 0.5) {
        node.rect.w = desiredW;
        changed = true;
      }
      if (Math.abs(node.rect.h - desiredH) > 0.5) {
        node.rect.h = desiredH;
        changed = true;
      }
      return changed;
    }

    if (desiredW > node.rect.w + 0.5) {
      node.rect.w = desiredW;
      changed = true;
    }
    if (desiredH > node.rect.h + 0.5) {
      node.rect.h = desiredH;
      changed = true;
    }
    return changed;
  }

  private scheduleTextNodeStreamingAutoGrow(nodeId: string): void {
    if (!nodeId) return;
    this.textStreamingAutoResizeNodeIds.add(nodeId);
    if (this.textStreamingAutoResizeRaf != null) return;

    this.textStreamingAutoResizeRaf = requestAnimationFrame(() => {
      this.textStreamingAutoResizeRaf = null;
      const ids = Array.from(this.textStreamingAutoResizeNodeIds);
      this.textStreamingAutoResizeNodeIds.clear();

      let anyResized = false;
      for (const id of ids) {
        const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === id) ?? null;
        if (!node) continue;
        if (!node.isGenerating) continue;
        const changed = this.applySpawnAutoSizeToTextNode(node, { mode: 'grow_only' });
        if (changed) anyResized = true;
      }

      if (anyResized) this.requestRender();
    });
  }

  private textRasterSigForNode(node: TextNode, contentRect: Rect): { sig: string; scrollY: number } {
    const scrollY = this.getTextNodeScrollY(node);
    const gutter = this.getTextScrollGutterPx();
    const sig = `${node.displayHash}|${Math.round(contentRect.w)}x${Math.round(contentRect.h)}|sy${scrollY}|sg${gutter}`;
    return { sig, scrollY };
  }

  private buildTextNodeDisplaySig(node: TextNode): string {
    const parts: string[] = [];
    parts.push(node.contentHash);
    parts.push(node.author);
    parts.push(node.isGenerating ? 'gen:1' : 'gen:0');

    const atts = Array.isArray(node.attachments) ? node.attachments : [];
    if (atts.length > 0) {
      const attSig = atts
        .map((a) => {
          if (!a || typeof a !== 'object') return '';
          if (a.kind === 'image') {
            const storageKey = typeof a.storageKey === 'string' ? a.storageKey : '';
            const rev = storageKey ? (this.attachmentThumbDataUrlByKey.get(storageKey)?.rev ?? 0) : 0;
            const dataLen = typeof a.data === 'string' ? a.data.length : 0;
            const name = typeof a.name === 'string' ? a.name.trim() : '';
            return `i:${storageKey}:${rev}:${dataLen}:${name}`;
          }
          if (a.kind === 'pdf') {
            const storageKey = typeof a.storageKey === 'string' ? a.storageKey : '';
            const dataLen = typeof a.data === 'string' ? a.data.length : 0;
            const name = typeof a.name === 'string' ? a.name.trim() : '';
            const size = Number.isFinite(a.size) ? a.size : '';
            return `p:${storageKey}:${dataLen}:${name}:${size}`;
          }
          if (a.kind === 'ink') {
            const storageKey = typeof a.storageKey === 'string' ? a.storageKey : '';
            const rev = Number.isFinite(a.rev) ? a.rev : '';
            return `k:${storageKey}:${rev}`;
          }
          return '';
        })
        .join('|');
      parts.push(`att:${attSig}`);
    }

    if (node.author === 'user') {
      const replyTo = (node.userPreface?.replyTo ?? '').trim();
      if (replyTo) parts.push(`replyTo:${replyTo}`);
      const ctxRaw = Array.isArray(node.userPreface?.contexts) ? node.userPreface!.contexts! : [];
      const ctx = ctxRaw.map((t) => String(t ?? '').trim()).filter(Boolean);
      if (ctx.length > 0) parts.push(`contexts:${ctx.join('\n')}`);
      const collapsed = node.collapsedPrefaceContexts ?? {};
      const collapsedKeys = Object.keys(collapsed)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n) && collapsed[n])
        .sort((a, b) => a - b)
        .join(',');
      if (collapsedKeys) parts.push(`ctxcollapsed:${collapsedKeys}`);
    }

    if (node.author === 'assistant') {
      const expanded = node.expandedSummaryChunks ?? {};
      const expandedKeys = Object.keys(expanded)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n) && expanded[n])
        .sort((a, b) => a - b)
        .join(',');
      parts.push(node.summaryExpanded ? 'sumexp:1' : 'sumexp:0');
      parts.push(`sumchunks:${expandedKeys}`);

	      if (node.isGenerating) {
	        const chunks = Array.isArray(node.thinkingSummary) ? node.thinkingSummary : [];
	        const sorted = chunks.slice().sort((a, b) => (a.summaryIndex ?? 0) - (b.summaryIndex ?? 0));
	        for (const c of sorted) parts.push(`s:${c.summaryIndex}:${c.done ? 1 : 0}:${c.text ?? ''}`);
	      } else {
	        const blocks = this.getFinalReasoningBlocks(node);
	        for (const b of blocks) parts.push(`b:${b.text ?? ''}`);
	      }
	    }

    return parts.join('\n');
  }

  private touchAttachmentThumbDataUrl(storageKey: string): void {
    const entry = this.attachmentThumbDataUrlByKey.get(storageKey);
    if (!entry) return;
    this.attachmentThumbDataUrlByKey.delete(storageKey);
    this.attachmentThumbDataUrlByKey.set(storageKey, entry);
  }

  private evictOldAttachmentThumbDataUrls(): void {
    while (
      this.attachmentThumbDataUrlByKey.size > this.attachmentThumbDataUrlMaxEntries ||
      this.attachmentThumbDataUrlBytes > this.attachmentThumbDataUrlMaxBytes
    ) {
      const oldestKey = this.attachmentThumbDataUrlByKey.keys().next().value as string | undefined;
      if (!oldestKey) return;
      const entry = this.attachmentThumbDataUrlByKey.get(oldestKey);
      if (entry) {
        this.attachmentThumbDataUrlBytes -= entry.size || 0;
      }
      this.attachmentThumbDataUrlByKey.delete(oldestKey);
    }
  }

  private async prefetchAttachmentThumbDataUrl(storageKey: string): Promise<void> {
    const key = typeof storageKey === 'string' ? storageKey.trim() : '';
    if (!key) return;
    if (this.attachmentThumbDataUrlByKey.has(key)) return;
    if (this.attachmentThumbDataUrlInFlight.has(key)) return;
    if (this.attachmentThumbDataUrlFailed.has(key)) return;

    this.attachmentThumbDataUrlInFlight.add(key);
    try {
      const rec = await getStoredAttachment(key);
      const blob = rec?.blob ?? null;
      if (!blob) {
        this.attachmentThumbDataUrlFailed.add(key);
        return;
      }

      const thumbDataUrl = await (async () => {
        if (typeof document === 'undefined') return null;
        const srcUrl = URL.createObjectURL(blob);
        try {
          const img = new Image();
          (img as any).decoding = 'async';
          img.src = srcUrl;
          if (typeof (img as any).decode === 'function') {
            await (img as any).decode();
          } else {
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = () => reject(new Error('Failed to load image attachment.'));
            });
          }

          const iw = Number.isFinite(img.naturalWidth) ? img.naturalWidth : 0;
          const ih = Number.isFinite(img.naturalHeight) ? img.naturalHeight : 0;
          if (iw <= 0 || ih <= 0) return null;

          const THUMB_PX = 192;
          const canvas = document.createElement('canvas');
          canvas.width = THUMB_PX;
          canvas.height = THUMB_PX;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;

          // "Cover" crop into a square thumbnail.
          const scale = Math.max(THUMB_PX / iw, THUMB_PX / ih);
          const sw = THUMB_PX / scale;
          const sh = THUMB_PX / scale;
          const sx = Math.max(0, (iw - sw) * 0.5);
          const sy = Math.max(0, (ih - sh) * 0.5);
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, THUMB_PX, THUMB_PX);

          try {
            return canvas.toDataURL('image/png');
          } catch {
            return null;
          }
        } finally {
          try {
            URL.revokeObjectURL(srcUrl);
          } catch {
            // ignore
          }
        }
      })();

      if (!thumbDataUrl) {
        this.attachmentThumbDataUrlFailed.add(key);
        return;
      }

      const size = Math.max(0, thumbDataUrl.length || 0);
      const rev = (this.attachmentThumbDataUrlRevByKey.get(key) ?? 0) + 1;
      this.attachmentThumbDataUrlRevByKey.set(key, rev);

      const prev = this.attachmentThumbDataUrlByKey.get(key);
      if (prev) this.attachmentThumbDataUrlBytes -= prev.size || 0;
      this.attachmentThumbDataUrlByKey.set(key, { key, dataUrl: thumbDataUrl, rev, size });
      this.attachmentThumbDataUrlBytes += size;
      this.touchAttachmentThumbDataUrl(key);
      this.evictOldAttachmentThumbDataUrls();

      let anyChanged = false;
      for (const node of this.nodes) {
        if (node.kind !== 'text') continue;
        const atts = Array.isArray(node.attachments) ? node.attachments : [];
        const usesKey = atts.some((a) => a?.kind === 'image' && typeof a.storageKey === 'string' && a.storageKey === key);
        if (!usesKey) continue;
        const prevHash = node.displayHash;
        this.recomputeTextNodeDisplayHash(node);
        if (node.displayHash !== prevHash) anyChanged = true;
      }

      if (anyChanged) {
        this.textRasterGeneration += 1;
        this.requestRender();
      }
    } catch {
      this.attachmentThumbDataUrlFailed.add(key);
    } finally {
      this.attachmentThumbDataUrlInFlight.delete(key);
    }
  }

  private resolveImageAttachmentThumbSrc(att: ChatAttachment): string | null {
    if (!att || att.kind !== 'image') return null;

    if (typeof att.data === 'string' && att.data) {
      const mimeType = typeof att.mimeType === 'string' && att.mimeType ? att.mimeType : 'image/png';
      return `data:${mimeType};base64,${att.data}`;
    }

    const storageKey = typeof att.storageKey === 'string' ? att.storageKey : '';
    if (!storageKey) return null;

    const entry = this.attachmentThumbDataUrlByKey.get(storageKey);
    if (entry?.dataUrl) {
      this.touchAttachmentThumbDataUrl(storageKey);
      return entry.dataUrl;
    }

    void this.prefetchAttachmentThumbDataUrl(storageKey);
    return null;
  }

  private recomputeTextNodeDisplayHash(node: TextNode): void {
    node.displayHash = fingerprintText(this.buildTextNodeDisplaySig(node));
  }

  private getFinalReasoningBlocks(node: TextNode): Array<{ id: number; text: string }> {
    const blocks = readReasoningSummaryBlocks(node.canonicalMeta);
    if (blocks.length > 0) return blocks.map((b, i) => ({ id: i, text: b.text }));
    const chunks = Array.isArray(node.thinkingSummary) ? node.thinkingSummary : [];
    if (chunks.length > 0) return chunks.map((c) => ({ id: c.summaryIndex ?? 0, text: c.text ?? '' }));
    return [];
  }

  private renderTextNodeHtml(node: TextNode): string {
    const isUser = node.author === 'user';
    const isAssistant = node.author === 'assistant';
    const content = typeof node.content === 'string' ? node.content : String(node.content ?? '');
    const hasContent = Boolean(content.trim());
    const parts: string[] = [];

    if (node.isGenerating && !hasContent) {
      parts.push('<div style="margin:8px 0 6px;color:rgba(255,255,255,0.55);font-size:0.93em;">Thinking...</div>');
    }

    if (isAssistant) {
      const streaming = Array.isArray(node.thinkingSummary) ? node.thinkingSummary : [];
      const finalBlocks = this.getFinalReasoningBlocks(node);
      const showSection = (streaming.length > 0) || (finalBlocks.length > 0);
      const showToggle = !node.isGenerating && finalBlocks.length > 0;
      const showBody =
        (node.isGenerating && streaming.length > 0) ||
        (!node.isGenerating && Boolean(node.summaryExpanded) && finalBlocks.length > 0);

      if (showSection) {
        if (showToggle) {
          const chevron = node.summaryExpanded ? '▾' : '▸';
          parts.push(
            `<div data-gcv1-summary-toggle="1" style="margin:8px 0 4px;display:inline-flex;align-items:center;gap:6px;` +
              `color:rgba(255,255,255,0.55);font-size:0.93em;cursor:pointer;user-select:none;">` +
              `<span aria-hidden="true" style="width:1em;display:inline-flex;justify-content:center;">${chevron}</span>` +
              `<span>Thinking summary</span>` +
              `</div>`,
          );
        }

        if (showBody) {
          parts.push('<div style="margin:0 0 8px;color:rgba(255,255,255,0.55);font-size:0.93em;">');
          const rows: Array<{ summaryIndex: number; text: string; done: boolean }> = node.isGenerating
            ? streaming.map((c) => ({ summaryIndex: c.summaryIndex ?? 0, text: c.text ?? '', done: Boolean(c.done) }))
            : finalBlocks.map((b) => ({ summaryIndex: b.id ?? 0, text: b.text ?? '', done: true }));

          for (const row of rows) {
            const idx = row.summaryIndex ?? 0;
            const rawText = row.text ?? '';
            if (node.isGenerating && !row.done) {
              parts.push(
                `<div style="display:flex;align-items:flex-start;gap:6px;margin:2px 0;">` +
                  `<span aria-hidden="true" style="width:1em;flex:0 0 1em;margin-top:0.15em;"></span>` +
                  `<div style="white-space:pre-wrap;flex:1;min-width:0;">${escapeHtml(stripStrong(rawText))}</div>` +
                  `</div>`,
              );
              continue;
            }

            const expanded = Boolean(node.expandedSummaryChunks?.[idx]);
            const chevron = expanded ? '▾' : '▸';
            const display = expanded ? stripStrong(rawText) : summarizeFirstLine(rawText);
            const textStyle = expanded
              ? 'white-space:pre-wrap;'
              : 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            parts.push(
              `<div style="display:flex;align-items:flex-start;gap:6px;margin:2px 0;">` +
                `<span data-gcv1-summary-chunk-toggle="${idx}" aria-hidden="true" ` +
                `style="width:1em;flex:0 0 1em;margin-top:0.15em;display:inline-flex;justify-content:center;` +
                `color:rgba(255,255,255,0.55);cursor:pointer;user-select:none;">${chevron}</span>` +
                `<div style="${textStyle}flex:1;min-width:0;">${escapeHtml(display)}</div>` +
                `</div>`,
            );
          }
          parts.push('</div>');
        }
      }
    }

    if (isUser) {
      const replyTo = (node.userPreface?.replyTo ?? '').trim();
      const ctxRaw = Array.isArray(node.userPreface?.contexts) ? node.userPreface!.contexts! : [];
      const ctx = ctxRaw.map((t) => String(t ?? '').trim()).filter(Boolean);
      if (replyTo || ctx.length > 0) {
        parts.push(
          '<div style="margin:8px 0 10px;padding:8px 10px;border:1px solid rgba(255,255,255,0.12);' +
            'border-radius:12px;background:rgba(0,0,0,0.18);font-size:0.85em;color:rgba(255,255,255,0.88);">',
        );
        if (replyTo) {
          parts.push(
            '<div style="margin:0 0 6px;">' +
              '<span style="opacity:0.75;">Replying to:</span> ' +
              '<span style="font-style:italic;white-space:pre-wrap;">' +
              escapeHtml(replyTo) +
              '</span>' +
              '</div>',
          );
        }
        for (let i = 0; i < ctx.length; i += 1) {
          const collapsed = Boolean(node.collapsedPrefaceContexts?.[i]);
          const chevron = collapsed ? '▸' : '▾';
          const display = collapsed ? summarizeFirstLine(ctx[i]) : ctx[i];
          const textStyle = collapsed
            ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
            : 'white-space:pre-wrap;';
          const rowAlign = collapsed ? 'center' : 'flex-start';
          const chevronMarginTop = collapsed ? '0' : '0.15em';
          const bodyStyle = collapsed
            ? 'flex:1;min-width:0;display:flex;align-items:center;'
            : 'flex:1;min-width:0;';
          parts.push(
            `<div style="display:flex;align-items:${rowAlign};gap:6px;margin:0 0 6px;">` +
              `<span data-gcv1-preface-context-toggle="${i}" aria-hidden="true" ` +
              `style="width:1em;flex:0 0 1em;margin-top:${chevronMarginTop};display:inline-flex;justify-content:center;` +
              'color:rgba(255,255,255,0.55);cursor:pointer;user-select:none;">' +
              chevron +
              '</span>' +
              `<div style="${bodyStyle}">` +
              `<span style="opacity:0.75;flex:0 0 auto;margin-right:6px;">Context ${i + 1}:</span>` +
              `<span style="font-style:italic;${textStyle}flex:1;min-width:0;">` +
              escapeHtml(display) +
              '</span>' +
              '</div>' +
              '</div>',
          );
        }
        parts.push('</div>');
      }
    }

    const atts = Array.isArray(node.attachments) ? node.attachments : [];
    if (atts.length > 0) {
      parts.push('<div style="display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 10px;">');
      for (const att of atts) {
        if (!att) continue;
        parts.push(
          '<div style="width:96px;height:96px;border-radius:8px;overflow:hidden;' +
            'border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.20);">',
        );

        if (att.kind === 'image') {
          const src = this.resolveImageAttachmentThumbSrc(att);
          if (src) {
            const alt = typeof att.name === 'string' && att.name.trim() ? att.name.trim() : 'attachment';
            parts.push(
              `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" ` +
                'style="width:100%;height:100%;object-fit:cover;display:block;" />',
            );
          } else {
            parts.push(
              '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
                'font-size:11px;color:rgba(243,244,246,0.85);">Image</div>',
            );
          }
        } else if (att.kind === 'pdf') {
          const label = 'PDF';
          const name = typeof att.name === 'string' && att.name.trim() ? att.name.trim() : 'document.pdf';
          parts.push(
            '<div style="width:100%;height:100%;display:flex;flex-direction:column;' +
              'align-items:center;justify-content:center;padding:6px;box-sizing:border-box;' +
              'text-align:center;color:rgba(243,244,246,0.90);">',
          );
          parts.push('<div style="font-weight:700;font-size:11px;">' + escapeHtml(label) + '</div>');
          parts.push(
            '<div style="font-size:10px;opacity:0.85;word-break:break-all;display:-webkit-box;' +
              '-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;">' +
              escapeHtml(name) +
              '</div>',
          );
          parts.push('</div>');
        } else if (att.kind === 'ink') {
          parts.push(
            '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
              'font-size:11px;color:rgba(243,244,246,0.85);">Ink</div>',
          );
        }

        parts.push('</div>');
      }
      parts.push('</div>');
    }

    if (hasContent) {
      if (node.isGenerating && !isUser) {
        parts.push('<div style="font-size:0.79em;color:rgba(255,255,255,0.45);margin:0 0 4px;">Streaming…</div>');
      }
      parts.push(renderMarkdownMath(content));
    }

    return parts.join('');
  }

  private updateTextLod2HitZonesFromOverlay(nodeId: string, displayHash: string, overlay: TextLod2Overlay): void {
    try {
      const z = Math.max(0.001, overlay.getZoom() || 1);
      const contentEl = overlay.getContentElement();
      const base = contentEl.getBoundingClientRect();
      const zones: TextHitZone[] = [];

      const sum = contentEl.querySelector('[data-gcv1-summary-toggle]') as HTMLElement | null;
      if (sum) {
        const r = sum.getBoundingClientRect();
        zones.push({
          kind: 'summary_toggle',
          left: (r.left - base.left) / z,
          top: (r.top - base.top) / z,
          width: r.width / z,
          height: r.height / z,
        });
      }

      const chunkBtns = Array.from(contentEl.querySelectorAll('[data-gcv1-summary-chunk-toggle]')) as HTMLElement[];
      for (const el of chunkBtns) {
        const raw = el.getAttribute('data-gcv1-summary-chunk-toggle') ?? '';
        const idx = Number(raw);
        if (!Number.isFinite(idx)) continue;
        const r = el.getBoundingClientRect();
        zones.push({
          kind: 'summary_chunk_toggle',
          summaryIndex: idx,
          left: (r.left - base.left) / z,
          top: (r.top - base.top) / z,
          width: r.width / z,
          height: r.height / z,
        });
      }

      const contextBtns = Array.from(
        contentEl.querySelectorAll('[data-gcv1-preface-context-toggle]'),
      ) as HTMLElement[];
      for (const el of contextBtns) {
        const raw = el.getAttribute('data-gcv1-preface-context-toggle') ?? '';
        const idx = Number(raw);
        if (!Number.isFinite(idx)) continue;
        const r = el.getBoundingClientRect();
        zones.push({
          kind: 'preface_context_toggle',
          contextIndex: idx,
          left: (r.left - base.left) / z,
          top: (r.top - base.top) / z,
          width: r.width / z,
          height: r.height / z,
        });
      }

      this.textLod2HitZones = { nodeId, displayHash, zones };
    } catch {
      this.textLod2HitZones = null;
    }
  }

  private getTextNodeHitZoneAtWorld(node: TextNode, world: Vec2): TextHitZone | null {
    const contentRect = this.textContentRect(node.rect);
    const localX = world.x - contentRect.x;
    const localY = world.y - contentRect.y;
    if (localX < 0 || localY < 0 || localX > contentRect.w || localY > contentRect.h) return null;

    // Prefer DOM overlay hit zones if the overlay is currently showing this node.
    const overlayZones =
      this.textLod2Target?.nodeId === node.id &&
      this.textLod2 &&
      this.textLod2HitZones &&
      this.textLod2HitZones.nodeId === node.id &&
      this.textLod2HitZones.displayHash === node.displayHash
        ? this.textLod2HitZones.zones
        : null;

    const zones = overlayZones ?? (() => {
      const sig = this.textRasterSigForNode(node, contentRect).sig;
      const best = this.getBestTextRaster(sig);
      return best?.hitZones ?? null;
    })();

    if (!zones || zones.length === 0) return null;
    for (const z of zones) {
      if (
        localX >= z.left &&
        localX <= z.left + z.width &&
        localY >= z.top &&
        localY <= z.top + z.height
      ) {
        return z;
      }
    }
    return null;
  }

  private ensureTextLod2Overlay(): TextLod2Overlay | null {
    if (this.textLod2) return this.textLod2;
    if (typeof document === 'undefined') return null;
    const host = this.overlayHost;
    if (!host) return null;
    const overlay = new TextLod2Overlay({
      host,
      textStyle: this.nodeTextStyle(),
      onRequestCloseSelection: () => {
        this.clearTextSelection({ suppressOverlayCallback: true });
        this.requestRender();
      },
      onRequestReplyToSelection: (nodeId, selectionText) => {
        try {
          this.onRequestReplyToSelection?.(nodeId, selectionText);
        } catch {
          // ignore
        }
      },
      onRequestAddToContext: (nodeId, selectionText) => {
        try {
          this.onRequestAddToContextSelection?.(nodeId, selectionText);
        } catch {
          // ignore
        }
      },
      onRequestPenTextSelectPointerDown: (nodeId, client, trigger) => {
        return this.beginPenTextSelectFromTextOverlay(nodeId, client, trigger);
      },
      onRequestPenTextSelectPointerMove: (nodeId, client, trigger) => {
        this.continuePenTextSelectFromTextOverlay(nodeId, client, trigger);
      },
      onRequestPenTextSelectPointerUp: (nodeId, client, trigger) => {
        this.endPenTextSelectFromTextOverlay(nodeId, client, trigger);
      },
      onRequestPenTextSelectPointerCancel: (nodeId, trigger) => {
        this.cancelPenTextSelectFromTextOverlay(nodeId, trigger);
      },
      onRequestAnnotateTextSelection: (nodeId, selectionText, client, trigger) => {
        this.beginTextAnnotationPlacement({ kind: 'text', textNodeId: nodeId, selectionText, client, trigger });
      },
      onRequestAnnotateInkSelection: (nodeId, selectionText, client, trigger) => {
        this.beginTextAnnotationPlacement({ kind: 'ink', textNodeId: nodeId, selectionText, client, trigger });
      },
      onRequestSelect: (nodeId) => {
        if (!nodeId) return;
        if (!this.nodes.some((n) => n.id === nodeId)) return;
        const changed = this.selectedNodeId !== nodeId || this.editingNodeId !== null;
        this.selectedNodeId = nodeId;
        this.editingNodeId = null;
        this.bringNodeToFront(nodeId);
        this.requestRender();
        if (changed) this.emitUiState();
      },
      onRequestEdit: (nodeId) => {
        if (!nodeId) return false;
        return this.tryBeginEditingNode(nodeId);
      },
      onRequestAction: (action: TextLod2Action) => {
        const nodeId = action?.nodeId;
        if (!nodeId) return;
        const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === nodeId) ?? null;
        if (!node) return;

        if (action.kind === 'preface_context_toggle') {
          if (node.author !== 'user') return;
          const idx = Number(action.contextIndex);
          if (!Number.isFinite(idx)) return;
          const prev = node.collapsedPrefaceContexts ?? {};
          const next: Record<number, boolean> = { ...prev };
          if (next[idx]) delete next[idx];
          else next[idx] = true;
          node.collapsedPrefaceContexts = Object.keys(next).length ? next : undefined;

          this.recomputeTextNodeDisplayHash(node);
          this.textRasterGeneration += 1;
          const contentRect = this.textContentRect(node.rect);
          const sig = this.textRasterSigForNode(node, contentRect).sig;
          this.textResizeHold = { nodeId: node.id, sig, expiresAt: performance.now() + 2200 };
          this.requestRender();
          try {
            this.onRequestPersist?.();
          } catch {
            // ignore
          }
          return;
        }

        if (node.author !== 'assistant') return;

        if (action.kind === 'summary_toggle') {
          const blocks = this.getFinalReasoningBlocks(node);
          if (node.isGenerating || blocks.length === 0) return;
          node.summaryExpanded = !node.summaryExpanded;
          this.recomputeTextNodeDisplayHash(node);
          this.textRasterGeneration += 1;
          const contentRect = this.textContentRect(node.rect);
          const sig = this.textRasterSigForNode(node, contentRect).sig;
          this.textResizeHold = { nodeId: node.id, sig, expiresAt: performance.now() + 2200 };
          this.requestRender();
          try {
            this.onRequestPersist?.();
          } catch {
            // ignore
          }
          return;
        }

        if (action.kind === 'summary_chunk_toggle') {
          const idx = Number(action.summaryIndex);
          if (!Number.isFinite(idx)) return;
          const prev = node.expandedSummaryChunks ?? {};
          const next: Record<number, boolean> = { ...prev };
          if (next[idx]) delete next[idx];
          else next[idx] = true;
          node.expandedSummaryChunks = Object.keys(next).length ? next : undefined;

          this.recomputeTextNodeDisplayHash(node);
          if (!node.isGenerating) {
            this.textRasterGeneration += 1;
            const contentRect = this.textContentRect(node.rect);
            const sig = this.textRasterSigForNode(node, contentRect).sig;
            this.textResizeHold = { nodeId: node.id, sig, expiresAt: performance.now() + 2200 };
          }
          this.requestRender();
          try {
            this.onRequestPersist?.();
          } catch {
            // ignore
          }
        }
      },
    });
    overlay.onScroll = (nodeId, scrollTop) => {
      const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === nodeId) ?? null;
      if (!node) return;
      if (node.id === this.editingNodeId) return;
      const next = Math.max(0, Math.round(Number(scrollTop) || 0));
      const prev = this.getTextNodeScrollY(node);
      if (next === prev) return;

      node.contentScrollY = next > 0 ? next : undefined;
      if (!node.isGenerating) {
        const contentRect = this.textContentRect(node.rect);
        const sig = this.textRasterSigForNode(node, contentRect).sig;
        this.textResizeHold = { nodeId: node.id, sig, expiresAt: performance.now() + 2200 };
      }

      this.requestRender();
      try {
        this.onRequestPersist?.();
      } catch {
        // ignore
      }
    };

    this.textLod2 = overlay;
    return overlay;
  }

  private ensureTextStreamLod2Overlay(): TextLod2Overlay | null {
    if (this.textStreamLod2) return this.textStreamLod2;
    if (typeof document === 'undefined') return null;
    const host = this.overlayHost;
    if (!host) return null;
    this.textStreamLod2 = new TextLod2Overlay({ host, zIndex: 9, textStyle: this.nodeTextStyle() });
    return this.textStreamLod2;
  }

  private ensurePdfTextLod2Overlay(): PdfTextLod2Overlay | null {
    if (this.pdfTextLod2) return this.pdfTextLod2;
    if (typeof document === 'undefined') return null;
    const host = this.overlayHost;
    if (!host) return null;
    this.pdfTextLod2 = new PdfTextLod2Overlay({
      host,
      onRequestCloseSelection: () => {
        this.clearPdfTextSelection({ suppressOverlayCallback: true });
        this.requestRender();
      },
      onRequestReplyToSelection: (nodeId, selectionText) => {
        try {
          this.onRequestReplyToSelection?.(nodeId, selectionText);
        } catch {
          // ignore
        }
      },
      onRequestAddToContext: (nodeId, selectionText) => {
        try {
          this.onRequestAddToContextSelection?.(nodeId, selectionText);
        } catch {
          // ignore
        }
      },
      onRequestAnnotateTextSelection: (nodeId, selectionText, anchor, client, trigger) => {
        this.beginPdfAnnotationPlacement({ kind: 'text', pdfNodeId: nodeId, selectionText, anchor, client, trigger });
      },
      onRequestAnnotateInkSelection: (nodeId, selectionText, anchor, client, trigger) => {
        this.beginPdfAnnotationPlacement({ kind: 'ink', pdfNodeId: nodeId, selectionText, anchor, client, trigger });
      },
      onTextLayerReady: () => {
        if (this.pdfSelectLastClient && this.pdfSelectTarget) this.schedulePdfPenSelectionUpdate();
        this.requestRender();
      },
    });
    return this.pdfTextLod2;
  }

  private beginPdfAnnotationPlacement(opts: {
    kind: 'text' | 'ink';
    pdfNodeId: string;
    selectionText: string;
    anchor: PdfSelectionStartAnchor;
    client?: { x: number; y: number } | null;
    trigger?: { pointerId: number; pointerType: string } | null;
  }): void {
    this.cancelTextAnnotationPlacement();

    // During annotation placement, ensure the PDF LOD2 text overlay isn't intercepting pointermove;
    // otherwise the dashed preview arrow can appear "frozen" until the mouse leaves the PDF region.
    this.hoverPdfPage = null;
    this.hoverTextNodeId = null;
    this.hoverNodeHeaderButton = null;
    this.pdfLod2Target = null;
    this.pdfTextLod2?.hide();

    const pdfNodeId = typeof opts.pdfNodeId === 'string' ? opts.pdfNodeId : String(opts.pdfNodeId ?? '');
    if (!pdfNodeId) return;
    const selectionText = String(opts.selectionText ?? '').trim();
    if (!selectionText) return;
    const pageNumber = Math.max(1, Math.floor(opts.anchor?.pageNumber ?? 1));
    const yPct = clamp(Number(opts.anchor?.yPct ?? 0.5), 0, 1);

    const trigger = opts.trigger ?? null;
    const triggerPointerType = trigger?.pointerType || 'mouse';
    const isDirectPointerPlacement = trigger != null && triggerPointerType !== 'mouse';

    const hoverWorld = (() => {
      if (isDirectPointerPlacement) return null;
      const client = opts.client;
      if (!client) return null;
      const clientX = Number(client.x);
      const clientY = Number(client.y);
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
      const rect = this.canvas.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0.5 || rect.height <= 0.5) return null;
      const p: Vec2 = {
        x: clamp(clientX - rect.left, 0, rect.width),
        y: clamp(clientY - rect.top, 0, rect.height),
      };
      return this.camera.screenToWorld(p);
    })();

    this.pdfAnnotationPlacement = {
      kind: opts.kind === 'ink' ? 'ink' : 'text',
      pdfNodeId,
      selectionText,
      anchor: { pageNumber, yPct },
      hoverWorld,
      outlineRect: null,
    };

    if (isDirectPointerPlacement) {
      const client = opts.client ?? null;
      const clientX = Number(client?.x);
      const clientY = Number(client?.y);
      if (Number.isFinite(clientX) && Number.isFinite(clientY) && trigger) {
        const rect = this.canvas.getBoundingClientRect();
        const p: Vec2 = { x: clientX - rect.left, y: clientY - rect.top };
        this.activeGesture = {
          kind: 'pdf-annotation-place',
          pointerId: trigger.pointerId,
          pointerType: triggerPointerType,
          hadHover: false,
        };
        this.suppressTapPointerIds.add(trigger.pointerId);
        this.input.adoptPointer({
          pointerId: trigger.pointerId,
          pointerType: triggerPointerType,
          pos: p,
          captureMode: 'node',
          forceDrag: true,
        });
      }
    }

    this.requestRender();
  }

  private beginTextAnnotationPlacement(opts: {
    kind: 'text' | 'ink';
    textNodeId: string;
    selectionText: string;
    client?: { x: number; y: number } | null;
    trigger?: { pointerId: number; pointerType: string } | null;
  }): void {
    this.cancelPdfAnnotationPlacement();

    // During annotation placement, ensure LOD2 DOM overlays aren't intercepting pointermove;
    // otherwise the dashed preview arrow can appear "frozen" until the mouse leaves the overlay region.
    this.hoverPdfPage = null;
    this.hoverTextNodeId = null;
    this.hoverNodeHeaderButton = null;
    this.textLod2Target = null;
    this.pdfLod2Target = null;
    this.textLod2?.hide();
    this.pdfTextLod2?.hide();

    const textNodeId = typeof opts.textNodeId === 'string' ? opts.textNodeId : String(opts.textNodeId ?? '');
    if (!textNodeId) return;
    const selectionText = String(opts.selectionText ?? '').trim();
    if (!selectionText) return;

    const trigger = opts.trigger ?? null;
    const triggerPointerType = trigger?.pointerType || 'mouse';
    const isDirectPointerPlacement = trigger != null && triggerPointerType !== 'mouse';

    const hoverWorld = (() => {
      if (isDirectPointerPlacement) return null;
      const client = opts.client;
      if (!client) return null;
      const clientX = Number(client.x);
      const clientY = Number(client.y);
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
      const rect = this.canvas.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0.5 || rect.height <= 0.5) return null;
      const p: Vec2 = {
        x: clamp(clientX - rect.left, 0, rect.width),
        y: clamp(clientY - rect.top, 0, rect.height),
      };
      return this.camera.screenToWorld(p);
    })();

    this.textAnnotationPlacement = {
      kind: opts.kind === 'ink' ? 'ink' : 'text',
      textNodeId,
      selectionText,
      hoverWorld,
      outlineRect: null,
    };

    if (isDirectPointerPlacement) {
      const client = opts.client ?? null;
      const clientX = Number(client?.x);
      const clientY = Number(client?.y);
      if (Number.isFinite(clientX) && Number.isFinite(clientY) && trigger) {
        const rect = this.canvas.getBoundingClientRect();
        const p: Vec2 = { x: clientX - rect.left, y: clientY - rect.top };
        this.activeGesture = {
          kind: 'text-annotation-place',
          pointerId: trigger.pointerId,
          pointerType: triggerPointerType,
          hadHover: false,
        };
        this.suppressTapPointerIds.add(trigger.pointerId);
        this.input.adoptPointer({
          pointerId: trigger.pointerId,
          pointerType: triggerPointerType,
          pos: p,
          captureMode: 'node',
          forceDrag: true,
        });
      }
    }

    this.requestRender();
  }

  private applyPdfAnnotationToChildNode(childNodeId: string, placement: PdfAnnotationPlacement): void {
    const childId = typeof childNodeId === 'string' ? childNodeId : String(childNodeId ?? '');
    if (!childId) return;
    const pdfNodeId = typeof placement.pdfNodeId === 'string' ? placement.pdfNodeId : String(placement.pdfNodeId ?? '');
    if (!pdfNodeId) return;

    const node = this.nodes.find((n) => n.id === childId) ?? null;
    if (!node) return;

    node.parentId = pdfNodeId;
    node.parentAnchor = {
      kind: 'pdf-selection',
      pageNumber: Math.max(1, Math.floor(placement.anchor.pageNumber || 1)),
      yPct: clamp(Number(placement.anchor.yPct || 0.5), 0, 1),
    };

    if (node.kind === 'text') {
      node.userPreface = { contexts: [placement.selectionText] };
      node.collapsedPrefaceContexts = { 0: true };
      const desiredPdfKey = `pdf:${pdfNodeId}`;
      const existing = Array.isArray(node.selectedAttachmentKeys) ? node.selectedAttachmentKeys : [];
      if (!existing.includes(desiredPdfKey)) {
        node.selectedAttachmentKeys = [...existing, desiredPdfKey];
      }
      this.recomputeTextNodeDisplayHash(node);
      this.textRasterGeneration += 1;
    }

    this.requestRender();
  }

  private applyTextAnnotationToChildNode(childNodeId: string, placement: TextAnnotationPlacement): void {
    const childId = typeof childNodeId === 'string' ? childNodeId : String(childNodeId ?? '');
    if (!childId) return;
    const textNodeId =
      typeof placement.textNodeId === 'string' ? placement.textNodeId : String(placement.textNodeId ?? '');
    if (!textNodeId) return;

    const node = this.nodes.find((n) => n.id === childId) ?? null;
    if (!node) return;

    node.parentId = textNodeId;
    node.parentAnchor = undefined;

    if (node.kind === 'text') {
      node.userPreface = { contexts: [placement.selectionText] };
      node.collapsedPrefaceContexts = { 0: true };
      this.recomputeTextNodeDisplayHash(node);
      this.textRasterGeneration += 1;
    }

    this.requestRender();
  }

  private localToClient(p: Vec2): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }

  clearTextSelection(opts?: { suppressOverlayCallback?: boolean }): void {
    this.textSelectNodeId = null;
    this.textSelectPointerId = null;
    this.textSelectAnchor = null;
    this.textSelectRange = null;
    this.textSelectLastClient = null;
    if (this.textSelectRaf != null) {
      try {
        cancelAnimationFrame(this.textSelectRaf);
      } catch { }
      this.textSelectRaf = null;
    }
    const overlay = this.textLod2;
    if (overlay) {
      overlay.clearHighlights();
      overlay.closeMenu({ suppressCallback: opts?.suppressOverlayCallback });
    }

    try {
      window.getSelection?.()?.removeAllRanges();
    } catch {
      // ignore
    }
  }

  clearPdfTextSelection(opts?: { suppressOverlayCallback?: boolean }): void {
    this.pdfSelectTarget = null;
    this.pdfSelectPointerId = null;
    this.pdfSelectAnchor = null;
    this.pdfSelectRange = null;
    this.pdfSelectLastClient = null;
    if (this.pdfSelectRaf != null) {
      try {
        cancelAnimationFrame(this.pdfSelectRaf);
      } catch { }
      this.pdfSelectRaf = null;
    }

    const overlay = this.pdfTextLod2;
    if (overlay) {
      overlay.clearHighlights();
      overlay.closeMenu({ suppressCallback: opts?.suppressOverlayCallback });
    }

    try {
      window.getSelection?.()?.removeAllRanges();
    } catch {
      // ignore
    }
  }

  private beginPenTextSelectFromTextOverlay(
    nodeId: string,
    client: { x: number; y: number },
    trigger: { pointerId: number; pointerType: string },
  ): boolean {
    if (this.tool !== 'select') return false;
    if (trigger.pointerType !== 'pen') return false;
    if (!nodeId) return false;
    const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === nodeId) ?? null;
    if (!node) return false;

    this.clearTextSelection({ suppressOverlayCallback: true });

    const selectionChanged = this.selectedNodeId !== node.id || this.editingNodeId !== null;
    this.selectedNodeId = node.id;
    this.editingNodeId = null;
    this.bringNodeToFront(node.id);

    this.textSelectNodeId = node.id;
    this.renderTextLod2Target({ nodeId: node.id, mode: 'select' });

    const anchor = this.caretRangeFromClientPointForLod2(client.x, client.y);
    const contentEl = this.textLod2?.getContentElement() ?? null;

    if (anchor && contentEl && contentEl.contains(anchor.startContainer)) {
      const caretNearPoint = (() => {
        const maxDistPx = 24;
        try {
          const rects = Array.from(anchor.getClientRects());
          const r = (rects[0] ?? anchor.getBoundingClientRect()) || null;
          if (!r) return false;
          const dx = client.x < r.left ? r.left - client.x : client.x > r.right ? client.x - r.right : 0;
          const dy = client.y < r.top ? r.top - client.y : client.y > r.bottom ? client.y - r.bottom : 0;
          return dx * dx + dy * dy <= maxDistPx * maxDistPx;
        } catch {
          return true;
        }
      })();

      if (!caretNearPoint) {
        this.clearTextSelection({ suppressOverlayCallback: true });
        this.requestRender();
        if (selectionChanged) this.emitUiState();
        return false;
      }

      try {
        window.getSelection?.()?.removeAllRanges();
      } catch {
        // ignore
      }

      this.textSelectPointerId = trigger.pointerId;
      this.textSelectAnchor = anchor;
      this.textSelectLastClient = { x: client.x, y: client.y };
      this.textSelectRange = null;

      this.activeGesture = { kind: 'text-select', pointerId: trigger.pointerId, nodeId: node.id };
      this.suppressTapPointerIds.add(trigger.pointerId);
      this.requestRender();
      if (selectionChanged) this.emitUiState();
      return true;
    }

    // Failed to map the pen point into DOM text; keep node selection but abort text selection.
    this.clearTextSelection({ suppressOverlayCallback: true });
    this.requestRender();
    if (selectionChanged) this.emitUiState();
    return false;
  }

  private continuePenTextSelectFromTextOverlay(
    nodeId: string,
    client: { x: number; y: number },
    trigger: { pointerId: number; pointerType: string },
  ): void {
    if (trigger.pointerType !== 'pen') return;
    const g = this.activeGesture;
    if (!g || g.kind !== 'text-select' || g.pointerId !== trigger.pointerId) return;
    if (g.nodeId !== nodeId) return;
    this.textSelectLastClient = { x: client.x, y: client.y };
    this.schedulePenSelectionUpdate();
  }

  private endPenTextSelectFromTextOverlay(
    nodeId: string,
    client: { x: number; y: number },
    trigger: { pointerId: number; pointerType: string },
  ): void {
    if (trigger.pointerType !== 'pen') return;
    const g = this.activeGesture;
    if (!g || g.kind !== 'text-select' || g.pointerId !== trigger.pointerId) return;
    if (g.nodeId !== nodeId) return;

    this.textSelectLastClient = { x: client.x, y: client.y };
    if (this.textSelectRaf != null) {
      try {
        cancelAnimationFrame(this.textSelectRaf);
      } catch { }
      this.textSelectRaf = null;
    }
    this.updatePenSelectionFromLastPoint();

    this.activeGesture = null;
    this.suppressTapPointerIds.delete(trigger.pointerId);

    // End the drag gesture but keep the selection alive while the menu is open.
    this.textSelectPointerId = null;
    this.textSelectAnchor = null;
    this.textSelectLastClient = null;

    const overlay = this.textLod2;
    const range = this.textSelectRange;
    const text = range ? extractTextFromRange(range) : '';
    if (overlay && range && text) {
      const rect = (() => {
        try {
          const rects = Array.from(range.getClientRects());
          return (rects[rects.length - 1] ?? range.getBoundingClientRect()) || null;
        } catch {
          return null;
        }
      })();
      if (rect) {
        overlay.openMenu({ anchorRect: rect, text, range });
      } else {
        this.clearTextSelection({ suppressOverlayCallback: true });
      }
    } else {
      this.clearTextSelection({ suppressOverlayCallback: true });
    }

    this.requestRender();
  }

  private cancelPenTextSelectFromTextOverlay(nodeId: string, trigger: { pointerId: number; pointerType: string }): void {
    if (trigger.pointerType !== 'pen') return;
    const g = this.activeGesture;
    if (!g || g.kind !== 'text-select' || g.pointerId !== trigger.pointerId) return;
    if (g.nodeId !== nodeId) return;
    this.handlePointerCancel({ pointerId: trigger.pointerId, pointerType: trigger.pointerType });
  }

  private computeTextLod2Target(): { nodeId: string; mode: TextLod2Mode } | null {
    if (this.editingNodeId) return null;
    const rawId = this.rawViewerNodeId;
    if (this.pdfAnnotationPlacement || this.textAnnotationPlacement) return null;

    const g = this.activeGesture;
    if (g?.kind === 'resize') {
      const node = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === g.nodeId) ?? null;
      if (node) return { nodeId: g.nodeId, mode: 'resize' };
    }

    if (this.textSelectNodeId && this.textSelectNodeId !== rawId) return { nodeId: this.textSelectNodeId, mode: 'select' };

    const overlay = this.textLod2;
    if (overlay?.isMenuOpen()) {
      const nodeId = overlay.getNodeId();
      if (nodeId && nodeId !== rawId) return { nodeId, mode: 'select' };
    }

    if (this.hoverTextNodeId && this.hoverTextNodeId !== rawId) return { nodeId: this.hoverTextNodeId, mode: 'select' };

    // Touch devices don't have hover; keep the selected text node "interactive" so it can be scrolled/read.
    if (this.touchUi && this.selectedNodeId && this.selectedNodeId !== rawId) {
      const selectedText = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === this.selectedNodeId) ?? null;
      if (selectedText) return { nodeId: selectedText.id, mode: 'select' };
    }

    // While an assistant is streaming, pin the LOD2 overlay to the generating node so
    // the canvas doesn't flicker to the LOD0 placeholder between raster updates.
    const view = this.worldViewportRect({ overscan: 280 });
    const selected = this.selectedNodeId
      ? (this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === this.selectedNodeId) ?? null)
      : null;
    if (selected?.isGenerating && selected.id !== rawId && rectsIntersect(selected.rect, view)) return { nodeId: selected.id, mode: 'select' };

    for (let i = this.nodes.length - 1; i >= 0; i -= 1) {
      const n = this.nodes[i];
      if (n.kind !== 'text') continue;
      if (!n.isGenerating) continue;
      if (n.id === rawId) continue;
      if (!rectsIntersect(n.rect, view)) continue;
      return { nodeId: n.id, mode: 'select' };
    }

    const hold = this.textResizeHold;
    if (hold) {
      const now = performance.now();
      const best = this.getBestTextRaster(hold.sig);
      if (best || now > hold.expiresAt) {
        this.textResizeHold = null;
      } else {
        if (hold.nodeId === rawId) return null;
        return { nodeId: hold.nodeId, mode: 'resize' };
      }
    }

    return null;
  }

  private computeTextStreamLod2Target(
    interactiveTarget: { nodeId: string; mode: TextLod2Mode } | null,
  ): { nodeId: string; mode: TextLod2Mode } | null {
    const editingId = this.editingNodeId;
    const rawId = this.rawViewerNodeId;
    const view = this.worldViewportRect({ overscan: 280 });
    const selected = this.selectedNodeId
      ? (this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === this.selectedNodeId) ?? null)
      : null;

    if (selected?.isGenerating && selected.id !== editingId && selected.id !== rawId && rectsIntersect(selected.rect, view)) {
      if (interactiveTarget?.nodeId === selected.id) return null;
      return { nodeId: selected.id, mode: 'select' };
    }

    for (let i = this.nodes.length - 1; i >= 0; i -= 1) {
      const n = this.nodes[i];
      if (n.kind !== 'text') continue;
      if (n.id === editingId) continue;
      if (n.id === rawId) continue;
      if (!n.isGenerating) continue;
      if (!rectsIntersect(n.rect, view)) continue;
      if (interactiveTarget?.nodeId === n.id) return null;
      return { nodeId: n.id, mode: 'select' };
    }

    return null;
  }

  private computePdfLod2Target(): { nodeId: string; token: number; pageNumber: number } | null {
    if (this.editingNodeId) return null;
    if (this.pdfAnnotationPlacement || this.textAnnotationPlacement) return null;

    const g = this.activeGesture;
    if (g?.kind === 'pdf-text-select') return { nodeId: g.nodeId, token: g.token, pageNumber: g.pageNumber };

    if (this.pdfSelectTarget) return this.pdfSelectTarget;

    const overlay = this.pdfTextLod2;
    if (overlay?.isMenuOpen()) {
      const nodeId = overlay.getNodeId();
      const token = overlay.getToken();
      const pageNumber = overlay.getPageNumber();
      if (nodeId && token != null && pageNumber != null) return { nodeId, token, pageNumber };
    }

    if (this.hoverPdfPage) return this.hoverPdfPage;

    return null;
  }

  private renderTextLod2Target(target: { nodeId: string; mode: TextLod2Mode } | null): void {
    const overlay = this.textLod2;
    if (!target) {
      if (overlay) overlay.hide();
      this.textLod2HitZones = null;
      return;
    }

    const node = this.nodes.find((n): n is TextNode => n.id === target.nodeId && n.kind === 'text');
    if (!node) {
      if (overlay) overlay.hide();
      this.textLod2HitZones = null;
      return;
    }

    const lod2 = this.ensureTextLod2Overlay();
    if (!lod2) return;

    const contentRect = this.textContentRect(node.rect);
    const tl = this.camera.worldToScreen({ x: contentRect.x, y: contentRect.y });
    const z = Math.max(0.001, this.camera.zoom || 1);
    const screenRect: Rect = { x: tl.x, y: tl.y, w: contentRect.w * z, h: contentRect.h * z };
    const cached = this.textLod2HtmlCache;
    const html =
      cached && cached.nodeId === node.id && cached.displayHash === node.displayHash
        ? cached.html
        : (() => {
            const nextHtml = this.renderTextNodeHtml(node);
            this.textLod2HtmlCache = { nodeId: node.id, displayHash: node.displayHash, html: nextHtml };
            return nextHtml;
          })();
    const isHovered = this.hoverTextNodeId === node.id;
    const isSelected = this.selectedNodeId === node.id;
    const interactive =
      target.mode === 'select' &&
      this.textSelectNodeId !== node.id &&
      (!node.isGenerating || isHovered || (this.touchUi && isSelected));
    const desiredScrollTop = this.getTextNodeScrollY(node);
    lod2.show({
      nodeId: node.id,
      mode: target.mode,
      interactive,
      screenRect,
      worldW: contentRect.w,
      worldH: contentRect.h,
      zoom: z,
      contentHash: node.displayHash,
      html,
      scrollTop: desiredScrollTop,
    });

    const actualScrollTop = Math.max(0, Math.round(lod2.getContentElement().scrollTop || 0));
    if (actualScrollTop !== desiredScrollTop) {
      node.contentScrollY = actualScrollTop > 0 ? actualScrollTop : undefined;
      try {
        this.onRequestPersist?.();
      } catch {
        // ignore
      }
    }
    this.updateTextLod2HitZonesFromOverlay(node.id, node.displayHash, lod2);
  }

  private renderTextStreamLod2Target(target: { nodeId: string; mode: TextLod2Mode } | null): void {
    const overlay = this.textStreamLod2;
    if (!target) {
      if (overlay) overlay.hide();
      return;
    }

    const node = this.nodes.find((n): n is TextNode => n.id === target.nodeId && n.kind === 'text');
    if (!node) {
      if (overlay) overlay.hide();
      return;
    }

    const lod2 = this.ensureTextStreamLod2Overlay();
    if (!lod2) return;

    const contentRect = this.textContentRect(node.rect);
    const tl = this.camera.worldToScreen({ x: contentRect.x, y: contentRect.y });
    const z = Math.max(0.001, this.camera.zoom || 1);
    const screenRect: Rect = { x: tl.x, y: tl.y, w: contentRect.w * z, h: contentRect.h * z };

    const cached = this.textStreamLod2HtmlCache;
    const html =
      cached && cached.nodeId === node.id && cached.displayHash === node.displayHash
        ? cached.html
        : (() => {
            const nextHtml = this.renderTextNodeHtml(node);
            this.textStreamLod2HtmlCache = { nodeId: node.id, displayHash: node.displayHash, html: nextHtml };
            return nextHtml;
          })();

    lod2.show({
      nodeId: node.id,
      mode: target.mode,
      interactive: false,
      screenRect,
      worldW: contentRect.w,
      worldH: contentRect.h,
      zoom: z,
      contentHash: node.displayHash,
      html,
    });
  }

  private renderPdfTextLod2Target(target: { nodeId: string; token: number; pageNumber: number } | null): void {
    const overlay = this.pdfTextLod2;
    if (!target) {
      if (overlay) overlay.hide();
      return;
    }

    const node = this.nodes.find((n): n is PdfNode => n.id === target.nodeId && n.kind === 'pdf');
    if (!node || node.status !== 'ready') {
      if (overlay) overlay.hide();
      return;
    }

    const state = this.pdfStateByNodeId.get(node.id);
    if (!state || state.token !== target.token) {
      if (overlay) overlay.hide();
      return;
    }

    const pageRect = this.getPdfPageRect(node, state, target.pageNumber);
    if (!pageRect) {
      if (overlay) overlay.hide();
      return;
    }

    const lod2 = this.ensurePdfTextLod2Overlay();
    if (!lod2) return;

    const tl = this.camera.worldToScreen({ x: pageRect.x, y: pageRect.y });
    const z = Math.max(0.001, this.camera.zoom || 1);
    const screenRect: Rect = { x: tl.x, y: tl.y, w: pageRect.w * z, h: pageRect.h * z };

    const pageW = Math.max(1, pageRect.w);
    const key = `${node.id}|t${state.token}|p${target.pageNumber}|w${Math.round(pageW)}`;

    const isPenSelection =
      this.pdfSelectTarget?.nodeId === node.id &&
      this.pdfSelectTarget?.token === state.token &&
      this.pdfSelectTarget?.pageNumber === target.pageNumber;
    const interactive = !isPenSelection;

    lod2.show({
      nodeId: node.id,
      token: state.token,
      pageNumber: target.pageNumber,
      mode: 'select',
      interactive,
      screenRect,
      worldW: pageRect.w,
      worldH: pageRect.h,
      zoom: z,
      pageKey: key,
      ensureTextLayer: async () => {
        const latest = this.pdfStateByNodeId.get(node.id);
        if (!latest || latest.token !== state.token) return null;
        if (target.pageNumber < 1 || target.pageNumber > latest.pageCount) return null;
        let page: PDFPageProxy;
        try {
          page = await latest.doc.getPage(target.pageNumber);
        } catch {
          return null;
        }
        const viewport1 = page.getViewport({ scale: 1 });
        const scale = pageW / Math.max(1, viewport1.width);
        const viewport: PageViewport = page.getViewport({ scale });
        let textContentSource: any;
        try {
          textContentSource = page.streamTextContent();
        } catch {
          try {
            textContentSource = await page.getTextContent();
          } catch {
            return null;
          }
        }
        return { viewport, textContentSource };
      },
    });
  }

  private caretRangeFromClientPointForLod2(clientX: number, clientY: number): Range | null {
    if (typeof document === 'undefined') return null;
    const overlay = this.textLod2;
    if (!overlay) return caretRangeFromClientPoint(document, clientX, clientY);
    return overlay.withPointerEventsEnabled(() => caretRangeFromClientPoint(document, clientX, clientY));
  }

  private caretRangeFromClientPointForPdfLod2(clientX: number, clientY: number): Range | null {
    if (typeof document === 'undefined') return null;
    const overlay = this.pdfTextLod2;
    if (!overlay) return caretRangeFromClientPoint(document, clientX, clientY);
    return overlay.withPointerEventsEnabled(() => caretRangeFromClientPoint(document, clientX, clientY));
  }

  private updatePenSelectionFromLastPoint(): void {
    if (typeof document === 'undefined') return;
    const nodeId = this.textSelectNodeId;
    const anchor = this.textSelectAnchor;
    const point = this.textSelectLastClient;
    const overlay = this.textLod2;
    if (!nodeId || !anchor || !point || !overlay) return;

    const contentEl = overlay.getContentElement();
    const focus = this.caretRangeFromClientPointForLod2(point.x, point.y);
    if (!focus || !contentEl.contains(focus.startContainer)) return;

    let forward = true;
    try {
      forward = anchor.compareBoundaryPoints(Range.START_TO_START, focus) <= 0;
    } catch {
      forward = true;
    }

    const range = document.createRange();
    if (forward) {
      range.setStart(anchor.startContainer, anchor.startOffset);
      range.setEnd(focus.startContainer, focus.startOffset);
    } else {
      range.setStart(focus.startContainer, focus.startOffset);
      range.setEnd(anchor.startContainer, anchor.startOffset);
    }

    this.textSelectRange = range;

    const contentRect = contentEl.getBoundingClientRect();
    const z = Math.max(0.01, overlay.getZoom() || 1);
    const rects: HighlightRect[] = Array.from(range.getClientRects())
      .map((r) => ({
        left: (r.left - contentRect.left) / z,
        top: (r.top - contentRect.top) / z,
        width: r.width / z,
        height: r.height / z,
      }))
      .filter((r) => r.width > 0.5 && r.height > 0.5);

    overlay.setHighlightRects(rects);
  }

  private schedulePenSelectionUpdate(): void {
    if (this.textSelectRaf != null) return;
    this.textSelectRaf = requestAnimationFrame(() => {
      this.textSelectRaf = null;
      this.updatePenSelectionFromLastPoint();
    });
  }

  private updatePdfPenSelectionFromLastPoint(): void {
    if (typeof document === 'undefined') return;
    const target = this.pdfSelectTarget;
    const point = this.pdfSelectLastClient;
    const overlay = this.pdfTextLod2;
    if (!target || !point || !overlay) return;

    if (overlay.getNodeId() !== target.nodeId || overlay.getToken() !== target.token || overlay.getPageNumber() !== target.pageNumber) {
      return;
    }

    const textEl = overlay.getTextLayerElement();

    // Only update the caret when the pointer is *actually over* a text span.
    // `caretRangeFromPoint` will otherwise snap to "nearest" text even when the
    // pointer is in whitespace (e.g. right margin / between paragraphs), which
    // causes large unintended selection jumps.
    const hitSpan = overlay.withPointerEventsEnabled(() => {
      try {
        const hit = document.elementFromPoint(point.x, point.y) as Element | null;
        return hit?.closest?.('span[role="presentation"]') ?? null;
      } catch {
        return null;
      }
    });
    if (!hitSpan || !textEl.contains(hitSpan)) return;

    const caret = this.caretRangeFromClientPointForPdfLod2(point.x, point.y);
    if (!caret || !textEl.contains(caret.startContainer)) return;

    // `caretRangeFromPoint` can return a caret on the text-layer container itself when
    // hovering in whitespace (e.g. right margin / between lines). Treat that as "no caret"
    // to avoid selection jumps and huge highlight rects.
    const caretContainerEl =
      caret.startContainer.nodeType === Node.ELEMENT_NODE
        ? (caret.startContainer as Element)
        : (((caret.startContainer as any).parentElement as Element | null) ?? null);
    const caretSpan = caretContainerEl?.closest?.('span[role="presentation"]') ?? null;
    if (!caretSpan || !textEl.contains(caretSpan)) return;

    if (!this.pdfSelectAnchor) {
      this.pdfSelectAnchor = caret;
      this.pdfSelectRange = null;
      overlay.clearHighlights();
      return;
    }

    let forward = true;
    try {
      forward = this.pdfSelectAnchor.compareBoundaryPoints(Range.START_TO_START, caret) <= 0;
    } catch {
      forward = true;
    }

    const range = document.createRange();
    if (forward) {
      range.setStart(this.pdfSelectAnchor.startContainer, this.pdfSelectAnchor.startOffset);
      range.setEnd(caret.startContainer, caret.startOffset);
    } else {
      range.setStart(caret.startContainer, caret.startOffset);
      range.setEnd(this.pdfSelectAnchor.startContainer, this.pdfSelectAnchor.startOffset);
    }

    this.pdfSelectRange = range;

    const contentRect = textEl.getBoundingClientRect();
    const z = Math.max(0.01, overlay.getZoom() || 1);
    const rects: PdfHighlightRect[] = Array.from(range.getClientRects())
      .map((r) => ({
        left: (r.left - contentRect.left) / z,
        top: (r.top - contentRect.top) / z,
        width: r.width / z,
        height: r.height / z,
      }))
      .filter((r) => r.width > 0.5 && r.height > 0.5);

    overlay.setHighlightRects(rects);
  }

  private schedulePdfPenSelectionUpdate(): void {
    if (this.pdfSelectRaf != null) return;
    this.pdfSelectRaf = requestAnimationFrame(() => {
      this.pdfSelectRaf = null;
      this.updatePdfPenSelectionFromLastPoint();
    });
  }

  private extractPlainTextFromRange(baseRange: Range): string {
    try {
      const range = baseRange.cloneRange();
      const frag = range.cloneContents();
      const tmp = document.createElement('div');
      tmp.style.position = 'fixed';
      tmp.style.left = '-99999px';
      tmp.style.top = '0';
      tmp.style.whiteSpace = 'pre-wrap';
      tmp.style.pointerEvents = 'none';
      tmp.appendChild(frag);
      document.body.appendChild(tmp);
      const raw = tmp.innerText;
      tmp.remove();
      return raw.trim();
    } catch {
      try {
        return baseRange.toString().trim();
      } catch {
        return '';
      }
    }
  }

  private getPdfPageRect(node: PdfNode, state: PdfNodeState, pageNumber: number): Rect | null {
    if (pageNumber < 1 || pageNumber > state.pageCount) return null;
    const contentRect = this.textContentRect(node.rect);
    const pageW = Math.max(1, contentRect.w);
    const pageGap = 16;
    let y = contentRect.y;

    for (let p = 1; p <= state.pageCount; p += 1) {
      const meta = state.metas[p - 1];
      const aspect = meta?.aspect ?? state.defaultAspect;
      const pageH = Math.max(1, pageW * (Number.isFinite(aspect) && aspect > 0 ? aspect : state.defaultAspect));
      const r: Rect = { x: contentRect.x, y, w: pageW, h: pageH };
      if (p === pageNumber) return r;
      y += pageH + pageGap;
    }
    return null;
  }

  private findPdfPageAtWorld(node: PdfNode, state: PdfNodeState, world: Vec2): { pageNumber: number; pageRect: Rect } | null {
    const contentRect = this.textContentRect(node.rect);
    const pageW = Math.max(1, contentRect.w);
    const pageGap = 16;
    let y = contentRect.y;

    for (let p = 1; p <= state.pageCount; p += 1) {
      const meta = state.metas[p - 1];
      const aspect = meta?.aspect ?? state.defaultAspect;
      const pageH = Math.max(1, pageW * (Number.isFinite(aspect) && aspect > 0 ? aspect : state.defaultAspect));
      const r: Rect = { x: contentRect.x, y, w: pageW, h: pageH };
      if (world.y >= y && world.y <= y + pageH) {
        if (world.x >= r.x && world.x <= r.x + r.w) return { pageNumber: p, pageRect: r };
        return null;
      }
      y += pageH + pageGap;
      if (world.y < y) return null;
    }
    return null;
  }

  private chooseInkRasterScale(): number {
    const ideal = this.dpr || 1;
    const cap = 2;
    const target = Math.max(1, Math.min(cap, ideal));
    return target < 1.5 ? 1 : 2;
  }

  private inkStrokeWidthWorld(pointerType: string): number {
    const z = Math.max(0.01, this.camera.zoom || 1);
    const basePx = pointerType === 'pen' ? 2.75 : 2.5;
    return basePx / z;
  }

  private inkMinPointDistWorld(pointerType: string): number {
    const z = Math.max(0.01, this.camera.zoom || 1);
    const basePx = pointerType === 'pen' ? 0.45 : 0.9;
    return basePx / z;
  }

  private eraserRadiusWorld(pointerType: string): number {
    const z = Math.max(0.01, this.camera.zoom || 1);
    const basePx = pointerType === 'pen' ? 10 : 12;
    return basePx / z;
  }

  private eraseWorldInkStrokesAlongSegment(a: Vec2, b: Vec2, radiusWorld: number): boolean {
    if (this.worldInkStrokes.length === 0) return false;
    let changed = false;
    for (let i = this.worldInkStrokes.length - 1; i >= 0; i -= 1) {
      const s = this.worldInkStrokes[i]!;
      const w = Number.isFinite(s.width) ? Math.max(0, s.width) : 0;
      const threshold = Math.max(0, radiusWorld) + w * 0.5;
      if (polylineIntersectsCapsule(s.points, a, b, threshold)) {
        this.worldInkStrokes.splice(i, 1);
        changed = true;
      }
    }
    return changed;
  }

  private eraseInkNodeStrokesAlongSegment(node: InkNode, a: InkPoint, b: InkPoint, radiusWorld: number): boolean {
    if (node.strokes.length === 0) return false;
    let changed = false;
    for (let i = node.strokes.length - 1; i >= 0; i -= 1) {
      const s = node.strokes[i]!;
      const w = Number.isFinite(s.width) ? Math.max(0, s.width) : 0;
      const threshold = Math.max(0, radiusWorld) + w * 0.5;
      if (polylineIntersectsCapsule(s.points, a, b, threshold)) {
        node.strokes.splice(i, 1);
        changed = true;
      }
    }
    return changed;
  }

  private pushInkPoint(stroke: InkStroke, p: InkPoint, minDistWorld: number): void {
    const pts = stroke.points;
    const last = pts.length > 0 ? pts[pts.length - 1] : null;
    if (!last) {
      pts.push(p);
      return;
    }
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    if (dx * dx + dy * dy < minDistWorld * minDistWorld) return;
    pts.push(p);
  }

  private drawInkStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke, opts?: { offsetX?: number; offsetY?: number }): void {
    const pts = stroke.points;
    if (pts.length === 0) return;
    const ox = opts?.offsetX ?? 0;
    const oy = opts?.offsetY ?? 0;

    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(0.0001, stroke.width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (pts.length === 1) {
      const p0 = pts[0]!;
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.arc(p0.x + ox, p0.y + oy, Math.max(0.0001, stroke.width) * 0.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(pts[0]!.x + ox, pts[0]!.y + oy);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]!;
      ctx.lineTo(p.x + ox, p.y + oy);
    }
    ctx.stroke();
  }

  private ensureInkNodeRaster(node: InkNode, contentRect: Rect): InkRaster | null {
    if (node.strokes.length === 0) {
      node.raster = null;
      return null;
    }

    let scale = this.chooseInkRasterScale();
    const worldW = Math.max(1, contentRect.w);
    const worldH = Math.max(1, contentRect.h);

    let pxW = Math.max(1, Math.round(worldW * scale));
    let pxH = Math.max(1, Math.round(worldH * scale));

    const MAX_DIM = 4096;
    const MAX_PIXELS = 6_000_000;

    const scaleByDim = Math.min(1, MAX_DIM / pxW, MAX_DIM / pxH);
    if (scaleByDim < 1) {
      scale *= scaleByDim;
      pxW = Math.max(1, Math.round(worldW * scale));
      pxH = Math.max(1, Math.round(worldH * scale));
    }

    const pixels = pxW * pxH;
    if (pixels > MAX_PIXELS) {
      const s = Math.sqrt(MAX_PIXELS / pixels);
      scale *= s;
      pxW = Math.max(1, Math.round(worldW * scale));
      pxH = Math.max(1, Math.round(worldH * scale));
    }

    const raster = node.raster;
    const needsRebuild =
      !raster ||
      raster.scale !== scale ||
      Math.abs(raster.worldW - worldW) > 0.5 ||
      Math.abs(raster.worldH - worldH) > 0.5 ||
      raster.drawnStrokeCount > node.strokes.length ||
      raster.canvas.width !== pxW ||
      raster.canvas.height !== pxH;

    if (needsRebuild) {
      const canvas = document.createElement('canvas');
      canvas.width = pxW;
      canvas.height = pxH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, pxW, pxH);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      for (const s of node.strokes) this.drawInkStroke(ctx, s);
      node.raster = { scale, worldW, worldH, canvas, drawnStrokeCount: node.strokes.length };
      return node.raster;
    }

    if (raster.drawnStrokeCount < node.strokes.length) {
      const ctx = raster.canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        for (let i = raster.drawnStrokeCount; i < node.strokes.length; i++) {
          const s = node.strokes[i]!;
          this.drawInkStroke(ctx, s);
        }
        raster.drawnStrokeCount = node.strokes.length;
      }
    }

    return raster;
  }

  private updatePdfNodeDerivedHeight(node: PdfNode, state: PdfNodeState): void {
    const PAD = 14;
    const HEADER_H = 50;
    const pageGap = 16;
    const pageW = Math.max(1, node.rect.w - PAD * 2);

    let contentH = 0;
    for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) {
      const meta = state.metas[pageNumber - 1];
      const aspect = meta?.aspect ?? state.defaultAspect;
      const pageH = Math.max(1, pageW * (Number.isFinite(aspect) && aspect > 0 ? aspect : state.defaultAspect));
      contentH += pageH + pageGap;
    }
    if (state.pageCount > 0) contentH -= pageGap;

    const desired = Math.max(220, HEADER_H + PAD + contentH);
    if (Math.abs(desired - node.rect.h) > 0.5) node.rect.h = desired;
  }

  private chooseTextRasterScale(): number {
    const ideal = (this.camera.zoom || 1) * (this.dpr || 1);
    const cap = this.interacting ? 1 : 2;
    const target = Math.max(0.5, Math.min(cap, ideal));
    if (target < 0.75) return 0.5;
    if (target < 1.5) return 1;
    return 2;
  }

  private choosePdfRasterScale(visibleWorldArea: number): number {
    const ideal = (this.camera.zoom || 1) * (this.dpr || 1);
    const cap = this.interacting ? 1 : 2;

    // Budget aims to keep *visible* pages stable in cache without thrash.
    // Leave slack for previously-viewed pages and overhead.
    const budgetBytes = Math.max(24 * 1024 * 1024, this.pdfPageCacheMaxBytes * 0.75);
    const area = Math.max(1, visibleWorldArea);
    const budgetScale = Math.sqrt(budgetBytes / (area * 4));

    const target = Math.max(0.25, Math.min(cap, ideal, budgetScale));
    const steps = this.pdfRasterScaleSteps;
    let chosen: number = steps[0];
    for (const s of steps) {
      if (s > cap) break;
      if (s <= target) chosen = s;
    }
    return chosen;
  }

  private getBestTextRaster(sig: string): { key: string; image: CanvasImageSource; hitZones?: TextHitZone[] } | null {
    const best = this.bestTextRasterKeyBySig.get(sig);
    if (!best) return null;
    const entry = this.textRasterCache.get(best.key);
    if (!entry) {
      this.bestTextRasterKeyBySig.delete(sig);
      return null;
    }
    this.touchTextRaster(best.key);
    return { key: best.key, image: entry.image, hitZones: entry.hitZones };
  }

  private updateTextRastersForViewport(): void {
    const view = this.worldViewportRect({ overscan: 320 });
    const desiredScale = this.chooseTextRasterScale();
    const desiredNodeIds = new Set<string>();

    for (const n of this.nodes) {
      if (n.kind !== 'text') continue;
      if (n.id === this.editingNodeId) continue;
      if (n.isGenerating) continue;
      if (!rectsIntersect(n.rect, view)) continue;

      const contentRect = this.textContentRect(n.rect);
      const { sig, scrollY } = this.textRasterSigForNode(n, contentRect);
      const best = this.bestTextRasterKeyBySig.get(sig);
      const hasBest = !!best && this.textRasterCache.has(best.key);
      if (hasBest && best!.rasterScale >= desiredScale) continue;

      const key = `${sig}|s${desiredScale}`;
      if (this.textRasterCache.has(key)) {
        this.bestTextRasterKeyBySig.set(sig, { key, rasterScale: desiredScale });
        continue;
      }

      desiredNodeIds.add(n.id);
      this.enqueueTextRaster({
        nodeId: n.id,
        key,
        sig,
        rasterScale: desiredScale,
        width: contentRect.w,
        height: contentRect.h,
        html: this.renderTextNodeHtml(n),
        scrollY,
      });
    }

    // Drop any queued rasters that are no longer needed for the current viewport
    // (prevents long "catch-up" bursts after panning/zooming/resizing).
    if (this.textRasterQueueByNodeId.size > 0) {
      for (const nodeId of this.textRasterQueueByNodeId.keys()) {
        if (!desiredNodeIds.has(nodeId)) this.textRasterQueueByNodeId.delete(nodeId);
      }
    }

    this.kickTextRasterQueue();
  }

  private updatePdfPageRendersForViewport(): void {
    const view = this.worldViewportRect({ overscan: 360 });
    const visible: Array<{
      nodeId: string;
      token: number;
      pageNumber: number;
      pageWorldW: number;
      pageWorldH: number;
    }> = [];
    let visibleArea = 0;

    for (const node of this.nodes) {
      if (node.kind !== 'pdf') continue;
      if (node.status !== 'ready') continue;

      const state = this.pdfStateByNodeId.get(node.id);
      if (!state) continue;

      // Full import: node height is derived from (pageCount + page sizes).
      this.updatePdfNodeDerivedHeight(node, state);

      const contentRect = this.textContentRect(node.rect);
      const pageW = Math.max(1, contentRect.w);
      const pageGap = 16;
      let y = contentRect.y;

      for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) {
        const meta = state.metas[pageNumber - 1];
        const aspect = meta?.aspect ?? state.defaultAspect;
        const pageH = Math.max(1, pageW * (Number.isFinite(aspect) && aspect > 0 ? aspect : state.defaultAspect));
        const pageRect: Rect = { x: contentRect.x, y, w: pageW, h: pageH };
        y += pageH + pageGap;

        if (!rectsIntersect(pageRect, view)) continue;

        void this.ensurePdfPageMeta(node.id, state.token, pageNumber);
        visible.push({ nodeId: node.id, token: state.token, pageNumber, pageWorldW: pageW, pageWorldH: pageH });
        visibleArea += pageW * pageH;
      }
    }

    const desiredScale = this.choosePdfRasterScale(visibleArea);
    this.pdfDesiredRasterScale = desiredScale;

    const desiredKeys = new Set<string>();
    for (const v of visible) {
      const key = `${v.nodeId}|t${v.token}|p${v.pageNumber}|w${Math.round(v.pageWorldW)}|s${desiredScale}`;
      desiredKeys.add(key);

      if (!this.pdfPageCache.has(key)) {
        this.enqueuePdfPageRender({
          nodeId: v.nodeId,
          token: v.token,
          pageNumber: v.pageNumber,
          key,
          pageWorldW: v.pageWorldW,
          pageWorldH: v.pageWorldH,
          rasterScale: desiredScale,
        });
      }
    }

    if (this.pdfPageRenderQueue.size > 0) {
      for (const key of this.pdfPageRenderQueue.keys()) {
        if (!desiredKeys.has(key)) this.pdfPageRenderQueue.delete(key);
      }
    }

    this.kickPdfPageRenderQueue();
  }

  private worldViewportRect(opts?: { overscan?: number }): Rect {
    const over = Math.max(0, Math.round(opts?.overscan ?? 0));
    const a = this.camera.screenToWorld({ x: -over, y: -over });
    const b = this.camera.screenToWorld({ x: this.cssW + over, y: this.cssH + over });
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  private clampRectToView(r: Rect): Rect {
    const view = this.worldViewportRect();
    const z = Math.max(0.001, this.camera.zoom || 1);
    const marginWorld = 12 / z;

    const minX = view.x + marginWorld;
    const minY = view.y + marginWorld;
    const maxX = view.x + view.w - marginWorld - r.w;
    const maxY = view.y + view.h - marginWorld - r.h;

    const clampOrCenter = (v: number, lo: number, hi: number, size: number, origin: number, span: number) => {
      if (Number.isFinite(hi) && hi >= lo) return clamp(v, lo, hi);
      return origin + (span - size) * 0.5;
    };

    return {
      x: clampOrCenter(r.x, minX, maxX, r.w, view.x, view.w),
      y: clampOrCenter(r.y, minY, maxY, r.h, view.y, view.h),
      w: r.w,
      h: r.h,
    };
  }

  private normalizeSpawnRect(r: Rect | null | undefined, opts?: { maxW?: number; maxH?: number }): Rect | null {
    if (!r) return null;
    let x = Number(r.x);
    let y = Number(r.y);
    let w = Number(r.w);
    let h = Number(r.h);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    if (w <= 0 || h <= 0) return null;
    if (w < this.minNodeW) w = this.minNodeW;
    if (h < this.minNodeH) h = this.minNodeH;

    const maxWRaw = Number(opts?.maxW);
    const maxW = Number.isFinite(maxWRaw) ? Math.max(this.minNodeW, maxWRaw) : Infinity;
    if (w > maxW) w = maxW;

    const maxHRaw = Number(opts?.maxH);
    const maxH = Number.isFinite(maxHRaw) ? Math.max(this.minNodeH, maxHRaw) : Infinity;
    if (h > maxH) h = maxH;

    return { x, y, w, h };
  }

  private rectFromWorldDrag(startWorld: Vec2, endWorld: Vec2, opts?: { maxW?: number; maxH?: number }): Rect | null {
    const sx = Number(startWorld.x);
    const sy = Number(startWorld.y);
    let ex = Number(endWorld.x);
    let ey = Number(endWorld.y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(ex) || !Number.isFinite(ey)) return null;

    let dx = ex - sx;
    let dy = ey - sy;

    const maxWRaw = Number(opts?.maxW);
    const maxW = Number.isFinite(maxWRaw) ? Math.max(this.minNodeW, maxWRaw) : Infinity;
    if (Number.isFinite(maxW) && Math.abs(dx) > maxW) ex = sx + (dx >= 0 ? maxW : -maxW);

    const maxHRaw = Number(opts?.maxH);
    const maxH = Number.isFinite(maxHRaw) ? Math.max(this.minNodeH, maxHRaw) : Infinity;
    if (Number.isFinite(maxH) && Math.abs(dy) > maxH) ey = sy + (dy >= 0 ? maxH : -maxH);

    dx = ex - sx;
    dy = ey - sy;

    if (Math.abs(dx) < this.minNodeW) ex = sx + (dx >= 0 ? this.minNodeW : -this.minNodeW);
    if (Math.abs(dy) < this.minNodeH) ey = sy + (dy >= 0 ? this.minNodeH : -this.minNodeH);

    const raw: Rect = {
      x: Math.min(sx, ex),
      y: Math.min(sy, ey),
      w: Math.abs(ex - sx),
      h: Math.abs(ey - sy),
    };
    return this.clampRectToView(raw);
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

  private findTopmostInkNodeAtWorld(world: Vec2): InkNode | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]!;
      if (n.kind !== 'ink') continue;
      const r = n.rect;
      if (world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h) {
        return n;
      }
    }
    return null;
  }

  private shouldDrawInk(pointerType: string): boolean {
    const t = pointerType || 'mouse';
    if (t === 'touch') return false;
    return this.tool === 'draw';
  }

  private shouldEraseInk(pointerType: string): boolean {
    const t = pointerType || 'mouse';
    if (t === 'touch') return false;
    return this.tool === 'erase';
  }

  private hitResizeHandle(world: Vec2, rect: Rect, opts?: { pointerType?: string }): ResizeCorner | null {
    const z = Math.max(0.01, this.camera.zoom || 1);
    const t = opts?.pointerType || 'mouse';
    const hitPx = t === 'touch' ? this.resizeHandleHitPxTouch : this.resizeHandleHitPx;
    let hw = hitPx / z;
    const maxHw = Math.max(0, Math.min(rect.w, rect.h) * 0.5);
    if (maxHw > 0) hw = Math.min(hw, maxHw);
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

  private handlePointerDown(p: Vec2, info: { pointerType: string; pointerId: number }): PointerCaptureMode | null {
    // Only capture when starting a custom interaction. Otherwise let InputController pan the camera.
    if (this.activeGesture) return null;
    if (this.editingNodeId) return null;

    const world = this.camera.screenToWorld(p);

    const pdfAnn = this.pdfAnnotationPlacement;
    if (pdfAnn && pdfAnn.outlineRect) {
      const corner = this.hitResizeHandle(world, pdfAnn.outlineRect, { pointerType: info.pointerType });
      if (corner) {
        this.suppressTapPointerIds.add(info.pointerId);
        this.activeGesture = {
          kind: 'pdf-annotation-outline-resize',
          pointerId: info.pointerId,
          corner,
          startWorld: world,
          startRect: { ...pdfAnn.outlineRect },
        };
        this.requestRender();
        return 'node';
      }
      return null;
    }
    if (pdfAnn && (info.pointerType || 'mouse') === 'mouse') {
      this.suppressTapPointerIds.add(info.pointerId);

      const drawToSpawn = pdfAnn.kind === 'ink' ? this.spawnInkNodeByDrawEnabled : this.spawnEditNodeByDrawEnabled;
      if (drawToSpawn) {
        this.activeGesture = {
          kind: 'spawn-by-draw',
          pointerId: info.pointerId,
          spawn: pdfAnn.kind === 'ink' ? { kind: 'ink' } : { kind: 'text', opts: { title: 'Note' } },
          startWorld: world,
          currentWorld: world,
          hasDrag: false,
          pdfAnnotation: pdfAnn,
        };
        return 'node';
      }

      const rect = pdfAnn.kind === 'ink'
        ? { x: world.x, y: world.y, w: 420, h: 280 }
        : { x: world.x, y: world.y, w: 460, h: 240 };

      const createdId =
        pdfAnn.kind === 'ink'
          ? this.spawnInkNode({ rect })
          : this.spawnTextNode({ title: 'Note', rect });
      this.applyPdfAnnotationToChildNode(createdId, pdfAnn);
      this.pdfAnnotationPlacement = null;
      try {
        this.onRequestPersist?.();
      } catch {
        // ignore
      }
      return 'node';
    }

    const textAnn = this.textAnnotationPlacement;
    if (textAnn && textAnn.outlineRect) {
      const corner = this.hitResizeHandle(world, textAnn.outlineRect, { pointerType: info.pointerType });
      if (corner) {
        this.suppressTapPointerIds.add(info.pointerId);
        this.activeGesture = {
          kind: 'text-annotation-outline-resize',
          pointerId: info.pointerId,
          corner,
          startWorld: world,
          startRect: { ...textAnn.outlineRect },
        };
        this.requestRender();
        return 'node';
      }
      return null;
    }
    if (textAnn && (info.pointerType || 'mouse') === 'mouse') {
      this.suppressTapPointerIds.add(info.pointerId);

      const drawToSpawn = textAnn.kind === 'ink' ? this.spawnInkNodeByDrawEnabled : this.spawnEditNodeByDrawEnabled;
      if (drawToSpawn) {
        this.activeGesture = {
          kind: 'spawn-by-draw',
          pointerId: info.pointerId,
          spawn: textAnn.kind === 'ink' ? { kind: 'ink' } : { kind: 'text', opts: { title: 'Note' } },
          startWorld: world,
          currentWorld: world,
          hasDrag: false,
          textAnnotation: textAnn,
        };
        return 'node';
      }

      const rect = textAnn.kind === 'ink'
        ? { x: world.x, y: world.y, w: 420, h: 280 }
        : { x: world.x, y: world.y, w: 460, h: 240 };

      const createdId =
        textAnn.kind === 'ink'
          ? this.spawnInkNode({ rect })
          : this.spawnTextNode({ title: 'Note', rect });
      this.applyTextAnnotationToChildNode(createdId, textAnn);
      this.textAnnotationPlacement = null;
      try {
        this.onRequestPersist?.();
      } catch {
        // ignore
      }
      return 'node';
    }

    const pendingSpawn = this.pendingSpawnByDraw;
    if (pendingSpawn) {
      this.pendingSpawnByDraw = null;
      this.activeGesture = {
        kind: 'spawn-by-draw',
        pointerId: info.pointerId,
        spawn: pendingSpawn,
        startWorld: world,
        currentWorld: world,
        hasDrag: false,
      };
      return 'node';
    }

    const hit = this.findTopmostNodeAtWorld(world);

    // Pen drag-to-highlight for text nodes (LOD2 DOM overlay).
    // Only in select mode; in draw/erase mode the pen should interact with ink.
    if (this.tool === 'select' && hit && hit.kind === 'text' && info.pointerType === 'pen') {
      const contentRect = this.textContentRect(hit.rect);
      const inContent =
        world.x >= contentRect.x &&
        world.x <= contentRect.x + contentRect.w &&
        world.y >= contentRect.y &&
        world.y <= contentRect.y + contentRect.h;

      if (inContent) {
        this.clearTextSelection({ suppressOverlayCallback: true });

        const selectionChanged = this.selectedNodeId !== hit.id || this.editingNodeId !== null;
        this.selectedNodeId = hit.id;
        this.editingNodeId = null;
        this.bringNodeToFront(hit.id);

        this.textSelectNodeId = hit.id;
        this.renderTextLod2Target({ nodeId: hit.id, mode: 'select' });

        const client = this.localToClient(p);
        const anchor = this.caretRangeFromClientPointForLod2(client.x, client.y);
        const contentEl = this.textLod2?.getContentElement() ?? null;

        if (anchor && contentEl && contentEl.contains(anchor.startContainer)) {
          try {
            window.getSelection?.()?.removeAllRanges();
          } catch {
            // ignore
          }

          this.textSelectPointerId = info.pointerId;
          this.textSelectAnchor = anchor;
          this.textSelectLastClient = client;
          this.textSelectRange = null;

          this.activeGesture = { kind: 'text-select', pointerId: info.pointerId, nodeId: hit.id };
          this.suppressTapPointerIds.add(info.pointerId);
          this.requestRender();
          if (selectionChanged) this.emitUiState();
          return 'text';
        }

        // Failed to map the pen point into DOM text; fall back to normal interaction.
        this.clearTextSelection({ suppressOverlayCallback: true });
      }
    }

    // Pen drag-to-highlight for PDF pages (text layer LOD2 DOM overlay).
    // Only in select mode; in draw/erase mode the pen should interact with ink.
    if (this.tool === 'select' && hit && hit.kind === 'pdf' && info.pointerType === 'pen' && hit.status === 'ready') {
      const state = this.pdfStateByNodeId.get(hit.id);
      if (state) {
        const contentRect = this.textContentRect(hit.rect);
        const inContent =
          world.x >= contentRect.x &&
          world.x <= contentRect.x + contentRect.w &&
          world.y >= contentRect.y &&
          world.y <= contentRect.y + contentRect.h;
        if (inContent) {
          const pageHit = this.findPdfPageAtWorld(hit, state, world);
          if (pageHit) {
            this.clearPdfTextSelection({ suppressOverlayCallback: true });

            const selectionChanged = this.selectedNodeId !== hit.id || this.editingNodeId !== null;
            this.selectedNodeId = hit.id;
            this.editingNodeId = null;
            this.bringNodeToFront(hit.id);

            this.pdfSelectTarget = { nodeId: hit.id, token: state.token, pageNumber: pageHit.pageNumber };
            this.renderPdfTextLod2Target(this.pdfSelectTarget);

            try {
              window.getSelection?.()?.removeAllRanges();
            } catch {
              // ignore
            }

            this.pdfSelectPointerId = info.pointerId;
            this.pdfSelectAnchor = null;
            this.pdfSelectLastClient = this.localToClient(p);
            this.pdfSelectRange = null;

            this.activeGesture = {
              kind: 'pdf-text-select',
              pointerId: info.pointerId,
              nodeId: hit.id,
              token: state.token,
              pageNumber: pageHit.pageNumber,
            };
            this.suppressTapPointerIds.add(info.pointerId);
            this.requestRender();
            if (selectionChanged) this.emitUiState();
            return 'text';
          }
        }
      }
    }

    if (this.shouldDrawInk(info.pointerType)) {
      const stroke: InkStroke = {
        points: [],
        width: this.inkStrokeWidthWorld(info.pointerType),
        color: 'rgba(147,197,253,0.92)',
      };

      const inkNode = this.findTopmostInkNodeAtWorld(world);
      if (inkNode) {
        const contentRect = this.textContentRect(inkNode.rect);
        const inContent =
          world.x >= contentRect.x &&
          world.x <= contentRect.x + contentRect.w &&
          world.y >= contentRect.y &&
          world.y <= contentRect.y + contentRect.h;
        if (inContent) {
          const local: InkPoint = {
            x: clamp(world.x - contentRect.x, 0, contentRect.w),
            y: clamp(world.y - contentRect.y, 0, contentRect.h),
          };
          stroke.points.push(local);
          this.activeGesture = {
            kind: 'ink-node',
            pointerId: info.pointerId,
            pointerType: info.pointerType,
            nodeId: inkNode.id,
            stroke,
          };

          const selectionChanged = this.selectedNodeId !== inkNode.id || this.editingNodeId !== null;
          this.selectedNodeId = inkNode.id;
          this.editingNodeId = null;
          this.bringNodeToFront(inkNode.id);
          this.suppressTapPointerIds.add(info.pointerId);
          this.requestRender();
          if (selectionChanged) this.emitUiState();
          return 'draw';
        }
      }

      stroke.points.push({ x: world.x, y: world.y });
      this.activeGesture = { kind: 'ink-world', pointerId: info.pointerId, pointerType: info.pointerType, stroke };
      this.suppressTapPointerIds.add(info.pointerId);
      this.requestRender();
      return 'draw';
    }

    if (this.shouldEraseInk(info.pointerType)) {
      const radiusWorld = this.eraserRadiusWorld(info.pointerType);

      const inkNode = this.findTopmostInkNodeAtWorld(world);
      if (inkNode) {
        const contentRect = this.textContentRect(inkNode.rect);
        const inContent =
          world.x >= contentRect.x &&
          world.x <= contentRect.x + contentRect.w &&
          world.y >= contentRect.y &&
          world.y <= contentRect.y + contentRect.h;
        if (inContent) {
          const local: InkPoint = {
            x: clamp(world.x - contentRect.x, 0, contentRect.w),
            y: clamp(world.y - contentRect.y, 0, contentRect.h),
          };

          this.eraseInkNodeStrokesAlongSegment(inkNode, local, local, radiusWorld);
          this.activeGesture = {
            kind: 'erase-node',
            pointerId: info.pointerId,
            pointerType: info.pointerType,
            nodeId: inkNode.id,
            radiusWorld,
            lastLocal: local,
          };

          const selectionChanged = this.selectedNodeId !== inkNode.id || this.editingNodeId !== null;
          this.selectedNodeId = inkNode.id;
          this.editingNodeId = null;
          this.bringNodeToFront(inkNode.id);
          this.suppressTapPointerIds.add(info.pointerId);
          this.requestRender();
          if (selectionChanged) this.emitUiState();
          return 'draw';
        }
      }

      this.eraseWorldInkStrokesAlongSegment(world, world, radiusWorld);
      this.activeGesture = {
        kind: 'erase-world',
        pointerId: info.pointerId,
        pointerType: info.pointerType,
        radiusWorld,
        lastWorld: world,
      };
      this.suppressTapPointerIds.add(info.pointerId);
      this.requestRender();
      return 'draw';
    }

    if (!hit) return null;

    const selectionChanged = this.selectedNodeId !== hit.id || this.editingNodeId !== null;
    this.selectedNodeId = hit.id;
    this.editingNodeId = null;
    this.bringNodeToFront(hit.id);

    if (hit.kind === 'pdf') {
      // Match pdftest-style interaction: dragging inside page content pans the world;
      // dragging on the node chrome/border moves the node.
      const contentRect = this.textContentRect(hit.rect);
      const inContent =
        world.x >= contentRect.x &&
        world.x <= contentRect.x + contentRect.w &&
        world.y >= contentRect.y &&
        world.y <= contentRect.y + contentRect.h;
      this.requestRender();
      if (selectionChanged) this.emitUiState();
      if (inContent) return null;
    }

    const menuBtn = this.menuButtonRect(hit.rect);
    const inMenu =
      world.x >= menuBtn.x &&
      world.x <= menuBtn.x + menuBtn.w &&
      world.y >= menuBtn.y &&
      world.y <= menuBtn.y + menuBtn.h;
    if (inMenu) {
      this.requestRender();
      if (selectionChanged) this.emitUiState();
      return 'node';
    }

    const replyBtn = this.replyButtonRect(hit.rect);
    const inReply =
      world.x >= replyBtn.x &&
      world.x <= replyBtn.x + replyBtn.w &&
      world.y >= replyBtn.y &&
      world.y <= replyBtn.y + replyBtn.h;
    if (inReply) {
      this.requestRender();
      if (selectionChanged) this.emitUiState();
      return 'node';
    }

	    if (hit.kind === 'text' && this.canCancelNode(hit)) {
	      const stopBtn = this.stopButtonRect(hit);
	      const inStop =
	        world.x >= stopBtn.x &&
	        world.x <= stopBtn.x + stopBtn.w &&
	        world.y >= stopBtn.y &&
	        world.y <= stopBtn.y + stopBtn.h;
	      if (inStop) {
	        this.requestRender();
	        if (selectionChanged) this.emitUiState();
	        return 'node';
	      }
	    }

	    if (hit.kind === 'text') {
	      const zone = this.getTextNodeHitZoneAtWorld(hit, world);
	      const isToggleZone =
	        zone &&
	        ((hit.author === 'assistant' && (zone.kind === 'summary_toggle' || zone.kind === 'summary_chunk_toggle')) ||
	          (hit.author === 'user' && zone.kind === 'preface_context_toggle'));
	      if (isToggleZone) {
	        this.requestRender();
	        if (selectionChanged) this.emitUiState();
	        return 'node';
	      }
	    }

		    const corner =
		      hit.kind === 'text' || hit.kind === 'ink'
		        ? this.hitResizeHandle(world, hit.rect, { pointerType: info.pointerType })
		        : null;
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
	      this.textResizeHold = null;
	      if (hit.kind === 'text') this.renderTextLod2Target({ nodeId: hit.id, mode: 'resize' });
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
    return 'node';
  }

  private handlePointerMove(p: Vec2, info: { pointerType: string; pointerId: number }): void {
    const g = this.activeGesture;
    if (!g || g.pointerId !== info.pointerId) return;

    if (g.kind === 'text-select') {
      this.textSelectLastClient = this.localToClient(p);
      this.schedulePenSelectionUpdate();
      return;
    }

    if (g.kind === 'pdf-text-select') {
      this.pdfSelectLastClient = this.localToClient(p);
      this.schedulePdfPenSelectionUpdate();
      return;
    }

    if (g.kind === 'pdf-annotation-place') {
      const placement = this.pdfAnnotationPlacement;
      if (!placement) {
        this.activeGesture = null;
        this.requestRender();
        return;
      }

      const inCanvas = p.x >= 0 && p.y >= 0 && p.x <= this.cssW && p.y <= this.cssH;
      if (!inCanvas) {
        if (placement.hoverWorld) {
          placement.hoverWorld = null;
          this.requestRender();
        }
        return;
      }

      g.hadHover = true;
      placement.hoverWorld = this.camera.screenToWorld(p);
      this.requestRender();
      return;
    }

    if (g.kind === 'text-annotation-place') {
      const placement = this.textAnnotationPlacement;
      if (!placement) {
        this.activeGesture = null;
        this.requestRender();
        return;
      }

      const inCanvas = p.x >= 0 && p.y >= 0 && p.x <= this.cssW && p.y <= this.cssH;
      if (!inCanvas) {
        if (placement.hoverWorld) {
          placement.hoverWorld = null;
          this.requestRender();
        }
        return;
      }

      g.hadHover = true;
      placement.hoverWorld = this.camera.screenToWorld(p);
      this.requestRender();
      return;
    }

	    if (g.kind === 'pdf-annotation-outline-resize') {
	      const placement = this.pdfAnnotationPlacement;
	      const startRect = g.startRect;
	      if (!placement?.outlineRect) return;

      const world = this.camera.screenToWorld(p);
      const dx = world.x - g.startWorld.x;
      const dy = world.y - g.startWorld.y;

      const right = startRect.x + startRect.w;
      const bottom = startRect.y + startRect.h;

      let next: Rect;
	      switch (g.corner) {
        case 'nw': {
          next = { x: startRect.x + dx, y: startRect.y + dy, w: startRect.w - dx, h: startRect.h - dy };
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
          next = { x: startRect.x, y: startRect.y + dy, w: startRect.w + dx, h: startRect.h - dy };
          if (next.w < this.minNodeW) next.w = this.minNodeW;
          if (next.h < this.minNodeH) {
            next.h = this.minNodeH;
            next.y = bottom - next.h;
          }
          break;
        }
        case 'sw': {
          next = { x: startRect.x + dx, y: startRect.y, w: startRect.w - dx, h: startRect.h + dy };
          if (next.w < this.minNodeW) {
            next.w = this.minNodeW;
            next.x = right - next.w;
          }
          if (next.h < this.minNodeH) next.h = this.minNodeH;
          break;
        }
        case 'se': {
          next = { x: startRect.x, y: startRect.y, w: startRect.w + dx, h: startRect.h + dy };
          if (next.w < this.minNodeW) next.w = this.minNodeW;
          if (next.h < this.minNodeH) next.h = this.minNodeH;
          break;
        }
	      }

	      if (placement.kind === 'ink') {
	        if (next.w > INK_NODE_MAX_W_PX) {
	          next.w = INK_NODE_MAX_W_PX;
	          if (g.corner === 'nw' || g.corner === 'sw') next.x = right - next.w;
	        }
	        if (next.h > INK_NODE_MAX_H_PX) {
	          next.h = INK_NODE_MAX_H_PX;
	          if (g.corner === 'nw' || g.corner === 'ne') next.y = bottom - next.h;
	        }
	      }

	      placement.outlineRect = next;
	      placement.hoverWorld = { x: next.x, y: next.y };
	      this.requestRender();
	      return;
	    }

	    if (g.kind === 'text-annotation-outline-resize') {
	      const placement = this.textAnnotationPlacement;
	      const startRect = g.startRect;
	      if (!placement?.outlineRect) return;

      const world = this.camera.screenToWorld(p);
      const dx = world.x - g.startWorld.x;
      const dy = world.y - g.startWorld.y;

      const right = startRect.x + startRect.w;
      const bottom = startRect.y + startRect.h;

      let next: Rect;
	      switch (g.corner) {
        case 'nw': {
          next = { x: startRect.x + dx, y: startRect.y + dy, w: startRect.w - dx, h: startRect.h - dy };
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
          next = { x: startRect.x, y: startRect.y + dy, w: startRect.w + dx, h: startRect.h - dy };
          if (next.w < this.minNodeW) next.w = this.minNodeW;
          if (next.h < this.minNodeH) {
            next.h = this.minNodeH;
            next.y = bottom - next.h;
          }
          break;
        }
        case 'sw': {
          next = { x: startRect.x + dx, y: startRect.y, w: startRect.w - dx, h: startRect.h + dy };
          if (next.w < this.minNodeW) {
            next.w = this.minNodeW;
            next.x = right - next.w;
          }
          if (next.h < this.minNodeH) next.h = this.minNodeH;
          break;
        }
        case 'se': {
          next = { x: startRect.x, y: startRect.y, w: startRect.w + dx, h: startRect.h + dy };
          if (next.w < this.minNodeW) next.w = this.minNodeW;
          if (next.h < this.minNodeH) next.h = this.minNodeH;
          break;
        }
	      }

	      if (placement.kind === 'ink') {
	        if (next.w > INK_NODE_MAX_W_PX) {
	          next.w = INK_NODE_MAX_W_PX;
	          if (g.corner === 'nw' || g.corner === 'sw') next.x = right - next.w;
	        }
	        if (next.h > INK_NODE_MAX_H_PX) {
	          next.h = INK_NODE_MAX_H_PX;
	          if (g.corner === 'nw' || g.corner === 'ne') next.y = bottom - next.h;
	        }
	      }

	      placement.outlineRect = next;
	      placement.hoverWorld = { x: next.x, y: next.y };
	      this.requestRender();
	      return;
	    }

    if (g.kind === 'ink-world') {
      const world = this.camera.screenToWorld(p);
      this.pushInkPoint(g.stroke, { x: world.x, y: world.y }, this.inkMinPointDistWorld(g.pointerType));
      this.requestRender();
      return;
    }

    if (g.kind === 'ink-node') {
      const node = this.nodes.find((n): n is InkNode => n.id === g.nodeId && n.kind === 'ink');
      if (!node) return;
      const contentRect = this.textContentRect(node.rect);
      const world = this.camera.screenToWorld(p);
      this.pushInkPoint(
        g.stroke,
        {
          x: clamp(world.x - contentRect.x, 0, contentRect.w),
          y: clamp(world.y - contentRect.y, 0, contentRect.h),
        },
        this.inkMinPointDistWorld(g.pointerType),
      );
      this.requestRender();
      return;
    }

    if (g.kind === 'erase-world') {
      const world = this.camera.screenToWorld(p);
      const changed = this.eraseWorldInkStrokesAlongSegment(g.lastWorld, world, g.radiusWorld);
      g.lastWorld = world;
      if (changed) this.requestRender();
      return;
    }

    if (g.kind === 'erase-node') {
      const node = this.nodes.find((n): n is InkNode => n.id === g.nodeId && n.kind === 'ink');
      if (!node) return;
      const contentRect = this.textContentRect(node.rect);
      const world = this.camera.screenToWorld(p);
      const local: InkPoint = {
        x: clamp(world.x - contentRect.x, 0, contentRect.w),
        y: clamp(world.y - contentRect.y, 0, contentRect.h),
      };
      const changed = this.eraseInkNodeStrokesAlongSegment(node, g.lastLocal, local, g.radiusWorld);
      g.lastLocal = local;
      if (changed) this.requestRender();
      return;
    }

    if (g.kind === 'spawn-by-draw') {
      const world = this.camera.screenToWorld(p);
      g.currentWorld = world;
      g.hasDrag = true;
      this.requestRender();
      return;
    }

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

	    if (node.kind === 'ink') {
	      if (next.w > INK_NODE_MAX_W_PX) {
	        next.w = INK_NODE_MAX_W_PX;
	        if (g.corner === 'nw' || g.corner === 'sw') next.x = right - next.w;
	      }
	      if (next.h > INK_NODE_MAX_H_PX) {
	        next.h = INK_NODE_MAX_H_PX;
	        if (g.corner === 'nw' || g.corner === 'ne') next.y = bottom - next.h;
	      }
	    }

	    node.rect = next;
	    this.requestRender();
	  }

  private handlePointerUp(p: Vec2, info: { pointerType: string; pointerId: number; wasDrag: boolean }): void {
    const g = this.activeGesture;
    if (!g || g.pointerId !== info.pointerId) return;

    if (g.kind === 'pdf-annotation-place') {
      const placement = this.pdfAnnotationPlacement;
      this.activeGesture = null;

      const inCanvas = p.x >= 0 && p.y >= 0 && p.x <= this.cssW && p.y <= this.cssH;
      if (!placement || !inCanvas || !g.hadHover) {
        this.pdfAnnotationPlacement = null;
        if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
        this.requestRender();
        return;
      }

      const world = this.camera.screenToWorld(p);
      const drawToSpawn = placement.kind === 'ink' ? this.spawnInkNodeByDrawEnabled : this.spawnEditNodeByDrawEnabled;

      if (drawToSpawn) {
        const rect = placement.kind === 'ink'
          ? { x: world.x, y: world.y, w: 420, h: 280 }
          : { x: world.x, y: world.y, w: 460, h: 240 };
        placement.outlineRect = rect;
        placement.hoverWorld = { x: rect.x, y: rect.y };
        if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
        this.requestRender();
        return;
      }

      const rect = placement.kind === 'ink'
        ? { x: world.x, y: world.y, w: 420, h: 280 }
        : { x: world.x, y: world.y, w: 460, h: 240 };
      const createdId =
        placement.kind === 'ink' ? this.spawnInkNode({ rect }) : this.spawnTextNode({ title: 'Note', rect });
      this.applyPdfAnnotationToChildNode(createdId, placement);
      this.pdfAnnotationPlacement = null;
      try {
        this.onRequestPersist?.();
      } catch {
        // ignore
      }
      if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
      return;
    }

    if (g.kind === 'text-annotation-place') {
      const placement = this.textAnnotationPlacement;
      this.activeGesture = null;

      const inCanvas = p.x >= 0 && p.y >= 0 && p.x <= this.cssW && p.y <= this.cssH;
      if (!placement || !inCanvas || !g.hadHover) {
        this.textAnnotationPlacement = null;
        if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
        this.requestRender();
        return;
      }

      const world = this.camera.screenToWorld(p);
      const drawToSpawn = placement.kind === 'ink' ? this.spawnInkNodeByDrawEnabled : this.spawnEditNodeByDrawEnabled;

      if (drawToSpawn) {
        const rect = placement.kind === 'ink'
          ? { x: world.x, y: world.y, w: 420, h: 280 }
          : { x: world.x, y: world.y, w: 460, h: 240 };
        placement.outlineRect = rect;
        placement.hoverWorld = { x: rect.x, y: rect.y };
        if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
        this.requestRender();
        return;
      }

      const rect = placement.kind === 'ink'
        ? { x: world.x, y: world.y, w: 420, h: 280 }
        : { x: world.x, y: world.y, w: 460, h: 240 };
      const createdId =
        placement.kind === 'ink' ? this.spawnInkNode({ rect }) : this.spawnTextNode({ title: 'Note', rect });
      this.applyTextAnnotationToChildNode(createdId, placement);
      this.textAnnotationPlacement = null;
      try {
        this.onRequestPersist?.();
      } catch {
        // ignore
      }
      if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
      return;
    }

    if (g.kind === 'pdf-annotation-outline-resize') {
      const placement = this.pdfAnnotationPlacement;
      const rect = placement?.outlineRect ?? null;
      this.activeGesture = null;
      if (!placement || !rect) {
        this.pdfAnnotationPlacement = null;
        if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
        this.requestRender();
        return;
      }

      const createdId =
        placement.kind === 'ink' ? this.spawnInkNode({ rect }) : this.spawnTextNode({ title: 'Note', rect });
      this.applyPdfAnnotationToChildNode(createdId, placement);
      this.pdfAnnotationPlacement = null;
      try {
        this.onRequestPersist?.();
      } catch {
        // ignore
      }
      if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
      return;
    }

    if (g.kind === 'text-annotation-outline-resize') {
      const placement = this.textAnnotationPlacement;
      const rect = placement?.outlineRect ?? null;
      this.activeGesture = null;
      if (!placement || !rect) {
        this.textAnnotationPlacement = null;
        if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
        this.requestRender();
        return;
      }

      const createdId =
        placement.kind === 'ink' ? this.spawnInkNode({ rect }) : this.spawnTextNode({ title: 'Note', rect });
      this.applyTextAnnotationToChildNode(createdId, placement);
      this.textAnnotationPlacement = null;
      try {
        this.onRequestPersist?.();
      } catch {
        // ignore
      }
      if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
      return;
    }

    if (g.kind === 'spawn-by-draw') {
      this.activeGesture = null;
      if (!info.wasDrag) {
        if (g.hasDrag) this.requestRender();
        return;
      }
      this.suppressTapPointerIds.delete(info.pointerId);

      const world = this.camera.screenToWorld(p);
      const rect = this.rectFromWorldDrag(
        g.startWorld,
        world,
        g.spawn.kind === 'ink' ? { maxW: INK_NODE_MAX_W_PX, maxH: INK_NODE_MAX_H_PX } : undefined,
      );
      if (!rect) {
        if (g.hasDrag) this.requestRender();
        return;
      }

      if (g.spawn.kind === 'text') {
        const id = this.spawnTextNode({ ...(g.spawn.opts ?? {}), rect });
        if (g.pdfAnnotation) {
          this.applyPdfAnnotationToChildNode(id, g.pdfAnnotation);
          this.pdfAnnotationPlacement = null;
          try {
            this.onRequestPersist?.();
          } catch {
            // ignore
          }
        } else if (g.textAnnotation) {
          this.applyTextAnnotationToChildNode(id, g.textAnnotation);
          this.textAnnotationPlacement = null;
          try {
            this.onRequestPersist?.();
          } catch {
            // ignore
          }
        }
      } else {
        const id = this.spawnInkNode({ rect });
        if (g.pdfAnnotation) {
          this.applyPdfAnnotationToChildNode(id, g.pdfAnnotation);
          this.pdfAnnotationPlacement = null;
          try {
            this.onRequestPersist?.();
          } catch {
            // ignore
          }
        } else if (g.textAnnotation) {
          this.applyTextAnnotationToChildNode(id, g.textAnnotation);
          this.textAnnotationPlacement = null;
          try {
            this.onRequestPersist?.();
          } catch {
            // ignore
          }
        }
      }
      return;
    }

    if (g.kind === 'text-select') {
      const client = this.localToClient(p);
      this.textSelectLastClient = client;
      if (this.textSelectRaf != null) {
        try {
          cancelAnimationFrame(this.textSelectRaf);
        } catch { }
        this.textSelectRaf = null;
      }
      this.updatePenSelectionFromLastPoint();

      this.activeGesture = null;
      this.suppressTapPointerIds.delete(info.pointerId);

      // End the drag gesture but keep the selection alive while the menu is open.
      this.textSelectPointerId = null;
      this.textSelectAnchor = null;
      this.textSelectLastClient = null;

      const overlay = this.textLod2;
      const range = this.textSelectRange;
      const text = range ? extractTextFromRange(range) : '';
      if (overlay && range && text) {
        const rect = (() => {
          try {
            const rects = Array.from(range.getClientRects());
            return (rects[rects.length - 1] ?? range.getBoundingClientRect()) || null;
          } catch {
            return null;
          }
        })();
        if (rect) {
          overlay.openMenu({ anchorRect: rect, text, range });
        } else {
          this.clearTextSelection({ suppressOverlayCallback: true });
        }
      } else {
        this.clearTextSelection({ suppressOverlayCallback: true });
      }

      this.requestRender();
      return;
    }

    if (g.kind === 'pdf-text-select') {
      const client = this.localToClient(p);
      this.pdfSelectLastClient = client;
      if (this.pdfSelectRaf != null) {
        try {
          cancelAnimationFrame(this.pdfSelectRaf);
        } catch { }
        this.pdfSelectRaf = null;
      }
      this.updatePdfPenSelectionFromLastPoint();

      this.activeGesture = null;
      this.suppressTapPointerIds.delete(info.pointerId);

      this.pdfSelectPointerId = null;
      this.pdfSelectAnchor = null;
      this.pdfSelectLastClient = null;

      const overlay = this.pdfTextLod2;
      const range = this.pdfSelectRange;
      const text = range ? this.extractPlainTextFromRange(range) : '';
      if (overlay && range && text) {
        const selectionStart = (() => {
          try {
            const rects = Array.from(range.getClientRects());
            const first = rects[0];
            if (!first) return null;
            const contentRect = overlay.getTextLayerElement().getBoundingClientRect();
            const z = Math.max(0.01, overlay.getZoom() || 1);
            const localY = (first.top - contentRect.top) / z + first.height / z / 2;
            const worldH = contentRect.height / z;
            if (!Number.isFinite(localY) || !Number.isFinite(worldH) || worldH <= 0.001) return null;
            const yPct = clamp(localY / worldH, 0, 1);
            if (!Number.isFinite(yPct)) return null;
            const pageNumber = g.pageNumber;
            if (!Number.isFinite(pageNumber) || pageNumber < 1) return null;
            return { pageNumber, yPct } satisfies PdfSelectionStartAnchor;
          } catch {
            return null;
          }
        })();
        const rect = (() => {
          try {
            const rects = Array.from(range.getClientRects());
            return (rects[rects.length - 1] ?? range.getBoundingClientRect()) || null;
          } catch {
            return null;
          }
        })();
        if (rect) {
          overlay.openMenu({ anchorRect: rect, text, selectionStart: selectionStart ?? null });
        } else {
          this.clearPdfTextSelection({ suppressOverlayCallback: true });
        }
      } else {
        this.clearPdfTextSelection({ suppressOverlayCallback: true });
      }

      this.requestRender();
      return;
    }

    if (g.kind === 'ink-world') {
      const world = this.camera.screenToWorld(p);
      this.pushInkPoint(g.stroke, { x: world.x, y: world.y }, this.inkMinPointDistWorld(g.pointerType));
      if (g.stroke.points.length > 0) this.worldInkStrokes.push(g.stroke);
      this.activeGesture = null;
      this.suppressTapPointerIds.delete(info.pointerId);
      this.requestRender();
      return;
    }

    if (g.kind === 'ink-node') {
      const node = this.nodes.find((n): n is InkNode => n.id === g.nodeId && n.kind === 'ink');
      if (!node) {
        this.activeGesture = null;
        this.suppressTapPointerIds.delete(info.pointerId);
        this.requestRender();
        return;
      }
      const contentRect = this.textContentRect(node.rect);
      const world = this.camera.screenToWorld(p);
      this.pushInkPoint(
        g.stroke,
        {
          x: clamp(world.x - contentRect.x, 0, contentRect.w),
          y: clamp(world.y - contentRect.y, 0, contentRect.h),
        },
        this.inkMinPointDistWorld(g.pointerType),
      );
      if (g.stroke.points.length > 0) {
        node.strokes.push(g.stroke);
        void this.ensureInkNodeRaster(node, contentRect);
      }
      this.activeGesture = null;
      this.suppressTapPointerIds.delete(info.pointerId);
      this.requestRender();
      return;
    }

    if (g.kind === 'erase-world') {
      const world = this.camera.screenToWorld(p);
      const changed = this.eraseWorldInkStrokesAlongSegment(g.lastWorld, world, g.radiusWorld);
      this.activeGesture = null;
      this.suppressTapPointerIds.delete(info.pointerId);
      if (changed) this.requestRender();
      return;
    }

    if (g.kind === 'erase-node') {
      const node = this.nodes.find((n): n is InkNode => n.id === g.nodeId && n.kind === 'ink');
      if (!node) {
        this.activeGesture = null;
        this.suppressTapPointerIds.delete(info.pointerId);
        this.requestRender();
        return;
      }
      const contentRect = this.textContentRect(node.rect);
      const world = this.camera.screenToWorld(p);
      const local: InkPoint = {
        x: clamp(world.x - contentRect.x, 0, contentRect.w),
        y: clamp(world.y - contentRect.y, 0, contentRect.h),
      };
      const changed = this.eraseInkNodeStrokesAlongSegment(node, g.lastLocal, local, g.radiusWorld);
      this.activeGesture = null;
      this.suppressTapPointerIds.delete(info.pointerId);
      if (changed) this.requestRender();
      return;
    }

	    if (g.kind === 'resize') {
	      const node = this.nodes.find((n): n is TextNode => n.id === g.nodeId && n.kind === 'text');
	      if (node) {
	        const contentRect = this.textContentRect(node.rect);
	        const sig = this.textRasterSigForNode(node, contentRect).sig;
	        this.textResizeHold = { nodeId: node.id, sig, expiresAt: performance.now() + 2200 };
	      }
	    }

    this.activeGesture = null;
    if (info.wasDrag) this.suppressTapPointerIds.delete(info.pointerId);
    this.requestRender();
  }

  private handlePointerCancel(info: { pointerType: string; pointerId: number }): void {
    const g = this.activeGesture;
    if (g && g.pointerId === info.pointerId) {
      if (g.kind === 'text-select') this.clearTextSelection({ suppressOverlayCallback: true });
      if (g.kind === 'pdf-text-select') this.clearPdfTextSelection({ suppressOverlayCallback: true });
      if (g.kind === 'pdf-annotation-place') this.pdfAnnotationPlacement = null;
      if (g.kind === 'pdf-annotation-outline-resize') this.pdfAnnotationPlacement = null;
      if (g.kind === 'spawn-by-draw' && g.pdfAnnotation) this.pdfAnnotationPlacement = null;
      if (g.kind === 'text-annotation-place') this.textAnnotationPlacement = null;
      if (g.kind === 'text-annotation-outline-resize') this.textAnnotationPlacement = null;
      if (g.kind === 'spawn-by-draw' && g.textAnnotation) this.textAnnotationPlacement = null;
      this.activeGesture = null;
    }
    this.suppressTapPointerIds.delete(info.pointerId);
    this.requestRender();
  }

  private handleTap(p: Vec2, info: { pointerType: string; pointerId: number }): void {
    if (this.suppressTapPointerIds.has(info.pointerId)) {
      this.suppressTapPointerIds.delete(info.pointerId);
      return;
    }
    if (this.editingNodeId) return;
    const world = this.camera.screenToWorld(p);
    const hit = this.findTopmostNodeAtWorld(world);

    if (hit) {
	      if (hit.kind === 'text' && this.canCancelNode(hit)) {
	        const btn = this.stopButtonRect(hit);
	        const inStop = world.x >= btn.x && world.x <= btn.x + btn.w && world.y >= btn.y && world.y <= btn.y + btn.h;
	        if (inStop) {
	          const changed = this.selectedNodeId !== hit.id || this.editingNodeId !== null;
	          this.selectedNodeId = hit.id;
          this.editingNodeId = null;
          this.bringNodeToFront(hit.id);
          this.requestRender();
          if (changed) this.emitUiState();
          this.onRequestCancelGeneration?.(hit.id);
          return;
        }
      }

      if (hit.kind === 'text' && hit.author === 'assistant') {
        const zone = this.getTextNodeHitZoneAtWorld(hit, world);
        if (zone) {
          const selectionChanged = this.selectedNodeId !== hit.id || this.editingNodeId !== null;
          this.selectedNodeId = hit.id;
          this.editingNodeId = null;
          this.bringNodeToFront(hit.id);

          if (zone.kind === 'summary_toggle') {
            const blocks = this.getFinalReasoningBlocks(hit);
            if (!hit.isGenerating && blocks.length > 0) {
              hit.summaryExpanded = !hit.summaryExpanded;
              this.recomputeTextNodeDisplayHash(hit);
              this.textRasterGeneration += 1;
              const contentRect = this.textContentRect(hit.rect);
              const sig = this.textRasterSigForNode(hit, contentRect).sig;
              this.textResizeHold = { nodeId: hit.id, sig, expiresAt: performance.now() + 2200 };
              this.requestRender();
              if (selectionChanged) this.emitUiState();
              try {
                this.onRequestPersist?.();
              } catch {
                // ignore
              }
              return;
            }
            if (selectionChanged) {
              this.requestRender();
              this.emitUiState();
            }
            return;
          }

          if (zone.kind === 'summary_chunk_toggle') {
            const idx = zone.summaryIndex ?? 0;
            const prev = hit.expandedSummaryChunks ?? {};
            const next: Record<number, boolean> = { ...prev };
            if (next[idx]) delete next[idx];
            else next[idx] = true;
            hit.expandedSummaryChunks = Object.keys(next).length ? next : undefined;

            this.recomputeTextNodeDisplayHash(hit);
            if (!hit.isGenerating) {
              this.textRasterGeneration += 1;
              const contentRect = this.textContentRect(hit.rect);
              const sig = this.textRasterSigForNode(hit, contentRect).sig;
              this.textResizeHold = { nodeId: hit.id, sig, expiresAt: performance.now() + 2200 };
            }
            this.requestRender();
            if (selectionChanged) this.emitUiState();
            try {
              this.onRequestPersist?.();
            } catch {
              // ignore
            }
            return;
          }
        }
      }

      if (hit.kind === 'text' && hit.author === 'user') {
        const zone = this.getTextNodeHitZoneAtWorld(hit, world);
        if (zone?.kind === 'preface_context_toggle') {
          const selectionChanged = this.selectedNodeId !== hit.id || this.editingNodeId !== null;
          this.selectedNodeId = hit.id;
          this.editingNodeId = null;
          this.bringNodeToFront(hit.id);

          const idx = Number(zone.contextIndex);
          if (Number.isFinite(idx)) {
            const prev = hit.collapsedPrefaceContexts ?? {};
            const next: Record<number, boolean> = { ...prev };
            if (next[idx]) delete next[idx];
            else next[idx] = true;
            hit.collapsedPrefaceContexts = Object.keys(next).length ? next : undefined;

            this.recomputeTextNodeDisplayHash(hit);
            this.textRasterGeneration += 1;
            const contentRect = this.textContentRect(hit.rect);
            const sig = this.textRasterSigForNode(hit, contentRect).sig;
            this.textResizeHold = { nodeId: hit.id, sig, expiresAt: performance.now() + 2200 };
            this.requestRender();
            if (selectionChanged) this.emitUiState();
            try {
              this.onRequestPersist?.();
            } catch {
              // ignore
            }
            return;
          }

          if (selectionChanged) {
            this.requestRender();
            this.emitUiState();
          }
          return;
        }
      }

      const menuBtn = this.menuButtonRect(hit.rect);
      const inMenu = world.x >= menuBtn.x && world.x <= menuBtn.x + menuBtn.w && world.y >= menuBtn.y && world.y <= menuBtn.y + menuBtn.h;
      if (inMenu) {
        const changed = this.selectedNodeId !== hit.id || this.editingNodeId !== null;
        this.selectedNodeId = hit.id;
        this.editingNodeId = null;
        this.bringNodeToFront(hit.id);
        this.requestRender();
        if (changed) this.emitUiState();
        this.onRequestNodeMenu?.(hit.id);
        return;
      }

      const btn = this.replyButtonRect(hit.rect);
      const inReply =
        world.x >= btn.x && world.x <= btn.x + btn.w && world.y >= btn.y && world.y <= btn.y + btn.h;
      if (inReply) {
        const changed = this.selectedNodeId !== hit.id || this.editingNodeId !== null;
        this.selectedNodeId = hit.id;
        this.editingNodeId = null;
        this.bringNodeToFront(hit.id);
        this.requestRender();
        if (changed) this.emitUiState();
        this.onRequestReply?.(hit.id);
        return;
      }

      if ((hit.kind === 'text' && hit.isEditNode) || hit.kind === 'ink') {
        const mainBtn = this.sendButtonMainRect(hit.rect);
        const arrowBtn = this.sendButtonArrowRect(hit.rect);
        const inMain =
          world.x >= mainBtn.x &&
          world.x <= mainBtn.x + mainBtn.w &&
          world.y >= mainBtn.y &&
          world.y <= mainBtn.y + mainBtn.h;
        const inArrow =
          world.x >= arrowBtn.x &&
          world.x <= arrowBtn.x + arrowBtn.w &&
          world.y >= arrowBtn.y &&
          world.y <= arrowBtn.y + arrowBtn.h;
        if (inMain || inArrow) {

          const changed = this.selectedNodeId !== hit.id || this.editingNodeId !== null;
          this.selectedNodeId = hit.id;
          this.editingNodeId = null;
          this.bringNodeToFront(hit.id);
          this.requestRender();
          if (changed) this.emitUiState();

          if (inArrow) this.onRequestSendEditNodeModelMenu?.(hit.id);
          else this.onRequestSendEditNode?.(hit.id);
          return;
        }
      }
    }

    const now = performance.now();
    const isDoubleTap =
      hit &&
      this.lastTapNodeId === hit.id &&
      now - this.lastTapAt < 350 &&
      this.lastTapPos != null &&
      (p.x - this.lastTapPos.x) * (p.x - this.lastTapPos.x) + (p.y - this.lastTapPos.y) * (p.y - this.lastTapPos.y) <
        18 * 18;
    this.lastTapAt = now;
    this.lastTapPos = p;
    this.lastTapNodeId = hit?.id ?? null;

    if (isDoubleTap && hit.kind === 'text') {
      if (this.tryBeginEditingNode(hit.id)) return;
    }

    const nextSelected = hit ? hit.id : null;
    const changed = nextSelected !== this.selectedNodeId;
    this.selectedNodeId = nextSelected;
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

  private rectIntersection(a: Rect, b: Rect): Rect | null {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    return { x: x0, y: y0, w, h };
  }

  private pathRoundedRect(ctx: CanvasRenderingContext2D, rect: Rect, radius: number): void {
    const r = Math.max(0, Math.min(radius, Math.min(rect.w, rect.h) * 0.5));
    const x = rect.x;
    const y = rect.y;
    const w = rect.w;
    const h = rect.h;

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
  }

  private ensureBackgroundCache(): NonNullable<WorldEngine['backgroundCache']> | null {
    if (!this.backgroundImage) return null;
    if (typeof document === 'undefined') return null;
    const w = this.backgroundImageW;
    const h = this.backgroundImageH;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;

    const pxW = Math.max(1, this.canvas.width);
    const pxH = Math.max(1, this.canvas.height);
    const cur = this.backgroundCache;
    const blurPx = Math.max(0, this.glassBlurCssPx * this.dpr);
    const saturatePct = Math.max(0, this.glassSaturatePct);
    const desiredBackend: GlassBlurBackend =
      this.glassBlurBackend === 'webgl' && !this.webglPreblurDisabled ? 'webgl' : 'canvas';
    const needsResize = !cur || cur.pxW !== pxW || cur.pxH !== pxH;
    const needsSharp = !cur || needsResize || cur.version !== this.backgroundVersion;
    const needsBlur =
      !cur ||
      needsResize ||
      cur.version !== this.backgroundVersion ||
      cur.blurBackend !== desiredBackend ||
      Math.abs(cur.blurPx - blurPx) > 0.01 ||
      Math.abs(cur.saturatePct - saturatePct) > 0.01;
    if (cur && !needsSharp && !needsBlur) return cur;

    const sharp = cur?.sharp ?? document.createElement('canvas');
    const blurred = cur?.blurred ?? document.createElement('canvas');
    if (needsResize) {
      sharp.width = pxW;
      sharp.height = pxH;
      blurred.width = pxW;
      blurred.height = pxH;
    }

    const sctx = sharp.getContext('2d');
    const bctx = blurred.getContext('2d');
    if (!sctx || !bctx) return null;

    if (needsSharp) {
      sctx.clearRect(0, 0, pxW, pxH);
      try {
        const scale = Math.max(pxW / w, pxH / h);
        const dw = w * scale;
        const dh = h * scale;
        const dx = (pxW - dw) * 0.5;
        const dy = (pxH - dh) * 0.5;
        sctx.imageSmoothingEnabled = true;
        sctx.drawImage(this.backgroundImage, dx, dy, dw, dh);
      } catch {
        // ignore; leave blank
      }
    }

    let blurBackendUsed: GlassBlurBackend = desiredBackend;
    if (needsBlur) {
      bctx.clearRect(0, 0, pxW, pxH);
      if (desiredBackend === 'webgl') {
        try {
          if (!this.webglPreblur) this.webglPreblur = new WebGLPreblur();
          const res = this.webglPreblur.render({
            source: sharp,
            dstW: pxW,
            dstH: pxH,
            blurPx,
            saturatePct,
          });
          bctx.save();
          bctx.filter = 'none';
          bctx.imageSmoothingEnabled = true;
          bctx.drawImage(res.canvas, 0, 0, res.canvas.width, res.canvas.height, 0, 0, pxW, pxH);
          bctx.restore();
          blurBackendUsed = 'webgl';
        } catch {
          this.webglPreblurDisabled = true;
          try {
            this.webglPreblur?.dispose();
          } catch {
            // ignore
          }
          this.webglPreblur = null;
          blurBackendUsed = 'canvas';
        }
      }

      if (blurBackendUsed === 'canvas') {
        try {
          bctx.save();
          const filters: string[] = [];
          if (blurPx > 0.01) filters.push(`blur(${blurPx.toFixed(2)}px)`);
          if (Math.abs(saturatePct - 100) > 0.01) filters.push(`saturate(${saturatePct.toFixed(0)}%)`);
          bctx.filter = filters.length ? filters.join(' ') : 'none';
          bctx.drawImage(sharp, 0, 0);
          bctx.restore();
        } catch {
          // ignore; leave blank
        }
      }
    }

    const next = { version: this.backgroundVersion, pxW, pxH, blurPx, saturatePct, blurBackend: blurBackendUsed, sharp, blurred };
    this.backgroundCache = next;
    return next;
  }

  private drawBackground(): void {
    const cache = this.ensureBackgroundCache();
    if (!cache) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    try {
      ctx.drawImage(cache.sharp, 0, 0, this.cssW, this.cssH);
    } catch {
      // ignore
    }
    ctx.restore();
  }

  private drawNodeGlassUnderlays(): void {
    if (!this.glassNodesEnabled) return;
    const cache = this.ensureBackgroundCache();
    if (!cache) return;

    const ctx = this.ctx;
    const view: Rect = { x: 0, y: 0, w: this.cssW, h: this.cssH };
    const z = Math.max(0.001, this.camera.zoom || 1);

    for (const node of this.nodes) {
      if (node.kind !== 'text' && node.kind !== 'ink') continue;

      const tl = this.camera.worldToScreen({ x: node.rect.x, y: node.rect.y });
      const screenRect: Rect = { x: tl.x, y: tl.y, w: node.rect.w * z, h: node.rect.h * z };
      const visible = this.rectIntersection(screenRect, view);
      if (!visible) continue;

      const r = 18 * z;
      ctx.save();
      this.pathRoundedRect(ctx, screenRect, r);
      ctx.clip();
      ctx.globalAlpha = this.glassUnderlayAlpha;

      const sx = visible.x * this.dpr;
      const sy = visible.y * this.dpr;
      const sw = visible.w * this.dpr;
      const sh = visible.h * this.dpr;
      try {
        ctx.drawImage(cache.blurred, sx, sy, sw, sh, visible.x, visible.y, visible.w, visible.h);
      } catch {
        // ignore
      }
      ctx.restore();
    }
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

  private replyButtonRect(nodeRect: Rect): Rect {
    const pad = TEXT_NODE_PAD_PX;
    const w = 58;
    const h = 22;
    const gap = 8;

    const menu = this.menuButtonRect(nodeRect);
    const x = menu.x - gap - w;
    const y = menu.y;
    const minX = nodeRect.x + pad;
    return { x: Math.max(minX, x), y, w, h };
  }

  private sendButtonRect(nodeRect: Rect): Rect {
    const pad = TEXT_NODE_PAD_PX;
    const w = 68;
    const h = 22;
    const gap = 8;

    const anchor = this.replyButtonRect(nodeRect);
    const x = anchor.x - gap - w;
    const y = anchor.y;
    const minX = nodeRect.x + pad;
    return { x: Math.max(minX, x), y, w, h };
  }

  private sendButtonArrowRect(nodeRect: Rect): Rect {
    const rect = this.sendButtonRect(nodeRect);
    const w = 18;
    return { x: rect.x + rect.w - w, y: rect.y, w, h: rect.h };
  }

  private sendButtonMainRect(nodeRect: Rect): Rect {
    const rect = this.sendButtonRect(nodeRect);
    const arrow = this.sendButtonArrowRect(nodeRect);
    return { x: rect.x, y: rect.y, w: Math.max(1, arrow.x - TEXT_NODE_SEND_BUTTON_SPLIT_GAP_PX - rect.x), h: rect.h };
  }

  private menuButtonRect(nodeRect: Rect): Rect {
    const pad = TEXT_NODE_PAD_PX;
    const w = 28;
    const h = 22;
    const x = nodeRect.x + nodeRect.w - pad - w;
    const y = nodeRect.y + 9;
    return { x, y, w, h };
  }

  private stopButtonRect(node: TextNode): Rect {
    const pad = TEXT_NODE_PAD_PX;
    const w = 56;
    const h = 22;
    const gap = 8;

    const nodeRect = node.rect;
    const anchor = this.replyButtonRect(nodeRect);
    const x = anchor.x - gap - w;
    const y = anchor.y;
    const minX = nodeRect.x + pad;
    return { x: Math.max(minX, x), y, w, h };
  }

  private canCancelNode(node: TextNode): boolean {
    if (!node.isGenerating) return false;
    const task = node.llmTask;
    if (!task || typeof task !== 'object') return false;
    if (!task.cancelable) return false;
    const taskId = typeof task.taskId === 'string' ? task.taskId.trim() : '';
    return Boolean(taskId);
  }

  private drawMenuButton(nodeRect: Rect, opts?: { active?: boolean; hovered?: boolean }): void {
    const ctx = this.ctx;
    const r = 9;
    const rect = this.menuButtonRect(nodeRect);
    const active = Boolean(opts?.active);
    const hovered = Boolean(opts?.hovered);

    ctx.save();
    if (hovered) {
      ctx.shadowColor = active ? 'rgba(147,197,253,0.5)' : 'rgba(255,255,255,0.28)';
      ctx.shadowBlur = 14;
    }

    ctx.fillStyle = active
      ? hovered
        ? 'rgba(147,197,253,0.26)'
        : 'rgba(147,197,253,0.18)'
      : hovered
        ? 'rgba(255,255,255,0.08)'
        : 'rgba(0,0,0,0.22)';
    ctx.strokeStyle = active
      ? hovered
        ? 'rgba(147,197,253,0.75)'
        : 'rgba(147,197,253,0.42)'
      : hovered
        ? 'rgba(255,255,255,0.28)'
        : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(rect.x + r, rect.y);
    ctx.lineTo(rect.x + rect.w - r, rect.y);
    ctx.arcTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + r, r);
    ctx.lineTo(rect.x + rect.w, rect.y + rect.h - r);
    ctx.arcTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - r, rect.y + rect.h, r);
    ctx.lineTo(rect.x + r, rect.y + rect.h);
    ctx.arcTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - r, r);
    ctx.lineTo(rect.x, rect.y + r);
    ctx.arcTo(rect.x, rect.y, rect.x + r, rect.y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = hovered || active ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.86)';
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.textBaseline = 'middle';
    const label = '⋮';
    const m = ctx.measureText(label);
    const textX = rect.x + (rect.w - (m.width || 0)) * 0.5;
    ctx.fillText(label, textX, rect.y + rect.h * 0.5);

    ctx.restore();
  }

  private drawReplyButton(nodeRect: Rect, opts?: { active?: boolean; hovered?: boolean }): void {
    const ctx = this.ctx;
    const r = 9;
    const rect = this.replyButtonRect(nodeRect);
    const active = Boolean(opts?.active);
    const hovered = Boolean(opts?.hovered);

    ctx.save();
    if (hovered) {
      ctx.shadowColor = active ? 'rgba(147,197,253,0.55)' : 'rgba(255,255,255,0.28)';
      ctx.shadowBlur = 14;
    }

    ctx.fillStyle = active
      ? hovered
        ? 'rgba(147,197,253,0.36)'
        : 'rgba(147,197,253,0.28)'
      : hovered
        ? 'rgba(255,255,255,0.08)'
        : 'rgba(0,0,0,0.22)';
    ctx.strokeStyle = active
      ? hovered
        ? 'rgba(147,197,253,0.85)'
        : 'rgba(147,197,253,0.55)'
      : hovered
        ? 'rgba(255,255,255,0.28)'
        : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(rect.x + r, rect.y);
    ctx.lineTo(rect.x + rect.w - r, rect.y);
    ctx.arcTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + r, r);
    ctx.lineTo(rect.x + rect.w, rect.y + rect.h - r);
    ctx.arcTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - r, rect.y + rect.h, r);
    ctx.lineTo(rect.x + r, rect.y + rect.h);
    ctx.arcTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - r, r);
    ctx.lineTo(rect.x, rect.y + r);
    ctx.arcTo(rect.x, rect.y, rect.x + r, rect.y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = hovered || active ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.86)';
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.textBaseline = 'middle';
    const label = 'Reply';
    const m = ctx.measureText(label);
    const textX = rect.x + (rect.w - (m.width || 0)) * 0.5;
    ctx.fillText(label, textX, rect.y + rect.h * 0.5);

    ctx.restore();
  }

  private drawSendButton(nodeRect: Rect, opts?: { active?: boolean; hovered?: boolean; arrowHovered?: boolean }): void {
    const ctx = this.ctx;
    const r = 9;
    const mainRect = this.sendButtonMainRect(nodeRect);
    const arrowRect = this.sendButtonArrowRect(nodeRect);
    const hovered = Boolean(opts?.hovered);
    const arrowHovered = Boolean(opts?.arrowHovered);
    const mainHovered = hovered && !arrowHovered;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(147,197,253,0.5)';

    const drawRoundedRect = (rect: Rect) => {
      ctx.beginPath();
      ctx.moveTo(rect.x + r, rect.y);
      ctx.lineTo(rect.x + rect.w - r, rect.y);
      ctx.arcTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + r, r);
      ctx.lineTo(rect.x + rect.w, rect.y + rect.h - r);
      ctx.arcTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - r, rect.y + rect.h, r);
      ctx.lineTo(rect.x + r, rect.y + rect.h);
      ctx.arcTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - r, r);
      ctx.lineTo(rect.x, rect.y + r);
      ctx.arcTo(rect.x, rect.y, rect.x + r, rect.y, r);
      ctx.closePath();
    };

    ctx.fillStyle = mainHovered ? 'rgba(147,197,253,0.32)' : 'rgba(147,197,253,0.22)';
    drawRoundedRect(mainRect);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = arrowHovered ? 'rgba(147,197,253,0.32)' : 'rgba(147,197,253,0.22)';
    drawRoundedRect(arrowRect);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.textBaseline = 'middle';

    const label = 'Send';
    const m = ctx.measureText(label);
    const textX = mainRect.x + (mainRect.w - (m.width || 0)) * 0.5;
    ctx.fillText(label, textX, mainRect.y + mainRect.h * 0.5);

    const arrowLabel = '▾';
    const ma = ctx.measureText(arrowLabel);
    const arrowX = arrowRect.x + (arrowRect.w - (ma.width || 0)) * 0.5;
    ctx.fillText(arrowLabel, arrowX, arrowRect.y + arrowRect.h * 0.5);

    ctx.restore();
  }

  private drawStopButton(node: TextNode, opts?: { hovered?: boolean }): void {
    const ctx = this.ctx;
    const r = 9;
    const rect = this.stopButtonRect(node);
    const hovered = Boolean(opts?.hovered);

    ctx.save();
    if (hovered) {
      ctx.shadowColor = 'rgba(248,113,113,0.45)';
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = hovered ? 'rgba(248,113,113,0.28)' : 'rgba(248,113,113,0.18)';
    ctx.strokeStyle = hovered ? 'rgba(248,113,113,0.92)' : 'rgba(248,113,113,0.62)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(rect.x + r, rect.y);
    ctx.lineTo(rect.x + rect.w - r, rect.y);
    ctx.arcTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + r, r);
    ctx.lineTo(rect.x + rect.w, rect.y + rect.h - r);
    ctx.arcTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - r, rect.y + rect.h, r);
    ctx.lineTo(rect.x + r, rect.y + rect.h);
    ctx.arcTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - r, r);
    ctx.lineTo(rect.x, rect.y + r);
    ctx.arcTo(rect.x, rect.y, rect.x + r, rect.y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.textBaseline = 'middle';
    const label = 'Stop';
    const m = ctx.measureText(label);
    const textX = rect.x + (rect.w - (m.width || 0)) * 0.5;
    ctx.fillText(label, textX, rect.y + rect.h * 0.5);

    ctx.restore();
  }

  private drawParentArrows(): void {
    const ctx = this.ctx;
    const z = Math.max(0.01, this.camera.zoom || 1);
    const view = this.worldViewportRect({ overscan: 420 });

    const byId = new Map<string, WorldNode>();
    for (const n of this.nodes) byId.set(n.id, n);

    const router = getEdgeRouter(this.edgeRouterId);
    const arrowHeadLen = 12 / z;
    const arrowHalfW = 6 / z;
    const routeStyle = {
      arrowHeadLength: arrowHeadLen,
      controlPointMin: 40 / z,
      controlPointMax: 200 / z,
      straightAlignThreshold: 4 / z,
    };

    ctx.save();
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = this.replyArrowColor;
    ctx.fillStyle = this.replyArrowColor;
    ctx.globalAlpha = this.replyArrowOpacity;

    const polylineEndDir = (pts: Vec2[]): Vec2 | null => {
      for (let i = pts.length - 1; i >= 1; i--) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.hypot(dx, dy) > 0.001) return { x: dx, y: dy };
      }
      return null;
    };

    const drawRoute = (route: EdgeRoute): { end: Vec2; endDir: Vec2 } | null => {
      if (route.kind === 'polyline') {
        const pts = route.points;
        if (pts.length < 2) return null;
        const endDir = polylineEndDir(pts);
        if (!endDir) return null;
        const end = pts[pts.length - 1]!;

        ctx.beginPath();
        ctx.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
        ctx.stroke();
        return { end, endDir };
      }

      const endDir: Vec2 = { x: route.p3.x - route.c2.x, y: route.p3.y - route.c2.y };
      if (Math.hypot(endDir.x, endDir.y) <= 0.001) return null;
      ctx.beginPath();
      ctx.moveTo(route.p0.x, route.p0.y);
      ctx.bezierCurveTo(route.c1.x, route.c1.y, route.c2.x, route.c2.y, route.p3.x, route.p3.y);
      ctx.stroke();
      return { end: route.p3, endDir };
    };

    for (const child of this.nodes) {
      const pid = child.parentId;
      if (!pid) continue;
      const parent = byId.get(pid);
      if (!parent) continue;

      if (!rectsIntersect(parent.rect, view) && !rectsIntersect(child.rect, view)) continue;

      const anchors = (() => {
        if (parent.kind !== 'pdf') return undefined;
        const a = child.parentAnchor;
        if (!a || a.kind !== 'pdf-selection') return undefined;
        const state = this.pdfStateByNodeId.get(parent.id);
        if (!state) return undefined;
        const pageRect = this.getPdfPageRect(parent, state, a.pageNumber);
        if (!pageRect) return undefined;

        const childCx = child.rect.x + child.rect.w * 0.5;
        const leftX = pageRect.x;
        const rightX = pageRect.x + pageRect.w;
        const side = Math.abs(childCx - rightX) < Math.abs(childCx - leftX) ? ('right' as const) : ('left' as const);
        const x = side === 'right' ? rightX : leftX;
        const y = pageRect.y + clamp(a.yPct, 0, 1) * pageRect.h;
        return { start: { side, point: { x, y } } };
      })();

      const route = router.route({
        parent: { id: parent.id, rect: parent.rect },
        child: { id: child.id, rect: child.rect },
        style: routeStyle,
        ...(anchors ? { anchors } : {}),
      });
      if (!route) continue;

      const drawn = drawRoute(route);
      if (!drawn) continue;
      const endX = drawn.end.x;
      const endY = drawn.end.y;

      const dx = drawn.endDir.x;
      const dy = drawn.endDir.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) continue;
      const ux = dx / len;
      const uy = dy / len;

      const px = -uy;
      const py = ux;
      const baseAnchor = route.arrow?.anchor === 'base';
      const baseX = baseAnchor ? endX : endX - ux * arrowHeadLen;
      const baseY = baseAnchor ? endY : endY - uy * arrowHeadLen;
      const tipX = baseAnchor ? endX + ux * arrowHeadLen : endX;
      const tipY = baseAnchor ? endY + uy * arrowHeadLen : endY;

      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(baseX + px * arrowHalfW, baseY + py * arrowHalfW);
      ctx.lineTo(baseX - px * arrowHalfW, baseY - py * arrowHalfW);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  private drawDemoNodes(): void {
    const ctx = this.ctx;
    const view = this.worldViewportRect({ overscan: 360 });
    for (const node of this.nodes) {
      if (node.id === this.editingNodeId) continue;
      if (node.kind === 'pdf' && node.status === 'ready') {
        const state = this.pdfStateByNodeId.get(node.id);
        if (state) this.updatePdfNodeDerivedHeight(node, state);
      }
      const { x, y, w, h } = node.rect;
      const r = 18;

      const isSelected = node.id === this.selectedNodeId;
      ctx.fillStyle = isSelected ? 'rgba(0,0,0,0.36)' : 'rgba(0,0,0,0.28)';
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
      ctx.font = '600 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
      const headerBtn = this.menuButtonRect(node.rect);
      ctx.textBaseline = 'middle';
      ctx.fillText(node.title, x + TEXT_NODE_PAD_PX, headerBtn.y + headerBtn.h * 0.5);
      ctx.textBaseline = 'top';
      const headerHover = this.hoverNodeHeaderButton;
      const hoverMenu = headerHover?.nodeId === node.id && headerHover.kind === 'menu';
      const hoverReply = headerHover?.nodeId === node.id && headerHover.kind === 'reply';
      const hoverStop = headerHover?.nodeId === node.id && headerHover.kind === 'stop';
      const hoverSend = headerHover?.nodeId === node.id && headerHover.kind === 'send';
      const hoverSendMenu = headerHover?.nodeId === node.id && headerHover.kind === 'send_menu';

      if (node.kind === 'text' && this.canCancelNode(node)) this.drawStopButton(node, { hovered: hoverStop });
      this.drawMenuButton(node.rect, { active: isSelected, hovered: hoverMenu });
      this.drawReplyButton(node.rect, { active: isSelected, hovered: hoverReply });
      if ((node.kind === 'text' && node.isEditNode) || node.kind === 'ink') {
        this.drawSendButton(node.rect, {
          active: isSelected,
          hovered: hoverSend || hoverSendMenu,
          arrowHovered: hoverSendMenu,
        });
      }

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';

      // Header separator.
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1 / (this.camera.zoom || 1);
      const headerDividerY = y + TEXT_NODE_HEADER_H_PX - TEXT_NODE_HEADER_GAP_PX;
      ctx.beginPath();
      ctx.moveTo(x + TEXT_NODE_PAD_PX, headerDividerY);
      ctx.lineTo(x + w - TEXT_NODE_PAD_PX, headerDividerY);
      ctx.stroke();

      if (node.kind === 'text') {
        const contentRect = this.textContentRect(node.rect);

        // When a text node is covered by a LOD2 DOM overlay, the overlay is responsible for the content.
        const hasLod2 =
          this.textLod2Target?.nodeId === node.id || this.textStreamLod2Target?.nodeId === node.id;
        const suppressContent = node.id === this.rawViewerNodeId;
        if (!hasLod2 && !suppressContent) {
	          const sig = this.textRasterSigForNode(node, contentRect).sig;
	          const raster = this.getBestTextRaster(sig);
	          if (raster) {
	            try {
	              ctx.drawImage(raster.image, contentRect.x, contentRect.y, contentRect.w, contentRect.h);
	            } catch {
	              // ignore; fall back to placeholder
	            }
	          } else {
	            const line = node.content.split('\n').find((s) => s.trim()) ?? '';
	            const preview = line.replace(/^#+\s*/, '').slice(0, 120);
	            ctx.fillText(preview ? preview : '…', contentRect.x, contentRect.y + 4);
	            ctx.fillStyle = 'rgba(255,255,255,0.45)';
	            ctx.fillText('Rendering…', contentRect.x, contentRect.y + 24);
	          }
	        }
      } else if (node.kind === 'pdf') {
        const contentRect = this.textContentRect(node.rect);
        if (node.status === 'empty') {
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.fillText('Import a PDF to begin.', contentRect.x, contentRect.y + 4);
        } else if (node.status === 'loading') {
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.fillText('Loading PDF…', contentRect.x, contentRect.y + 4);
        } else if (node.status === 'error') {
          ctx.fillStyle = 'rgba(255,80,80,0.85)';
          ctx.fillText('Failed to load PDF', contentRect.x, contentRect.y + 4);
          if (node.error) {
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.fillText(String(node.error).slice(0, 140), contentRect.x, contentRect.y + 24);
          }
        } else if (node.status === 'ready') {
          const state = this.pdfStateByNodeId.get(node.id);
          if (!state) {
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.fillText('PDF missing state', contentRect.x, contentRect.y + 4);
          } else {
            const pageW = Math.max(1, contentRect.w);
            const pageGap = 16;
            let pageY = contentRect.y;

            ctx.save();
            ctx.beginPath();
            ctx.rect(contentRect.x, contentRect.y, contentRect.w, contentRect.h);
            ctx.clip();

            for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) {
              const meta = state.metas[pageNumber - 1];
              const aspect = meta?.aspect ?? state.defaultAspect;
              const pageH = Math.max(1, pageW * (Number.isFinite(aspect) && aspect > 0 ? aspect : state.defaultAspect));
              const pageRect: Rect = { x: contentRect.x, y: pageY, w: pageW, h: pageH };
              pageY += pageH + pageGap;

              if (!rectsIntersect(pageRect, view)) continue;

              ctx.fillStyle = 'rgba(255,255,255,0.94)';
              ctx.fillRect(pageRect.x, pageRect.y, pageRect.w, pageRect.h);
              ctx.strokeStyle = 'rgba(0,0,0,0.12)';
              ctx.lineWidth = 1 / (this.camera.zoom || 1);
              ctx.strokeRect(pageRect.x, pageRect.y, pageRect.w, pageRect.h);

              const sig = `${node.id}|t${state.token}|p${pageNumber}|w${Math.round(pageW)}`;
              const desiredScale = this.pdfDesiredRasterScale;
              const steps = this.pdfRasterScaleSteps;
              const makeKey = (scale: number) => `${sig}|s${scale}`;

              let img: CanvasImageSource | null = this.getPdfPageFromCache(makeKey(desiredScale));
              if (!img) {
                // Prefer the best cached scale <= desired, so memory usage converges to the budgeted scale.
                for (let i = steps.length - 1; i >= 0; i -= 1) {
                  const s = steps[i];
                  if (s >= desiredScale) continue;
                  img = this.getPdfPageFromCache(makeKey(s));
                  if (img) break;
                }
              }
              if (!img) {
                // As a temporary placeholder, allow drawing a higher-res cached page without touching LRU.
                for (let i = 0; i < steps.length; i += 1) {
                  const s = steps[i];
                  if (s <= desiredScale) continue;
                  img = this.getPdfPageFromCache(makeKey(s), { touch: false });
                  if (img) break;
                }
              }

              if (img) {
                try {
                  ctx.drawImage(img, pageRect.x, pageRect.y, pageRect.w, pageRect.h);
                } catch {
                  // ignore; leave background
                }
              } else {
                ctx.fillStyle = 'rgba(0,0,0,0.55)';
                ctx.font = `${14 / (this.camera.zoom || 1)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
                ctx.fillText(`Rendering page ${pageNumber}…`, pageRect.x + 14, pageRect.y + 18);
              }
            }

            ctx.restore();
          }
        }
	      } else if (node.kind === 'ink') {
	        const contentRect = this.textContentRect(node.rect);
	        ctx.save();
	        ctx.beginPath();
	        ctx.rect(contentRect.x, contentRect.y, contentRect.w, contentRect.h);
	        ctx.clip();

	        ctx.fillStyle = this.glassNodesEnabled ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.22)';
	        ctx.fillRect(contentRect.x, contentRect.y, contentRect.w, contentRect.h);

	        const g = this.activeGesture;
	        const isResizing = g?.kind === 'resize' && g.nodeId === node.id;
	        const raster = isResizing ? node.raster : this.ensureInkNodeRaster(node, contentRect);
	        if (raster) {
	          try {
	            const drawW = isResizing ? raster.worldW : contentRect.w;
	            const drawH = isResizing ? raster.worldH : contentRect.h;
	            ctx.drawImage(raster.canvas, contentRect.x, contentRect.y, drawW, drawH);
	          } catch {
	            // ignore; fall back to vectors
	          }
	        }

        if (!raster && node.strokes.length > 0) {
          for (const s of node.strokes) this.drawInkStroke(ctx, s, { offsetX: contentRect.x, offsetY: contentRect.y });
        }

	        if (g && g.kind === 'ink-node' && g.nodeId === node.id) {
	          this.drawInkStroke(ctx, g.stroke, { offsetX: contentRect.x, offsetY: contentRect.y });
	        }

        if (node.strokes.length === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.50)';
          ctx.font = `${14 / (this.camera.zoom || 1)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
          ctx.textBaseline = 'top';
          ctx.fillText('Draw with a pen, or switch to Draw tool.', contentRect.x + 14, contentRect.y + 14);
        }

        ctx.restore();
      }

      // Resize handles are intentionally hidden; cursor changes near corners indicate resizability.
    }
  }

  private drawTextAnnotationPlacementPreview(): void {
    const placement = this.textAnnotationPlacement;
    if (!placement) return;

    const endpoint = (() => {
      const g = this.activeGesture;
      if (g && g.kind === 'spawn-by-draw' && g.textAnnotation) return g.currentWorld;
      return placement.hoverWorld;
    })();
    if (!endpoint) return;

    const parent = this.nodes.find((n): n is TextNode => n.kind === 'text' && n.id === placement.textNodeId) ?? null;
    if (!parent) return;

    const parentCenter: Vec2 = { x: parent.rect.x + parent.rect.w * 0.5, y: parent.rect.y + parent.rect.h * 0.5 };
    const dx = endpoint.x - parentCenter.x;
    const dy = endpoint.y - parentCenter.y;
    const endSide =
      Math.abs(dx) > Math.abs(dy)
        ? dx >= 0
          ? ('left' as const)
          : ('right' as const)
        : dy >= 0
          ? ('top' as const)
          : ('bottom' as const);

    const z = Math.max(0.01, this.camera.zoom || 1);
    const arrowHeadLen = 12 / z;
    const arrowHalfW = 6 / z;

    const ctx = this.ctx;
    const router = getEdgeRouter(this.edgeRouterId);
    const routeStyle = {
      arrowHeadLength: arrowHeadLen,
      controlPointMin: 40 / z,
      controlPointMax: 200 / z,
      straightAlignThreshold: 4 / z,
    };
    const route = router.route({
      parent: { id: parent.id, rect: parent.rect },
      child: { id: '__text-annotation-preview__', rect: { x: endpoint.x, y: endpoint.y, w: 1, h: 1 } },
      style: routeStyle,
      anchors: { end: { side: endSide, point: endpoint } },
    });
    if (!route) return;

    ctx.save();
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = this.replyArrowColor;
    ctx.fillStyle = this.replyArrowColor;
    ctx.globalAlpha = this.replyArrowOpacity;

    const polylineEndDir = (pts: Vec2[]): Vec2 | null => {
      for (let i = pts.length - 1; i >= 1; i--) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.hypot(dx, dy) > 0.001) return { x: dx, y: dy };
      }
      return null;
    };

    const drawRoute = (r: EdgeRoute): { end: Vec2; endDir: Vec2 } | null => {
      if (r.kind === 'polyline') {
        const pts = r.points;
        if (pts.length < 2) return null;
        const endDir = polylineEndDir(pts);
        if (!endDir) return null;
        const end = pts[pts.length - 1]!;

        ctx.beginPath();
        ctx.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
        ctx.stroke();
        return { end, endDir };
      }

      const endDir: Vec2 = { x: r.p3.x - r.c2.x, y: r.p3.y - r.c2.y };
      if (Math.hypot(endDir.x, endDir.y) <= 0.001) return null;
      ctx.beginPath();
      ctx.moveTo(r.p0.x, r.p0.y);
      ctx.bezierCurveTo(r.c1.x, r.c1.y, r.c2.x, r.c2.y, r.p3.x, r.p3.y);
      ctx.stroke();
      return { end: r.p3, endDir };
    };

    const drawn = drawRoute(route);
    if (drawn) {
      const endX = drawn.end.x;
      const endY = drawn.end.y;

      const dx = drawn.endDir.x;
      const dy = drawn.endDir.y;
      const len = Math.hypot(dx, dy);
      if (len > 0.001) {
        const ux = dx / len;
        const uy = dy / len;
        const px = -uy;
        const py = ux;

        const baseAnchor = route.arrow?.anchor === 'base';
        const baseX = baseAnchor ? endX : endX - ux * arrowHeadLen;
        const baseY = baseAnchor ? endY : endY - uy * arrowHeadLen;
        const tipX = baseAnchor ? endX + ux * arrowHeadLen : endX;
        const tipY = baseAnchor ? endY + uy * arrowHeadLen : endY;

        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseX + px * arrowHalfW, baseY + py * arrowHalfW);
        ctx.lineTo(baseX - px * arrowHalfW, baseY - py * arrowHalfW);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private drawTextAnnotationOutlinePreview(): void {
    const placement = this.textAnnotationPlacement;
    const rect = placement?.outlineRect ?? null;
    if (!placement || !rect) return;

    const ctx = this.ctx;
    const z = Math.max(0.01, this.camera.zoom || 1);
    const stroke = placement.kind === 'ink' ? 'rgba(167,139,250,0.92)' : 'rgba(147,197,253,0.92)';
    const fill = placement.kind === 'ink' ? 'rgba(167,139,250,0.10)' : 'rgba(147,197,253,0.10)';

    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2 / z;
    ctx.setLineDash([7 / z, 5 / z]);

    const { x, y, w, h } = rect;
    const r = Math.min(18, w * 0.5, h * 0.5);
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
    ctx.restore();

    this.drawResizeHandles(rect, { fillStyle: stroke });
  }

  private drawPdfAnnotationPlacementPreview(): void {
    const placement = this.pdfAnnotationPlacement;
    if (!placement) return;

    const endpoint = (() => {
      const g = this.activeGesture;
      if (g && g.kind === 'spawn-by-draw' && g.pdfAnnotation) return g.currentWorld;
      return placement.hoverWorld;
    })();
    if (!endpoint) return;

    const pdfNode = this.nodes.find((n): n is PdfNode => n.kind === 'pdf' && n.id === placement.pdfNodeId) ?? null;
    if (!pdfNode || pdfNode.status !== 'ready') return;
    const state = this.pdfStateByNodeId.get(pdfNode.id);
    if (!state) return;
    const pageRect = this.getPdfPageRect(pdfNode, state, placement.anchor.pageNumber);
    if (!pageRect) return;

    const anchorY = pageRect.y + clamp(placement.anchor.yPct, 0, 1) * pageRect.h;
    const leftX = pageRect.x;
    const rightX = pageRect.x + pageRect.w;
    const startSide = Math.abs(endpoint.x - rightX) < Math.abs(endpoint.x - leftX) ? ('right' as const) : ('left' as const);
    const start: Vec2 = { x: startSide === 'right' ? rightX : leftX, y: anchorY };

    const dx = endpoint.x - start.x;
    const dy = endpoint.y - start.y;
    const endSide =
      Math.abs(dx) > Math.abs(dy)
        ? dx >= 0
          ? ('left' as const)
          : ('right' as const)
        : dy >= 0
          ? ('top' as const)
          : ('bottom' as const);

    const z = Math.max(0.01, this.camera.zoom || 1);
    const arrowHeadLen = 12 / z;
    const arrowHalfW = 6 / z;

    const ctx = this.ctx;
    const router = getEdgeRouter(this.edgeRouterId);
    const routeStyle = {
      arrowHeadLength: arrowHeadLen,
      controlPointMin: 40 / z,
      controlPointMax: 200 / z,
      straightAlignThreshold: 4 / z,
    };
    const route = router.route({
      parent: { id: pdfNode.id, rect: pdfNode.rect },
      child: { id: '__pdf-annotation-preview__', rect: { x: endpoint.x, y: endpoint.y, w: 1, h: 1 } },
      style: routeStyle,
      anchors: { start: { side: startSide, point: start }, end: { side: endSide, point: endpoint } },
    });
    if (!route) return;

    ctx.save();
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = this.replyArrowColor;
    ctx.fillStyle = this.replyArrowColor;
    ctx.globalAlpha = this.replyArrowOpacity;

    const polylineEndDir = (pts: Vec2[]): Vec2 | null => {
      for (let i = pts.length - 1; i >= 1; i--) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.hypot(dx, dy) > 0.001) return { x: dx, y: dy };
      }
      return null;
    };

    const drawRoute = (r: EdgeRoute): { end: Vec2; endDir: Vec2 } | null => {
      if (r.kind === 'polyline') {
        const pts = r.points;
        if (pts.length < 2) return null;
        const endDir = polylineEndDir(pts);
        if (!endDir) return null;
        const end = pts[pts.length - 1]!;

        ctx.beginPath();
        ctx.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
        ctx.stroke();
        return { end, endDir };
      }

      const endDir: Vec2 = { x: r.p3.x - r.c2.x, y: r.p3.y - r.c2.y };
      if (Math.hypot(endDir.x, endDir.y) <= 0.001) return null;
      ctx.beginPath();
      ctx.moveTo(r.p0.x, r.p0.y);
      ctx.bezierCurveTo(r.c1.x, r.c1.y, r.c2.x, r.c2.y, r.p3.x, r.p3.y);
      ctx.stroke();
      return { end: r.p3, endDir };
    };

    const drawn = drawRoute(route);
    if (drawn) {
      const endX = drawn.end.x;
      const endY = drawn.end.y;

      const dx = drawn.endDir.x;
      const dy = drawn.endDir.y;
      const len = Math.hypot(dx, dy);
      if (len > 0.001) {
        const ux = dx / len;
        const uy = dy / len;
        const px = -uy;
        const py = ux;

        const baseAnchor = route.arrow?.anchor === 'base';
        const baseX = baseAnchor ? endX : endX - ux * arrowHeadLen;
        const baseY = baseAnchor ? endY : endY - uy * arrowHeadLen;
        const tipX = baseAnchor ? endX + ux * arrowHeadLen : endX;
        const tipY = baseAnchor ? endY + uy * arrowHeadLen : endY;

        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseX + px * arrowHalfW, baseY + py * arrowHalfW);
        ctx.lineTo(baseX - px * arrowHalfW, baseY - py * arrowHalfW);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private drawPdfAnnotationOutlinePreview(): void {
    const placement = this.pdfAnnotationPlacement;
    const rect = placement?.outlineRect ?? null;
    if (!placement || !rect) return;

    const ctx = this.ctx;
    const z = Math.max(0.01, this.camera.zoom || 1);
    const stroke = placement.kind === 'ink' ? 'rgba(167,139,250,0.92)' : 'rgba(147,197,253,0.92)';
    const fill = placement.kind === 'ink' ? 'rgba(167,139,250,0.10)' : 'rgba(147,197,253,0.10)';

    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2 / z;
    ctx.setLineDash([7 / z, 5 / z]);

    const { x, y, w, h } = rect;
    const r = Math.min(18, w * 0.5, h * 0.5);
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
    ctx.restore();

    this.drawResizeHandles(rect, { fillStyle: stroke });
  }

  private drawWorldInk(): void {
    const ctx = this.ctx;
    const g = this.activeGesture;
    const hasInProgress = g?.kind === 'ink-world';
    if (this.worldInkStrokes.length === 0 && !hasInProgress) return;

    ctx.save();
    for (const s of this.worldInkStrokes) this.drawInkStroke(ctx, s);
    if (hasInProgress && g) this.drawInkStroke(ctx, g.stroke);
    ctx.restore();
  }

  private drawSpawnByDrawPreview(): void {
    const g = this.activeGesture;
    if (!g || g.kind !== 'spawn-by-draw' || !g.hasDrag) return;

    const rect = this.rectFromWorldDrag(
      g.startWorld,
      g.currentWorld,
      g.spawn.kind === 'ink' ? { maxW: INK_NODE_MAX_W_PX, maxH: INK_NODE_MAX_H_PX } : undefined,
    );
    if (!rect) return;

    const ctx = this.ctx;
    const z = Math.max(0.01, this.camera.zoom || 1);
    const stroke = g.spawn.kind === 'ink' ? 'rgba(167,139,250,0.92)' : 'rgba(147,197,253,0.92)';
    const fill = g.spawn.kind === 'ink' ? 'rgba(167,139,250,0.10)' : 'rgba(147,197,253,0.10)';

    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2 / z;
    ctx.setLineDash([7 / z, 5 / z]);

    const { x, y, w, h } = rect;
    const r = Math.min(18, w * 0.5, h * 0.5);
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
    ctx.restore();
  }

  private drawResizeHandles(rect: Rect, opts?: { fillStyle?: string }): void {
    const ctx = this.ctx;
    const z = Math.max(0.01, this.camera.zoom || 1);
    const size = this.resizeHandleDrawPx / z;
    if (size <= 0) return;

    const pad = 2 / z;
    const x0 = rect.x + pad;
    const y0 = rect.y + pad;
    const x1 = rect.x + rect.w - size - pad;
    const y1 = rect.y + rect.h - size - pad;

    ctx.fillStyle = opts?.fillStyle ?? 'rgba(147,197,253,0.85)';
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

  draw(): void {
    const nextTextLod2Target = this.computeTextLod2Target();
    this.textLod2Target = nextTextLod2Target;
    const nextTextStreamLod2Target = this.computeTextStreamLod2Target(nextTextLod2Target);
    this.textStreamLod2Target = nextTextStreamLod2Target;
    const nextPdfLod2Target = this.computePdfLod2Target();
    this.pdfLod2Target = nextPdfLod2Target;

    const ctx = this.ctx;
    this.applyScreenTransform();
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.drawBackground();
    this.drawNodeGlassUnderlays();

    this.applyWorldTransform();
    this.drawGrid();
    this.drawParentArrows();
    this.updateTextRastersForViewport();
    this.updatePdfPageRendersForViewport();
    this.drawDemoNodes();
    this.drawWorldInk();
    this.drawSpawnByDrawPreview();
    this.drawTextAnnotationOutlinePreview();
    this.drawTextAnnotationPlacementPreview();
    this.drawPdfAnnotationOutlinePreview();
    this.drawPdfAnnotationPlacementPreview();
    this.renderTextStreamLod2Target(nextTextStreamLod2Target);
    this.renderTextLod2Target(nextTextLod2Target);
    this.renderPdfTextLod2Target(nextPdfLod2Target);
    this.emitDebug();
  }
}
