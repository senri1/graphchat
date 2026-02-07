import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listLatexProjectFiles, pickLatexProject, readLatexProjectFile, type LatexProjectFile, writeLatexProjectFile } from '../latex/project';
import { synctexForward, synctexInverse } from '../latex/synctex';
import type { Rect } from '../engine/types';
import LatexPdfPreview from './LatexPdfPreview';

type LatexProjectState = {
  projectRoot: string | null;
  mainFile: string | null;
  activeFile: string | null;
};

type Props = {
  nodeId: string;
  title: string | null;
  initialValue: string;
  anchorRect: Rect | null;
  getScreenRect?: () => Rect | null;
  getZoom?: () => number;
  viewport: { w: number; h: number };
  zoom: number;
  baseFontSizePx: number;
  compiledPdfUrl: string | null;
  compileError: string | null;
  compileLog: string | null;
  compiledAt: number | null;
  latexProject: LatexProjectState | null;
  onDraftChange?: (next: string) => void;
  onProjectStateChange?: (patch: {
    projectRoot?: string | null;
    mainFile?: string | null;
    activeFile?: string | null;
    content?: string;
  }) => void | Promise<void>;
  onResize: (nextRect: Rect) => void;
  onResizeEnd: () => void;
  onCommit: (next: string) => void;
  onCancel: () => void;
  onCompile: (req: { source: string; projectRoot?: string | null; mainFile?: string | null }) => Promise<void>;
};

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

type ProjectTreeNode = ProjectTreeDirNode | ProjectTreeFileNode;
type ProjectTreeDirNode = { kind: 'dir'; name: string; path: string; children: ProjectTreeNode[] };
type ProjectTreeFileNode = { kind: 'file'; file: LatexProjectFile };

type CompileDiagnostic = {
  key: string;
  fileRaw: string;
  filePath: string | null;
  line: number;
  message: string;
};

const PDF_ZOOM_MIN = 0.35;
const PDF_ZOOM_MAX = 4;
const PDF_ZOOM_STEP = 0.1;

function normalizePathLike(value: string): string {
  return String(value ?? '').replace(/\\/g, '/');
}

function baseName(filePath: string): string {
  const normalized = normalizePathLike(filePath);
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function lineOffsetFromOneBased(text: string, lineRaw: number): number {
  const line = Math.max(1, Math.floor(Number.isFinite(lineRaw) ? lineRaw : 1));
  if (!text) return 0;
  let offset = 0;
  let current = 1;
  while (current < line && offset < text.length) {
    const nl = text.indexOf('\n', offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
    current += 1;
  }
  return offset;
}

function buildExpandedDirs(files: LatexProjectFile[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const file of files) {
    const segments = String(file.path ?? '').split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < segments.length - 1; i += 1) {
      acc = acc ? `${acc}/${segments[i]}` : segments[i];
      out[acc] = true;
    }
  }
  return out;
}

function sortTreeChildren(children: ProjectTreeNode[]): ProjectTreeNode[] {
  return [...children].sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1;
    if (a.kind !== 'dir' && b.kind === 'dir') return 1;
    if (a.kind === 'dir' && b.kind === 'dir') return a.name.localeCompare(b.name);
    if (a.kind === 'file' && b.kind === 'file') return a.file.path.localeCompare(b.file.path);
    return 0;
  });
}

function buildProjectTree(files: LatexProjectFile[]): ProjectTreeDirNode {
  const root: ProjectTreeDirNode = { kind: 'dir', name: '', path: '', children: [] };
  const byPath = new Map<string, ProjectTreeDirNode>();
  byPath.set('', root);

  const sorted = [...files].sort((a, b) => String(a.path ?? '').localeCompare(String(b.path ?? '')));
  for (const file of sorted) {
    const filePath = String(file.path ?? '').trim();
    if (!filePath) continue;
    const parts = filePath.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let parentPath = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      const dirPath = parentPath ? `${parentPath}/${seg}` : seg;
      let dir = byPath.get(dirPath);
      if (!dir) {
        dir = { kind: 'dir', name: seg, path: dirPath, children: [] };
        byPath.set(dirPath, dir);
        const parent = byPath.get(parentPath);
        if (parent) parent.children.push(dir);
      }
      parentPath = dirPath;
    }

    const parent = byPath.get(parentPath) ?? root;
    parent.children.push({ kind: 'file', file });
  }

  const visit = (node: ProjectTreeDirNode): ProjectTreeDirNode => ({
    ...node,
    children: sortTreeChildren(
      node.children.map((child) => (child.kind === 'dir' ? visit(child) : child)),
    ),
  });
  return visit(root);
}

function filterProjectTree(root: ProjectTreeDirNode, queryRaw: string): ProjectTreeDirNode | null {
  const query = String(queryRaw ?? '').trim().toLowerCase();
  if (!query) return root;

  const matchFile = (f: LatexProjectFile): boolean => {
    const path = String(f.path ?? '').toLowerCase();
    const bn = baseName(path);
    const kind = String(f.kind ?? '').toLowerCase();
    return path.includes(query) || bn.includes(query) || kind.includes(query);
  };

  const visit = (node: ProjectTreeDirNode): ProjectTreeDirNode | null => {
    const nameMatch = String(node.name ?? '').toLowerCase().includes(query);
    if (nameMatch) return node;

    const nextChildren: ProjectTreeNode[] = [];
    for (const child of node.children) {
      if (child.kind === 'dir') {
        const next = visit(child);
        if (next) nextChildren.push(next);
        continue;
      }
      if (matchFile(child.file)) nextChildren.push(child);
    }
    if (nextChildren.length === 0) return null;
    return { ...node, children: nextChildren };
  };

  return visit(root);
}

export default function LatexNodeEditor(props: Props) {
  const {
    nodeId,
    title,
    initialValue,
    anchorRect,
    getScreenRect,
    getZoom,
    viewport,
    zoom,
    baseFontSizePx,
    compiledPdfUrl,
    compileError,
    compileLog,
    compiledAt,
    latexProject,
    onDraftChange,
    onProjectStateChange,
    onResize,
    onResizeEnd,
    onCommit,
    onCancel,
    onCompile,
  } = props;

  const [draft, setDraft] = useState(() => initialValue ?? '');
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [mainFile, setMainFile] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [projectFiles, setProjectFiles] = useState<LatexProjectFile[]>([]);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [runtimeCompileError, setRuntimeCompileError] = useState<string | null>(null);
  const [treeQuery, setTreeQuery] = useState('');
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [treeVisible, setTreeVisible] = useState(true);
  const [isSyncingPdf, setIsSyncingPdf] = useState(false);
  const [pdfSyncTarget, setPdfSyncTarget] = useState<{ token: number; page: number; x?: number | null; y?: number | null } | null>(null);
  const [pdfZoom, setPdfZoom] = useState(1);
  const [logVisible, setLogVisible] = useState(false);
  const [logCollapsed, setLogCollapsed] = useState(false);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(draft);
  const projectRootRef = useRef<string | null>(null);
  const mainFileRef = useRef<string | null>(null);
  const activeFileRef = useRef<string | null>(null);
  const lastCompileLogRef = useRef<string | null>(null);
  const syncTokenRef = useRef(0);
  const onProjectStateChangeRef = useRef<Props['onProjectStateChange']>(onProjectStateChange);
  const loadTicketRef = useRef(0);
  const anchorRectRef = useRef<Rect | null>(anchorRect ?? null);
  const onCommitRef = useRef(onCommit);
  const onCancelRef = useRef(onCancel);
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  const onCompileRef = useRef(onCompile);
  const onDraftChangeRef = useRef<Props['onDraftChange']>(onDraftChange);
  const getScreenRectRef = useRef<Props['getScreenRect']>(getScreenRect);
  const getZoomRef = useRef<Props['getZoom']>(getZoom);
  const resizeRef = useRef<{
    pointerId: number;
    corner: ResizeCorner;
    startClient: { x: number; y: number };
    startRect: Rect;
  } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClient: { x: number; y: number };
    startRect: Rect;
  } | null>(null);

  const [liveRect, setLiveRect] = useState<Rect | null>(() => anchorRect ?? null);
  const liveRectRef = useRef<Rect | null>(anchorRect ?? null);

  const projectFileByPath = useMemo(() => new Map(projectFiles.map((f) => [f.path, f] as const)), [projectFiles]);
  const editableProjectFiles = useMemo(() => projectFiles.filter((f) => f.editable), [projectFiles]);
  const projectTree = useMemo(() => buildProjectTree(projectFiles), [projectFiles]);
  const filteredProjectTree = useMemo(() => filterProjectTree(projectTree, treeQuery), [projectTree, treeQuery]);

  const selectedTreeFile =
    selectedTreePath && projectFileByPath.has(selectedTreePath) ? projectFileByPath.get(selectedTreePath) ?? null : null;
  const selectedReadOnlyFile = selectedTreeFile && !selectedTreeFile.editable ? selectedTreeFile : null;

  const applyDraft = useCallback((next: string) => {
    const text = typeof next === 'string' ? next : String(next ?? '');
    setDraft(text);
    draftRef.current = text;
    onDraftChangeRef.current?.(text);
  }, []);

  const jumpToLineInTextarea = useCallback((lineRaw: number) => {
    const el = taRef.current;
    if (!el) return;
    const text = draftRef.current;
    const offset = lineOffsetFromOneBased(text, lineRaw);
    el.focus();
    try {
      el.setSelectionRange(offset, offset);
    } catch {
      // ignore
    }

    const before = text.slice(0, offset);
    const row = Math.max(0, before.split('\n').length - 1);
    const cs = getComputedStyle(el);
    const lineHeight = Number.parseFloat(cs.lineHeight || '') || 18;
    el.scrollTop = Math.max(0, row * lineHeight - el.clientHeight * 0.33);
  }, []);

  useEffect(() => {
    onCommitRef.current = onCommit;
    onCancelRef.current = onCancel;
    onResizeRef.current = onResize;
    onResizeEndRef.current = onResizeEnd;
    onCompileRef.current = onCompile;
    onDraftChangeRef.current = onDraftChange;
    onProjectStateChangeRef.current = onProjectStateChange;
  }, [onCancel, onCommit, onCompile, onDraftChange, onProjectStateChange, onResize, onResizeEnd]);

  useEffect(() => {
    getScreenRectRef.current = getScreenRect;
  }, [getScreenRect]);

  useEffect(() => {
    getZoomRef.current = getZoom;
  }, [getZoom]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    liveRectRef.current = liveRect ?? null;
  }, [liveRect]);

  useEffect(() => {
    projectRootRef.current = projectRoot;
    mainFileRef.current = mainFile;
    activeFileRef.current = activeFile;
  }, [activeFile, mainFile, projectRoot]);

  useEffect(() => {
    const nextLog = typeof compileLog === 'string' && compileLog.trim() ? compileLog : null;
    if (!nextLog) {
      lastCompileLogRef.current = null;
      setLogVisible(false);
      setLogCollapsed(false);
      return;
    }
    if (lastCompileLogRef.current !== nextLog) {
      lastCompileLogRef.current = nextLog;
      setLogVisible(true);
      setLogCollapsed(false);
    }
  }, [compileLog]);

  useEffect(() => {
    if (compiledPdfUrl) return;
    setPdfSyncTarget(null);
  }, [compiledPdfUrl]);

  const persistProjectState = useCallback(
    async (patch: { projectRoot?: string | null; mainFile?: string | null; activeFile?: string | null; content?: string }) => {
      try {
        await onProjectStateChangeRef.current?.(patch);
      } catch {
        // ignore
      }
    },
    [],
  );

  const refreshProject = useCallback(
    async (
      rootRaw: string,
      preferredMainRaw?: string | null,
      preferredActiveRaw?: string | null,
      opts?: { persist?: boolean; fallbackContent?: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      const root = typeof rootRaw === 'string' ? rootRaw.trim() : '';
      if (!root) {
        setProjectRoot(null);
        setMainFile(null);
        setActiveFile(null);
        setProjectFiles([]);
        setProjectError(null);
        setProjectBusy(false);
        setIsDirty(false);
        setTreeQuery('');
        setExpandedDirs({});
        setSelectedTreePath(null);
        setTreeVisible(true);
        setIsSyncingPdf(false);
        setPdfSyncTarget(null);
        return { ok: false, error: 'Project root is missing.' };
      }

      const ticket = ++loadTicketRef.current;
      setProjectBusy(true);
      setProjectError(null);

      try {
        const indexRes = await listLatexProjectFiles(root);
        if (!indexRes.ok || !indexRes.index) {
          const msg = (indexRes.error ?? 'Failed to load project files.').trim();
          throw new Error(msg || 'Failed to load project files.');
        }
        if (ticket !== loadTicketRef.current) return { ok: false, error: 'stale' };

        const files = Array.isArray(indexRes.index.files) ? indexRes.index.files : [];
        const editablePaths = new Set(files.filter((f) => f.editable).map((f) => f.path));
        const texPaths = files.filter((f) => f.editable && f.kind === 'tex').map((f) => f.path);

        const preferredMain = typeof preferredMainRaw === 'string' ? preferredMainRaw.trim() : '';
        const preferredActive = typeof preferredActiveRaw === 'string' ? preferredActiveRaw.trim() : '';
        const suggestedMain = typeof indexRes.index.suggestedMainFile === 'string' ? indexRes.index.suggestedMainFile.trim() : '';

        let nextMain = preferredMain && editablePaths.has(preferredMain) ? preferredMain : null;
        if (!nextMain && suggestedMain && editablePaths.has(suggestedMain)) nextMain = suggestedMain;
        if (!nextMain && texPaths.length > 0) nextMain = texPaths[0];

        let nextActive = preferredActive && editablePaths.has(preferredActive) ? preferredActive : null;
        if (!nextActive && nextMain && editablePaths.has(nextMain)) nextActive = nextMain;
        if (!nextActive) {
          const firstEditable = files.find((f) => f.editable);
          nextActive = firstEditable ? firstEditable.path : null;
        }

        let loadedContent = typeof opts?.fallbackContent === 'string' ? opts.fallbackContent : initialValue ?? '';
        if (nextActive) {
          const fileRes = await readLatexProjectFile(root, nextActive);
          if (!fileRes.ok) throw new Error((fileRes.error ?? 'Failed to open file.').trim() || 'Failed to open file.');
          if (ticket !== loadTicketRef.current) return { ok: false, error: 'stale' };
          loadedContent = typeof fileRes.content === 'string' ? fileRes.content : '';
        }

        setProjectRoot(root);
        setMainFile(nextMain);
        setActiveFile(nextActive);
        setProjectFiles(files);
        setExpandedDirs(buildExpandedDirs(files));
        setTreeQuery('');
        setSelectedTreePath(nextActive ?? (files[0]?.path ?? null));
        setTreeVisible(true);
        setIsSyncingPdf(false);
        setProjectError(null);
        setIsDirty(false);
        applyDraft(loadedContent);

        if (opts?.persist !== false) {
          try {
            await onProjectStateChangeRef.current?.({
              projectRoot: root,
              mainFile: nextMain,
              activeFile: nextActive,
              content: loadedContent,
            });
          } catch {
            // ignore
          }
        }

        return { ok: true };
      } catch (err: any) {
        if (ticket !== loadTicketRef.current) return { ok: false, error: 'stale' };
        const msg = err ? String(err?.message ?? err) : 'Failed to load project files.';
        setProjectError(msg);
        return { ok: false, error: msg };
      } finally {
        if (ticket === loadTicketRef.current) setProjectBusy(false);
      }
    },
    [applyDraft, initialValue],
  );

  useEffect(() => {
    setRuntimeCompileError(null);
    setIsCompiling(false);
    setIsSavingFile(false);

    const root = typeof latexProject?.projectRoot === 'string' ? latexProject.projectRoot.trim() : '';
    const nextMain = typeof latexProject?.mainFile === 'string' ? latexProject.mainFile.trim() : '';
    const nextActive = typeof latexProject?.activeFile === 'string' ? latexProject.activeFile.trim() : '';

    if (root) {
      void refreshProject(root, nextMain || null, nextActive || null, {
        persist: false,
        fallbackContent: initialValue ?? '',
      });
    } else {
      loadTicketRef.current += 1;
      setProjectRoot(null);
      setMainFile(null);
      setActiveFile(null);
      setProjectFiles([]);
      setProjectBusy(false);
      setProjectError(null);
      setIsDirty(false);
      setTreeQuery('');
      setExpandedDirs({});
      setSelectedTreePath(null);
      setTreeVisible(true);
      setIsSyncingPdf(false);
      setPdfSyncTarget(null);
      applyDraft(initialValue ?? '');
    }

    const raf = requestAnimationFrame(() => taRef.current?.focus());
    return () => {
      loadTicketRef.current += 1;
      cancelAnimationFrame(raf);
    };
  }, [
    applyDraft,
    initialValue,
    latexProject?.activeFile,
    latexProject?.mainFile,
    latexProject?.projectRoot,
    nodeId,
    refreshProject,
  ]);

  useEffect(() => {
    if (resizeRef.current || dragRef.current) return;
    setLiveRect(anchorRect ?? null);
    anchorRectRef.current = anchorRect ?? null;
  }, [anchorRect?.x, anchorRect?.y, anchorRect?.w, anchorRect?.h, nodeId]);

  const followEnabled = typeof getScreenRect === 'function';
  const applyFollowRectToElement = useCallback((rect: Rect | null) => {
    const el = rootRef.current;
    if (!el || !rect) return;

    const rawZoom = getZoomRef.current?.();
    const zNow = Math.max(0.001, Number.isFinite(rawZoom as number) ? Number(rawZoom) : 1);
    const screenW = Math.max(1, Number(rect.w));
    const screenH = Math.max(1, Number(rect.h));
    const unscaledW = Math.max(1, screenW / zNow);
    const unscaledH = Math.max(1, screenH / zNow);

    el.style.setProperty('--editor-scale', '1');
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0) scale(${zNow})`;
    el.style.width = `${unscaledW}px`;
    el.style.height = `${unscaledH}px`;
  }, []);

  useEffect(() => {
    if (!followEnabled) return;
    let raf = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      raf = requestAnimationFrame(tick);
      const el = rootRef.current;
      const fn = getScreenRectRef.current;
      if (!el) return;

      if (resizeRef.current || dragRef.current) return;
      if (!fn) return;
      const r = fn();
      if (!r) return;
      anchorRectRef.current = r;
      liveRectRef.current = r;
      applyFollowRectToElement(r);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      try {
        cancelAnimationFrame(raf);
      } catch {
        // ignore
      }
    };
  }, [applyFollowRectToElement, followEnabled]);

  const applyResize = (start: Rect, corner: ResizeCorner, dx: number, dy: number, minW: number, minH: number): Rect => {
    const right = start.x + start.w;
    const bottom = start.y + start.h;

    let next: Rect;
    switch (corner) {
      case 'nw':
        next = { x: start.x + dx, y: start.y + dy, w: start.w - dx, h: start.h - dy };
        break;
      case 'ne':
        next = { x: start.x, y: start.y + dy, w: start.w + dx, h: start.h - dy };
        break;
      case 'sw':
        next = { x: start.x + dx, y: start.y, w: start.w - dx, h: start.h + dy };
        break;
      default:
        next = { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy };
        break;
    }

    if (next.w < minW) {
      if (corner === 'nw' || corner === 'sw') next.x = right - minW;
      next.w = minW;
    }
    if (next.h < minH) {
      if (corner === 'nw' || corner === 'ne') next.y = bottom - minH;
      next.h = minH;
    }
    return next;
  };

  const finishResize = useCallback((pointerId?: number) => {
    const active = resizeRef.current;
    if (!active) return;
    if (typeof pointerId === 'number' && active.pointerId !== pointerId) return;
    resizeRef.current = null;
    const next = liveRectRef.current;
    if (next) onResizeRef.current(next);
    onResizeEndRef.current();
  }, []);

  const finishDrag = useCallback((pointerId?: number) => {
    const active = dragRef.current;
    if (!active) return;
    if (typeof pointerId === 'number' && active.pointerId !== pointerId) return;
    dragRef.current = null;
    const next = liveRectRef.current;
    if (next) onResizeRef.current(next);
    onResizeEndRef.current();
  }, []);

  const beginResize = (corner: ResizeCorner) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = followEnabled
      ? (anchorRectRef.current ?? liveRectRef.current)
      : (liveRectRef.current ?? anchorRectRef.current);
    if (!rect) return;
    const pointerId = e.pointerId;
    const target = e.currentTarget;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // ignore
    }

    resizeRef.current = {
      pointerId,
      corner,
      startClient: { x: e.clientX, y: e.clientY },
      startRect: { ...rect },
    };
  };

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - active.startClient.x;
    const dy = e.clientY - active.startClient.y;
    const next = applyResize(active.startRect, active.corner, dx, dy, 340, 240);
    setLiveRect(next);
    if (followEnabled) applyFollowRectToElement(next);
    onResizeRef.current(next);
  };

  const onResizePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    finishResize(e.pointerId);
  };

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = followEnabled
      ? (anchorRectRef.current ?? liveRectRef.current)
      : (liveRectRef.current ?? anchorRectRef.current);
    if (!rect) return;
    const pointerId = e.pointerId;
    const target = e.currentTarget;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // ignore
    }

    dragRef.current = {
      pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      startRect: { ...rect },
    };
  };

  const onDragPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - active.startClient.x;
    const dy = e.clientY - active.startClient.y;
    const next: Rect = { ...active.startRect, x: active.startRect.x + dx, y: active.startRect.y + dy };
    setLiveRect(next);
    if (followEnabled) applyFollowRectToElement(next);
    onResizeRef.current(next);
  };

  const onDragPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    finishDrag(e.pointerId);
  };

  const saveActiveFile = useCallback(async (): Promise<boolean> => {
    const root = typeof projectRootRef.current === 'string' ? projectRootRef.current.trim() : '';
    const filePath = typeof activeFileRef.current === 'string' ? activeFileRef.current.trim() : '';
    if (!root || !filePath) return true;
    if (!isDirty) return true;

    setIsSavingFile(true);
    try {
      const res = await writeLatexProjectFile(root, filePath, draftRef.current);
      if (!res.ok) {
        const msg = (res.error ?? 'Failed to save file.').trim() || 'Failed to save file.';
        setProjectError(msg);
        setRuntimeCompileError(msg);
        return false;
      }
      setProjectError(null);
      setIsDirty(false);
      await persistProjectState({
        projectRoot: root,
        mainFile: mainFileRef.current,
        activeFile: filePath,
        content: draftRef.current,
      });
      return true;
    } finally {
      setIsSavingFile(false);
    }
  }, [isDirty, persistProjectState]);

  const switchActiveFile = useCallback(
    async (nextPathRaw: string, opts?: { line?: number }): Promise<boolean> => {
      const root = typeof projectRootRef.current === 'string' ? projectRootRef.current.trim() : '';
      const nextPath = typeof nextPathRaw === 'string' ? nextPathRaw.trim() : '';
      if (!root || !nextPath) return false;
      const fileMeta = projectFileByPath.get(nextPath) ?? null;
      if (!fileMeta || !fileMeta.editable) {
        const msg = fileMeta ? 'Selected file is read-only in this MVP.' : `File not found: ${nextPath}`;
        setProjectError(msg);
        setRuntimeCompileError(msg);
        setSelectedTreePath(nextPath);
        return false;
      }

      const targetLine = Number(opts?.line);
      if ((activeFileRef.current ?? '') === nextPath) {
        setSelectedTreePath(nextPath);
        if (Number.isFinite(targetLine) && targetLine > 0) {
          requestAnimationFrame(() => jumpToLineInTextarea(targetLine));
        }
        return true;
      }

      const saved = await saveActiveFile();
      if (!saved) return false;

      const res = await readLatexProjectFile(root, nextPath);
      if (!res.ok) {
        const msg = (res.error ?? 'Failed to open file.').trim() || 'Failed to open file.';
        setProjectError(msg);
        setRuntimeCompileError(msg);
        return false;
      }

      const content = typeof res.content === 'string' ? res.content : '';
      setActiveFile(nextPath);
      setSelectedTreePath(nextPath);
      setProjectError(null);
      setIsDirty(false);
      applyDraft(content);
      await persistProjectState({
        projectRoot: root,
        mainFile: mainFileRef.current,
        activeFile: nextPath,
        content,
      });

      if (Number.isFinite(targetLine) && targetLine > 0) {
        requestAnimationFrame(() => jumpToLineInTextarea(targetLine));
      }
      return true;
    },
    [applyDraft, jumpToLineInTextarea, persistProjectState, projectFileByPath, saveActiveFile],
  );

  const setMainToActive = useCallback(async () => {
    const root = typeof projectRootRef.current === 'string' ? projectRootRef.current.trim() : '';
    const active = typeof activeFileRef.current === 'string' ? activeFileRef.current.trim() : '';
    if (!root || !active) return;
    setMainFile(active);
    await persistProjectState({
      projectRoot: root,
      mainFile: active,
      activeFile: active,
      content: draftRef.current,
    });
  }, [persistProjectState]);

  const openProject = useCallback(async () => {
    const picked = await pickLatexProject();
    if (!picked.ok || !picked.projectRoot) {
      if (picked.error && !picked.error.toLowerCase().includes('canceled')) {
        setProjectError(picked.error);
      }
      return;
    }
    setRuntimeCompileError(null);
    await refreshProject(picked.projectRoot, null, null, {
      persist: true,
      fallbackContent: initialValue ?? '',
    });
  }, [initialValue, refreshProject]);

  const refreshCurrentProject = useCallback(async () => {
    const root = typeof projectRootRef.current === 'string' ? projectRootRef.current.trim() : '';
    if (!root) return;
    const saved = await saveActiveFile();
    if (!saved) return;
    await refreshProject(root, mainFileRef.current, activeFileRef.current, {
      persist: true,
      fallbackContent: draftRef.current,
    });
  }, [refreshProject, saveActiveFile]);

  const commit = useCallback(async () => {
    const saved = await saveActiveFile();
    if (!saved) return;
    onCommitRef.current(draftRef.current);
  }, [saveActiveFile]);

  const cancel = useCallback(() => {
    onCancelRef.current();
  }, []);

  const compile = useCallback(async () => {
    if (isCompiling) return;
    setRuntimeCompileError(null);

    const root = typeof projectRootRef.current === 'string' ? projectRootRef.current.trim() : '';
    const main = typeof mainFileRef.current === 'string' ? mainFileRef.current.trim() : '';
    if (root && !main) {
      setRuntimeCompileError('Select a main .tex file before compiling.');
      return;
    }

    setIsCompiling(true);
    try {
      if (root && main) {
        const saved = await saveActiveFile();
        if (!saved) return;
        await onCompileRef.current({ source: draftRef.current, projectRoot: root, mainFile: main });
        return;
      }
      await onCompileRef.current({ source: draftRef.current });
    } catch (err: any) {
      const msg = err ? String(err?.message ?? err) : 'Compile failed.';
      setRuntimeCompileError(msg);
    } finally {
      setIsCompiling(false);
    }
  }, [isCompiling, saveActiveFile]);

  const syncSourceToPdf = useCallback(async () => {
    const root = typeof projectRootRef.current === 'string' ? projectRootRef.current.trim() : '';
    const main = typeof mainFileRef.current === 'string' ? mainFileRef.current.trim() : '';
    const source = typeof activeFileRef.current === 'string' ? activeFileRef.current.trim() : '';
    if (!root || !main || !source) {
      setRuntimeCompileError('SyncTeX needs a project root, main file, and active source file.');
      return;
    }
    if (!compiledPdfUrl) {
      setRuntimeCompileError('Compile first to generate the PDF before SyncTeX lookup.');
      return;
    }

    const sourceMeta = projectFileByPath.get(source) ?? null;
    if (!sourceMeta || !sourceMeta.editable) {
      setRuntimeCompileError('Select an editable source file before SyncTeX lookup.');
      return;
    }

    const text = draftRef.current;
    const selectionStart = (() => {
      const el = taRef.current;
      if (!el) return text.length;
      const raw = Number(el.selectionStart);
      if (!Number.isFinite(raw)) return text.length;
      return Math.max(0, Math.min(text.length, Math.floor(raw)));
    })();
    const line = Math.max(1, text.slice(0, selectionStart).split('\n').length);

    setIsSyncingPdf(true);
    try {
      const res = await synctexForward({
        projectRoot: root,
        mainFile: main,
        sourceFile: source,
        line,
      });
      if (!res.ok || !Number.isFinite(Number(res.page))) {
        const msg = (res.error ?? 'SyncTeX forward lookup failed.').trim();
        setRuntimeCompileError(msg || 'SyncTeX forward lookup failed.');
        return;
      }
      setRuntimeCompileError(null);
      const page = Math.max(1, Math.floor(Number(res.page)));
      setPdfSyncTarget({
        token: ++syncTokenRef.current,
        page,
        x: Number.isFinite(Number(res.x)) ? Number(res.x) : null,
        y: Number.isFinite(Number(res.y)) ? Number(res.y) : null,
      });
    } finally {
      setIsSyncingPdf(false);
    }
  }, [compiledPdfUrl, projectFileByPath]);

  const syncPdfToSource = useCallback(
    async (payload: { page: number; x: number; y: number }) => {
      const root = typeof projectRootRef.current === 'string' ? projectRootRef.current.trim() : '';
      const main = typeof mainFileRef.current === 'string' ? mainFileRef.current.trim() : '';
      if (!root || !main) return;

      const page = Math.max(1, Math.floor(Number(payload.page)));
      const x = Number(payload.x);
      const y = Number(payload.y);
      if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) return;

      setIsSyncingPdf(true);
      try {
        const res = await synctexInverse({
          projectRoot: root,
          mainFile: main,
          page,
          x,
          y,
        });
        if (!res.ok) {
          const msg = (res.error ?? 'SyncTeX inverse lookup failed.').trim();
          setRuntimeCompileError(msg || 'SyncTeX inverse lookup failed.');
          return;
        }
        const pathRaw = typeof res.filePath === 'string' ? res.filePath.trim() : '';
        const line = Number(res.line);
        if (!pathRaw) {
          const rawHint = typeof res.sourcePathRaw === 'string' ? res.sourcePathRaw.trim() : '';
          setRuntimeCompileError(
            rawHint
              ? `SyncTeX matched "${rawHint}" but it is outside the current project root.`
              : 'SyncTeX inverse lookup did not return a source path in this project.',
          );
          return;
        }
        const jumped = await switchActiveFile(pathRaw, { line: Number.isFinite(line) && line > 0 ? line : 1 });
        if (!jumped) return;
        setRuntimeCompileError(null);
        setSelectedTreePath(pathRaw);
      } finally {
        setIsSyncingPdf(false);
      }
    },
    [switchActiveFile],
  );

  const handlePdfInverseSync = useCallback(
    (payload: { page: number; x: number; y: number }) => {
      void syncPdfToSource(payload);
    },
    [syncPdfToSource],
  );

  const diagnostics = useMemo<CompileDiagnostic[]>(() => {
    const raw = typeof compileLog === 'string' ? compileLog : '';
    if (!raw.trim()) return [];

    const files = projectFiles;
    const pathSet = new Set(files.map((f) => f.path));
    const byBaseName = new Map<string, string[]>();
    for (const file of files) {
      const bn = baseName(file.path);
      const list = byBaseName.get(bn) ?? [];
      list.push(file.path);
      byBaseName.set(bn, list);
    }

    const rootNormRaw = projectRoot ? normalizePathLike(projectRoot).replace(/\/+$/, '') : '';
    const resolvePath = (fileRaw: string): string | null => {
      const trimmed = normalizePathLike(fileRaw).trim();
      if (!trimmed) return null;

      let candidate = trimmed.replace(/^\.\//, '');
      if (pathSet.has(candidate)) return candidate;

      if (rootNormRaw && candidate.startsWith(`${rootNormRaw}/`)) {
        candidate = candidate.slice(rootNormRaw.length + 1);
        if (pathSet.has(candidate)) return candidate;
      }

      const bn = baseName(candidate);
      const matches = byBaseName.get(bn) ?? [];
      if (matches.length === 1) return matches[0];
      return null;
    };

    const out: CompileDiagnostic[] = [];
    const seen = new Set<string>();
    const lines = raw.split(/\r?\n/);
    const diagRe = /^(.+?\.(?:tex|bib|sty|cls|bst|ltx|md|txt)):(\d+):\s*(.*)$/;

    for (const line of lines) {
      const match = diagRe.exec(line);
      if (!match) continue;
      const fileRaw = String(match[1] ?? '').trim();
      const lineNum = Number(match[2]);
      if (!Number.isFinite(lineNum) || lineNum < 1) continue;
      const message = String(match[3] ?? '').trim();
      const filePath = resolvePath(fileRaw);
      const key = `${filePath ?? fileRaw}:${lineNum}:${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, fileRaw, filePath, line: Math.floor(lineNum), message });
      if (out.length >= 120) break;
    }
    return out;
  }, [compileLog, projectFiles, projectRoot]);

  const openDiagnostic = useCallback(
    async (diag: CompileDiagnostic) => {
      const path = diag.filePath;
      if (!path) {
        setRuntimeCompileError(`Could not map diagnostic file "${diag.fileRaw}" to a project file.`);
        setLogVisible(true);
        setLogCollapsed(false);
        return;
      }
      const file = projectFileByPath.get(path) ?? null;
      if (!file || !file.editable) {
        setRuntimeCompileError(`Diagnostic points to read-only file "${path}".`);
        setSelectedTreePath(path);
        setLogVisible(true);
        setLogCollapsed(false);
        return;
      }
      const ok = await switchActiveFile(path, { line: diag.line });
      if (ok) {
        setSelectedTreePath(path);
        setLogVisible(true);
      }
    },
    [projectFileByPath, switchActiveFile],
  );

  const toggleDirExpanded = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => ({ ...prev, [dirPath]: !(prev[dirPath] !== false) }));
  }, []);

  const onProjectFileClick = useCallback(
    (file: LatexProjectFile) => {
      setSelectedTreePath(file.path);
      if (!file.editable) return;
      void switchActiveFile(file.path);
    },
    [switchActiveFile],
  );

  const renderTreeNodes = useCallback(
    (nodes: ProjectTreeNode[], depth = 0): React.ReactNode => {
      return nodes.map((node) => {
        if (node.kind === 'dir') {
          const expanded = expandedDirs[node.path] !== false;
          return (
            <div key={`d:${node.path}`} className="editor__latexTreeNode">
              <button
                type="button"
                className="editor__latexTreeRow editor__latexTreeRow--dir"
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                onClick={() => toggleDirExpanded(node.path)}
              >
                <span className="editor__latexTreeCaret" aria-hidden="true">
                  {expanded ? '▾' : '▸'}
                </span>
                <span className="editor__latexTreeName">{node.name || '/'}</span>
              </button>
              {expanded ? <div className="editor__latexTreeChildren">{renderTreeNodes(node.children, depth + 1)}</div> : null}
            </div>
          );
        }

        const file = node.file;
        const selected = selectedTreePath === file.path;
        const isMain = mainFile === file.path;
        const isActive = activeFile === file.path;
        return (
          <div key={`f:${file.path}`} className="editor__latexTreeNode">
            <button
              type="button"
              className={`editor__latexTreeRow editor__latexTreeRow--file ${
                selected ? 'editor__latexTreeRow--selected' : ''
              } ${!file.editable ? 'editor__latexTreeRow--readonly' : ''}`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={() => onProjectFileClick(file)}
              title={file.editable ? file.path : `${file.path} (read-only)`}
            >
              <span className="editor__latexTreeCaret" aria-hidden="true">
                {file.editable ? '•' : '○'}
              </span>
              <span className="editor__latexTreeName">{baseName(file.path)}</span>
              {isMain ? <span className="editor__latexTreeBadge">main</span> : null}
              {!file.editable ? <span className="editor__latexTreeBadge">asset</span> : null}
              {isActive ? <span className="editor__latexTreeBadge">edit</span> : null}
            </button>
          </div>
        );
      });
    },
    [activeFile, expandedDirs, mainFile, onProjectFileClick, selectedTreePath, toggleDirExpanded],
  );

  const activeAnchorRect = liveRect ?? anchorRect ?? null;
  const style = useMemo<React.CSSProperties>(() => {
    const baseFontSize = Math.max(10, baseFontSizePx || 16);
    const editorVars = { ['--editor-scale' as any]: 1, ['--editor-font-size' as any]: `${baseFontSize}px` } as any;
    if (followEnabled) {
      return {
        left: 0,
        top: 0,
        borderRadius: 'calc(18px * var(--editor-scale, 1))',
        willChange: 'transform,width,height',
        ...editorVars,
      };
    }
    if (activeAnchorRect) {
      return {
        left: activeAnchorRect.x,
        top: activeAnchorRect.y,
        width: activeAnchorRect.w,
        height: activeAnchorRect.h,
        borderRadius: 'calc(18px * var(--editor-scale, 1))',
        ...editorVars,
      };
    }

    const margin = 12;
    const vpW = Math.max(1, viewport.w || window.innerWidth || 1);
    const vpH = Math.max(1, viewport.h || window.innerHeight || 1);
    const w = Math.min(980, vpW - margin * 2);
    const h = Math.min(Math.round(vpH * 0.76), vpH - margin * 2);
    return {
      left: (vpW - w) * 0.5,
      top: margin,
      width: w,
      height: h,
      ...editorVars,
    };
  }, [activeAnchorRect, baseFontSizePx, followEnabled, viewport.h, viewport.w]);

  const effectiveError = runtimeCompileError || projectError;
  const statusText = useMemo(() => {
    if (projectBusy) return 'Loading project...';
    if (isSavingFile) return 'Saving file...';
    if (isSyncingPdf) return 'SyncTeX lookup...';
    if (isCompiling) return 'Compiling...';
    if (effectiveError) return effectiveError;
    if (compileError) return compileError;
    if (Number.isFinite(compiledAt) && (compiledAt as number) > 0) {
      return `Compiled ${new Date(compiledAt as number).toLocaleString()}`;
    }
    if (projectRoot && mainFile) return `Ready to compile ${mainFile}`;
    return 'No compiled PDF yet.';
  }, [compileError, compiledAt, effectiveError, isCompiling, isSavingFile, isSyncingPdf, mainFile, projectBusy, projectRoot]);

  const compileDisabled = isCompiling || projectBusy || isSavingFile || Boolean(projectRoot && !mainFile);
  const showMainAsActive = Boolean(projectRoot && activeFile && mainFile && activeFile !== mainFile);
  const rootDisplay = projectRoot ? projectRoot : 'Inline document';
  const hasCompileLog = Boolean(typeof compileLog === 'string' && compileLog.trim());
  const canInverseSync = Boolean(projectRoot && mainFile && compiledPdfUrl);
  const editableCount = editableProjectFiles.length;
  const assetCount = projectFiles.length - editableCount;
  const canZoomOut = pdfZoom > PDF_ZOOM_MIN + 0.001;
  const canZoomIn = pdfZoom < PDF_ZOOM_MAX - 0.001;
  const zoomLabel = `${Math.round(pdfZoom * 100)}%`;

  const adjustPdfZoom = useCallback((delta: number) => {
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) return;
    setPdfZoom((prev) => {
      const next = Math.max(PDF_ZOOM_MIN, Math.min(PDF_ZOOM_MAX, prev + d));
      return Math.round(next * 100) / 100;
    });
  }, []);

  const resetPdfZoom = useCallback(() => {
    setPdfZoom(1);
  }, []);

  const openCompiledPdf = useCallback(() => {
    if (!compiledPdfUrl) return;
    try {
      window.open(compiledPdfUrl, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore
    }
  }, [compiledPdfUrl]);

  const downloadCompiledPdf = useCallback(() => {
    if (!compiledPdfUrl || typeof document === 'undefined') return;
    try {
      const a = document.createElement('a');
      a.href = compiledPdfUrl;
      a.download = 'latex-output.pdf';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      // ignore
    }
  }, [compiledPdfUrl]);

  return (
    <div
      ref={rootRef}
      className="editor editor--edit editor--latex"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className="editor__resizeHandle editor__resizeHandle--nw"
        aria-hidden="true"
        onPointerDown={beginResize('nw')}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
        onLostPointerCapture={(e) => finishResize(e.pointerId)}
      />
      <div
        className="editor__resizeHandle editor__resizeHandle--ne"
        aria-hidden="true"
        onPointerDown={beginResize('ne')}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
        onLostPointerCapture={(e) => finishResize(e.pointerId)}
      />
      <div
        className="editor__resizeHandle editor__resizeHandle--sw"
        aria-hidden="true"
        onPointerDown={beginResize('sw')}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
        onLostPointerCapture={(e) => finishResize(e.pointerId)}
      />
      <div
        className="editor__resizeHandle editor__resizeHandle--se"
        aria-hidden="true"
        onPointerDown={beginResize('se')}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
        onLostPointerCapture={(e) => finishResize(e.pointerId)}
      />

      <div className="editor__topbar">
        <div
          className="editor__title editor__title--draggable"
          onPointerDown={beginDrag}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerEnd}
          onPointerCancel={onDragPointerEnd}
          onLostPointerCapture={(e) => finishDrag(e.pointerId)}
        >
          {title ?? 'LaTeX node'}
        </div>
        <div className="editor__actions">
          <button className="editor__btn" type="button" onClick={() => void openProject()} disabled={projectBusy || isCompiling || isSavingFile}>
            Open project
          </button>
          {projectRoot ? (
            <button className="editor__btn" type="button" onClick={() => void refreshCurrentProject()} disabled={projectBusy || isCompiling || isSavingFile}>
              Refresh
            </button>
          ) : null}
          {projectRoot ? (
            <button className="editor__btn" type="button" onClick={() => void saveActiveFile()} disabled={!isDirty || isSavingFile || projectBusy}>
              {isSavingFile ? 'Saving...' : 'Save file'}
            </button>
          ) : null}
          {projectRoot ? (
            <button className="editor__btn" type="button" onClick={() => setTreeVisible((v) => !v)} disabled={projectBusy}>
              {treeVisible ? 'Hide tree' : 'Show tree'}
            </button>
          ) : null}
          {showMainAsActive ? (
            <button className="editor__btn" type="button" onClick={() => void setMainToActive()} disabled={projectBusy || isCompiling || isSavingFile}>
              Set main
            </button>
          ) : null}
          {projectRoot && mainFile && activeFile ? (
            <button
              className="editor__btn"
              type="button"
              onClick={() => void syncSourceToPdf()}
              disabled={projectBusy || isCompiling || isSavingFile || isSyncingPdf || !compiledPdfUrl}
            >
              {isSyncingPdf ? 'Syncing...' : 'Sync PDF'}
            </button>
          ) : null}
          <button className="editor__btn editor__btn--primary" type="button" onClick={() => void compile()} disabled={compileDisabled}>
            {isCompiling ? 'Compiling...' : 'Compile'}
          </button>
          <button className="editor__btn" type="button" onClick={cancel}>
            Cancel
          </button>
          <button className="editor__btn editor__btn--primary" type="button" onClick={() => void commit()}>
            Done
          </button>
        </div>
      </div>

      <div className="editor__body editor__body--preview">
        <div className="editor__pane editor__pane--edit">
          <div className="editor__paneLabel">TeX source</div>
          <div className="editor__latexProjectMeta">
            <div className="editor__latexProjectRoot" title={rootDisplay}>
              {rootDisplay}
            </div>
            {projectRoot ? (
              <div className="editor__latexProjectHint">
                Main: {mainFile ?? 'not set'}
                {isDirty ? ' - unsaved changes' : ''}
                {` - ${editableCount} editable, ${assetCount} assets`}
              </div>
            ) : null}
          </div>

          <div className="editor__latexWorkspace">
            {projectRoot && treeVisible ? (
              <div className="editor__latexTreePane">
                <input
                  className="editor__latexTreeSearch"
                  value={treeQuery}
                  onChange={(e) => setTreeQuery(e.target.value)}
                  placeholder="Search project files..."
                  aria-label="Search project files"
                />
                <div className="editor__latexTreeBody" role="tree" aria-label="LaTeX project files">
                  {filteredProjectTree && filteredProjectTree.children.length > 0 ? (
                    renderTreeNodes(filteredProjectTree.children, 0)
                  ) : (
                    <div className="editor__latexTreeEmpty">No matching files.</div>
                  )}
                </div>
              </div>
            ) : null}

            <div className="editor__latexEditorPane">
              {projectRoot && !treeVisible ? (
                <div className="editor__latexTreeCollapsedBar">
                  <span className="editor__latexTreeCollapsedText">Project tree hidden</span>
                  <button className="editor__btn editor__btn--compact" type="button" onClick={() => setTreeVisible(true)}>
                    Show tree
                  </button>
                </div>
              ) : null}
              {selectedReadOnlyFile ? (
                <div className="editor__latexReadonlyHint">
                  Selected read-only asset: <code>{selectedReadOnlyFile.path}</code>. Select a source file to edit.
                </div>
              ) : null}
              <textarea
                ref={taRef}
                className="editor__textarea editor__textarea--latex"
                value={draft}
                spellCheck={false}
                onChange={(e) => {
                  const next = e.target.value;
                  applyDraft(next);
                  if (projectRootRef.current && activeFileRef.current) setIsDirty(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancel();
                    return;
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    e.stopPropagation();
                    void saveActiveFile();
                    return;
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    void compile();
                    return;
                  }
                  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
                    e.preventDefault();
                    e.stopPropagation();
                    void syncSourceToPdf();
                  }
                }}
              />
            </div>
          </div>
        </div>

        <div className="editor__pane editor__pane--preview">
          <div className="editor__paneLabelRow">
            <div className={`editor__paneLabel ${compileError || effectiveError ? 'editor__paneLabel--error' : ''}`}>{statusText}</div>
            <div className="editor__paneActions">
              {compiledPdfUrl ? (
                <>
                  <button className="editor__btn editor__btn--compact" type="button" onClick={() => adjustPdfZoom(-PDF_ZOOM_STEP)} disabled={!canZoomOut}>
                    -
                  </button>
                  <button className="editor__btn editor__btn--compact" type="button" onClick={resetPdfZoom} title="Reset zoom (fit width)">
                    {zoomLabel}
                  </button>
                  <button className="editor__btn editor__btn--compact" type="button" onClick={() => adjustPdfZoom(PDF_ZOOM_STEP)} disabled={!canZoomIn}>
                    +
                  </button>
                  <button className="editor__btn editor__btn--compact" type="button" onClick={openCompiledPdf}>
                    Open
                  </button>
                  <button className="editor__btn editor__btn--compact" type="button" onClick={downloadCompiledPdf}>
                    Download
                  </button>
                </>
              ) : null}
              {hasCompileLog ? (
                <button
                  className="editor__btn editor__btn--compact"
                  type="button"
                  onClick={() => {
                    if (!logVisible) {
                      setLogVisible(true);
                      setLogCollapsed(false);
                      return;
                    }
                    setLogCollapsed((v) => !v);
                  }}
                >
                  {!logVisible ? 'Show log' : logCollapsed ? 'Expand log' : 'Minimize log'}
                </button>
              ) : null}
            </div>
          </div>

          <div className="editor__preview editor__preview--pdf">
            <LatexPdfPreview
              pdfUrl={compiledPdfUrl}
              syncTarget={pdfSyncTarget}
              zoom={pdfZoom}
              onInverseSync={canInverseSync ? handlePdfInverseSync : undefined}
            />
          </div>

          {hasCompileLog && logVisible ? (
            <div className="editor__latexLogPanel">
              <div className="editor__latexLogLabelRow">
                <div className="editor__latexLogLabel">Compiler log</div>
                <div className="editor__latexLogActions">
                  <button className="editor__btn editor__btn--compact" type="button" onClick={() => setLogCollapsed((v) => !v)}>
                    {logCollapsed ? 'Expand' : 'Minimize'}
                  </button>
                  <button className="editor__btn editor__btn--compact" type="button" onClick={() => setLogVisible(false)}>
                    Close
                  </button>
                </div>
              </div>

              {!logCollapsed ? (
                <>
                  {diagnostics.length > 0 ? (
                    <div className="editor__latexDiagList">
                      {diagnostics.map((diag) => {
                        const mappedFile = diag.filePath ? projectFileByPath.get(diag.filePath) ?? null : null;
                        const canJump = Boolean(mappedFile && mappedFile.editable);
                        return (
                          <button
                            key={diag.key}
                            className={`editor__latexDiagRow ${canJump ? 'editor__latexDiagRow--clickable' : 'editor__latexDiagRow--muted'}`}
                            type="button"
                            onClick={() => void openDiagnostic(diag)}
                            disabled={!canJump}
                            title={
                              canJump
                                ? `Open ${diag.filePath}:${diag.line}`
                                : `Could not open ${diag.fileRaw}:${diag.line}`
                            }
                          >
                            <span className="editor__latexDiagLoc">{`${diag.filePath ?? diag.fileRaw}:${diag.line}`}</span>
                            <span className="editor__latexDiagMsg">{diag.message || 'Compile diagnostic'}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  <pre className="editor__latexLogBody">{compileLog ?? ''}</pre>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
