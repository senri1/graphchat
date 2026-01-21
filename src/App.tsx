import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorldEngine, type GlassBlurBackend, type WorldEngineDebug } from './engine/WorldEngine';
import ChatComposer from './components/ChatComposer';
import RawPayloadViewer from './components/RawPayloadViewer';
import TextNodeEditor from './components/TextNodeEditor';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import { Icons } from './components/Icons';
import SettingsModal from './components/SettingsModal';
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
import type { ChatAttachment, ChatNode, ThinkingSummaryChunk } from './model/chat';
import { buildOpenAIResponseRequest, type OpenAIChatSettings } from './llm/openai';
import { DEFAULT_MODEL_ID, listModels, type TextVerbosity } from './llm/registry';
import { extractCanonicalMessage, extractCanonicalMeta } from './llm/openaiCanonical';
import { readFileAsDataUrl, splitDataUrl } from './utils/files';
import { deleteAttachment, deleteAttachments, getAttachment, listAttachmentKeys, putAttachment } from './storage/attachments';
import { clearAllStores } from './storage/db';
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
import { putPayload } from './storage/payloads';

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
  thinkingSummary: ThinkingSummaryChunk[];
  lastFlushedText: string;
  lastFlushAt: number;
  flushTimer: number | null;
  closed: boolean;
};

type DraftAttachmentDedupeState = {
  inFlight: Set<string>;
  attached: Set<string>;
  byStorageKey: Map<string, string>;
};

function fileSignature(file: File): string {
  const name = typeof (file as any)?.name === 'string' ? String((file as any).name) : '';
  const size = Number.isFinite((file as any)?.size) ? Number((file as any).size) : 0;
  const type = typeof (file as any)?.type === 'string' ? String((file as any).type) : '';
  const lastModified = Number.isFinite((file as any)?.lastModified) ? Number((file as any).lastModified) : 0;
  return `${name}|${size}|${type}|${lastModified}`;
}

function comparableAttachmentKey(att: ChatAttachment | null | undefined): string {
  if (!att) return '';
  if (att.kind !== 'image' && att.kind !== 'pdf') return '';
  const name = typeof att.name === 'string' ? att.name.trim() : '';
  const size = Number.isFinite(att.size) ? att.size : 0;
  const mimeType = typeof (att as any)?.mimeType === 'string' ? String((att as any).mimeType).trim() : '';
  return `${att.kind}|${name}|${size}|${mimeType}`;
}

function comparableFileKey(file: File): string {
  const name = typeof (file as any)?.name === 'string' ? String((file as any).name).trim() : '';
  const size = Number.isFinite((file as any)?.size) ? Number((file as any).size) : 0;
  const type = typeof (file as any)?.type === 'string' ? String((file as any).type).toLowerCase() : '';
  const lowerName = name.toLowerCase();
  const isPdf = type === 'application/pdf' || lowerName.endsWith('.pdf');
  const isImage =
    type.startsWith('image/') ||
    lowerName.endsWith('.png') ||
    lowerName.endsWith('.jpg') ||
    lowerName.endsWith('.jpeg') ||
    lowerName.endsWith('.gif') ||
    lowerName.endsWith('.webp');
  if (!isPdf && !isImage) return '';
  const kind = isPdf ? 'pdf' : 'image';
  const mimeType = isPdf ? 'application/pdf' : type.startsWith('image/') ? type : 'image/png';
  return `${kind}|${name}|${size}|${mimeType}`;
}

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
    visual: {
      glassNodesEnabled: boolean;
      glassNodesBlurCssPxWebgl: number;
      glassNodesSaturatePctWebgl: number;
      glassNodesBlurCssPxCanvas: number;
      glassNodesSaturatePctCanvas: number;
      uiGlassBlurCssPxWebgl: number;
      uiGlassSaturatePctWebgl: number;
      glassNodesUnderlayAlpha: number;
      glassNodesBlurBackend: GlassBlurBackend;
    };
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
  const lastAddAttachmentFilesRef = useRef<{ sig: string; at: number }>({ sig: '', at: 0 });
  const draftAttachmentDedupeRef = useRef<Map<string, DraftAttachmentDedupeState>>(new Map());
  const [replySelection, setReplySelection] = useState<ReplySelection | null>(null);
  const [replyContextAttachments, setReplyContextAttachments] = useState<ContextAttachmentItem[]>(() => []);
  const [replySelectedAttachmentKeys, setReplySelectedAttachmentKeys] = useState<string[]>(() => []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<'appearance' | 'debug' | 'reset'>('appearance');
  const [debugHudVisible, setDebugHudVisible] = useState(true);
  const [stressSpawnCount, setStressSpawnCount] = useState<number>(50);
  const [backgroundStorageKey, setBackgroundStorageKey] = useState<string | null>(() => null);
  const [glassNodesEnabled, setGlassNodesEnabled] = useState<boolean>(() => false);
  const [glassNodesBlurCssPxWebgl, setGlassNodesBlurCssPxWebgl] = useState<number>(() => 10);
  const [glassNodesSaturatePctWebgl, setGlassNodesSaturatePctWebgl] = useState<number>(() => 140);
  const [glassNodesBlurCssPxCanvas, setGlassNodesBlurCssPxCanvas] = useState<number>(() => 10);
  const [glassNodesSaturatePctCanvas, setGlassNodesSaturatePctCanvas] = useState<number>(() => 140);
  const [glassNodesUnderlayAlpha, setGlassNodesUnderlayAlpha] = useState<number>(() => 0.95);
  const [glassNodesBlurBackend, setGlassNodesBlurBackend] = useState<GlassBlurBackend>(() => 'webgl');
  const [uiGlassBlurCssPxWebgl, setUiGlassBlurCssPxWebgl] = useState<number>(() => 10);
  const [uiGlassSaturatePctWebgl, setUiGlassSaturatePctWebgl] = useState<number>(() => 140);
  const glassNodesEnabledRef = useRef<boolean>(glassNodesEnabled);
  const glassNodesBlurCssPxWebglRef = useRef<number>(glassNodesBlurCssPxWebgl);
  const glassNodesSaturatePctWebglRef = useRef<number>(glassNodesSaturatePctWebgl);
  const glassNodesBlurCssPxCanvasRef = useRef<number>(glassNodesBlurCssPxCanvas);
  const glassNodesSaturatePctCanvasRef = useRef<number>(glassNodesSaturatePctCanvas);
  const glassNodesUnderlayAlphaRef = useRef<number>(glassNodesUnderlayAlpha);
  const glassNodesBlurBackendRef = useRef<GlassBlurBackend>(glassNodesBlurBackend);
  const uiGlassBlurCssPxWebglRef = useRef<number>(uiGlassBlurCssPxWebgl);
  const uiGlassSaturatePctWebglRef = useRef<number>(uiGlassSaturatePctWebgl);
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
    };
    chatMetaRef.current.set(chatId, meta);
    return meta;
  };

  const ensureDraftAttachmentDedupe = (chatId: string): DraftAttachmentDedupeState => {
    const existing = draftAttachmentDedupeRef.current.get(chatId);
    if (existing) return existing;
    const created: DraftAttachmentDedupeState = { inFlight: new Set(), attached: new Set(), byStorageKey: new Map() };
    draftAttachmentDedupeRef.current.set(chatId, created);
    return created;
  };

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    glassNodesEnabledRef.current = glassNodesEnabled;
    glassNodesBlurCssPxWebglRef.current = glassNodesBlurCssPxWebgl;
    glassNodesSaturatePctWebglRef.current = glassNodesSaturatePctWebgl;
    glassNodesBlurCssPxCanvasRef.current = glassNodesBlurCssPxCanvas;
    glassNodesSaturatePctCanvasRef.current = glassNodesSaturatePctCanvas;
    glassNodesUnderlayAlphaRef.current = glassNodesUnderlayAlpha;
    glassNodesBlurBackendRef.current = glassNodesBlurBackend;
    uiGlassBlurCssPxWebglRef.current = uiGlassBlurCssPxWebgl;
    uiGlassSaturatePctWebglRef.current = uiGlassSaturatePctWebgl;

    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const activeBlurCssPx = glassNodesBlurBackend === 'canvas' ? glassNodesBlurCssPxCanvas : glassNodesBlurCssPxWebgl;
    const activeSaturatePct =
      glassNodesBlurBackend === 'canvas' ? glassNodesSaturatePctCanvas : glassNodesSaturatePctWebgl;
    const uiBlurCssPx = glassNodesBlurBackend === 'webgl' ? uiGlassBlurCssPxWebgl : activeBlurCssPx;
    const uiSaturatePct = glassNodesBlurBackend === 'webgl' ? uiGlassSaturatePctWebgl : activeSaturatePct;
    root.style.setProperty('--ui-glass-blur', `${Math.round(uiBlurCssPx)}px`);
    root.style.setProperty('--ui-glass-saturate', `${Math.round(uiSaturatePct)}%`);
    const t = Math.max(0, Math.min(1, glassNodesUnderlayAlpha));
    const uiMinAlpha = 0.12;
    const uiMaxAlpha = 0.6;
    const gamma = 0.26;
    const uiAlpha = uiMinAlpha + (uiMaxAlpha - uiMinAlpha) * Math.pow(1 - t, gamma);
    root.style.setProperty('--ui-glass-bg-alpha', uiAlpha.toFixed(3));
  }, [
    glassNodesEnabled,
    glassNodesBlurCssPxWebgl,
    glassNodesSaturatePctWebgl,
    glassNodesBlurCssPxCanvas,
    glassNodesSaturatePctCanvas,
    glassNodesUnderlayAlpha,
    glassNodesBlurBackend,
    uiGlassBlurCssPxWebgl,
    uiGlassSaturatePctWebgl,
  ]);

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
          await putWorkspaceSnapshot({
            key: 'workspace',
            root,
            activeChatId: active,
            focusedFolderId: focused,
            visual: {
              glassNodesEnabled: Boolean(glassNodesEnabledRef.current),
              glassNodesBlurCssPx:
                glassNodesBlurBackendRef.current === 'canvas'
                  ? Math.max(0, Math.min(30, glassNodesBlurCssPxCanvasRef.current))
                  : Math.max(0, Math.min(30, glassNodesBlurCssPxWebglRef.current)),
              glassNodesSaturatePct:
                glassNodesBlurBackendRef.current === 'canvas'
                  ? Math.max(100, Math.min(200, glassNodesSaturatePctCanvasRef.current))
                  : Math.max(100, Math.min(200, glassNodesSaturatePctWebglRef.current)),
              glassNodesBlurCssPxWebgl: Math.max(0, Math.min(30, glassNodesBlurCssPxWebglRef.current)),
              glassNodesSaturatePctWebgl: Math.max(100, Math.min(200, glassNodesSaturatePctWebglRef.current)),
              glassNodesBlurCssPxCanvas: Math.max(0, Math.min(30, glassNodesBlurCssPxCanvasRef.current)),
              glassNodesSaturatePctCanvas: Math.max(100, Math.min(200, glassNodesSaturatePctCanvasRef.current)),
              uiGlassBlurCssPxWebgl: Math.max(0, Math.min(30, uiGlassBlurCssPxWebglRef.current)),
              uiGlassSaturatePctWebgl: Math.max(100, Math.min(200, uiGlassSaturatePctWebglRef.current)),
              glassNodesUnderlayAlpha: Number.isFinite(glassNodesUnderlayAlphaRef.current)
                ? Math.max(0, Math.min(1, glassNodesUnderlayAlphaRef.current))
                : 0.95,
              glassNodesBlurBackend: glassNodesBlurBackendRef.current === 'canvas' ? 'canvas' : 'webgl',
            },
          });
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
    const blurBackend = glassNodesBlurBackendRef.current === 'canvas' ? 'canvas' : 'webgl';
    const blurCssPx =
      blurBackend === 'canvas' ? glassNodesBlurCssPxCanvasRef.current : glassNodesBlurCssPxWebglRef.current;
    const saturatePct =
      blurBackend === 'canvas' ? glassNodesSaturatePctCanvasRef.current : glassNodesSaturatePctWebglRef.current;
    engine.setGlassNodesEnabled(Boolean(glassNodesEnabledRef.current));
    engine.setGlassNodesBlurBackend(blurBackend);
    engine.setGlassNodesBlurCssPx(Number.isFinite(blurCssPx) ? Math.max(0, Math.min(30, blurCssPx)) : 10);
    engine.setGlassNodesSaturatePct(Number.isFinite(saturatePct) ? Math.max(100, Math.min(200, saturatePct)) : 140);
    engine.setGlassNodesUnderlayAlpha(
      Number.isFinite(glassNodesUnderlayAlphaRef.current) ? glassNodesUnderlayAlphaRef.current : 0.95,
    );

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
    result: {
      finalText: string;
      error: string | null;
      cancelled?: boolean;
      apiResponse?: unknown;
      apiResponseKey?: string;
      canonicalMessage?: unknown;
      canonicalMeta?: unknown;
      usage?: unknown;
    },
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
      thinkingSummary: undefined,
    };
    if (result.apiResponse !== undefined) patch.apiResponse = result.apiResponse;
    if (result.apiResponseKey !== undefined) patch.apiResponseKey = result.apiResponseKey;
    if (result.canonicalMessage !== undefined) patch.canonicalMessage = result.canonicalMessage as any;
    if (result.canonicalMeta !== undefined) patch.canonicalMeta = result.canonicalMeta as any;
    updateStoredTextNode(job.chatId, job.assistantNodeId, patch);

    if (activeChatIdRef.current === job.chatId) {
      const engine = engineRef.current;
      engine?.setTextNodeLlmState(job.assistantNodeId, { isGenerating: false, modelId: job.modelId, llmError: result.error });
      if (result.canonicalMessage !== undefined || result.canonicalMeta !== undefined) {
        engine?.setTextNodeCanonical(job.assistantNodeId, {
          canonicalMessage: result.canonicalMessage,
          canonicalMeta: result.canonicalMeta,
        });
      }
      engine?.setTextNodeThinkingSummary(job.assistantNodeId, undefined);
      engine?.setTextNodeContent(job.assistantNodeId, finalText, { streaming: false });
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
      thinkingSummary: [],
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
      try {
        const key = `${chatId}/${job.userNodeId}/req`;
        await putPayload({ key, json: sentRequest });
        updateStoredTextNode(chatId, job.userNodeId, { apiRequestKey: key });
      } catch {
        // ignore
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
          onEvent: (evt: any) => {
            if (job.closed) return;
            const t = typeof evt?.type === 'string' ? String(evt.type) : '';
            if (t === 'response.reasoning_summary_text.delta') {
              const idx = typeof evt?.summary_index === 'number' ? evt.summary_index : 0;
              const delta = typeof evt?.delta === 'string' ? evt.delta : '';
              if (!delta) return;

              const chunks = job.thinkingSummary ?? [];
              const existing = chunks.find((c) => c.summaryIndex === idx);
              const nextChunks: ThinkingSummaryChunk[] = existing
                ? chunks.map((c) => (c.summaryIndex === idx ? { ...c, text: c.text + delta } : c))
                : [...chunks, { summaryIndex: idx, text: delta, done: false }];
              job.thinkingSummary = nextChunks;

              updateStoredTextNode(chatId, job.assistantNodeId, { thinkingSummary: nextChunks });
              if (activeChatIdRef.current === chatId) {
                engineRef.current?.setTextNodeThinkingSummary(job.assistantNodeId, nextChunks);
              }
            } else if (t === 'response.reasoning_summary_text.done') {
              const idx = typeof evt?.summary_index === 'number' ? evt.summary_index : 0;
              const chunks = job.thinkingSummary ?? [];
              if (!chunks.length) return;
              const nextChunks: ThinkingSummaryChunk[] = chunks.map((c) => (c.summaryIndex === idx ? { ...c, done: true } : c));
              job.thinkingSummary = nextChunks;

              updateStoredTextNode(chatId, job.assistantNodeId, { thinkingSummary: nextChunks });
              if (activeChatIdRef.current === chatId) {
                engineRef.current?.setTextNodeThinkingSummary(job.assistantNodeId, nextChunks);
              }
            }
          },
        },
      });

      if (!generationJobsByAssistantIdRef.current.has(job.assistantNodeId)) return;
      const usedWebSearch =
        Array.isArray((request as any)?.tools) && (request as any).tools.some((tool: any) => tool && tool.type === 'web_search');
      const effort = (request as any)?.reasoning?.effort;
      const verbosity = (request as any)?.text?.verbosity;
      const baseCanonicalMeta = extractCanonicalMeta(res.response, { usedWebSearch, effort, verbosity });
      const canonicalMessage = extractCanonicalMessage(
        res.response,
        typeof res.text === 'string' ? res.text : job.fullText,
      );
      const finalText = (typeof res.text === 'string' ? res.text : '') || canonicalMessage?.text || job.fullText || '';
      const streamed = job.thinkingSummary ?? [];
      const canonicalMeta = (() => {
        const hasBlocks = Array.isArray((baseCanonicalMeta as any)?.reasoningSummaryBlocks) && (baseCanonicalMeta as any).reasoningSummaryBlocks.length > 0;
        if (hasBlocks || streamed.length === 0) return baseCanonicalMeta;
        return {
          ...(baseCanonicalMeta ?? {}),
          reasoningSummaryBlocks: [...streamed]
            .sort((a, b) => (a.summaryIndex ?? 0) - (b.summaryIndex ?? 0))
            .map((c) => ({ type: 'summary_text' as const, text: c?.text ?? '' })),
        };
      })();
      const storedResponse = res.response !== undefined ? cloneRawPayloadForDisplay(res.response) : undefined;
      let responseKey: string | undefined = undefined;
      if (res.response !== undefined) {
        try {
          const key = `${chatId}/${job.assistantNodeId}/res`;
          await putPayload({ key, json: res.response });
          responseKey = key;
        } catch {
          // ignore
        }
      }
      if (res.ok) {
        finishJob(job.assistantNodeId, {
          finalText,
          error: null,
          apiResponse: storedResponse,
          apiResponseKey: responseKey,
          canonicalMessage,
          canonicalMeta,
        });
      } else {
        const error = res.cancelled ? 'Canceled' : res.error;
        finishJob(job.assistantNodeId, {
          finalText,
          error,
          cancelled: res.cancelled,
          apiResponse: storedResponse,
          apiResponseKey: responseKey,
          canonicalMessage,
          canonicalMeta,
        });
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
        existingMeta.draftAttachments = composerDraftAttachments.slice();
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
    setComposerDraftAttachments(Array.isArray(meta.draftAttachments) ? meta.draftAttachments.slice() : []);
    setReplySelection(meta.replyTo);
    setReplySelectedAttachmentKeys(Array.isArray(meta.selectedAttachmentKeys) ? meta.selectedAttachmentKeys : []);
    setBackgroundStorageKey(typeof meta.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : null);
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

    const visual = payload.visual;
    glassNodesEnabledRef.current = Boolean(visual.glassNodesEnabled);
    glassNodesBlurCssPxWebglRef.current = Number.isFinite(visual.glassNodesBlurCssPxWebgl) ? visual.glassNodesBlurCssPxWebgl : 10;
    glassNodesSaturatePctWebglRef.current = Number.isFinite(visual.glassNodesSaturatePctWebgl) ? visual.glassNodesSaturatePctWebgl : 140;
    glassNodesBlurCssPxCanvasRef.current = Number.isFinite(visual.glassNodesBlurCssPxCanvas) ? visual.glassNodesBlurCssPxCanvas : 10;
    glassNodesSaturatePctCanvasRef.current = Number.isFinite(visual.glassNodesSaturatePctCanvas) ? visual.glassNodesSaturatePctCanvas : 140;
    uiGlassBlurCssPxWebglRef.current = Number.isFinite(visual.uiGlassBlurCssPxWebgl) ? visual.uiGlassBlurCssPxWebgl : glassNodesBlurCssPxWebglRef.current;
    uiGlassSaturatePctWebglRef.current = Number.isFinite(visual.uiGlassSaturatePctWebgl)
      ? visual.uiGlassSaturatePctWebgl
      : glassNodesSaturatePctWebglRef.current;
    glassNodesUnderlayAlphaRef.current = Number.isFinite(visual.glassNodesUnderlayAlpha) ? visual.glassNodesUnderlayAlpha : 0.95;
    glassNodesBlurBackendRef.current = visual.glassNodesBlurBackend === 'canvas' ? 'canvas' : 'webgl';
    setGlassNodesEnabled(glassNodesEnabledRef.current);
    setGlassNodesBlurCssPxWebgl(glassNodesBlurCssPxWebglRef.current);
    setGlassNodesSaturatePctWebgl(glassNodesSaturatePctWebglRef.current);
    setGlassNodesBlurCssPxCanvas(glassNodesBlurCssPxCanvasRef.current);
    setGlassNodesSaturatePctCanvas(glassNodesSaturatePctCanvasRef.current);
    setGlassNodesUnderlayAlpha(glassNodesUnderlayAlphaRef.current);
    setGlassNodesBlurBackend(glassNodesBlurBackendRef.current);
    setUiGlassBlurCssPxWebgl(uiGlassBlurCssPxWebglRef.current);
    setUiGlassSaturatePctWebgl(uiGlassSaturatePctWebglRef.current);

    bootedRef.current = true;
    setActiveChatId(resolvedActive);

    const engine = engineRef.current;
    if (engine) {
      const blurBackend = glassNodesBlurBackendRef.current === 'canvas' ? 'canvas' : 'webgl';
      const blurCssPx =
        blurBackend === 'canvas' ? glassNodesBlurCssPxCanvasRef.current : glassNodesBlurCssPxWebglRef.current;
      const saturatePct =
        blurBackend === 'canvas' ? glassNodesSaturatePctCanvasRef.current : glassNodesSaturatePctWebglRef.current;
      engine.setGlassNodesEnabled(glassNodesEnabledRef.current);
      engine.setGlassNodesBlurBackend(blurBackend);
      engine.setGlassNodesBlurCssPx(Number.isFinite(blurCssPx) ? Math.max(0, Math.min(30, blurCssPx)) : 10);
      engine.setGlassNodesSaturatePct(Number.isFinite(saturatePct) ? Math.max(100, Math.min(200, saturatePct)) : 140);
      engine.setGlassNodesUnderlayAlpha(glassNodesUnderlayAlphaRef.current);
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
	    setComposerDraftAttachments(Array.isArray(meta.draftAttachments) ? meta.draftAttachments.slice() : []);
	    setReplySelection(meta.replyTo);
    setReplySelectedAttachmentKeys(Array.isArray(meta.selectedAttachmentKeys) ? meta.selectedAttachmentKeys : []);
    setBackgroundStorageKey(typeof meta.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : null);
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

      const desiredActiveChatId = typeof ws.activeChatId === 'string' ? ws.activeChatId : chatIds[0];
      let legacyVisualFromActive: {
        glassNodesEnabled: boolean;
        glassNodesBlurCssPx: number;
        glassNodesSaturatePct: number;
        glassNodesUnderlayAlpha: number;
        glassNodesBlurBackend?: GlassBlurBackend;
      } | null = null;

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

          if (chatId === desiredActiveChatId) {
            legacyVisualFromActive = {
              glassNodesEnabled: Boolean(raw?.glassNodesEnabled),
              glassNodesBlurCssPx: Number.isFinite(Number(raw?.glassNodesBlurCssPx))
                ? Math.max(0, Math.min(30, Number(raw.glassNodesBlurCssPx)))
                : 10,
              glassNodesSaturatePct: Number.isFinite(Number(raw?.glassNodesSaturatePct))
                ? Math.max(100, Math.min(200, Number(raw.glassNodesSaturatePct)))
                : 140,
              glassNodesUnderlayAlpha: Number.isFinite(Number(raw?.glassNodesUnderlayAlpha))
                ? Math.max(0, Math.min(1, Number(raw.glassNodesUnderlayAlpha)))
                : 0.95,
            };
          }

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
          };
          chatMeta.set(chatId, meta);
        } catch {
          // ignore missing meta
        }
      }

      const visualRaw = (ws as any)?.visual ?? null;
      const visualSrc =
        visualRaw && typeof visualRaw === 'object'
          ? visualRaw
          : legacyVisualFromActive && typeof legacyVisualFromActive === 'object'
            ? legacyVisualFromActive
            : null;
      const glassNodesBlurBackend: GlassBlurBackend = visualSrc?.glassNodesBlurBackend === 'canvas' ? 'canvas' : 'webgl';
      const legacyBlurCssPxRaw = Number((visualSrc as any)?.glassNodesBlurCssPx);
      const legacySaturatePctRaw = Number((visualSrc as any)?.glassNodesSaturatePct);
      const fallbackBlurCssPx = Number.isFinite(legacyBlurCssPxRaw)
        ? Math.max(0, Math.min(30, legacyBlurCssPxRaw))
        : 10;
      const fallbackSaturatePct = Number.isFinite(legacySaturatePctRaw)
        ? Math.max(100, Math.min(200, legacySaturatePctRaw))
        : 140;
      const blurCssPxWebglRaw = Number((visualSrc as any)?.glassNodesBlurCssPxWebgl);
      const blurCssPxCanvasRaw = Number((visualSrc as any)?.glassNodesBlurCssPxCanvas);
      const saturatePctWebglRaw = Number((visualSrc as any)?.glassNodesSaturatePctWebgl);
      const saturatePctCanvasRaw = Number((visualSrc as any)?.glassNodesSaturatePctCanvas);
      const glassNodesBlurCssPxWebgl = Number.isFinite(blurCssPxWebglRaw)
        ? Math.max(0, Math.min(30, blurCssPxWebglRaw))
        : fallbackBlurCssPx;
      const glassNodesBlurCssPxCanvas = Number.isFinite(blurCssPxCanvasRaw)
        ? Math.max(0, Math.min(30, blurCssPxCanvasRaw))
        : fallbackBlurCssPx;
      const glassNodesSaturatePctWebgl = Number.isFinite(saturatePctWebglRaw)
        ? Math.max(100, Math.min(200, saturatePctWebglRaw))
        : fallbackSaturatePct;
      const glassNodesSaturatePctCanvas = Number.isFinite(saturatePctCanvasRaw)
        ? Math.max(100, Math.min(200, saturatePctCanvasRaw))
        : fallbackSaturatePct;
      const uiBlurCssPxWebglRaw = Number((visualSrc as any)?.uiGlassBlurCssPxWebgl);
      const uiSaturatePctWebglRaw = Number((visualSrc as any)?.uiGlassSaturatePctWebgl);
      const uiGlassBlurCssPxWebgl = Number.isFinite(uiBlurCssPxWebglRaw)
        ? Math.max(0, Math.min(30, uiBlurCssPxWebglRaw))
        : glassNodesBlurCssPxWebgl;
      const uiGlassSaturatePctWebgl = Number.isFinite(uiSaturatePctWebglRaw)
        ? Math.max(100, Math.min(200, uiSaturatePctWebglRaw))
        : glassNodesSaturatePctWebgl;
      const visual = {
        glassNodesEnabled: Boolean(visualSrc?.glassNodesEnabled),
        glassNodesBlurCssPxWebgl,
        glassNodesSaturatePctWebgl,
        glassNodesBlurCssPxCanvas,
        glassNodesSaturatePctCanvas,
        uiGlassBlurCssPxWebgl,
        uiGlassSaturatePctWebgl,
        glassNodesUnderlayAlpha: Number.isFinite(Number(visualSrc?.glassNodesUnderlayAlpha))
          ? Math.max(0, Math.min(1, Number(visualSrc.glassNodesUnderlayAlpha)))
          : 0.95,
        glassNodesBlurBackend,
      };

      const payload = {
        root,
        activeChatId: desiredActiveChatId,
        focusedFolderId: typeof ws.focusedFolderId === 'string' ? ws.focusedFolderId : root.id,
        visual,
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
            const rawList = Array.from(files ?? []);
            const dedupe = ensureDraftAttachmentDedupe(chatId);

            const sigParts = rawList
              .map((f) => fileSignature(f))
              .sort();
            const sig = sigParts.join(',');
            const now = Date.now();
            if (sig) {
              const prev = lastAddAttachmentFilesRef.current;
              if (prev.sig === sig && now - prev.at < 1500) return;
              lastAddAttachmentFilesRef.current = { sig, at: now };
            }

            const seen = new Set<string>();
            const list = rawList.filter((f) => {
              const key = fileSignature(f);
              if (!key) return true;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });

            void (async () => {
              for (const f of list) {
                const fileSig = fileSignature(f);
                const compKey = comparableFileKey(f);
                if (fileSig && (dedupe.inFlight.has(fileSig) || dedupe.attached.has(fileSig))) continue;

                if (compKey) {
                  const meta = ensureChatMeta(chatId);
                  const exists = meta.draftAttachments.some((att) => comparableAttachmentKey(att) === compKey);
                  if (exists) continue;
                }

                if (fileSig) dedupe.inFlight.add(fileSig);
                try {
                  const att = await fileToChatAttachment(f);
                  if (!att) continue;

                  if (compKey) {
                    const meta = ensureChatMeta(chatId);
                    const exists = meta.draftAttachments.some((it) => comparableAttachmentKey(it) === compKey);
                    if (exists) {
                      const storageKey =
                        att && (att.kind === 'image' || att.kind === 'pdf') ? (att.storageKey as string | undefined) : undefined;
                      if (storageKey) void deleteAttachment(storageKey);
                      continue;
                    }
                  }

                  const meta = ensureChatMeta(chatId);
                  meta.draftAttachments = [...meta.draftAttachments, att];
                  if (fileSig) {
                    dedupe.attached.add(fileSig);
                    const storageKey =
                      att && (att.kind === 'image' || att.kind === 'pdf') ? (att.storageKey as string | undefined) : undefined;
                    if (storageKey) dedupe.byStorageKey.set(storageKey, fileSig);
                  }
                  if (activeChatIdRef.current === chatId) {
                    setComposerDraftAttachments(meta.draftAttachments.slice());
                  }
                } catch {
                  // ignore
                } finally {
                  if (fileSig) dedupe.inFlight.delete(fileSig);
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
            if (storageKey) {
              const dedupe = ensureDraftAttachmentDedupe(activeChatId);
              const fileSig = dedupe.byStorageKey.get(storageKey);
              if (fileSig) {
                dedupe.attached.delete(fileSig);
                dedupe.inFlight.delete(fileSig);
              }
              dedupe.byStorageKey.delete(storageKey);
            }
            setComposerDraftAttachments(meta.draftAttachments.slice());
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
	            draftAttachmentDedupeRef.current.delete(activeChatId);
	            lastAddAttachmentFilesRef.current = { sig: '', at: 0 };
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
        <div
          className="toolStrip"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <button
            className="toolStrip__btn"
            type="button"
            title="Settings"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            onClick={() => {
              setSettingsPanel('appearance');
              setSettingsOpen(true);
            }}
          >
            <Icons.gear className="toolStrip__icon" />
          </button>
          <button
            className={`toolStrip__btn ${ui.tool === 'draw' ? 'toolStrip__btn--active' : ''}`}
            type="button"
            title={ui.tool === 'draw' ? 'Draw mode (click for select)' : 'Select mode (click for draw)'}
            aria-label="Toggle draw mode"
            aria-pressed={ui.tool === 'draw'}
            onClick={() => engineRef.current?.setTool(ui.tool === 'draw' ? 'select' : 'draw')}
          >
            <Icons.pen className="toolStrip__icon" />
          </button>
          <button
            className="toolStrip__btn"
            type="button"
            title="New ink node"
            aria-label="New ink node"
            onClick={() => engineRef.current?.spawnInkNode()}
          >
            <Icons.inkBox className="toolStrip__icon" />
          </button>
        </div>
        <SettingsModal
          open={settingsOpen}
          activePanel={settingsPanel}
          onChangePanel={setSettingsPanel}
          onClose={() => setSettingsOpen(false)}
          backgroundEnabled={Boolean(backgroundStorageKey)}
          onImportBackground={() => backgroundInputRef.current?.click()}
          onClearBackground={() => {
            const chatId = activeChatIdRef.current;
            const meta = ensureChatMeta(chatId);
            meta.backgroundStorageKey = null;
            setBackgroundStorageKey(null);
            attachmentsGcDirtyRef.current = true;
            engineRef.current?.clearBackground();
            schedulePersistSoon();
          }}
          onImportPdf={() => pdfInputRef.current?.click()}
          glassNodesEnabled={glassNodesEnabled}
          onToggleGlassNodes={() => {
            const next = !glassNodesEnabledRef.current;
            glassNodesEnabledRef.current = next;
            setGlassNodesEnabled(next);
            engineRef.current?.setGlassNodesEnabled(next);
            schedulePersistSoon();
          }}
          glassBlurBackend={glassNodesBlurBackend}
          onChangeGlassBlurBackend={(next) => {
            const value: GlassBlurBackend = next === 'canvas' ? 'canvas' : 'webgl';
            glassNodesBlurBackendRef.current = value;
            setGlassNodesBlurBackend(value);
            const blurCssPx =
              value === 'canvas' ? glassNodesBlurCssPxCanvasRef.current : glassNodesBlurCssPxWebglRef.current;
            const saturatePct =
              value === 'canvas' ? glassNodesSaturatePctCanvasRef.current : glassNodesSaturatePctWebglRef.current;
            const engine = engineRef.current;
            engine?.setGlassNodesBlurBackend(value);
            engine?.setGlassNodesBlurCssPx(Number.isFinite(blurCssPx) ? Math.max(0, Math.min(30, blurCssPx)) : 10);
            engine?.setGlassNodesSaturatePct(
              Number.isFinite(saturatePct) ? Math.max(100, Math.min(200, saturatePct)) : 140,
            );
            schedulePersistSoon();
          }}
          glassBlurPx={glassNodesBlurBackend === 'canvas' ? glassNodesBlurCssPxCanvas : glassNodesBlurCssPxWebgl}
          onChangeGlassBlurPx={(raw) => {
            const next = Number.isFinite(raw) ? Math.max(0, Math.min(30, raw)) : 0;
            if (glassNodesBlurBackendRef.current === 'canvas') {
              glassNodesBlurCssPxCanvasRef.current = next;
              setGlassNodesBlurCssPxCanvas(next);
            } else {
              glassNodesBlurCssPxWebglRef.current = next;
              setGlassNodesBlurCssPxWebgl(next);
            }
            engineRef.current?.setGlassNodesBlurCssPx(next);
            schedulePersistSoon();
          }}
          glassSaturationPct={glassNodesBlurBackend === 'canvas' ? glassNodesSaturatePctCanvas : glassNodesSaturatePctWebgl}
          onChangeGlassSaturationPct={(raw) => {
            const next = Number.isFinite(raw) ? Math.max(100, Math.min(200, raw)) : 140;
            if (glassNodesBlurBackendRef.current === 'canvas') {
              glassNodesSaturatePctCanvasRef.current = next;
              setGlassNodesSaturatePctCanvas(next);
            } else {
              glassNodesSaturatePctWebglRef.current = next;
              setGlassNodesSaturatePctWebgl(next);
            }
            engineRef.current?.setGlassNodesSaturatePct(next);
            schedulePersistSoon();
          }}
          uiGlassBlurPxWebgl={uiGlassBlurCssPxWebgl}
          onChangeUiGlassBlurPxWebgl={(raw) => {
            const next = Number.isFinite(raw) ? Math.max(0, Math.min(30, raw)) : 10;
            uiGlassBlurCssPxWebglRef.current = next;
            setUiGlassBlurCssPxWebgl(next);
            schedulePersistSoon();
          }}
          uiGlassSaturationPctWebgl={uiGlassSaturatePctWebgl}
          onChangeUiGlassSaturationPctWebgl={(raw) => {
            const next = Number.isFinite(raw) ? Math.max(100, Math.min(200, raw)) : 140;
            uiGlassSaturatePctWebglRef.current = next;
            setUiGlassSaturatePctWebgl(next);
            schedulePersistSoon();
          }}
          glassOpacityPct={glassNodesUnderlayAlpha * 100}
          onChangeGlassOpacityPct={(raw) => {
            const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
            const next = pct / 100;
            glassNodesUnderlayAlphaRef.current = next;
            setGlassNodesUnderlayAlpha(next);
            engineRef.current?.setGlassNodesUnderlayAlpha(next);
            schedulePersistSoon();
          }}
          debugHudVisible={debugHudVisible}
          onToggleDebugHudVisible={() => setDebugHudVisible((prev) => !prev)}
          spawnCount={stressSpawnCount}
          onChangeSpawnCount={(raw) => {
            const next = Number.isFinite(raw) ? Math.max(1, Math.min(500, Math.round(raw))) : 50;
            setStressSpawnCount(next);
          }}
          onSpawnNodes={() => engineRef.current?.spawnLatexStressTest(Math.max(1, Math.min(500, stressSpawnCount)))}
          onClearStressNodes={() => {
            engineRef.current?.clearStressNodes();
            attachmentsGcDirtyRef.current = true;
            schedulePersistSoon();
          }}
          onResetToDefaults={() => {
            if (
              !window.confirm(
                'Reset to defaults?\n\nThis will remove the background and delete all chats (including stored attachments and payload logs).',
              )
            ) {
              return;
            }

            setSettingsOpen(false);
            setRawViewer(null);

            for (const assistantNodeId of Array.from(generationJobsByAssistantIdRef.current.keys())) {
              cancelJob(assistantNodeId);
            }

            const chatId = genId('chat');
            const root: WorkspaceFolder = {
              kind: 'folder',
              id: 'root',
              name: 'Workspace',
              expanded: true,
              children: [{ kind: 'chat', id: chatId, name: 'Chat 1' }],
            };

            const chatStates = new Map<string, WorldEngineChatState>();
            const state = createEmptyChatState();
            chatStates.set(chatId, state);

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
            });

            chatStatesRef.current = chatStates;
            chatMetaRef.current = chatMeta;
            treeRootRef.current = root;
            focusedFolderIdRef.current = root.id;
            activeChatIdRef.current = chatId;

            setTreeRoot(root);
            setFocusedFolderId(root.id);
            setActiveChatId(chatId);
            setComposerDraft('');
            setComposerDraftAttachments([]);
            setReplySelection(null);
            setReplyContextAttachments([]);
            setReplySelectedAttachmentKeys([]);
            setBackgroundStorageKey(null);
            setComposerModelId(DEFAULT_MODEL_ID);
            setComposerVerbosity('medium');
            setComposerWebSearch(false);
            setDebugHudVisible(true);

            glassNodesEnabledRef.current = false;
            glassNodesBlurCssPxWebglRef.current = 10;
            glassNodesSaturatePctWebglRef.current = 140;
            glassNodesBlurCssPxCanvasRef.current = 10;
            glassNodesSaturatePctCanvasRef.current = 140;
            uiGlassBlurCssPxWebglRef.current = 10;
            uiGlassSaturatePctWebglRef.current = 140;
            glassNodesUnderlayAlphaRef.current = 0.95;
            glassNodesBlurBackendRef.current = 'webgl';
            setGlassNodesEnabled(false);
            setGlassNodesBlurCssPxWebgl(10);
            setGlassNodesSaturatePctWebgl(140);
            setGlassNodesBlurCssPxCanvas(10);
            setGlassNodesSaturatePctCanvas(140);
            setGlassNodesUnderlayAlpha(0.95);
            setGlassNodesBlurBackend('webgl');
            setUiGlassBlurCssPxWebgl(10);
            setUiGlassSaturatePctWebgl(140);

            const engine = engineRef.current;
            if (engine) {
              try {
                engine.cancelEditing();
              } catch {
                // ignore
              }
              try {
                engine.clearSelection();
              } catch {
                // ignore
              }
              engine.setTool('select');
              engine.loadChatState(state);
              engine.clearBackground();
              engine.setGlassNodesEnabled(false);
              engine.setGlassNodesBlurCssPx(10);
              engine.setGlassNodesSaturatePct(140);
              engine.setGlassNodesUnderlayAlpha(0.95);
              engine.setGlassNodesBlurBackend('webgl');
              setUi(engine.getUiState());
            }

            backgroundLoadSeqRef.current += 1;
            attachmentsGcDirtyRef.current = false;

            void (async () => {
              try {
                await clearAllStores();
              } catch {
                // ignore
              } finally {
                schedulePersistSoon();
              }
            })();
          }}
        />
        {debugHudVisible ? (
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
        ) : null}
      </div>
    </div>
  );
}
