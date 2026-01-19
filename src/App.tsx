import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorldEngine, type WorldEngineDebug } from './engine/WorldEngine';
import ChatComposer from './components/ChatComposer';
import TextNodeEditor from './components/TextNodeEditor';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import { createEmptyChatState, type WorldEngineChatState } from './engine/WorldEngine';
import {
  type WorkspaceChat,
  type WorkspaceFolder,
  collectChatIds,
  deleteItem,
  findFirstChatId,
  findItem,
  insertItem,
  moveItem,
  renameItem,
  toggleFolder,
} from './workspace/tree';
import { getOpenAIApiKey, streamOpenAIResponse } from './services/openaiService';
import type { ChatNode } from './model/chat';

type ChatTurnMeta = {
  id: string;
  createdAt: number;
  userNodeId: string;
  assistantNodeId: string;
  attachmentNodeIds: string[];
};

type ReplySelection = { nodeId: string; preview: string };

type ChatRuntimeMeta = {
  draft: string;
  replyTo: ReplySelection | null;
  headNodeId: string | null;
  turns: ChatTurnMeta[];
};

type ChatGenerationJob = {
  chatId: string;
  userNodeId: string;
  assistantNodeId: string;
  modelId: string;
  startedAt: number;
  abortController: AbortController;
  fullText: string;
  lastFlushedText: string;
  lastFlushAt: number;
  flushTimer: number | null;
  closed: boolean;
};

const DEFAULT_OPENAI_MODEL_ID = 'gpt-4o-mini';

function genId(prefix: string): string {
  const p = prefix.replace(/[^a-z0-9_-]/gi, '').slice(0, 8) || 'id';
  try {
    const uuid = (crypto as any)?.randomUUID?.() as string | undefined;
    if (uuid) return `${p}_${uuid}`;
  } catch {
    // ignore
  }
  return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildOpenAIInputFromChatNodes(nodes: ChatNode[], leafUserNodeId: string): any[] {
  const byId = new Map<string, ChatNode>();
  for (const n of nodes) byId.set(n.id, n);

  const chain: ChatNode[] = [];
  let cur: ChatNode | null = byId.get(leafUserNodeId) ?? null;
  while (cur) {
    chain.push(cur);
    const parentId = (cur as any)?.parentId as string | null | undefined;
    if (!parentId) break;
    cur = byId.get(parentId) ?? null;
  }
  chain.reverse();

  const input: any[] = [];
  for (const n of chain) {
    if (n.kind !== 'text') continue;
    const text = typeof n.content === 'string' ? n.content : String((n as any)?.content ?? '');
    if (!text.trim()) continue;
    if (n.author === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text }] });
    } else {
      input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    }
  }
  return input;
}

export default function App() {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const generationJobsRef = useRef<Map<string, ChatGenerationJob>>(new Map());
  const [debug, setDebug] = useState<WorldEngineDebug | null>(null);
  const [ui, setUi] = useState(() => ({
    selectedNodeId: null as string | null,
    editingNodeId: null as string | null,
    editingText: '',
    tool: 'select' as 'select' | 'draw',
  }));
  const [viewport, setViewport] = useState(() => ({ w: 1, h: 1 }));
  const [composerDraft, setComposerDraft] = useState('');
  const [replySelection, setReplySelection] = useState<ReplySelection | null>(null);
  const [, setGenerationUiVersion] = useState(0);

  const initial = useMemo(() => {
    const chatId = genId('chat');
    const root: WorkspaceFolder = {
      kind: 'folder',
      id: 'root',
      name: 'Workspace',
      expanded: true,
      children: [{ kind: 'chat', id: chatId, name: 'Chat 1' }],
    };
    const chatStates = new Map<string, WorldEngineChatState>();
    chatStates.set(chatId, createEmptyChatState());
    const chatMeta = new Map<string, ChatRuntimeMeta>();
    chatMeta.set(chatId, { draft: '', replyTo: null, headNodeId: null, turns: [] });
    return { root, chatId, chatStates, chatMeta };
  }, []);

  const [treeRoot, setTreeRoot] = useState<WorkspaceFolder>(() => initial.root);
  const [activeChatId, setActiveChatId] = useState<string>(() => initial.chatId);
  const [focusedFolderId, setFocusedFolderId] = useState<string>(() => initial.root.id);
  const chatStatesRef = useRef<Map<string, WorldEngineChatState>>(initial.chatStates);
  const chatMetaRef = useRef<Map<string, ChatRuntimeMeta>>(initial.chatMeta);
  const activeChatIdRef = useRef<string>(activeChatId);

  const ensureChatMeta = (chatId: string): ChatRuntimeMeta => {
    const existing = chatMetaRef.current.get(chatId);
    if (existing) return existing;
    const meta: ChatRuntimeMeta = { draft: '', replyTo: null, headNodeId: null, turns: [] };
    chatMetaRef.current.set(chatId, meta);
    return meta;
  };

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const activeJob = generationJobsRef.current.get(activeChatId) ?? null;

  const updateStoredTextNode = (chatId: string, nodeId: string, patch: Partial<Extract<ChatNode, { kind: 'text' }>>) => {
    const state = chatStatesRef.current.get(chatId);
    if (!state) return;
    const node = state.nodes.find((n): n is Extract<ChatNode, { kind: 'text' }> => n.kind === 'text' && n.id === nodeId);
    if (!node) return;
    Object.assign(node, patch);
  };

  const flushJobToStateAndEngine = (job: ChatGenerationJob) => {
    if (job.closed) return;
    const next = job.fullText;
    if (next === job.lastFlushedText) return;
    job.lastFlushedText = next;
    job.lastFlushAt = performance.now();

    updateStoredTextNode(job.chatId, job.assistantNodeId, {
      content: next,
      isGenerating: true,
      modelId: job.modelId,
      llmError: null,
    });

    if (activeChatIdRef.current === job.chatId) {
      const engine = engineRef.current;
      engine?.setTextNodeLlmState(job.assistantNodeId, { isGenerating: true, modelId: job.modelId, llmError: null });
      engine?.setTextNodeContent(job.assistantNodeId, next, { streaming: true });
    }
  };

  const scheduleJobFlush = (job: ChatGenerationJob) => {
    if (job.closed) return;
    if (job.flushTimer != null) return;
    const minIntervalMs = 50;
    const now = performance.now();
    const delay = Math.max(0, minIntervalMs - (now - job.lastFlushAt));
    job.flushTimer = window.setTimeout(() => {
      job.flushTimer = null;
      flushJobToStateAndEngine(job);
    }, delay);
  };

  const finishJob = (chatId: string, result: { finalText: string; error: string | null; cancelled?: boolean }) => {
    const job = generationJobsRef.current.get(chatId);
    if (!job) return;
    job.closed = true;
    if (job.flushTimer != null) {
      try {
        window.clearTimeout(job.flushTimer);
      } catch {
        // ignore
      }
      job.flushTimer = null;
    }

    const rawText = result.finalText ?? job.fullText;
    const finalText =
      rawText.trim() || !result.error ? rawText : result.cancelled ? 'Canceled.' : `Error: ${result.error}`;
    updateStoredTextNode(chatId, job.assistantNodeId, {
      content: finalText,
      isGenerating: false,
      modelId: job.modelId,
      llmError: result.error,
    });

    if (activeChatIdRef.current === chatId) {
      const engine = engineRef.current;
      engine?.setTextNodeContent(job.assistantNodeId, finalText, { streaming: false });
      engine?.setTextNodeLlmState(job.assistantNodeId, { isGenerating: false, modelId: job.modelId, llmError: result.error });
    }

    generationJobsRef.current.delete(chatId);
    setGenerationUiVersion((v) => v + 1);
  };

  const cancelJob = (chatId: string) => {
    const job = generationJobsRef.current.get(chatId);
    if (!job) return;
    try {
      job.abortController.abort();
    } catch {
      // ignore
    }
    finishJob(chatId, { finalText: job.fullText, error: 'Canceled', cancelled: true });
  };

  const startOpenAIGeneration = (args: { chatId: string; userNodeId: string; assistantNodeId: string }) => {
    const chatId = args.chatId;
    if (!chatId) return;
    if (generationJobsRef.current.has(chatId)) return;

    const apiKey = getOpenAIApiKey();
    if (!apiKey) {
      const msg = 'OpenAI API key missing. Set VITE_OPENAI_API_KEY in graphchatv1/.env.local';
      updateStoredTextNode(chatId, args.assistantNodeId, { content: msg, isGenerating: false, llmError: msg });
      if (activeChatIdRef.current === chatId) {
        engineRef.current?.setTextNodeContent(args.assistantNodeId, msg, { streaming: false });
        engineRef.current?.setTextNodeLlmState(args.assistantNodeId, {
          isGenerating: false,
          modelId: DEFAULT_OPENAI_MODEL_ID,
          llmError: msg,
        });
      }
      setGenerationUiVersion((v) => v + 1);
      return;
    }

    const state = chatStatesRef.current.get(chatId);
    const input = buildOpenAIInputFromChatNodes(state?.nodes ?? [], args.userNodeId);
    const request = {
      model: DEFAULT_OPENAI_MODEL_ID,
      input,
      store: false,
    } as Record<string, unknown>;

    const job: ChatGenerationJob = {
      chatId,
      userNodeId: args.userNodeId,
      assistantNodeId: args.assistantNodeId,
      modelId: DEFAULT_OPENAI_MODEL_ID,
      startedAt: Date.now(),
      abortController: new AbortController(),
      fullText: '',
      lastFlushedText: '',
      lastFlushAt: 0,
      flushTimer: null,
      closed: false,
    };

    generationJobsRef.current.set(chatId, job);
    updateStoredTextNode(chatId, job.assistantNodeId, { isGenerating: true, modelId: job.modelId, llmError: null });
    if (activeChatIdRef.current === chatId) {
      engineRef.current?.setTextNodeLlmState(job.assistantNodeId, { isGenerating: true, modelId: job.modelId, llmError: null });
    }
    setGenerationUiVersion((v) => v + 1);

    void (async () => {
      const res = await streamOpenAIResponse({
        apiKey,
        request,
        signal: job.abortController.signal,
        callbacks: {
          onDelta: (_delta, fullText) => {
            if (job.closed) return;
            job.fullText = fullText;
            scheduleJobFlush(job);
          },
        },
      });

      if (!generationJobsRef.current.has(chatId)) return;
      if (res.ok) {
        finishJob(chatId, { finalText: res.text, error: null });
      } else {
        const error = res.cancelled ? 'Canceled' : res.error;
        finishJob(chatId, { finalText: res.text ?? job.fullText, error, cancelled: res.cancelled });
      }
    })();
  };

  useEffect(() => {
    const el = composerDockRef.current;
    if (!el) return;
    const rootEl = document.documentElement;
    const update = () => {
      const height = el.getBoundingClientRect().height;
      rootEl.style.setProperty('--composer-dock-height', `${Math.ceil(height)}px`);
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const container = workspaceRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const engine = new WorldEngine({ canvas });
    engine.onDebug = setDebug;
    engine.onUiState = setUi;
    engine.onRequestReply = (nodeId) => {
      const chatId = activeChatIdRef.current;
      const meta = ensureChatMeta(chatId);
      const preview = engine.getNodeReplyPreview(nodeId);
      const next: ReplySelection = { nodeId, preview };
      meta.replyTo = next;
      setReplySelection(next);
    };
    engine.start();
    engineRef.current = engine;
    setUi(engine.getUiState());

    const initialState = chatStatesRef.current.get(activeChatId) ?? createEmptyChatState();
    chatStatesRef.current.set(activeChatId, initialState);
    engine.loadChatState(initialState);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      setViewport({ w: rect.width, h: rect.height });
      engine.resize(rect.width, rect.height);
    };

    const ro = new ResizeObserver(() => resize());
    ro.observe(container);
    resize();

    return () => {
      ro.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (ui.editingNodeId) return;
      if (!engineRef.current) return;

      const active = document.activeElement as HTMLElement | null;
      const canvas = canvasRef.current;
      const isTypingTarget =
        !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (isTypingTarget) return;
      if (active && active !== document.body && active !== document.documentElement && active !== canvas) return;

      if (e.key === 'Enter') {
        engineRef.current.beginEditingSelectedNode();
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        engineRef.current.clearSelection();
        e.preventDefault();
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        engineRef.current.deleteSelectedNode();
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ui.editingNodeId]);

  const editorAnchor = ui.editingNodeId ? engineRef.current?.getNodeScreenRect(ui.editingNodeId) ?? null : null;
  const editorTitle = ui.editingNodeId ? engineRef.current?.getNodeTitle(ui.editingNodeId) ?? null : null;
  const editorZoom = debug?.zoom ?? engineRef.current?.camera.zoom ?? 1;

  const switchChat = (nextChatId: string, opts?: { saveCurrent?: boolean }) => {
    if (!nextChatId) return;
    const engine = engineRef.current;
    const prevChatId = activeChatId;
    if (nextChatId === prevChatId) return;

    if (prevChatId) {
      const existingMeta = chatMetaRef.current.get(prevChatId);
      if (existingMeta) {
        existingMeta.draft = composerDraft;
        existingMeta.replyTo = replySelection;
      }
    }

    if (engine) {
      engine.cancelEditing();
      if (opts?.saveCurrent !== false && prevChatId) {
        chatStatesRef.current.set(prevChatId, engine.exportChatState());
      }
      const nextState = chatStatesRef.current.get(nextChatId) ?? createEmptyChatState();
      chatStatesRef.current.set(nextChatId, nextState);
      engine.loadChatState(nextState);
      setUi(engine.getUiState());
    }

    const meta = ensureChatMeta(nextChatId);
    setComposerDraft(meta.draft);
    setReplySelection(meta.replyTo);
    setActiveChatId(nextChatId);
  };

  const createChat = (parentFolderId: string) => {
    const id = genId('chat');
    const item: WorkspaceChat = { kind: 'chat', id, name: 'New chat' };
    setTreeRoot((prev) => insertItem(prev, parentFolderId || prev.id, item));
    chatStatesRef.current.set(id, createEmptyChatState());
    chatMetaRef.current.set(id, { draft: '', replyTo: null, headNodeId: null, turns: [] });
    switchChat(id);
  };

  const createFolder = (parentFolderId: string) => {
    const id = genId('folder');
    const folder: WorkspaceFolder = { kind: 'folder', id, name: 'New folder', expanded: true, children: [] };
    setTreeRoot((prev) => insertItem(prev, parentFolderId || prev.id, folder));
    setFocusedFolderId(id);
  };

  const deleteTreeItem = (itemId: string) => {
    if (!itemId) return;
    const existing = findItem(treeRoot, itemId);
    if (!existing) return;
    if (itemId === treeRoot.id) return;

    const label = existing.kind === 'folder' ? 'folder' : 'chat';
    if (!window.confirm(`Delete this ${label}?`)) return;

    const { root: nextRoot, removed } = deleteItem(treeRoot, itemId);
    const removedChatIds = removed ? collectChatIds(removed) : [];
    for (const chatId of removedChatIds) {
      chatStatesRef.current.delete(chatId);
      chatMetaRef.current.delete(chatId);
    }

    let nextActive = activeChatId;
    if (removedChatIds.includes(activeChatId)) {
      nextActive = findFirstChatId(nextRoot) ?? '';
      if (!nextActive) {
        const id = genId('chat');
        const item: WorkspaceChat = { kind: 'chat', id, name: 'Chat 1' };
        const rootWithChat = insertItem(nextRoot, nextRoot.id, item);
        setTreeRoot(rootWithChat);
        chatStatesRef.current.set(id, createEmptyChatState());
        chatMetaRef.current.set(id, { draft: '', replyTo: null, headNodeId: null, turns: [] });
        switchChat(id, { saveCurrent: false });
        return;
      }
    }

    setTreeRoot(nextRoot);
    if (nextActive !== activeChatId) switchChat(nextActive, { saveCurrent: false });
  };

  return (
    <div className="app">
      <WorkspaceSidebar
        root={treeRoot}
        activeChatId={activeChatId}
        focusedFolderId={focusedFolderId}
        onFocusFolder={setFocusedFolderId}
        onToggleFolder={(folderId) => setTreeRoot((prev) => toggleFolder(prev, folderId))}
        onSelectChat={(chatId) => switchChat(chatId)}
        onCreateChat={(folderId) => createChat(folderId)}
        onCreateFolder={(folderId) => createFolder(folderId)}
        onRenameItem={(itemId, name) => setTreeRoot((prev) => renameItem(prev, itemId, name))}
        onDeleteItem={(itemId) => deleteTreeItem(itemId)}
        onMoveItem={(itemId, folderId) => setTreeRoot((prev) => moveItem(prev, itemId, folderId))}
      />

      <div className="workspace" ref={workspaceRef}>
        <canvas className="stage" ref={canvasRef} />
        {ui.editingNodeId ? (
          <TextNodeEditor
            nodeId={ui.editingNodeId}
            title={editorTitle}
            initialValue={ui.editingText}
            anchorRect={editorAnchor}
            viewport={viewport}
            zoom={editorZoom}
            onCommit={(next) => engineRef.current?.commitEditing(next)}
            onCancel={() => engineRef.current?.cancelEditing()}
          />
        ) : null}

        <ChatComposer
          containerRef={composerDockRef}
          value={composerDraft}
          onChange={(next) => {
            setComposerDraft(next);
            ensureChatMeta(activeChatId).draft = next;
          }}
          replyPreview={replySelection?.preview ?? null}
          onCancelReply={() => {
            const meta = ensureChatMeta(activeChatId);
            meta.replyTo = null;
            setReplySelection(null);
          }}
          isGenerating={Boolean(activeJob)}
          onCancelGeneration={() => cancelJob(activeChatId)}
          sendDisabled={!composerDraft.trim() || Boolean(activeJob)}
          onSend={() => {
            const engine = engineRef.current;
            if (!engine) return;
            const raw = composerDraft;
            if (!raw.trim()) return;
            if (generationJobsRef.current.has(activeChatId)) return;

            const meta = ensureChatMeta(activeChatId);
            const desiredParentId = replySelection?.nodeId && engine.hasNode(replySelection.nodeId) ? replySelection.nodeId : null;
            const res = engine.spawnChatTurn({ userText: raw, parentNodeId: desiredParentId });

            meta.turns.push({
              id: genId('turn'),
              createdAt: Date.now(),
              userNodeId: res.userNodeId,
              assistantNodeId: res.assistantNodeId,
              attachmentNodeIds: [],
            });
            meta.headNodeId = res.assistantNodeId;
            meta.replyTo = null;
            meta.draft = '';
            setReplySelection(null);
            setComposerDraft('');

            const snapshot = engine.exportChatState();
            chatStatesRef.current.set(activeChatId, snapshot);
            startOpenAIGeneration({ chatId: activeChatId, userNodeId: res.userNodeId, assistantNodeId: res.assistantNodeId });
          }}
        />
        <div
          className="controls"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="controls__title">{findItem(treeRoot, activeChatId)?.name ?? 'Chat'}</div>
          <input
            ref={pdfInputRef}
            className="controls__fileInput"
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!file) return;
              void engineRef.current?.importPdfFromFile(file);
            }}
          />
          <button className="controls__btn" type="button" onClick={() => pdfInputRef.current?.click()}>
            Import PDF
          </button>
          <button
            className={`controls__btn ${ui.tool === 'select' ? 'controls__btn--active' : ''}`}
            type="button"
            onClick={() => engineRef.current?.setTool('select')}
          >
            Select
          </button>
          <button
            className={`controls__btn ${ui.tool === 'draw' ? 'controls__btn--active' : ''}`}
            type="button"
            onClick={() => engineRef.current?.setTool('draw')}
          >
            Draw
          </button>
          <button className="controls__btn" type="button" onClick={() => engineRef.current?.spawnInkNode()}>
            New Ink Node
          </button>
          <button className="controls__btn" type="button" onClick={() => engineRef.current?.spawnLatexStressTest(50)}>
            +50 nodes
          </button>
          <button className="controls__btn" type="button" onClick={() => engineRef.current?.clearStressNodes()}>
            Clear
          </button>
        </div>
        <div className="hud">
          <div style={{ fontWeight: 650, marginBottom: 2 }}>GraphChatV1</div>
          <div style={{ opacity: 0.9 }}>
            {debug
              ? `zoom ${debug.zoom.toFixed(2)} • cam ${debug.cameraX.toFixed(1)}, ${debug.cameraY.toFixed(1)} • ${
                  debug.interacting ? 'interacting' : 'idle'
                }`
              : 'starting…'}
          </div>
        </div>
      </div>
    </div>
  );
}
