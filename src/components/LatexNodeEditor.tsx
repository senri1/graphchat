import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listLatexProjectFiles, pickLatexProject, readLatexProjectFile, type LatexProjectFile, writeLatexProjectFile } from '../latex/project';
import type { Rect } from '../engine/types';

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

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(draft);
  const projectRootRef = useRef<string | null>(null);
  const mainFileRef = useRef<string | null>(null);
  const activeFileRef = useRef<string | null>(null);
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

  const applyDraft = useCallback((next: string) => {
    const text = typeof next === 'string' ? next : String(next ?? '');
    setDraft(text);
    draftRef.current = text;
    onDraftChangeRef.current?.(text);
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
        const allPaths = new Set(files.map((f) => f.path));
        const texPaths = files.filter((f) => f.kind === 'tex').map((f) => f.path);

        const preferredMain = typeof preferredMainRaw === 'string' ? preferredMainRaw.trim() : '';
        const preferredActive = typeof preferredActiveRaw === 'string' ? preferredActiveRaw.trim() : '';
        const suggestedMain = typeof indexRes.index.suggestedMainFile === 'string' ? indexRes.index.suggestedMainFile.trim() : '';

        let nextMain = preferredMain && allPaths.has(preferredMain) ? preferredMain : null;
        if (!nextMain && suggestedMain && allPaths.has(suggestedMain)) nextMain = suggestedMain;
        if (!nextMain && texPaths.length > 0) nextMain = texPaths[0];

        let nextActive = preferredActive && allPaths.has(preferredActive) ? preferredActive : null;
        if (!nextActive && nextMain && allPaths.has(nextMain)) nextActive = nextMain;
        if (!nextActive && files.length > 0) nextActive = files[0].path;

        let loadedContent = typeof opts?.fallbackContent === 'string' ? opts!.fallbackContent : initialValue ?? '';
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

      const rawZoom = getZoomRef.current?.();
      const zNow = Math.max(0.001, Number.isFinite(rawZoom as number) ? Number(rawZoom) : 1);
      el.style.setProperty('--editor-scale', '1');

      if (!fn) return;
      const r = fn();
      if (!r) return;
      anchorRectRef.current = r;

      const screenW = Math.max(1, Number(r.w));
      const screenH = Math.max(1, Number(r.h));
      const unscaledW = Math.max(1, screenW / zNow);
      const unscaledH = Math.max(1, screenH / zNow);
      el.style.transformOrigin = '0 0';
      el.style.transform = `translate3d(${r.x}px, ${r.y}px, 0) scale(${zNow})`;
      el.style.width = `${unscaledW}px`;
      el.style.height = `${unscaledH}px`;
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
  }, [followEnabled]);

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
    const rect = liveRectRef.current ?? anchorRectRef.current;
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
    const rect = liveRectRef.current ?? anchorRectRef.current;
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

  const saveActiveFile = useCallback(async () => {
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
    async (nextPathRaw: string) => {
      const root = typeof projectRootRef.current === 'string' ? projectRootRef.current.trim() : '';
      const nextPath = typeof nextPathRaw === 'string' ? nextPathRaw.trim() : '';
      if (!root || !nextPath) return;
      if ((activeFileRef.current ?? '') === nextPath) return;
      const saved = await saveActiveFile();
      if (!saved) return;

      const res = await readLatexProjectFile(root, nextPath);
      if (!res.ok) {
        const msg = (res.error ?? 'Failed to open file.').trim() || 'Failed to open file.';
        setProjectError(msg);
        setRuntimeCompileError(msg);
        return;
      }

      const content = typeof res.content === 'string' ? res.content : '';
      setActiveFile(nextPath);
      setProjectError(null);
      setIsDirty(false);
      applyDraft(content);
      await persistProjectState({
        projectRoot: root,
        mainFile: mainFileRef.current,
        activeFile: nextPath,
        content,
      });
    },
    [applyDraft, persistProjectState, saveActiveFile],
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
    if (isCompiling) return 'Compiling...';
    if (effectiveError) return effectiveError;
    if (compileError) return compileError;
    if (Number.isFinite(compiledAt) && (compiledAt as number) > 0) {
      return `Compiled ${new Date(compiledAt as number).toLocaleString()}`;
    }
    if (projectRoot && mainFile) return `Ready to compile ${mainFile}`;
    return 'No compiled PDF yet.';
  }, [compileError, compiledAt, effectiveError, isCompiling, isSavingFile, mainFile, projectBusy, projectRoot]);

  const compileDisabled = isCompiling || projectBusy || isSavingFile || Boolean(projectRoot && !mainFile);
  const showMainAsActive = Boolean(projectRoot && activeFile && mainFile && activeFile !== mainFile);
  const rootDisplay = projectRoot ? projectRoot : 'Inline document';
  const fileListValue = activeFile ?? '';
  const hasCompileLog = Boolean(typeof compileLog === 'string' && compileLog.trim());

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
          {showMainAsActive ? (
            <button className="editor__btn" type="button" onClick={() => void setMainToActive()} disabled={projectBusy || isCompiling || isSavingFile}>
              Set main
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
              <>
                <div className="editor__latexProjectControls">
                  <label className="editor__latexProjectControlsLabel" htmlFor={`latex-file-select-${nodeId}`}>
                    File
                  </label>
                  <select
                    id={`latex-file-select-${nodeId}`}
                    className="editor__latexProjectSelect"
                    value={fileListValue}
                    onChange={(e) => void switchActiveFile(e.target.value)}
                    disabled={projectBusy || isCompiling || isSavingFile || projectFiles.length === 0}
                  >
                    {!fileListValue ? <option value="">No file selected</option> : null}
                    {projectFiles.map((file) => (
                      <option key={file.path} value={file.path}>
                        {file.path}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="editor__latexProjectHint">
                  Main: {mainFile ?? 'not set'}
                  {isDirty ? ' • unsaved changes' : ''}
                </div>
              </>
            ) : null}
          </div>
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
              }
            }}
          />
        </div>
        <div className="editor__pane editor__pane--preview">
          <div className={`editor__paneLabel ${compileError || effectiveError ? 'editor__paneLabel--error' : ''}`}>{statusText}</div>
          <div className="editor__preview editor__preview--pdf">
            {compiledPdfUrl ? (
              <iframe className="editor__pdfPreview" src={compiledPdfUrl} title="Compiled PDF preview" />
            ) : (
              <div className="editor__emptyPreview">Compile the document to preview the PDF.</div>
            )}
          </div>
          {hasCompileLog ? (
            <div className="editor__latexLogPanel">
              <div className="editor__latexLogLabel">Compiler log</div>
              <pre className="editor__latexLogBody">{compileLog ?? ''}</pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
