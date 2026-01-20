import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorldEngine, type WorldEngineDebug } from './engine/WorldEngine';
import ChatComposer from './components/ChatComposer';
import RawPayloadViewer from './components/RawPayloadViewer';
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
import type { ChatAttachment, ChatNode } from './model/chat';
import { buildOpenAIResponseRequest, type OpenAIChatSettings } from './llm/openai';
import { DEFAULT_MODEL_ID, listModels, type TextVerbosity } from './llm/registry';
import { readFileAsDataUrl, splitDataUrl } from './utils/files';
import { deleteAttachment, deleteAttachments, getAttachment, listAttachmentKeys, putAttachment } from './storage/attachments';
import {
  deleteChatMetaRecord,
  deleteChatStateRecord,
  getChatMetaRecord,
  getChatStateRecord,
  getWorkspaceSnapshot,
  putChatMetaRecord,
  putChatStateRecord,
  putWorkspaceSnapshot,
} from './storage/persistence';

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
  draftAttachments: ChatAttachment[];
  replyTo: ReplySelection | null;
  selectedAttachmentKeys: string[];
  headNodeId: string | null;
  turns: ChatTurnMeta[];
  llm: OpenAIChatSettings;
  backgroundStorageKey: string | null;
  glassNodesEnabled: boolean;
};

type GenerationJob = {
  chatId: string;
  userNodeId: string;
  assistantNodeId: string;
  modelId: string;
  llmParams: NonNullable<Extract<ChatNode, { kind: 'text' }>['llmParams']>;
  startedAt: number;
  abortController: AbortController;
  fullText: string;
  lastFlushedText: string;
  lastFlushAt: number;
  flushTimer: number | null;
  closed: boolean;
};

type RawViewerState = {
  nodeId: string;
  title: string;
  kind: 'request' | 'response';
  payload: unknown;
};

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

function isProbablyDataUrl(value: string): boolean {
  return /^data:[^,]+,/.test(value);
}

function truncateDataUrlForDisplay(value: string, maxChars: number): string {
  const s = String(value ?? '');
  if (s.length <= maxChars) return s;
  const comma = s.indexOf(',');
  if (comma === -1) return `${s.slice(0, maxChars)}… (${s.length} chars)`;
  const prefix = s.slice(0, comma + 1);
  const data = s.slice(comma + 1);
  const keep = Math.max(0, maxChars - prefix.length);
  return `${prefix}${data.slice(0, keep)}… (${data.length} chars)`;
}

function cloneRawPayloadForDisplay(payload: unknown, opts?: { maxDepth?: number; maxStringChars?: number; maxDataUrlChars?: number }): unknown {
  const maxDepth = Math.max(1, Math.floor(opts?.maxDepth ?? 30));
  const maxStringChars = Math.max(256, Math.floor(opts?.maxStringChars ?? 20000));
  const maxDataUrlChars = Math.max(64, Math.floor(opts?.maxDataUrlChars ?? 220));

  const seen = new WeakMap<object, unknown>();
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > maxDepth) return '[Max depth]';
    if (typeof value === 'string') {
      if (isProbablyDataUrl(value)) return truncateDataUrlForDisplay(value, maxDataUrlChars);
      if (value.length > maxStringChars) return `${value.slice(0, maxStringChars)}… (${value.length} chars)`;
      return value;
    }
    if (value == null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return seen.get(value as object);

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value as object, out);
      for (const item of value) out.push(visit(item, depth + 1));
      return out;
    }

    const out: Record<string, unknown> = {};
    seen.set(value as object, out);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = visit(v, depth + 1);
    return out;
  };

  return visit(payload, 0);
}

async function fileToChatAttachment(file: File): Promise<ChatAttachment | null> {
  const name = (file.name ?? '').trim() || undefined;
  const lowerName = (name ?? '').toLowerCase();
  const type = (file.type ?? '').toLowerCase();
  const size = Number.isFinite(file.size) ? file.size : undefined;

  const isPdf = type === 'application/pdf' || lowerName.endsWith('.pdf');
  const isImage =
    type.startsWith('image/') ||
    lowerName.endsWith('.png') ||
    lowerName.endsWith('.jpg') ||
    lowerName.endsWith('.jpeg') ||
    lowerName.endsWith('.gif') ||
    lowerName.endsWith('.webp');

  if (!isPdf && !isImage) return null;

  if (isPdf) {
    const mimeType = 'application/pdf' as const;
    try {
      const storageKey = await putAttachment({ blob: file, mimeType, name, size });
      return { kind: 'pdf', name, mimeType, storageKey, size };
    } catch {
      const dataUrl = await readFileAsDataUrl(file);
      const parts = splitDataUrl(dataUrl);
      if (!parts?.base64) return null;
      return { kind: 'pdf', name, mimeType, data: parts.base64, size };
    }
  }

  const mimeType = type.startsWith('image/') ? type : 'image/png';
  try {
    const storageKey = await putAttachment({ blob: file, mimeType, name, size });
    return { kind: 'image', name, mimeType, storageKey, size, detail: 'auto' };
  } catch {
    const dataUrl = await readFileAsDataUrl(file);
    const parts = splitDataUrl(dataUrl);
    if (!parts?.base64) return null;
    return { kind: 'image', name, mimeType: parts.mimeType || mimeType, data: parts.base64, size, detail: 'auto' };
  }
}

type ContextAttachmentItem = {
  key: string;
  nodeId: string;
  attachment: ChatAttachment;
};

function collectAttachmentStorageKeys(nodes: ChatNode[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.kind === 'text') {
      const atts = Array.isArray((n as any)?.attachments) ? ((n as any).attachments as ChatAttachment[]) : [];
      for (const att of atts) {
        if (!att) continue;
        const storageKey =
          att.kind === 'image' || att.kind === 'pdf' ? (typeof att.storageKey === 'string' ? att.storageKey : '') : '';
        if (storageKey) out.add(storageKey);
      }
      continue;
    }

    if (n.kind === 'pdf') {
      const storageKey = typeof (n as any)?.storageKey === 'string' ? String((n as any).storageKey) : '';
      if (storageKey) out.add(storageKey);
    }
  }
  return Array.from(out);
}

function collectContextAttachments(nodes: ChatNode[], startNodeId: string): ContextAttachmentItem[] {
  const byId = new Map<string, ChatNode>();
  for (const n of nodes) byId.set(n.id, n);

  const out: ContextAttachmentItem[] = [];
  let cur: ChatNode | null = byId.get(startNodeId) ?? null;
  while (cur) {
    if (cur.kind === 'text' && cur.author === 'user' && Array.isArray(cur.attachments)) {
      for (let i = 0; i < cur.attachments.length; i += 1) {
        const att = cur.attachments[i];
        if (!att) continue;
        out.push({ key: `${cur.id}:${i}`, nodeId: cur.id, attachment: att });
      }
    }
    const parentId = (cur as any)?.parentId as string | null | undefined;
    if (!parentId) break;
    cur = byId.get(parentId) ?? null;
  }

  return out;
}

function collectAllReferencedAttachmentKeys(args: {
  chatIds: string[];
  chatStates: Map<string, WorldEngineChatState>;
  chatMeta: Map<string, ChatRuntimeMeta>;
}): Set<string> {
  const referenced = new Set<string>();
  const chatIds = args.chatIds ?? [];

  for (const chatId of chatIds) {
    const state = args.chatStates.get(chatId);
    if (state) {
      for (const key of collectAttachmentStorageKeys(state.nodes ?? [])) referenced.add(key);
    }

    const meta = args.chatMeta.get(chatId);
    const bgKey = typeof meta?.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : '';
    if (bgKey) referenced.add(bgKey);
    const draft = meta?.draftAttachments ?? [];
    for (const att of draft) {
      if (!att) continue;
      if (att.kind !== 'image' && att.kind !== 'pdf') continue;
      const key = typeof att.storageKey === 'string' ? att.storageKey : '';
      if (key) referenced.add(key);
    }
  }

  return referenced;
}

export default function App() {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const generationJobsByAssistantIdRef = useRef<Map<string, GenerationJob>>(new Map());
  const [debug, setDebug] = useState<WorldEngineDebug | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const engineReadyRef = useRef(false);
  const bootedRef = useRef(false);
  const bootPayloadRef = useRef<{
    root: WorkspaceFolder;
    activeChatId: string;
    focusedFolderId: string;
    chatStates: Map<string, WorldEngineChatState>;
    chatMeta: Map<string, ChatRuntimeMeta>;
  } | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const hydratingPdfChatsRef = useRef<Set<string>>(new Set());
  const attachmentsGcDirtyRef = useRef(false);
  const attachmentsGcRunningRef = useRef(false);
  const attachmentsGcLastRunAtRef = useRef(0);
  const [ui, setUi] = useState(() => ({
    selectedNodeId: null as string | null,
    editingNodeId: null as string | null,
    editingText: '',
    tool: 'select' as 'select' | 'draw',
  }));
  const [rawViewer, setRawViewer] = useState<RawViewerState | null>(null);
  const [viewport, setViewport] = useState(() => ({ w: 1, h: 1 }));
  const [composerDraft, setComposerDraft] = useState('');
  const [composerDraftAttachments, setComposerDraftAttachments] = useState<ChatAttachment[]>(() => []);
  const [replySelection, setReplySelection] = useState<ReplySelection | null>(null);
  const [replyContextAttachments, setReplyContextAttachments] = useState<ContextAttachmentItem[]>(() => []);
  const [replySelectedAttachmentKeys, setReplySelectedAttachmentKeys] = useState<string[]>(() => []);
  const [backgroundStorageKey, setBackgroundStorageKey] = useState<string | null>(() => null);
  const [glassNodesEnabled, setGlassNodesEnabled] = useState<boolean>(() => false);
  const backgroundLoadSeqRef = useRef(0);
  const modelOptions = useMemo(() => listModels(), []);
  const [composerModelId, setComposerModelId] = useState<string>(() => DEFAULT_MODEL_ID);
  const [composerVerbosity, setComposerVerbosity] = useState<TextVerbosity>(() => 'medium');
  const [composerWebSearch, setComposerWebSearch] = useState<boolean>(() => false);

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
    chatMeta.set(chatId, {
      draft: '',
      draftAttachments: [],
      replyTo: null,
      selectedAttachmentKeys: [],
      headNodeId: null,
      turns: [],
      llm: { modelId: DEFAULT_MODEL_ID, verbosity: 'medium', webSearchEnabled: false },
      backgroundStorageKey: null,
      glassNodesEnabled: false,
    });
    return { root, chatId, chatStates, chatMeta };
  }, []);

  const [treeRoot, setTreeRoot] = useState<WorkspaceFolder>(() => initial.root);
  const [activeChatId, setActiveChatId] = useState<string>(() => initial.chatId);
  const [focusedFolderId, setFocusedFolderId] = useState<string>(() => initial.root.id);
  const treeRootRef = useRef<WorkspaceFolder>(initial.root);
  const focusedFolderIdRef = useRef<string>(initial.root.id);
  const chatStatesRef = useRef<Map<string, WorldEngineChatState>>(initial.chatStates);
  const chatMetaRef = useRef<Map<string, ChatRuntimeMeta>>(initial.chatMeta);
  const activeChatIdRef = useRef<string>(activeChatId);

  const ensureChatMeta = (chatId: string): ChatRuntimeMeta => {
    const existing = chatMetaRef.current.get(chatId);
    if (existing) return existing;
    const meta: ChatRuntimeMeta = {
      draft: '',
      draftAttachments: [],
      replyTo: null,
      selectedAttachmentKeys: [],
      headNodeId: null,
      turns: [],
      llm: { modelId: DEFAULT_MODEL_ID, verbosity: 'medium', webSearchEnabled: false },
      backgroundStorageKey: null,
      glassNodesEnabled: false,
    };
    chatMetaRef.current.set(chatId, meta);
    return meta;
  };

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    setRawViewer(null);
  }, [activeChatId]);

  useEffect(() => {
    engineReadyRef.current = engineReady;
  }, [engineReady]);

  useEffect(() => {
    treeRootRef.current = treeRoot;
  }, [treeRoot]);

  useEffect(() => {
    focusedFolderIdRef.current = focusedFolderId;
  }, [focusedFolderId]);

  const schedulePersistSoon = useMemo(() => {
    const persist = () => {
      if (!bootedRef.current) return;
      const root = treeRootRef.current;
      const active = activeChatIdRef.current;
      const focused = focusedFolderIdRef.current;

      const chatIds = collectChatIds(root);
      const engine = engineRef.current;
      if (engine && active) {
        try {
          chatStatesRef.current.set(active, engine.exportChatState());
        } catch {
          // ignore
        }
      }

      void (async () => {
        try {
          await putWorkspaceSnapshot({ key: 'workspace', root, activeChatId: active, focusedFolderId: focused });
        } catch {
          // ignore
        }

        for (const chatId of chatIds) {
          const state = chatStatesRef.current.get(chatId);
          if (state) {
            try {
              await putChatStateRecord(chatId, {
                camera: state.camera,
                nodes: state.nodes,
                worldInkStrokes: state.worldInkStrokes,
              });
            } catch {
              // ignore
            }
          }
          const meta = chatMetaRef.current.get(chatId);
          if (meta) {
            try {
              await putChatMetaRecord(chatId, meta);
            } catch {
              // ignore
            }
          }
        }

        if (attachmentsGcDirtyRef.current && !attachmentsGcRunningRef.current) {
          const now = Date.now();
          const minIntervalMs = 5000;
          if (now - attachmentsGcLastRunAtRef.current >= minIntervalMs) {
            attachmentsGcRunningRef.current = true;
            try {
              const referenced = collectAllReferencedAttachmentKeys({
                chatIds,
                chatStates: chatStatesRef.current,
                chatMeta: chatMetaRef.current,
              });
              const allKeys = await listAttachmentKeys();
              const toDelete = allKeys.filter((k) => !referenced.has(k));
              if (toDelete.length) await deleteAttachments(toDelete);
              attachmentsGcDirtyRef.current = false;
              attachmentsGcLastRunAtRef.current = Date.now();
            } catch {
              // ignore
            } finally {
              attachmentsGcRunningRef.current = false;
            }
          }
        }
      })();
    };

    return () => {
      if (!bootedRef.current) return;
      if (persistTimerRef.current != null) return;
      persistTimerRef.current = window.setTimeout(() => {
        persistTimerRef.current = null;
        persist();
      }, 350);
    };
  }, []);

  useEffect(() => {
    if (!bootedRef.current) return;
    if (!debug) return;
    if (debug.interacting) return;
    schedulePersistSoon();
  }, [debug?.interacting, schedulePersistSoon]);

  const applyVisualSettings = (chatId: string) => {
    const engine = engineRef.current;
    if (!engine) return;

    const meta = ensureChatMeta(chatId);
    engine.setGlassNodesEnabled(Boolean(meta.glassNodesEnabled));

    const key = typeof meta.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : null;
    const seq = (backgroundLoadSeqRef.current += 1);
    if (!key) {
      engine.clearBackground();
      return;
    }

    void (async () => {
      const rec = await getAttachment(key);
      if (backgroundLoadSeqRef.current !== seq) return;
      if (!rec?.blob) {
        const latest = ensureChatMeta(chatId);
        if (latest.backgroundStorageKey === key) latest.backgroundStorageKey = null;
        if (activeChatIdRef.current === chatId) setBackgroundStorageKey(null);
        attachmentsGcDirtyRef.current = true;
        engine.clearBackground();
        schedulePersistSoon();
        return;
      }
      await engine.setBackgroundFromBlob(rec.blob);
    })();
  };

  const hydratePdfNodesForChat = (chatId: string, state: WorldEngineChatState) => {
    const cid = chatId;
    if (!cid) return;
    if (hydratingPdfChatsRef.current.has(cid)) return;

    const pdfNodes = (state?.nodes ?? []).filter(
      (n): n is Extract<ChatNode, { kind: 'pdf' }> =>
        n.kind === 'pdf' && typeof (n as any)?.storageKey === 'string' && Boolean(String((n as any).storageKey).trim()),
    );
    if (pdfNodes.length === 0) return;

    hydratingPdfChatsRef.current.add(cid);
    void (async () => {
      try {
        const engine = engineRef.current;
        if (!engine) return;

        for (const node of pdfNodes) {
          const storageKey = String((node as any).storageKey ?? '').trim();
          if (!storageKey) continue;
          const rec = await getAttachment(storageKey);
          if (!rec?.blob) continue;
          const buf = await rec.blob.arrayBuffer();
          await engine.hydratePdfNodeFromArrayBuffer({
            nodeId: node.id,
            buffer: buf,
            fileName: node.fileName ?? null,
            storageKey,
          });
        }
      } finally {
        hydratingPdfChatsRef.current.delete(cid);
        schedulePersistSoon();
      }
    })();
  };

  const updateStoredTextNode = (chatId: string, nodeId: string, patch: Partial<Extract<ChatNode, { kind: 'text' }>>) => {
    const state = chatStatesRef.current.get(chatId);
    if (!state) return;
    const node = state.nodes.find((n): n is Extract<ChatNode, { kind: 'text' }> => n.kind === 'text' && n.id === nodeId);
    if (!node) return;
    Object.assign(node, patch);
  };

  const flushJobToStateAndEngine = (job: GenerationJob) => {
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

  const scheduleJobFlush = (job: GenerationJob) => {
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

  const finishJob = (
    assistantNodeId: string,
    result: { finalText: string; error: string | null; cancelled?: boolean; apiResponse?: unknown },
  ) => {
    const job = generationJobsByAssistantIdRef.current.get(assistantNodeId);
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
    const patch: Partial<Extract<ChatNode, { kind: 'text' }>> = {
      content: finalText,
      isGenerating: false,
      modelId: job.modelId,
      llmError: result.error,
    };
    if (result.apiResponse !== undefined) patch.apiResponse = result.apiResponse;
    updateStoredTextNode(job.chatId, job.assistantNodeId, patch);

    if (activeChatIdRef.current === job.chatId) {
      const engine = engineRef.current;
      engine?.setTextNodeContent(job.assistantNodeId, finalText, { streaming: false });
      engine?.setTextNodeLlmState(job.assistantNodeId, { isGenerating: false, modelId: job.modelId, llmError: result.error });
      if (result.apiResponse !== undefined) engine?.setTextNodeApiPayload(job.assistantNodeId, { apiResponse: result.apiResponse });
    }

    generationJobsByAssistantIdRef.current.delete(assistantNodeId);
    schedulePersistSoon();
  };

  const cancelJob = (assistantNodeId: string) => {
    const job = generationJobsByAssistantIdRef.current.get(assistantNodeId);
    if (!job) return;
    try {
      job.abortController.abort();
    } catch {
      // ignore
    }
    finishJob(assistantNodeId, { finalText: job.fullText, error: 'Canceled', cancelled: true });
  };

  const startOpenAIGeneration = (args: {
    chatId: string;
    userNodeId: string;
    assistantNodeId: string;
    settings: OpenAIChatSettings;
  }) => {
    const chatId = args.chatId;
    if (!chatId) return;
    if (generationJobsByAssistantIdRef.current.has(args.assistantNodeId)) return;

    const apiKey = getOpenAIApiKey();
    if (!apiKey) {
      const msg = 'OpenAI API key missing. Set VITE_OPENAI_API_KEY in graphchatv1/.env.local';
      updateStoredTextNode(chatId, args.assistantNodeId, { content: msg, isGenerating: false, llmError: msg });
      if (activeChatIdRef.current === chatId) {
        engineRef.current?.setTextNodeContent(args.assistantNodeId, msg, { streaming: false });
        engineRef.current?.setTextNodeLlmState(args.assistantNodeId, {
          isGenerating: false,
          modelId: args.settings.modelId,
          llmError: msg,
        });
      }
      return;
    }

    const state = chatStatesRef.current.get(chatId);
    const settings = args.settings;
    const llmParams = { verbosity: settings.verbosity, webSearchEnabled: settings.webSearchEnabled };

    const job: GenerationJob = {
      chatId,
      userNodeId: args.userNodeId,
      assistantNodeId: args.assistantNodeId,
      modelId: settings.modelId,
      llmParams,
      startedAt: Date.now(),
      abortController: new AbortController(),
      fullText: '',
      lastFlushedText: '',
      lastFlushAt: 0,
      flushTimer: null,
      closed: false,
    };

    generationJobsByAssistantIdRef.current.set(job.assistantNodeId, job);
    updateStoredTextNode(chatId, job.assistantNodeId, {
      isGenerating: true,
      modelId: job.modelId,
      llmParams: job.llmParams,
      llmError: null,
    });
    if (activeChatIdRef.current === chatId) {
      engineRef.current?.setTextNodeLlmState(job.assistantNodeId, {
        isGenerating: true,
        modelId: job.modelId,
        llmParams: job.llmParams,
        llmError: null,
      });
    }

    void (async () => {
      let request: Record<string, unknown>;
      try {
        request = await buildOpenAIResponseRequest({
          nodes: state?.nodes ?? [],
          leafUserNodeId: args.userNodeId,
          settings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finishJob(job.assistantNodeId, { finalText: job.fullText, error: msg });
        return;
      }
      if (job.closed || job.abortController.signal.aborted) return;

      const sentRequest = { ...(request ?? {}), stream: true };
      const storedRequest = cloneRawPayloadForDisplay(sentRequest);
      updateStoredTextNode(chatId, job.userNodeId, { apiRequest: storedRequest });
      if (activeChatIdRef.current === chatId) {
        engineRef.current?.setTextNodeApiPayload(job.userNodeId, { apiRequest: storedRequest });
      }
      schedulePersistSoon();

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

      if (!generationJobsByAssistantIdRef.current.has(job.assistantNodeId)) return;
      const storedResponse = res.response !== undefined ? cloneRawPayloadForDisplay(res.response) : undefined;
      if (res.ok) {
        finishJob(job.assistantNodeId, { finalText: res.text, error: null, apiResponse: storedResponse });
      } else {
        const error = res.cancelled ? 'Canceled' : res.error;
        finishJob(job.assistantNodeId, { finalText: res.text ?? job.fullText, error, cancelled: res.cancelled, apiResponse: storedResponse });
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
      const snapshot = engine.exportChatState();
      const ctx = collectContextAttachments(snapshot.nodes, nodeId);
      const keys = ctx.map((it) => it.key);
      meta.replyTo = next;
      meta.selectedAttachmentKeys = keys;
      setReplySelection(next);
      setReplyContextAttachments(ctx);
      setReplySelectedAttachmentKeys(keys);
    };
    engine.onRequestRaw = (nodeId) => {
      const snapshot = engine.exportChatState();
      const node = snapshot.nodes.find((n): n is Extract<ChatNode, { kind: 'text' }> => n.kind === 'text' && n.id === nodeId) ?? null;
      if (!node) return;
      const kind: RawViewerState['kind'] = node.author === 'user' ? 'request' : 'response';
      const payload = kind === 'request' ? node.apiRequest : node.apiResponse;
      const title = `${kind === 'request' ? 'Raw request' : 'Raw response'} • ${node.title}`;
      setRawViewer((prev) => (prev?.nodeId === nodeId ? null : { nodeId, title, kind, payload }));
    };
    engine.onRequestCancelGeneration = (nodeId) => cancelJob(nodeId);
    engine.start();
    engineRef.current = engine;
    setUi(engine.getUiState());

    const initialState = chatStatesRef.current.get(activeChatId) ?? createEmptyChatState();
    chatStatesRef.current.set(activeChatId, initialState);
    engine.loadChatState(initialState);
    setEngineReady(true);

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
        attachmentsGcDirtyRef.current = true;
        schedulePersistSoon();
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ui.editingNodeId]);

  const editorAnchor = ui.editingNodeId ? engineRef.current?.getNodeScreenRect(ui.editingNodeId) ?? null : null;
  const editorTitle = ui.editingNodeId ? engineRef.current?.getNodeTitle(ui.editingNodeId) ?? null : null;
  const editorZoom = debug?.zoom ?? engineRef.current?.camera.zoom ?? 1;
  const rawAnchor = rawViewer ? engineRef.current?.getNodeScreenRect(rawViewer.nodeId) ?? null : null;

  const switchChat = (nextChatId: string, opts?: { saveCurrent?: boolean }) => {
    if (!nextChatId) return;
    const engine = engineRef.current;
    const prevChatId = activeChatId;
    if (nextChatId === prevChatId) return;

    if (prevChatId) {
      const existingMeta = chatMetaRef.current.get(prevChatId);
      if (existingMeta) {
        existingMeta.draft = composerDraft;
        existingMeta.draftAttachments = composerDraftAttachments;
        existingMeta.replyTo = replySelection;
        existingMeta.selectedAttachmentKeys = replySelectedAttachmentKeys;
        existingMeta.llm = {
          modelId: composerModelId,
          verbosity: composerVerbosity,
          webSearchEnabled: composerWebSearch,
        };
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
      if ((nextState.pdfStates?.length ?? 0) === 0) {
        hydratePdfNodesForChat(nextChatId, nextState);
      }
    }

    const meta = ensureChatMeta(nextChatId);
    setComposerDraft(meta.draft);
    setComposerDraftAttachments(Array.isArray(meta.draftAttachments) ? meta.draftAttachments : []);
    setReplySelection(meta.replyTo);
    setReplySelectedAttachmentKeys(Array.isArray(meta.selectedAttachmentKeys) ? meta.selectedAttachmentKeys : []);
    setBackgroundStorageKey(typeof meta.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : null);
    setGlassNodesEnabled(Boolean(meta.glassNodesEnabled));
    if (meta.replyTo?.nodeId) {
      const nextState = chatStatesRef.current.get(nextChatId) ?? createEmptyChatState();
      setReplyContextAttachments(collectContextAttachments(nextState.nodes, meta.replyTo.nodeId));
    } else {
      setReplyContextAttachments([]);
    }
    setComposerModelId(meta.llm.modelId || DEFAULT_MODEL_ID);
    setComposerVerbosity((meta.llm.verbosity as TextVerbosity) || 'medium');
    setComposerWebSearch(Boolean(meta.llm.webSearchEnabled));
    setActiveChatId(nextChatId);
    applyVisualSettings(nextChatId);
    schedulePersistSoon();
  };

  const applyBootPayload = (payload: NonNullable<typeof bootPayloadRef.current>) => {
    if (!payload) return;
    if (bootedRef.current) return;

    const root = payload.root;
    const chatStates = payload.chatStates;
    const chatMeta = payload.chatMeta;
    const desiredActive = payload.activeChatId;

    setTreeRoot(root);
    setFocusedFolderId(payload.focusedFolderId || root.id);
    chatStatesRef.current = chatStates;
    chatMetaRef.current = chatMeta;

    const chatIds = collectChatIds(root);
    const active = chatIds.includes(desiredActive) ? desiredActive : findFirstChatId(root) ?? desiredActive;
    const resolvedActive = active || (chatIds[0] ?? activeChatIdRef.current);

    bootedRef.current = true;
    setActiveChatId(resolvedActive);

    const engine = engineRef.current;
    if (engine) {
      engine.cancelEditing();
      const nextState = chatStatesRef.current.get(resolvedActive) ?? createEmptyChatState();
      chatStatesRef.current.set(resolvedActive, nextState);
      engine.loadChatState(nextState);
      setUi(engine.getUiState());
      if ((nextState.pdfStates?.length ?? 0) === 0) {
        hydratePdfNodesForChat(resolvedActive, nextState);
      }
    }

    const meta = ensureChatMeta(resolvedActive);
    setComposerDraft(meta.draft);
    setComposerDraftAttachments(Array.isArray(meta.draftAttachments) ? meta.draftAttachments : []);
    setReplySelection(meta.replyTo);
    setReplySelectedAttachmentKeys(Array.isArray(meta.selectedAttachmentKeys) ? meta.selectedAttachmentKeys : []);
    setBackgroundStorageKey(typeof meta.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : null);
    setGlassNodesEnabled(Boolean(meta.glassNodesEnabled));
    if (meta.replyTo?.nodeId) {
      const nextState = chatStatesRef.current.get(resolvedActive) ?? createEmptyChatState();
      setReplyContextAttachments(collectContextAttachments(nextState.nodes, meta.replyTo.nodeId));
    } else {
      setReplyContextAttachments([]);
    }
    setComposerModelId(meta.llm.modelId || DEFAULT_MODEL_ID);
    setComposerVerbosity((meta.llm.verbosity as TextVerbosity) || 'medium');
    setComposerWebSearch(Boolean(meta.llm.webSearchEnabled));

    applyVisualSettings(resolvedActive);
    schedulePersistSoon();
  };

  useEffect(() => {
    void (async () => {
      if (bootedRef.current) return;
      let ws: Awaited<ReturnType<typeof getWorkspaceSnapshot>> = null;
      try {
        ws = await getWorkspaceSnapshot();
      } catch {
        ws = null;
      }
      if (!ws || !ws.root || ws.root.kind !== 'folder') {
        bootedRef.current = true;
        schedulePersistSoon();
        return;
      }

      const root = ws.root;
      const chatIds = collectChatIds(root);
      if (chatIds.length === 0) {
        bootedRef.current = true;
        schedulePersistSoon();
        return;
      }

      const chatStates = new Map<string, WorldEngineChatState>();
      const chatMeta = new Map<string, ChatRuntimeMeta>();

      for (const chatId of chatIds) {
        try {
          const rec = await getChatStateRecord(chatId);
          if (rec?.state) {
            const s = rec.state as any;
            chatStates.set(chatId, {
              camera: s.camera ?? { x: 0, y: 0, zoom: 1 },
              nodes: Array.isArray(s.nodes) ? (s.nodes as ChatNode[]) : [],
              worldInkStrokes: Array.isArray(s.worldInkStrokes) ? (s.worldInkStrokes as any) : [],
              pdfStates: [],
            });
          } else {
            chatStates.set(chatId, createEmptyChatState());
          }
        } catch {
          chatStates.set(chatId, createEmptyChatState());
        }

        try {
          const metaRec = await getChatMetaRecord(chatId);
          const raw = (metaRec?.meta ?? null) as any;
          const llmRaw = raw?.llm ?? null;
          const meta: ChatRuntimeMeta = {
            draft: typeof raw?.draft === 'string' ? raw.draft : '',
            draftAttachments: Array.isArray(raw?.draftAttachments) ? (raw.draftAttachments as ChatAttachment[]) : [],
            replyTo:
              raw?.replyTo && typeof raw.replyTo === 'object' && typeof raw.replyTo.nodeId === 'string'
                ? { nodeId: raw.replyTo.nodeId, preview: String(raw.replyTo.preview ?? '') }
                : null,
            selectedAttachmentKeys: Array.isArray(raw?.selectedAttachmentKeys)
              ? (raw.selectedAttachmentKeys as any[]).filter((k) => typeof k === 'string')
              : [],
            headNodeId: typeof raw?.headNodeId === 'string' ? raw.headNodeId : null,
            turns: Array.isArray(raw?.turns) ? (raw.turns as ChatTurnMeta[]) : [],
            llm: {
              modelId: typeof llmRaw?.modelId === 'string' ? llmRaw.modelId : DEFAULT_MODEL_ID,
              verbosity: typeof llmRaw?.verbosity === 'string' ? llmRaw.verbosity : 'medium',
              webSearchEnabled: Boolean(llmRaw?.webSearchEnabled),
            },
            backgroundStorageKey: typeof raw?.backgroundStorageKey === 'string' ? raw.backgroundStorageKey : null,
            glassNodesEnabled: Boolean(raw?.glassNodesEnabled),
          };
          chatMeta.set(chatId, meta);
        } catch {
          // ignore missing meta
        }
      }

      const payload = {
        root,
        activeChatId: typeof ws.activeChatId === 'string' ? ws.activeChatId : chatIds[0],
        focusedFolderId: typeof ws.focusedFolderId === 'string' ? ws.focusedFolderId : root.id,
        chatStates,
        chatMeta,
      };

      bootPayloadRef.current = payload;
      if (engineReadyRef.current) {
        applyBootPayload(payload);
        bootPayloadRef.current = null;
      }
    })();
  }, [schedulePersistSoon]);

  useEffect(() => {
    if (!engineReady) return;
    const payload = bootPayloadRef.current;
    if (!payload) return;
    applyBootPayload(payload);
    bootPayloadRef.current = null;
  }, [engineReady]);

  const createChat = (parentFolderId: string) => {
    const id = genId('chat');
    const item: WorkspaceChat = { kind: 'chat', id, name: 'New chat' };
    setTreeRoot((prev) => insertItem(prev, parentFolderId || prev.id, item));
    chatStatesRef.current.set(id, createEmptyChatState());
    chatMetaRef.current.set(id, {
      draft: '',
      draftAttachments: [],
      replyTo: null,
      selectedAttachmentKeys: [],
      headNodeId: null,
      turns: [],
      llm: { modelId: DEFAULT_MODEL_ID, verbosity: 'medium', webSearchEnabled: false },
      backgroundStorageKey: null,
      glassNodesEnabled: false,
    });
    switchChat(id);
  };

  const createFolder = (parentFolderId: string) => {
    const id = genId('folder');
    const folder: WorkspaceFolder = { kind: 'folder', id, name: 'New folder', expanded: true, children: [] };
    setTreeRoot((prev) => insertItem(prev, parentFolderId || prev.id, folder));
    setFocusedFolderId(id);
    schedulePersistSoon();
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

    if (removedChatIds.length > 0) {
      const removedSet = new Set(removedChatIds);
      for (const [assistantNodeId, job] of generationJobsByAssistantIdRef.current.entries()) {
        if (!removedSet.has(job.chatId)) continue;
        cancelJob(assistantNodeId);
      }
    }

    for (const chatId of removedChatIds) {
      const state = chatStatesRef.current.get(chatId);
      const nodeKeys = state ? collectAttachmentStorageKeys(state.nodes ?? []) : [];
      const meta = chatMetaRef.current.get(chatId);
      const bgKey = typeof meta?.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : '';
      const draftKeys =
        meta?.draftAttachments
          ?.map((att) => {
            if (!att) return '';
            if (att.kind !== 'image' && att.kind !== 'pdf') return '';
            return typeof att.storageKey === 'string' ? att.storageKey : '';
          })
          .filter(Boolean) ?? [];
      const keys = Array.from(new Set([...nodeKeys, ...draftKeys, ...(bgKey ? [bgKey] : [])]));
      if (keys.length) {
        void (async () => {
          for (const key of keys) {
            try {
              await deleteAttachment(key);
            } catch {
              // ignore
            }
          }
        })();
      }
      chatStatesRef.current.delete(chatId);
      chatMetaRef.current.delete(chatId);
      void deleteChatStateRecord(chatId);
      void deleteChatMetaRecord(chatId);
    }
    attachmentsGcDirtyRef.current = true;

    let nextActive = activeChatId;
    if (removedChatIds.includes(activeChatId)) {
      nextActive = findFirstChatId(nextRoot) ?? '';
      if (!nextActive) {
        const id = genId('chat');
        const item: WorkspaceChat = { kind: 'chat', id, name: 'Chat 1' };
        const rootWithChat = insertItem(nextRoot, nextRoot.id, item);
        setTreeRoot(rootWithChat);
        chatStatesRef.current.set(id, createEmptyChatState());
        chatMetaRef.current.set(id, {
          draft: '',
          draftAttachments: [],
          replyTo: null,
          selectedAttachmentKeys: [],
          headNodeId: null,
          turns: [],
          llm: { modelId: DEFAULT_MODEL_ID, verbosity: 'medium', webSearchEnabled: false },
          backgroundStorageKey: null,
          glassNodesEnabled: false,
        });
        switchChat(id, { saveCurrent: false });
        return;
      }
    }

    setTreeRoot(nextRoot);
    if (nextActive !== activeChatId) switchChat(nextActive, { saveCurrent: false });
    schedulePersistSoon();
  };

  return (
    <div className="app">
      <WorkspaceSidebar
        root={treeRoot}
        activeChatId={activeChatId}
        focusedFolderId={focusedFolderId}
        onFocusFolder={(folderId) => {
          setFocusedFolderId(folderId);
          schedulePersistSoon();
        }}
        onToggleFolder={(folderId) => {
          setTreeRoot((prev) => toggleFolder(prev, folderId));
          schedulePersistSoon();
        }}
        onSelectChat={(chatId) => switchChat(chatId)}
        onCreateChat={(folderId) => createChat(folderId)}
        onCreateFolder={(folderId) => createFolder(folderId)}
        onRenameItem={(itemId, name) => {
          setTreeRoot((prev) => renameItem(prev, itemId, name));
          schedulePersistSoon();
        }}
        onDeleteItem={(itemId) => deleteTreeItem(itemId)}
        onMoveItem={(itemId, folderId) => {
          setTreeRoot((prev) => moveItem(prev, itemId, folderId));
          schedulePersistSoon();
        }}
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
            onCommit={(next) => {
              engineRef.current?.commitEditing(next);
              schedulePersistSoon();
            }}
            onCancel={() => engineRef.current?.cancelEditing()}
          />
        ) : null}
        {rawViewer ? (
          <RawPayloadViewer
            nodeId={rawViewer.nodeId}
            title={rawViewer.title}
            kind={rawViewer.kind}
            payload={rawViewer.payload}
            anchorRect={rawAnchor}
            viewport={viewport}
            zoom={editorZoom}
            onClose={() => setRawViewer(null)}
          />
        ) : null}

        <ChatComposer
          containerRef={composerDockRef}
          value={composerDraft}
          onChange={(next) => {
            setComposerDraft(next);
            ensureChatMeta(activeChatId).draft = next;
          }}
          draftAttachments={composerDraftAttachments}
          onAddAttachmentFiles={(files) => {
            const chatId = activeChatIdRef.current;
            const list = Array.from(files ?? []);
            void (async () => {
              for (const f of list) {
                try {
                  const att = await fileToChatAttachment(f);
                  if (!att) continue;
                  const meta = ensureChatMeta(chatId);
                  meta.draftAttachments.push(att);
                  if (activeChatIdRef.current === chatId) {
                    setComposerDraftAttachments((prev) => [...prev, att]);
                  }
                } catch {
                  // ignore
                }
              }
            })();
          }}
          onRemoveDraftAttachment={(index) => {
            const idx = Math.max(0, Math.floor(index));
            const meta = ensureChatMeta(activeChatId);
            const removed = meta.draftAttachments[idx] ?? null;
            meta.draftAttachments = meta.draftAttachments.filter((_att, i) => i !== idx);
            const storageKey =
              removed && (removed.kind === 'image' || removed.kind === 'pdf') ? (removed.storageKey as string | undefined) : undefined;
            if (storageKey) void deleteAttachment(storageKey);
            setComposerDraftAttachments(meta.draftAttachments);
          }}
          contextAttachments={replyContextAttachments}
          selectedContextAttachmentKeys={replySelectedAttachmentKeys}
          onToggleContextAttachmentKey={(key, included) => {
            const meta = ensureChatMeta(activeChatId);
            const set = new Set(meta.selectedAttachmentKeys);
            if (included) set.add(key);
            else set.delete(key);
            const next = Array.from(set);
            meta.selectedAttachmentKeys = next;
            setReplySelectedAttachmentKeys(next);
          }}
          modelId={composerModelId}
          modelOptions={modelOptions}
          onChangeModelId={(next) => {
            const value = next || DEFAULT_MODEL_ID;
            setComposerModelId(value);
            ensureChatMeta(activeChatId).llm.modelId = value;
          }}
          verbosity={composerVerbosity}
          onChangeVerbosity={(next) => {
            setComposerVerbosity(next);
            ensureChatMeta(activeChatId).llm.verbosity = next;
          }}
          webSearchEnabled={composerWebSearch}
          onChangeWebSearchEnabled={(next) => {
            setComposerWebSearch(next);
            ensureChatMeta(activeChatId).llm.webSearchEnabled = next;
          }}
          replyPreview={replySelection?.preview ?? null}
          onCancelReply={() => {
            const meta = ensureChatMeta(activeChatId);
            meta.replyTo = null;
            meta.selectedAttachmentKeys = [];
            setReplySelection(null);
            setReplyContextAttachments([]);
            setReplySelectedAttachmentKeys([]);
          }}
          sendDisabled={!composerDraft.trim() && composerDraftAttachments.length === 0}
          onSend={() => {
            const engine = engineRef.current;
            if (!engine) return;
            const raw = composerDraft;
            if (!raw.trim() && composerDraftAttachments.length === 0) return;

            const meta = ensureChatMeta(activeChatId);
            const desiredParentId = replySelection?.nodeId && engine.hasNode(replySelection.nodeId) ? replySelection.nodeId : null;
            const res = engine.spawnChatTurn({
              userText: raw,
              parentNodeId: desiredParentId,
              userAttachments: composerDraftAttachments.length ? composerDraftAttachments : undefined,
              selectedAttachmentKeys: replySelectedAttachmentKeys.length ? replySelectedAttachmentKeys : undefined,
            });

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
            meta.draftAttachments = [];
            meta.selectedAttachmentKeys = [];
            setReplySelection(null);
            setReplyContextAttachments([]);
            setReplySelectedAttachmentKeys([]);
            setComposerDraft('');
            setComposerDraftAttachments([]);

            const snapshot = engine.exportChatState();
            chatStatesRef.current.set(activeChatId, snapshot);
            const settings: OpenAIChatSettings = {
              modelId: composerModelId,
              verbosity: composerVerbosity,
              webSearchEnabled: composerWebSearch,
            };
            startOpenAIGeneration({
              chatId: activeChatId,
              userNodeId: res.userNodeId,
              assistantNodeId: res.assistantNodeId,
              settings,
            });
            schedulePersistSoon();
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
              void (async () => {
                try {
                  let storageKey: string | null = null;
                  try {
                    storageKey = await putAttachment({
                      blob: file,
                      mimeType: 'application/pdf',
                      name: file.name || undefined,
                      size: Number.isFinite(file.size) ? file.size : undefined,
                    });
                  } catch {
                    storageKey = null;
                  }
                  await engineRef.current?.importPdfFromFile(file, { storageKey });
                } finally {
                  schedulePersistSoon();
                }
              })();
            }}
          />
          <button className="controls__btn" type="button" onClick={() => pdfInputRef.current?.click()}>
            Import PDF
          </button>
          <input
            ref={backgroundInputRef}
            className="controls__fileInput"
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!file) return;
              const chatId = activeChatIdRef.current;
              void (async () => {
                try {
                  let storageKey: string | null = null;
                  try {
                    storageKey = await putAttachment({
                      blob: file,
                      mimeType: file.type || 'image/png',
                      name: file.name || undefined,
                      size: Number.isFinite(file.size) ? file.size : undefined,
                    });
                  } catch {
                    storageKey = null;
                  }

                  const meta = ensureChatMeta(chatId);
                  meta.backgroundStorageKey = storageKey;
                  if (activeChatIdRef.current === chatId) setBackgroundStorageKey(storageKey);
                  attachmentsGcDirtyRef.current = true;

                  await engineRef.current?.setBackgroundFromBlob(file);
                } finally {
                  schedulePersistSoon();
                }
              })();
            }}
          />
          <button className="controls__btn" type="button" onClick={() => backgroundInputRef.current?.click()}>
            Import Background
          </button>
          <button
            className="controls__btn"
            type="button"
            disabled={!backgroundStorageKey}
            onClick={() => {
              const chatId = activeChatIdRef.current;
              const meta = ensureChatMeta(chatId);
              meta.backgroundStorageKey = null;
              setBackgroundStorageKey(null);
              attachmentsGcDirtyRef.current = true;
              engineRef.current?.clearBackground();
              schedulePersistSoon();
            }}
          >
            Clear Background
          </button>
          <button
            className={`controls__btn ${glassNodesEnabled ? 'controls__btn--active' : ''}`}
            type="button"
            onClick={() => {
              const chatId = activeChatIdRef.current;
              const meta = ensureChatMeta(chatId);
              const next = !Boolean(meta.glassNodesEnabled);
              meta.glassNodesEnabled = next;
              setGlassNodesEnabled(next);
              engineRef.current?.setGlassNodesEnabled(next);
              schedulePersistSoon();
            }}
          >
            Glass Nodes
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
          <button
            className="controls__btn"
            type="button"
            onClick={() => {
              engineRef.current?.clearStressNodes();
              attachmentsGcDirtyRef.current = true;
              schedulePersistSoon();
            }}
          >
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
