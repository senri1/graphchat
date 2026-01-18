import { chooseNiceStep, clamp } from './math';
import { Camera } from './Camera';
import { InputController, type PointerCaptureMode } from './InputController';
import { rectsIntersect, type Rect, type Vec2 } from './types';
import { rasterizeMarkdownMathToImage } from './raster/textRaster';
import { renderMarkdownMath } from '../markdown/renderMarkdownMath';
import { normalizeMathDelimitersFromCopyTex } from '../markdown/mathDelimiters';
import { TextLod2Overlay, type HighlightRect, type TextLod2Mode } from './TextLod2Overlay';
import { PdfTextLod2Overlay, type HighlightRect as PdfHighlightRect } from './PdfTextLod2Overlay';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { loadPdfDocument } from './pdf/pdfjs';

export type WorldEngineDebug = {
  cssW: number;
  cssH: number;
  dpr: number;
  cameraX: number;
  cameraY: number;
  zoom: number;
  interacting: boolean;
};

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
};

type TextNode = DemoNodeBase & {
  kind: 'text';
  rect: Rect;
  content: string;
  contentHash: string;
};

type PdfNode = DemoNodeBase & {
  kind: 'pdf';
  rect: Rect;
  fileName: string | null;
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
  source: string;
};

type PdfPageMeta = {
  pageNumber: number;
  viewportW: number;
  viewportH: number;
  aspect: number;
};

type PdfNodeState = {
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
  renderDpi: number;
};

export type WorldEngineUiState = {
  selectedNodeId: string | null;
  editingNodeId: string | null;
  editingText: string;
  tool: Tool;
};

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

type Tool = 'select' | 'draw';

type InkPoint = { x: number; y: number };

type InkStroke = {
  points: InkPoint[];
  width: number;
  color: string;
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

type ActiveGesture = ActiveNodeGesture | ActiveInkGesture | ActiveTextSelectGesture | ActivePdfTextSelectGesture;

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

  onUiState?: (state: WorldEngineUiState) => void;

  private selectedNodeId: string | null = 'n1';
  private editingNodeId: string | null = null;
  private tool: Tool = 'select';
  private activeGesture: ActiveGesture | null = null;
  private suppressTapPointerIds = new Set<number>();

  private readonly overlayHost: HTMLElement | null;
  private textLod2: TextLod2Overlay | null = null;
  private textLod2Target: { nodeId: string; mode: TextLod2Mode } | null = null;
  private textResizeHold: { nodeId: string; sig: string; expiresAt: number } | null = null;

  private textSelectNodeId: string | null = null;
  private textSelectPointerId: number | null = null;
  private textSelectAnchor: Range | null = null;
  private textSelectRange: Range | null = null;
  private textSelectLastClient: { x: number; y: number } | null = null;
  private textSelectRaf: number | null = null;

  private hoverTextNodeId: string | null = null;
  private hoverPdfPage: { nodeId: string; token: number; pageNumber: number } | null = null;

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
  private readonly minNodeW = 160;
  private readonly minNodeH = 110;

  private lastTapAt = 0;
  private lastTapPos: Vec2 | null = null;
  private lastTapNodeId: string | null = null;

  private readonly textRasterQueueByNodeId = new Map<string, TextRasterJob>();
  private textRasterRunning = false;
  private textRasterGeneration = 0;

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
  private readonly pdfRenderDpi = 2;

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

  private worldInkStrokes: InkStroke[] = [];

  private readonly nodes: WorldNode[] = [
    {
      kind: 'text',
      id: 'n1',
      rect: { x: 80, y: 80, w: 420, h: 260 },
      title: 'Text node (Markdown + LaTeX)',
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
    },
    {
      kind: 'pdf',
      id: 'n2',
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
      rect: { x: 240, y: 390, w: 360, h: 240 },
      title: 'Ink node (vector → bitmap)',
      strokes: [],
      raster: null,
    },
  ];

  private nodeSeq = 1;

  constructor(opts: { canvas: HTMLCanvasElement; overlayHost?: HTMLElement | null }) {
    this.canvas = opts.canvas;
    this.overlayHost = opts.overlayHost ?? this.canvas.parentElement;
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Missing 2D canvas context');
    this.ctx = ctx;

    const inputEl = this.canvas.parentElement ?? this.canvas;
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
    });

    // Initialize hashes for seeded nodes.
    for (const n of this.nodes) {
      if (n.kind === 'text') n.contentHash = fingerprintText(n.content);
    }
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

    const seeded = this.nodes.find((node): node is TextNode => node.kind === 'text' && node.id === 'n1');
    const content = seeded?.content ?? '';

    for (let i = 0; i < n; i++) {
      const id = `t${Date.now().toString(36)}-${(this.nodeSeq++).toString(36)}`;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const node: TextNode = {
        kind: 'text',
        id,
        rect: { x: startX + col * spacingX, y: startY + row * spacingY, w: nodeW, h: nodeH },
        title: 'Text node (Markdown + LaTeX)',
        content,
        contentHash: fingerprintText(content),
      };
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
    const keepIds = new Set(['n1', 'n2', 'n3']);
    const before = this.nodes.length;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i]!;
      if (keepIds.has(node.id)) continue;
      if (node.kind === 'pdf') this.disposePdfNode(node.id);
      this.nodes.splice(i, 1);
    }
    this.worldInkStrokes = [];
    const baseInk = this.nodes.find((n): n is InkNode => n.kind === 'ink' && n.id === 'n3');
    if (baseInk) {
      baseInk.strokes = [];
      baseInk.raster = null;
    }
    this.selectedNodeId = 'n1';
    this.editingNodeId = null;
    this.tool = 'select';
    this.requestRender();
    this.emitUiState();
  }

  setTool(tool: Tool): void {
    const next = tool === 'draw' ? 'draw' : 'select';
    if (this.tool === next) return;
    this.tool = next;
    this.requestRender();
    this.emitUiState();
  }

  spawnInkNode(): void {
    const id = `i${Date.now().toString(36)}-${(this.nodeSeq++).toString(36)}`;
    const center = this.camera.screenToWorld({ x: this.cssW * 0.5, y: this.cssH * 0.5 });
    const nodeW = 420;
    const nodeH = 280;
    const node: InkNode = {
      kind: 'ink',
      id,
      rect: { x: center.x - nodeW * 0.5, y: center.y - nodeH * 0.5, w: nodeW, h: nodeH },
      title: 'Ink node',
      strokes: [],
      raster: null,
    };
    this.nodes.push(node);
    const changed = this.selectedNodeId !== id || this.editingNodeId !== null;
    this.selectedNodeId = id;
    this.editingNodeId = null;
    this.bringNodeToFront(id);
    this.requestRender();
    if (changed) this.emitUiState();
  }

  clearWorldInk(): void {
    if (this.worldInkStrokes.length === 0) return;
    this.worldInkStrokes = [];
    this.requestRender();
  }

  async importPdfFromFile(file: File): Promise<void> {
    const f = file;
    if (!f) return;

    const id = `p${Date.now().toString(36)}-${(this.nodeSeq++).toString(36)}`;
    const center = this.camera.screenToWorld({ x: this.cssW * 0.5, y: this.cssH * 0.5 });
    const nodeW = 680;
    const nodeH = 220;
    const node: PdfNode = {
      kind: 'pdf',
      id,
      rect: { x: center.x - nodeW * 0.5, y: center.y - 120, w: nodeW, h: nodeH },
      title: f.name || 'PDF',
      fileName: f.name || null,
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
          const res = await rasterizeMarkdownMathToImage(job.source, {
            width: job.width,
            height: job.height,
            rasterScale: job.rasterScale,
          });
          if (this.textRasterGeneration !== gen) {
            this.closeImage(res.image);
            return;
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

  private getPdfPageFromCache(key: string): CanvasImageSource | null {
    const entry = this.pdfPageCache.get(key);
    if (!entry) return null;
    this.touchPdfPage(key);
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
    const renderScale = (job.pageWorldW * job.renderDpi) / Math.max(1, meta.viewportW);
    const viewport = page.getViewport({ scale: renderScale });

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
    this.pdfLod2Target = null;
    if (this.textLod2) {
      this.textLod2.dispose();
      this.textLod2 = null;
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
    if (this.tool !== 'select') return;

    const t = ev.pointerType || 'mouse';
    if (t !== 'mouse') return;
    if ((ev.buttons ?? 0) !== 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const p: Vec2 = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (p.x < 0 || p.y < 0 || p.x > rect.width || p.y > rect.height) return;

    const world = this.camera.screenToWorld(p);
    const hit = this.findTopmostNodeAtWorld(world);
    let nextTextHover: string | null = null;
    let nextPdfHover: { nodeId: string; token: number; pageNumber: number } | null = null;

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

    const changed = nextTextHover !== this.hoverTextNodeId || nextPdfHover?.pageNumber !== this.hoverPdfPage?.pageNumber || nextPdfHover?.nodeId !== this.hoverPdfPage?.nodeId || nextPdfHover?.token !== this.hoverPdfPage?.token;
    if (changed) {
      this.hoverTextNodeId = nextTextHover;
      this.hoverPdfPage = nextPdfHover;
      this.requestRender();
    }
  };

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

  getNodeScreenRect(nodeId: string): Rect | null {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const tl = this.camera.worldToScreen({ x: node.rect.x, y: node.rect.y });
    const br = this.camera.worldToScreen({ x: node.rect.x + node.rect.w, y: node.rect.y + node.rect.h });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  beginEditingSelectedNode(): void {
    if (this.editingNodeId) return;
    const nodeId = this.selectedNodeId;
    if (!nodeId) return;
    this.beginEditingNode(nodeId);
  }

  beginEditingNode(nodeId: string): void {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== 'text') return;
    const changed = this.editingNodeId !== nodeId || this.selectedNodeId !== nodeId;
    this.selectedNodeId = nodeId;
    this.editingNodeId = nodeId;
    this.bringNodeToFront(nodeId);
    this.requestRender();
    if (changed) this.emitUiState();
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
    this.textRasterGeneration += 1;
    this.requestRender();
    this.emitUiState();
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

  private emitUiState(): void {
    this.onUiState?.(this.getUiState());
  }

  private textContentRect(nodeRect: Rect): Rect {
    const PAD = 14;
    const HEADER_H = 50;
    const x = nodeRect.x + PAD;
    const y = nodeRect.y + HEADER_H;
    const w = Math.max(1, nodeRect.w - PAD * 2);
    const h = Math.max(1, nodeRect.h - HEADER_H - PAD);
    return { x, y, w, h };
  }

  private ensureTextLod2Overlay(): TextLod2Overlay | null {
    if (this.textLod2) return this.textLod2;
    if (typeof document === 'undefined') return null;
    const host = this.overlayHost;
    if (!host) return null;
    this.textLod2 = new TextLod2Overlay({
      host,
      onRequestCloseSelection: () => {
        this.clearTextSelection({ suppressOverlayCallback: true });
        this.requestRender();
      },
    });
    return this.textLod2;
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
      onTextLayerReady: () => {
        if (this.pdfSelectLastClient && this.pdfSelectTarget) this.schedulePdfPenSelectionUpdate();
        this.requestRender();
      },
    });
    return this.pdfTextLod2;
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

  private computeTextLod2Target(): { nodeId: string; mode: TextLod2Mode } | null {
    if (this.editingNodeId) return null;

    const g = this.activeGesture;
    if (g?.kind === 'resize') return { nodeId: g.nodeId, mode: 'resize' };

    if (this.textSelectNodeId) return { nodeId: this.textSelectNodeId, mode: 'select' };

    const overlay = this.textLod2;
    if (overlay?.isMenuOpen()) {
      const nodeId = overlay.getNodeId();
      if (nodeId) return { nodeId, mode: 'select' };
    }

    if (this.hoverTextNodeId) return { nodeId: this.hoverTextNodeId, mode: 'select' };

    const hold = this.textResizeHold;
    if (hold) {
      const now = performance.now();
      const best = this.getBestTextRaster(hold.sig);
      if (best || now > hold.expiresAt) {
        this.textResizeHold = null;
      } else {
        return { nodeId: hold.nodeId, mode: 'resize' };
      }
    }

    return null;
  }

  private computePdfLod2Target(): { nodeId: string; token: number; pageNumber: number } | null {
    if (this.editingNodeId) return null;

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
      return;
    }

    const node = this.nodes.find((n): n is TextNode => n.id === target.nodeId && n.kind === 'text');
    if (!node) {
      if (overlay) overlay.hide();
      return;
    }

    const lod2 = this.ensureTextLod2Overlay();
    if (!lod2) return;

    const contentRect = this.textContentRect(node.rect);
    const tl = this.camera.worldToScreen({ x: contentRect.x, y: contentRect.y });
    const z = Math.max(0.001, this.camera.zoom || 1);
    const screenRect: Rect = { x: tl.x, y: tl.y, w: contentRect.w * z, h: contentRect.h * z };
    const html = renderMarkdownMath(node.content ?? '');
    const interactive = target.mode === 'select' && this.textSelectNodeId !== node.id;
    lod2.show({
      nodeId: node.id,
      mode: target.mode,
      interactive,
      screenRect,
      worldW: contentRect.w,
      worldH: contentRect.h,
      zoom: z,
      contentHash: node.contentHash,
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
    const caret = this.caretRangeFromClientPointForPdfLod2(point.x, point.y);
    if (!caret || !textEl.contains(caret.startContainer)) return;

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

    const scale = this.chooseInkRasterScale();
    const worldW = Math.max(1, contentRect.w);
    const worldH = Math.max(1, contentRect.h);
    const pxW = Math.max(1, Math.round(worldW * scale));
    const pxH = Math.max(1, Math.round(worldH * scale));

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

  private getBestTextRaster(sig: string): { key: string; image: CanvasImageSource } | null {
    const best = this.bestTextRasterKeyBySig.get(sig);
    if (!best) return null;
    const entry = this.textRasterCache.get(best.key);
    if (!entry) {
      this.bestTextRasterKeyBySig.delete(sig);
      return null;
    }
    this.touchTextRaster(best.key);
    return { key: best.key, image: entry.image };
  }

  private updateTextRastersForViewport(): void {
    const view = this.worldViewportRect({ overscan: 320 });
    const desiredScale = this.chooseTextRasterScale();
    const desiredNodeIds = new Set<string>();

    for (const n of this.nodes) {
      if (n.kind !== 'text') continue;
      if (n.id === this.editingNodeId) continue;
      if (!rectsIntersect(n.rect, view)) continue;

      const contentRect = this.textContentRect(n.rect);
      const sig = `${n.contentHash}|${Math.round(contentRect.w)}x${Math.round(contentRect.h)}`;
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
        source: n.content,
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
    const desiredKeys = new Set<string>();

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

        const key = `${node.id}|t${state.token}|p${pageNumber}|w${Math.round(pageW)}|d${this.pdfRenderDpi}`;
        desiredKeys.add(key);

        if (!this.pdfPageCache.has(key)) {
          this.enqueuePdfPageRender({
            nodeId: node.id,
            token: state.token,
            pageNumber,
            key,
            pageWorldW: pageW,
            pageWorldH: pageH,
            renderDpi: this.pdfRenderDpi,
          });
        }
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
    if (t === 'pen') return true;
    return this.tool === 'draw';
  }

  private hitResizeHandle(world: Vec2, rect: Rect): ResizeCorner | null {
    const z = Math.max(0.01, this.camera.zoom || 1);
    const hw = this.resizeHandleHitPx / z;
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
    const hit = this.findTopmostNodeAtWorld(world);

    // Pen drag-to-highlight for text nodes (LOD2 DOM overlay).
    if (hit && hit.kind === 'text' && info.pointerType === 'pen') {
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
    if (hit && hit.kind === 'pdf' && info.pointerType === 'pen' && hit.status === 'ready') {
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

    const corner = hit.kind === 'text' ? this.hitResizeHandle(world, hit.rect) : null;
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
      this.renderTextLod2Target({ nodeId: hit.id, mode: 'resize' });
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

    node.rect = next;
    this.requestRender();
  }

  private handlePointerUp(p: Vec2, info: { pointerType: string; pointerId: number; wasDrag: boolean }): void {
    const g = this.activeGesture;
    if (!g || g.pointerId !== info.pointerId) return;

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
          overlay.openMenu({ anchorRect: rect, text });
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
        const rect = (() => {
          try {
            const rects = Array.from(range.getClientRects());
            return (rects[rects.length - 1] ?? range.getBoundingClientRect()) || null;
          } catch {
            return null;
          }
        })();
        if (rect) {
          overlay.openMenu({ anchorRect: rect, text });
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

    if (g.kind === 'resize') {
      const node = this.nodes.find((n): n is TextNode => n.id === g.nodeId && n.kind === 'text');
      if (node) {
        const contentRect = this.textContentRect(node.rect);
        const sig = `${node.contentHash}|${Math.round(contentRect.w)}x${Math.round(contentRect.h)}`;
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
      this.beginEditingNode(hit.id);
      return;
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
      ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.085)' : 'rgba(255,255,255,0.06)';
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
      ctx.font = `${14 / (this.camera.zoom || 1)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
      ctx.textBaseline = 'top';
      ctx.fillText(node.title, x + 14, y + 12);

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `${12 / (this.camera.zoom || 1)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;

      // Header separator.
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1 / (this.camera.zoom || 1);
      ctx.beginPath();
      ctx.moveTo(x + 12, y + 48);
      ctx.lineTo(x + w - 12, y + 48);
      ctx.stroke();

      if (node.kind === 'text') {
        const contentRect = this.textContentRect(node.rect);

        // When LOD2 is active for this node, the DOM overlay is responsible for the content.
        if (this.textLod2Target?.nodeId !== node.id) {
          const sig = `${node.contentHash}|${Math.round(contentRect.w)}x${Math.round(contentRect.h)}`;
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
            ctx.fillText(preview ? preview : '…', x + 14, y + 34);
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.fillText('Rendering…', contentRect.x, contentRect.y);
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

              const key = `${node.id}|t${state.token}|p${pageNumber}|w${Math.round(pageW)}|d${this.pdfRenderDpi}`;
              const img = this.getPdfPageFromCache(key);
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

        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(contentRect.x, contentRect.y, contentRect.w, contentRect.h);

        const raster = this.ensureInkNodeRaster(node, contentRect);
        if (raster) {
          try {
            ctx.drawImage(raster.canvas, contentRect.x, contentRect.y, contentRect.w, contentRect.h);
          } catch {
            // ignore; fall back to vectors
          }
        }

        if (!raster && node.strokes.length > 0) {
          for (const s of node.strokes) this.drawInkStroke(ctx, s, { offsetX: contentRect.x, offsetY: contentRect.y });
        }

        const g = this.activeGesture;
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

      if (isSelected && node.kind === 'text' && node.id !== this.editingNodeId) this.drawResizeHandles(node.rect);
    }
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

  private drawResizeHandles(rect: Rect): void {
    const ctx = this.ctx;
    const z = Math.max(0.01, this.camera.zoom || 1);
    const size = this.resizeHandleDrawPx / z;
    if (size <= 0) return;

    const pad = 2 / z;
    const x0 = rect.x + pad;
    const y0 = rect.y + pad;
    const x1 = rect.x + rect.w - size - pad;
    const y1 = rect.y + rect.h - size - pad;

    ctx.fillStyle = 'rgba(147,197,253,0.85)';
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

  private drawScreenHud(): void {
    const ctx = this.ctx;
    this.applyScreenTransform();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.textBaseline = 'bottom';
    ctx.fillText(
      `tool: ${this.tool} • ink: pen / Draw tool • pan: drag background • move: drag node • resize: corners • edit: double-click/Enter • zoom: pinch/ctrl+wheel`,
      10,
      this.cssH - 10,
    );
  }

  draw(): void {
    const nextTextLod2Target = this.computeTextLod2Target();
    this.textLod2Target = nextTextLod2Target;
    const nextPdfLod2Target = this.computePdfLod2Target();
    this.pdfLod2Target = nextPdfLod2Target;

    const ctx = this.ctx;
    this.applyScreenTransform();
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    this.applyWorldTransform();
    this.drawGrid();
    this.drawDemoNodes();
    this.drawWorldInk();

    this.updateTextRastersForViewport();
    this.updatePdfPageRendersForViewport();
    this.renderTextLod2Target(nextTextLod2Target);
    this.renderPdfTextLod2Target(nextPdfLod2Target);
    this.drawScreenHud();
    this.emitDebug();
  }
}
