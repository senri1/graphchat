import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  WorldEngine,
  createEmptyChatState,
  type CanonicalizeLayoutAlgorithm,
  type GlassBlurBackend,
  type WorldEngineChatState,
  type WorldEngineDebug,
  type WorldEngineUiState,
} from './engine/WorldEngine';
import type { Rect } from './engine/types';
import ChatComposer from './components/ChatComposer';
import NodeHeaderMenu from './components/NodeHeaderMenu';
import RawPayloadViewer from './components/RawPayloadViewer';
import TextNodeEditor from './components/TextNodeEditor';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import FolderPickerDialog from './components/FolderPickerDialog';
import { Icons } from './components/Icons';
import SettingsModal from './components/SettingsModal';
import ConfirmDialog from './components/ConfirmDialog';
import { DEFAULT_EDGE_ROUTER_ID, listEdgeRouters, normalizeEdgeRouterId, type EdgeRouterId } from './engine/edgeRouting';
import {
  type WorkspaceChat,
  type WorkspaceFolder,
  collectChatIds,
  deleteItem,
  findFirstChatId,
  findItem,
  insertItem,
  insertItemAtTop,
  moveItem,
  renameItem,
  toggleFolder,
} from './workspace/tree';
import {
  cancelOpenAIResponse,
  getOpenAIApiKey,
  retrieveOpenAIResponse,
  sendOpenAIResponse,
  startOpenAIBackgroundResponse,
  streamOpenAIResponse,
  streamOpenAIResponseById,
} from './services/openaiService';
import { getGeminiApiKey, sendGeminiResponse } from './services/geminiService';
import type { ChatAttachment, ChatNode, InkStroke, ThinkingSummaryChunk } from './model/chat';
import { normalizeBackgroundLibrary, type BackgroundLibraryItem } from './model/backgrounds';
import { buildOpenAIResponseRequest, type OpenAIChatSettings } from './llm/openai';
import { buildGeminiContext, type GeminiChatSettings } from './llm/gemini';
import { DEFAULT_MODEL_ID, getModelInfo, listModels } from './llm/registry';
import { extractCanonicalMessage, extractCanonicalMeta } from './llm/openaiCanonical';
import { buildModelUserSettings, normalizeModelUserSettings, type ModelUserSettingsById } from './llm/modelUserSettings';
import { readFileAsDataUrl, splitDataUrl } from './utils/files';
import type { ArchiveV1, ArchiveV2 } from './utils/archive';
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
import { getPayload, putPayload } from './storage/payloads';
import { fontFamilyCss, normalizeFontFamilyKey, type FontFamilyKey } from './ui/typography';

type ChatTurnMeta = {
  id: string;
  createdAt: number;
  userNodeId: string;
  assistantNodeId: string;
  attachmentNodeIds: string[];
};

type ReplySelection = { nodeId: string; preview: string; text?: string };

type ChatRuntimeMeta = {
  draft: string;
  draftInkStrokes: InkStroke[];
  composerMode: 'text' | 'ink';
  draftAttachments: ChatAttachment[];
  replyTo: ReplySelection | null;
  contextSelections: string[];
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
  background: boolean;
  taskId: string | null;
  lastEventSeq: number | null;
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

type ToastKind = 'success' | 'error' | 'info';

type ToastState = {
  id: number;
  kind: ToastKind;
  message: string;
};

type MenuPos = { left: number; top?: number; bottom?: number; maxHeight: number };

type PendingEditNodeSend = { nodeId: string; modelIdOverride?: string | null; assistantRect?: Rect | null };

type SendTurnArgs = {
  userText: string;
  extraUserPreface?: { replyTo?: string; contexts?: string[] } | null;
  modelIdOverride?: string | null;
  defaultParentNodeId?: string | null;
  allowPdfAttachmentParentFallback?: boolean;
  clearComposerText?: boolean;
};

type InkInputDebugConfig = {
  debug: boolean;
  hud: boolean;
  layer: boolean;
  layerPointerEvents: boolean;
  preventTouchStart: boolean;
  preventTouchMove: boolean;
  pointerCapture: boolean;
};

type InkInputHudState = {
  lastEventAgoMs: number;
  lastEventType: string;
  lastEventDetail: string;
  counts: Record<string, number>;
  recent: Array<{ dtMs: number; type: string; detail: string }>;
  visibilityState: string;
  hasFocus: boolean;
  activeEl: string;
  selectionRangeCount: number;
};

const DEFAULT_COMPOSER_FONT_FAMILY: FontFamilyKey = 'ui-monospace';
const DEFAULT_COMPOSER_FONT_SIZE_PX = 13;

const DEFAULT_NODE_FONT_FAMILY: FontFamilyKey = 'ui-sans-serif';
const DEFAULT_NODE_FONT_SIZE_PX = 14;

const DEFAULT_SIDEBAR_FONT_FAMILY: FontFamilyKey = 'ui-sans-serif';
const DEFAULT_SIDEBAR_FONT_SIZE_PX = 12;

const DEFAULT_REPLY_ARROW_COLOR = '#93c5fd';
const DEFAULT_REPLY_ARROW_OPACITY = 1;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeHexColor(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return fallback;
}

function parseBoolParam(params: URLSearchParams, key: string, fallback: boolean): boolean {
  if (!params.has(key)) return fallback;
  const raw = (params.get(key) ?? '').trim().toLowerCase();
  if (!raw) return true;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

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

type ConfirmDeleteState =
  | { kind: 'tree-item'; itemId: string; itemType: 'chat' | 'folder'; name: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'background'; backgroundId: string; name: string };

type ConfirmApplyBackgroundState = {
  chatId: string;
  backgroundId: string;
  backgroundName: string;
};

type ConfirmExportState =
  | { kind: 'chat'; chatId: string }
  | { kind: 'all'; closeSettingsOnConfirm?: boolean };

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
    if (n.kind === 'text' || n.kind === 'ink') {
      const atts = Array.isArray((n as any)?.attachments) ? ((n as any).attachments as ChatAttachment[]) : [];
      for (const att of atts) {
        if (!att) continue;
        const storageKey = typeof (att as any)?.storageKey === 'string' ? String((att as any).storageKey).trim() : '';
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
  const seenPdfStorageKeys = new Set<string>();
  let cur: ChatNode | null = byId.get(startNodeId) ?? null;
  while (cur) {
    if (cur.kind === 'text' && cur.author === 'user' && Array.isArray(cur.attachments)) {
      for (let i = 0; i < cur.attachments.length; i += 1) {
        const att = cur.attachments[i];
        if (!att) continue;
        if (att.kind === 'pdf' && typeof (att as any)?.storageKey === 'string') {
          const k = String((att as any).storageKey).trim();
          if (k) seenPdfStorageKeys.add(k);
        }
        out.push({ key: `${cur.id}:${i}`, nodeId: cur.id, attachment: att });
      }
    }
    if (cur.kind === 'ink' && Array.isArray((cur as any)?.attachments)) {
      const atts = (cur as any).attachments as ChatAttachment[];
      for (let i = 0; i < atts.length; i += 1) {
        const att = atts[i];
        if (!att) continue;
        if (att.kind === 'pdf' && typeof (att as any)?.storageKey === 'string') {
          const k = String((att as any).storageKey).trim();
          if (k) seenPdfStorageKeys.add(k);
        }
        out.push({ key: `${cur.id}:${i}`, nodeId: cur.id, attachment: att });
      }
    }
    if (cur.kind === 'pdf') {
      const storageKey = typeof (cur as any)?.storageKey === 'string' ? String((cur as any).storageKey).trim() : '';
      if (storageKey && !seenPdfStorageKeys.has(storageKey)) {
        seenPdfStorageKeys.add(storageKey);
        const name = typeof cur.fileName === 'string' && cur.fileName.trim() ? cur.fileName.trim() : undefined;
        const attachment: ChatAttachment = { kind: 'pdf', mimeType: 'application/pdf', storageKey, ...(name ? { name } : {}) };
        out.push({ key: `pdf:${cur.id}`, nodeId: cur.id, attachment });
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
  backgroundLibrary: BackgroundLibraryItem[];
}): Set<string> {
  const referenced = new Set<string>();
  const chatIds = args.chatIds ?? [];

  for (const bg of args.backgroundLibrary ?? []) {
    const key = typeof bg?.storageKey === 'string' ? bg.storageKey : '';
    if (key) referenced.add(key);
  }

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
      if (att.kind !== 'image' && att.kind !== 'pdf' && att.kind !== 'ink') continue;
      const key = typeof (att as any)?.storageKey === 'string' ? String((att as any).storageKey).trim() : '';
      if (key) referenced.add(key);
    }
  }

  return referenced;
}

function findChatNameAndFolderPath(
  root: WorkspaceFolder,
  chatId: string,
): { name: string; folderPath: string[] } | null {
  const targetId = String(chatId ?? '').trim();
  if (!targetId) return null;

  const walk = (folder: WorkspaceFolder, path: string[]): { name: string; folderPath: string[] } | null => {
    for (const child of folder.children ?? []) {
      if (!child) continue;
      if (child.kind === 'chat' && child.id === targetId) {
        return { name: child.name, folderPath: path };
      }
      if (child.kind === 'folder') {
        const name = String(child.name ?? '').trim();
        const nextPath = name ? [...path, name] : path;
        const hit = walk(child, nextPath);
        if (hit) return hit;
      }
    }
    return null;
  };

  return walk(root, []);
}

export default function App() {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const worldSurfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inkCaptureRef = useRef<HTMLDivElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const editingDraftByNodeIdRef = useRef<Map<string, string>>(new Map());
  const lastEditingNodeIdRef = useRef<string | null>(null);
  const generationJobsByAssistantIdRef = useRef<Map<string, GenerationJob>>(new Map());
  const resumedLlmJobsRef = useRef(false);
  const inkInputConfig = useMemo<InkInputDebugConfig>(() => {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const debug = parseBoolParam(params, 'inkDebug', false);
    const hud = parseBoolParam(params, 'inkHud', debug);
    return {
      debug,
      hud,
      layer: parseBoolParam(params, 'inkLayer', true),
      layerPointerEvents: parseBoolParam(params, 'inkLayerPointerEvents', true),
      preventTouchStart: parseBoolParam(params, 'inkPreventStart', false),
      preventTouchMove: parseBoolParam(params, 'inkPreventMove', true),
      pointerCapture: parseBoolParam(params, 'inkPointerCapture', true),
    };
  }, []);
  const inkDiagRef = useRef({
    lastEventAt: typeof performance !== 'undefined' ? performance.now() : 0,
    lastEventType: 'init',
    lastEventDetail: '',
    counts: {} as Record<string, number>,
    recent: [] as Array<{ t: number; type: string; detail: string }>,
  });
  const [inkHud, setInkHud] = useState<InkInputHudState | null>(null);
  const [debug, setDebug] = useState<WorldEngineDebug | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const engineReadyRef = useRef(false);
  const bootedRef = useRef(false);
  const bootPayloadRef = useRef<{
    root: WorkspaceFolder;
    activeChatId: string;
    focusedFolderId: string;
    backgroundLibrary: BackgroundLibraryItem[];
    llm: {
      modelUserSettings: ModelUserSettingsById;
    };
    visual: {
      glassNodesEnabled: boolean;
      edgeRouterId: EdgeRouterId;
      replyArrowColor: string;
      replyArrowOpacity: number;
      replySpawnKind: 'text' | 'ink';
      glassNodesBlurCssPxWebgl: number;
      glassNodesSaturatePctWebgl: number;
      glassNodesBlurCssPxCanvas: number;
      glassNodesSaturatePctCanvas: number;
      uiGlassBlurCssPxWebgl: number;
      uiGlassSaturatePctWebgl: number;
      glassNodesUnderlayAlpha: number;
      glassNodesBlurBackend: GlassBlurBackend;
      composerFontFamily: FontFamilyKey;
      composerFontSizePx: number;
      composerMinimized: boolean;
      nodeFontFamily: FontFamilyKey;
      nodeFontSizePx: number;
      sidebarFontFamily: FontFamilyKey;
      sidebarFontSizePx: number;
      spawnEditNodeByDraw: boolean;
      spawnInkNodeByDraw: boolean;
      inkSendCropEnabled: boolean;
      inkSendCropPaddingPx: number;
      inkSendDownscaleEnabled: boolean;
      inkSendMaxPixels: number;
      inkSendMaxDimPx: number;
    };
    chatStates: Map<string, WorldEngineChatState>;
    chatMeta: Map<string, ChatRuntimeMeta>;
  } | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const hydratingPdfChatsRef = useRef<Set<string>>(new Set());
  const attachmentsGcDirtyRef = useRef(false);
  const attachmentsGcRunningRef = useRef(false);
  const attachmentsGcLastRunAtRef = useRef(0);
  const [ui, setUi] = useState<WorldEngineUiState>(() => ({
    selectedNodeId: null,
    editingNodeId: null,
    editingText: '',
    tool: 'select',
  }));
  const [rawViewer, setRawViewer] = useState<RawViewerState | null>(null);
  const [nodeMenuId, setNodeMenuId] = useState<string | null>(null);
  const [editNodeSendMenuId, setEditNodeSendMenuId] = useState<string | null>(null);
  const [editNodeSendMenuPos, setEditNodeSendMenuPos] = useState<MenuPos | null>(null);
  const [replySpawnMenuId, setReplySpawnMenuId] = useState<string | null>(null);
  const [replySpawnMenuPos, setReplySpawnMenuPos] = useState<MenuPos | null>(null);
  const [pendingEditNodeSend, setPendingEditNodeSend] = useState<PendingEditNodeSend | null>(null);
	  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteState | null>(null);
	  const [confirmApplyBackground, setConfirmApplyBackground] = useState<ConfirmApplyBackgroundState | null>(null);
	  const [confirmExport, setConfirmExport] = useState<ConfirmExportState | null>(null);
	  const [toast, setToast] = useState<ToastState | null>(null);
	  const [viewport, setViewport] = useState(() => ({ w: 1, h: 1 }));
	  const [composerDraft, setComposerDraft] = useState('');
    const [composerMode, setComposerMode] = useState<'text' | 'ink'>(() => 'text');
    const [composerInkStrokes, setComposerInkStrokes] = useState<InkStroke[]>(() => []);
	  const [composerDraftAttachments, setComposerDraftAttachments] = useState<ChatAttachment[]>(() => []);
	  const lastAddAttachmentFilesRef = useRef<{ sig: string; at: number }>({ sig: '', at: 0 });
  const draftAttachmentDedupeRef = useRef<Map<string, DraftAttachmentDedupeState>>(new Map());
  const [replySelection, setReplySelection] = useState<ReplySelection | null>(null);
  const [contextSelections, setContextSelections] = useState<string[]>(() => []);
  const contextTargetEditNodeIdRef = useRef<string | null>(null);
  const [replyContextAttachments, setReplyContextAttachments] = useState<ContextAttachmentItem[]>(() => []);
  const [replySelectedAttachmentKeys, setReplySelectedAttachmentKeys] = useState<string[]>(() => []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<'appearance' | 'models' | 'debug' | 'data' | 'reset'>('appearance');
  const [debugHudVisible, setDebugHudVisible] = useState(true);
  const [allowEditingAllTextNodes, setAllowEditingAllTextNodes] = useState(false);
  const allowEditingAllTextNodesRef = useRef<boolean>(allowEditingAllTextNodes);
  const [spawnEditNodeByDraw, setSpawnEditNodeByDraw] = useState(false);
  const spawnEditNodeByDrawRef = useRef<boolean>(spawnEditNodeByDraw);
  const [spawnInkNodeByDraw, setSpawnInkNodeByDraw] = useState(false);
  const spawnInkNodeByDrawRef = useRef<boolean>(spawnInkNodeByDraw);
  const [inkSendCropEnabled, setInkSendCropEnabled] = useState(true);
  const inkSendCropEnabledRef = useRef<boolean>(inkSendCropEnabled);
  const [inkSendCropPaddingPx, setInkSendCropPaddingPx] = useState<number>(24);
  const inkSendCropPaddingPxRef = useRef<number>(inkSendCropPaddingPx);
  const [inkSendDownscaleEnabled, setInkSendDownscaleEnabled] = useState(true);
  const inkSendDownscaleEnabledRef = useRef<boolean>(inkSendDownscaleEnabled);
  const [inkSendMaxPixels, setInkSendMaxPixels] = useState<number>(6_000_000);
  const inkSendMaxPixelsRef = useRef<number>(inkSendMaxPixels);
  const [inkSendMaxDimPx, setInkSendMaxDimPx] = useState<number>(4096);
  const inkSendMaxDimPxRef = useRef<number>(inkSendMaxDimPx);
  const [stressSpawnCount, setStressSpawnCount] = useState<number>(50);
  const [canonicalizeLayoutAlgorithm, setCanonicalizeLayoutAlgorithm] = useState<CanonicalizeLayoutAlgorithm>('layered');
  const [backgroundLibrary, setBackgroundLibrary] = useState<BackgroundLibraryItem[]>(() => []);
  const [backgroundStorageKey, setBackgroundStorageKey] = useState<string | null>(() => null);
  const [pendingImportArchive, setPendingImportArchive] = useState<ArchiveV1 | ArchiveV2 | null>(null);
  const [importIncludeDateInName, setImportIncludeDateInName] = useState(false);
  const [importBackgroundAvailable, setImportBackgroundAvailable] = useState(false);
  const [importIncludeBackground, setImportIncludeBackground] = useState(false);
  const [glassNodesEnabled, setGlassNodesEnabled] = useState<boolean>(() => false);
  const [glassNodesBlurCssPxWebgl, setGlassNodesBlurCssPxWebgl] = useState<number>(() => 10);
  const [glassNodesSaturatePctWebgl, setGlassNodesSaturatePctWebgl] = useState<number>(() => 140);
  const [glassNodesBlurCssPxCanvas, setGlassNodesBlurCssPxCanvas] = useState<number>(() => 10);
  const [glassNodesSaturatePctCanvas, setGlassNodesSaturatePctCanvas] = useState<number>(() => 140);
  const [glassNodesUnderlayAlpha, setGlassNodesUnderlayAlpha] = useState<number>(() => 0.95);
  const [glassNodesBlurBackend, setGlassNodesBlurBackend] = useState<GlassBlurBackend>(() => 'webgl');
  const [edgeRouterId, setEdgeRouterId] = useState<EdgeRouterId>(() => DEFAULT_EDGE_ROUTER_ID);
  const [replyArrowColor, setReplyArrowColor] = useState<string>(() => DEFAULT_REPLY_ARROW_COLOR);
  const [replyArrowOpacity, setReplyArrowOpacity] = useState<number>(() => DEFAULT_REPLY_ARROW_OPACITY);
  const [replySpawnKind, setReplySpawnKind] = useState<'text' | 'ink'>(() => 'text');
  const [uiGlassBlurCssPxWebgl, setUiGlassBlurCssPxWebgl] = useState<number>(() => 10);
  const [uiGlassSaturatePctWebgl, setUiGlassSaturatePctWebgl] = useState<number>(() => 140);
  const [composerFontFamily, setComposerFontFamily] = useState<FontFamilyKey>(() => DEFAULT_COMPOSER_FONT_FAMILY);
  const [composerFontSizePx, setComposerFontSizePx] = useState<number>(() => DEFAULT_COMPOSER_FONT_SIZE_PX);
  const [composerMinimized, setComposerMinimized] = useState<boolean>(() => false);
  const [nodeFontFamily, setNodeFontFamily] = useState<FontFamilyKey>(() => DEFAULT_NODE_FONT_FAMILY);
  const [nodeFontSizePx, setNodeFontSizePx] = useState<number>(() => DEFAULT_NODE_FONT_SIZE_PX);
  const [sidebarFontFamily, setSidebarFontFamily] = useState<FontFamilyKey>(() => DEFAULT_SIDEBAR_FONT_FAMILY);
  const [sidebarFontSizePx, setSidebarFontSizePx] = useState<number>(() => DEFAULT_SIDEBAR_FONT_SIZE_PX);
  const backgroundLibraryRef = useRef<BackgroundLibraryItem[]>(backgroundLibrary);
  const glassNodesEnabledRef = useRef<boolean>(glassNodesEnabled);

  useEffect(() => {
    const editingId = String(ui.editingNodeId ?? '').trim();
    if (editingId.startsWith('n')) {
      contextTargetEditNodeIdRef.current = editingId;
      return;
    }
    const selectedId = String(ui.selectedNodeId ?? '').trim();
    if (selectedId.startsWith('n')) {
      contextTargetEditNodeIdRef.current = selectedId;
    }
  }, [ui.editingNodeId, ui.selectedNodeId]);
  const glassNodesBlurCssPxWebglRef = useRef<number>(glassNodesBlurCssPxWebgl);
  const glassNodesSaturatePctWebglRef = useRef<number>(glassNodesSaturatePctWebgl);
  const glassNodesBlurCssPxCanvasRef = useRef<number>(glassNodesBlurCssPxCanvas);
  const glassNodesSaturatePctCanvasRef = useRef<number>(glassNodesSaturatePctCanvas);
  const glassNodesUnderlayAlphaRef = useRef<number>(glassNodesUnderlayAlpha);
  const glassNodesBlurBackendRef = useRef<GlassBlurBackend>(glassNodesBlurBackend);
  const edgeRouterIdRef = useRef<EdgeRouterId>(edgeRouterId);
  const replyArrowColorRef = useRef<string>(replyArrowColor);
  const replyArrowOpacityRef = useRef<number>(replyArrowOpacity);
  const replySpawnKindRef = useRef<'text' | 'ink'>(replySpawnKind);
  const uiGlassBlurCssPxWebglRef = useRef<number>(uiGlassBlurCssPxWebgl);
  const uiGlassSaturatePctWebglRef = useRef<number>(uiGlassSaturatePctWebgl);
  const composerFontFamilyRef = useRef<FontFamilyKey>(composerFontFamily);
  const composerFontSizePxRef = useRef<number>(composerFontSizePx);
  const composerMinimizedRef = useRef<boolean>(composerMinimized);
  const nodeFontFamilyRef = useRef<FontFamilyKey>(nodeFontFamily);
  const nodeFontSizePxRef = useRef<number>(nodeFontSizePx);
  const sidebarFontFamilyRef = useRef<FontFamilyKey>(sidebarFontFamily);
  const sidebarFontSizePxRef = useRef<number>(sidebarFontSizePx);
  const backgroundLoadSeqRef = useRef(0);
  const allModels = useMemo(() => listModels(), []);
  const edgeRouterOptions = useMemo(
    () => listEdgeRouters().map((r) => ({ id: r.id as EdgeRouterId, label: r.label, description: r.description })),
    [],
  );
  const [modelUserSettings, setModelUserSettings] = useState<ModelUserSettingsById>(() => buildModelUserSettings(allModels, null));
  const modelUserSettingsRef = useRef<ModelUserSettingsById>(modelUserSettings);
  const composerModelOptions = useMemo(
    () => allModels.filter((m) => modelUserSettings[m.id]?.includeInComposer !== false),
    [allModels, modelUserSettings],
  );

  const toastTimerRef = useRef<number | null>(null);
  const toastIdRef = useRef(0);
  const showToast = (message: string, kind: ToastKind = 'info', durationMs = 3200) => {
    const id = ++toastIdRef.current;
    setToast({ id, kind, message });
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    if (durationMs > 0) {
      toastTimerRef.current = window.setTimeout(() => {
        setToast((current) => (current && current.id === id ? null : current));
      }, durationMs);
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    };
  }, []);
  const [composerModelId, setComposerModelId] = useState<string>(() => DEFAULT_MODEL_ID);
  const [composerWebSearch, setComposerWebSearch] = useState<boolean>(() => true);

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
      draftInkStrokes: [],
      composerMode: 'text',
      draftAttachments: [],
      replyTo: null,
      contextSelections: [],
      selectedAttachmentKeys: [],
      headNodeId: null,
      turns: [],
      llm: { modelId: DEFAULT_MODEL_ID, webSearchEnabled: true },
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
      draftInkStrokes: [],
      composerMode: 'text',
      draftAttachments: [],
      replyTo: null,
      contextSelections: [],
      selectedAttachmentKeys: [],
      headNodeId: null,
      turns: [],
      llm: { modelId: DEFAULT_MODEL_ID, webSearchEnabled: true },
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
    modelUserSettingsRef.current = modelUserSettings;
  }, [modelUserSettings]);

  useEffect(() => {
    backgroundLibraryRef.current = backgroundLibrary;
  }, [backgroundLibrary]);

  useEffect(() => {
    allowEditingAllTextNodesRef.current = allowEditingAllTextNodes;
    engineRef.current?.setAllowEditingAllTextNodes(allowEditingAllTextNodes);
  }, [allowEditingAllTextNodes]);

  useEffect(() => {
    spawnEditNodeByDrawRef.current = spawnEditNodeByDraw;
  }, [spawnEditNodeByDraw]);

  useEffect(() => {
    spawnInkNodeByDrawRef.current = spawnInkNodeByDraw;
  }, [spawnInkNodeByDraw]);

  useEffect(() => {
    inkSendCropEnabledRef.current = inkSendCropEnabled;
  }, [inkSendCropEnabled]);

  useEffect(() => {
    inkSendCropPaddingPxRef.current = inkSendCropPaddingPx;
  }, [inkSendCropPaddingPx]);

  useEffect(() => {
    inkSendDownscaleEnabledRef.current = inkSendDownscaleEnabled;
  }, [inkSendDownscaleEnabled]);

  useEffect(() => {
    inkSendMaxPixelsRef.current = inkSendMaxPixels;
  }, [inkSendMaxPixels]);

  useEffect(() => {
    inkSendMaxDimPxRef.current = inkSendMaxDimPx;
  }, [inkSendMaxDimPx]);

  useEffect(() => {
    edgeRouterIdRef.current = edgeRouterId;
    engineRef.current?.setEdgeRouter(edgeRouterId);
  }, [edgeRouterId]);

  useEffect(() => {
    replyArrowColorRef.current = replyArrowColor;
    engineRef.current?.setReplyArrowColor(replyArrowColor);
  }, [replyArrowColor]);

  useEffect(() => {
    replyArrowOpacityRef.current = replyArrowOpacity;
    engineRef.current?.setReplyArrowOpacity(replyArrowOpacity);
  }, [replyArrowOpacity]);

  useEffect(() => {
    replySpawnKindRef.current = replySpawnKind;
    engineRef.current?.setReplySpawnKind(replySpawnKind);
  }, [replySpawnKind]);

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
    composerFontFamilyRef.current = composerFontFamily;
    composerFontSizePxRef.current = composerFontSizePx;
    nodeFontFamilyRef.current = nodeFontFamily;
    nodeFontSizePxRef.current = nodeFontSizePx;
    sidebarFontFamilyRef.current = sidebarFontFamily;
    sidebarFontSizePxRef.current = sidebarFontSizePx;

    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.style.setProperty('--composer-font-family', fontFamilyCss(composerFontFamily));
    root.style.setProperty(
      '--composer-font-size',
      `${Math.round(clampNumber(composerFontSizePx, 10, 30, DEFAULT_COMPOSER_FONT_SIZE_PX))}px`,
    );
    root.style.setProperty('--node-font-family', fontFamilyCss(nodeFontFamily));
    root.style.setProperty(
      '--node-font-size',
      `${Math.round(clampNumber(nodeFontSizePx, 10, 30, DEFAULT_NODE_FONT_SIZE_PX))}px`,
    );
    root.style.setProperty('--sidebar-font-family', fontFamilyCss(sidebarFontFamily));
    root.style.setProperty(
      '--sidebar-font-size',
      `${Math.round(clampNumber(sidebarFontSizePx, 8, 24, DEFAULT_SIDEBAR_FONT_SIZE_PX))}px`,
    );
  }, [composerFontFamily, composerFontSizePx, nodeFontFamily, nodeFontSizePx, sidebarFontFamily, sidebarFontSizePx]);

  useEffect(() => {
    composerMinimizedRef.current = composerMinimized;
  }, [composerMinimized]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const handle = window.setTimeout(() => {
      engine.setNodeTextFontFamily(fontFamilyCss(nodeFontFamilyRef.current));
      engine.setNodeTextFontSizePx(nodeFontSizePxRef.current);
    }, 200);
    return () => window.clearTimeout(handle);
  }, [nodeFontFamily, nodeFontSizePx]);

  useEffect(() => {
    setRawViewer(null);
    setNodeMenuId(null);
    setEditNodeSendMenuId(null);
    setReplySpawnMenuId(null);
  }, [activeChatId]);

  useEffect(() => {
    engineRef.current?.setRawViewerNodeId(rawViewer?.nodeId ?? null);
    return () => engineRef.current?.setRawViewerNodeId(null);
  }, [rawViewer?.nodeId]);

  const getNodeMenuButtonRect = React.useCallback((nodeId: string): { left: number; top: number; right: number; bottom: number } | null => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return null;
    const r = engine.getNodeMenuButtonScreenRect(nodeId);
    if (!r) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const left = canvasRect.left + r.x;
    const top = canvasRect.top + r.y;
    const right = left + r.w;
    const bottom = top + r.h;
    return { left, top, right, bottom };
  }, []);

  const getNodeSendMenuButtonRect = React.useCallback((nodeId: string): { left: number; top: number; right: number; bottom: number } | null => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return null;
    const r = engine.getNodeSendButtonArrowScreenRect(nodeId);
    if (!r) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const left = canvasRect.left + r.x;
    const top = canvasRect.top + r.y;
    const right = left + r.w;
    const bottom = top + r.h;
    return { left, top, right, bottom };
  }, []);

  const getNodeReplyMenuButtonRect = React.useCallback((nodeId: string): { left: number; top: number; right: number; bottom: number } | null => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return null;
    const r = engine.getNodeReplyButtonArrowScreenRect(nodeId);
    if (!r) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const left = canvasRect.left + r.x;
    const top = canvasRect.top + r.y;
    const right = left + r.w;
    const bottom = top + r.h;
    return { left, top, right, bottom };
  }, []);

  const toggleRawViewerForNode = React.useCallback((nodeId: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    const chatId = activeChatIdRef.current;
    const snapshot = engine.exportChatState();
    const node = snapshot.nodes.find((n) => n.id === nodeId) ?? null;
    if (!node) return;
    if (node.kind === 'ink') {
      const kind: RawViewerState['kind'] = 'request';
      const title = `Raw request • ${node.title}`;
      const key = chatId ? `${chatId}/${nodeId}/req` : '';

      setRawViewer((prev) => {
        if (prev?.nodeId === nodeId) return null;
        return { nodeId, title, kind, payload: undefined };
      });

      if (!key) return;
      void (async () => {
        try {
          const loaded = await getPayload(key);
          setRawViewer((prev) => {
            if (!prev || prev.nodeId !== nodeId) return prev;
            return { ...prev, payload: loaded === null ? undefined : cloneRawPayloadForDisplay(loaded) };
          });
        } catch {
          // ignore
        }
      })();
      return;
    }

    if (node.kind !== 'text') return;
	    const kind: RawViewerState['kind'] = node.author === 'user' ? 'request' : 'response';
	    const title = `${kind === 'request' ? 'Raw request' : 'Raw response'} • ${node.title}`;

	    const directPayload = kind === 'request' ? (node as any).apiRequest : (node as any).apiResponse;
	    const rawKey = kind === 'request' ? (node as any).apiRequestKey : (node as any).apiResponseKey;
	    const explicitKey = typeof rawKey === 'string' ? rawKey.trim() : '';
	    const key = explicitKey || (chatId ? `${chatId}/${nodeId}/${kind === 'request' ? 'req' : 'res'}` : '');

    setRawViewer((prev) => {
      if (prev?.nodeId === nodeId) return null;
      return { nodeId, title, kind, payload: directPayload };
    });

	    if (directPayload !== undefined) return;
	    if (!key) return;
	    void (async () => {
	      try {
	        const loaded = await getPayload(key);
	        setRawViewer((prev) => {
	          if (!prev || prev.nodeId !== nodeId) return prev;
	          return { ...prev, payload: loaded === null ? undefined : cloneRawPayloadForDisplay(loaded) };
	        });
	      } catch {
	        // ignore
	      }
    })();
  }, []);

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
            backgroundLibrary: backgroundLibraryRef.current,
            llm: { modelUserSettings: modelUserSettingsRef.current as any },
            visual: {
              glassNodesEnabled: Boolean(glassNodesEnabledRef.current),
              edgeRouterId: edgeRouterIdRef.current,
              replyArrowColor: replyArrowColorRef.current,
              replyArrowOpacity: Number.isFinite(replyArrowOpacityRef.current)
                ? Math.max(0, Math.min(1, replyArrowOpacityRef.current))
                : DEFAULT_REPLY_ARROW_OPACITY,
              replySpawnKind: replySpawnKindRef.current,
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
              composerFontFamily: composerFontFamilyRef.current,
              composerFontSizePx: Math.round(clampNumber(composerFontSizePxRef.current, 10, 30, DEFAULT_COMPOSER_FONT_SIZE_PX)),
              composerMinimized: Boolean(composerMinimizedRef.current),
              nodeFontFamily: nodeFontFamilyRef.current,
              nodeFontSizePx: Math.round(clampNumber(nodeFontSizePxRef.current, 10, 30, DEFAULT_NODE_FONT_SIZE_PX)),
              sidebarFontFamily: sidebarFontFamilyRef.current,
              sidebarFontSizePx: Math.round(clampNumber(sidebarFontSizePxRef.current, 8, 24, DEFAULT_SIDEBAR_FONT_SIZE_PX)),
              spawnEditNodeByDraw: Boolean(spawnEditNodeByDrawRef.current),
              spawnInkNodeByDraw: Boolean(spawnInkNodeByDrawRef.current),
              inkSendCropEnabled: Boolean(inkSendCropEnabledRef.current),
              inkSendCropPaddingPx: Math.round(clampNumber(inkSendCropPaddingPxRef.current, 0, 200, 24)),
              inkSendDownscaleEnabled: Boolean(inkSendDownscaleEnabledRef.current),
              inkSendMaxPixels: Math.round(clampNumber(inkSendMaxPixelsRef.current, 100_000, 40_000_000, 6_000_000)),
              inkSendMaxDimPx: Math.round(clampNumber(inkSendMaxDimPxRef.current, 256, 8192, 4096)),
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
                backgroundLibrary: backgroundLibraryRef.current,
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
    engine.setEdgeRouter(edgeRouterIdRef.current);
    engine.setReplyArrowColor(replyArrowColorRef.current);
    engine.setReplyArrowOpacity(replyArrowOpacityRef.current);
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

  const setChatBackgroundStorageKey = (chatId: string, storageKey: string | null) => {
    if (!chatId) return;
    const key = typeof storageKey === 'string' ? storageKey : null;
    const meta = ensureChatMeta(chatId);
    meta.backgroundStorageKey = key;
    if (activeChatIdRef.current === chatId) {
      setBackgroundStorageKey(key);
      applyVisualSettings(chatId);
    }
    attachmentsGcDirtyRef.current = true;
    schedulePersistSoon();
  };

  const setBackgroundLibraryNext = (next: BackgroundLibraryItem[]) => {
    backgroundLibraryRef.current = next;
    setBackgroundLibrary(next);
  };

  const upsertBackgroundLibraryItem = (item: BackgroundLibraryItem) => {
    const storageKey = typeof item?.storageKey === 'string' ? item.storageKey : '';
    if (!storageKey) return;
    const prev = backgroundLibraryRef.current ?? [];
    const idx = prev.findIndex((b) => b.storageKey === storageKey);
    const normalized: BackgroundLibraryItem = {
      id: storageKey,
      storageKey,
      name: String(item.name ?? '').trim() || `Background ${storageKey.slice(-6)}`,
      createdAt: Number.isFinite(item.createdAt) ? Math.max(0, Math.floor(item.createdAt)) : Date.now(),
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      ...(typeof item.size === 'number' ? { size: item.size } : {}),
    };
    const next = idx >= 0 ? prev.map((b, i) => (i === idx ? { ...b, ...normalized } : b)) : [normalized, ...prev];
    next.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.name.localeCompare(b.name));
    setBackgroundLibraryNext(next);
    attachmentsGcDirtyRef.current = true;
    schedulePersistSoon();
  };

  const renameBackgroundLibraryItem = (backgroundId: string, name: string) => {
    const id = String(backgroundId ?? '').trim();
    const nextName = String(name ?? '').trim();
    if (!id || !nextName) return;
    const prev = backgroundLibraryRef.current ?? [];
    const next = prev.map((b) => (b.id === id ? { ...b, name: nextName } : b));
    setBackgroundLibraryNext(next);
    schedulePersistSoon();
  };

  const requestDeleteBackgroundLibraryItem = (backgroundId: string) => {
    const id = String(backgroundId ?? '').trim();
    if (!id) return;
    const bg = (backgroundLibraryRef.current ?? []).find((b) => b.id === id);
    if (!bg) return;
    setConfirmDelete({ kind: 'background', backgroundId: id, name: bg.name });
  };

  const performDeleteBackgroundLibraryItem = (backgroundId: string) => {
    const id = String(backgroundId ?? '').trim();
    if (!id) return;

    setConfirmApplyBackground((prev) => (prev?.backgroundId === id ? null : prev));

    const prevLib = backgroundLibraryRef.current ?? [];
    const nextLib = prevLib.filter((b) => b.id !== id);
    setBackgroundLibraryNext(nextLib);

    for (const [chatId, meta] of Array.from(chatMetaRef.current.entries())) {
      if (meta?.backgroundStorageKey !== id) continue;
      meta.backgroundStorageKey = null;
      if (activeChatIdRef.current === chatId) {
        setBackgroundStorageKey(null);
        applyVisualSettings(chatId);
      }
    }

    attachmentsGcDirtyRef.current = true;
    void (async () => {
      try {
        await deleteAttachment(id);
      } catch {
        // ignore
      } finally {
        schedulePersistSoon();
      }
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
	      llmTask: undefined,
	      thinkingSummary: undefined,
	    };
    if (result.apiResponse !== undefined) patch.apiResponse = result.apiResponse;
    if (result.apiResponseKey !== undefined) patch.apiResponseKey = result.apiResponseKey;
    if (result.canonicalMessage !== undefined) patch.canonicalMessage = result.canonicalMessage as any;
    if (result.canonicalMeta !== undefined) patch.canonicalMeta = result.canonicalMeta as any;
    updateStoredTextNode(job.chatId, job.assistantNodeId, patch);

	    if (activeChatIdRef.current === job.chatId) {
	      const engine = engineRef.current;
	      engine?.setTextNodeLlmState(job.assistantNodeId, {
	        isGenerating: false,
	        modelId: job.modelId,
	        llmError: result.error,
	        llmTask: null,
	      } as any);
	      if (result.canonicalMessage !== undefined || result.canonicalMeta !== undefined) {
	        engine?.setTextNodeCanonical(job.assistantNodeId, {
	          canonicalMessage: result.canonicalMessage,
	          canonicalMeta: result.canonicalMeta,
        });
      }
	      engine?.setTextNodeThinkingSummary(job.assistantNodeId, undefined);
	      engine?.setTextNodeContent(job.assistantNodeId, finalText, { streaming: false });
	      if (result.apiResponse !== undefined || result.apiResponseKey !== undefined) {
	        engine?.setTextNodeApiPayload(job.assistantNodeId, {
	          apiResponse: result.apiResponse,
	          apiResponseKey: result.apiResponseKey,
	        });
	      }
	    }

    generationJobsByAssistantIdRef.current.delete(assistantNodeId);
    schedulePersistSoon();
  };

	  const cancelJob = (assistantNodeId: string) => {
	    const job = generationJobsByAssistantIdRef.current.get(assistantNodeId);
	    if (!job) return;

	    const chatId = job.chatId;
	    const taskId = typeof job.taskId === 'string' ? job.taskId.trim() : '';
	    const shouldCancelRemote = Boolean(job.background && taskId);
	    const apiKey = shouldCancelRemote ? getOpenAIApiKey() : null;
	    try {
	      job.abortController.abort();
	    } catch {
	      // ignore
	    }
	    finishJob(assistantNodeId, { finalText: job.fullText, error: 'Canceled', cancelled: true });

	    if (!shouldCancelRemote || !apiKey) return;
	    void (async () => {
	      const cancelled = await cancelOpenAIResponse({ apiKey, responseId: taskId });
	      if (!cancelled.ok || cancelled.response === undefined) return;
	      const storedResponse = cloneRawPayloadForDisplay(cancelled.response);
	      let responseKey: string | undefined = undefined;
	      try {
	        const key = `${chatId}/${assistantNodeId}/res`;
	        await putPayload({ key, json: cancelled.response });
	        responseKey = key;
	      } catch {
	        // ignore
	      }
		      updateStoredTextNode(chatId, assistantNodeId, { apiResponse: storedResponse, apiResponseKey: responseKey });
		      if (activeChatIdRef.current === chatId) {
		        engineRef.current?.setTextNodeApiPayload(assistantNodeId, { apiResponse: storedResponse, apiResponseKey: responseKey });
		      }
		      schedulePersistSoon();
		    })();
		  };

  const startOpenAIGeneration = (args: {
    chatId: string;
    userNodeId: string;
    assistantNodeId: string;
    settings: OpenAIChatSettings;
    nodesOverride?: ChatNode[];
  }) => {
    const chatId = args.chatId;
    if (!chatId) return;
    if (generationJobsByAssistantIdRef.current.has(args.assistantNodeId)) return;

    const apiKey = getOpenAIApiKey();
    if (!apiKey) {
      const msg = 'OpenAI API key missing. Set OPENAI_API_KEY in graphchatv1/.env.local';
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
	      background: Boolean(settings.background),
	      taskId: null,
	      lastEventSeq: null,
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
          nodes: args.nodesOverride ?? state?.nodes ?? [],
          leafUserNodeId: args.userNodeId,
          settings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finishJob(job.assistantNodeId, { finalText: job.fullText, error: msg });
        return;
      }
	      if (job.closed || job.abortController.signal.aborted) return;

	      const streamingEnabled = typeof settings.stream === 'boolean' ? settings.stream : true;
	      const backgroundEnabled = Boolean(settings.background);
	      const sentRequest = backgroundEnabled
	        ? { ...(request ?? {}), background: true, ...(streamingEnabled ? { stream: true } : {}) }
	        : streamingEnabled
	          ? { ...(request ?? {}), stream: true }
	          : { ...(request ?? {}) };
	      const storedRequest = cloneRawPayloadForDisplay(sentRequest);
	      updateStoredTextNode(chatId, job.userNodeId, { apiRequest: storedRequest });
	      if (activeChatIdRef.current === chatId) {
	        engineRef.current?.setTextNodeApiPayload(job.userNodeId, { apiRequest: storedRequest });
      }
	      try {
	        const key = `${chatId}/${job.userNodeId}/req`;
	        await putPayload({ key, json: sentRequest });
	        updateStoredTextNode(chatId, job.userNodeId, { apiRequestKey: key });
	        if (activeChatIdRef.current === chatId) {
	          engineRef.current?.setTextNodeApiPayload(job.userNodeId, { apiRequestKey: key });
	        }
	      } catch {
	        // ignore
		      }
	      schedulePersistSoon();

	      const callbacks = {
	        onDelta: (_delta: string, fullText: string) => {
	          if (job.closed) return;
	          job.fullText = fullText;
	          scheduleJobFlush(job);
	        },
		        onEvent: (evt: any) => {
		          if (job.closed) return;

		          const seq = typeof evt?.sequence_number === 'number' ? evt.sequence_number : null;
		          if (seq != null) job.lastEventSeq = seq;
		          if (seq != null && job.background && typeof job.taskId === 'string' && job.taskId) {
		            const llmTask = {
		              provider: 'openai',
		              kind: 'response',
		              taskId: job.taskId,
		              background: true,
		              cancelable: true,
		              lastEventSeq: seq,
		            };
		            updateStoredTextNode(chatId, job.assistantNodeId, { llmTask } as any);
		            if (activeChatIdRef.current === chatId) {
		              engineRef.current?.setTextNodeLlmState(job.assistantNodeId, { llmTask } as any);
		            }
		          }

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
	            const nextChunks: ThinkingSummaryChunk[] = chunks.map((c) =>
	              c.summaryIndex === idx ? { ...c, done: true } : c,
	            );
	            job.thinkingSummary = nextChunks;

	            updateStoredTextNode(chatId, job.assistantNodeId, { thinkingSummary: nextChunks });
	            if (activeChatIdRef.current === chatId) {
	              engineRef.current?.setTextNodeThinkingSummary(job.assistantNodeId, nextChunks);
	            }
	          }
	        },
	      };

	      const sleepMs = (ms: number) =>
	        new Promise<void>((resolve) => {
	          if (job.abortController.signal.aborted) return resolve();
	          const handle = window.setTimeout(resolve, ms);
	          job.abortController.signal.addEventListener(
	            'abort',
	            () => {
	              try {
	                window.clearTimeout(handle);
	              } catch {
	                // ignore
	              }
	              resolve();
	            },
	            { once: true },
	          );
	        });

	      const pollResponseUntilDone = async (responseId: string) => {
	        const minDelayMs = 650;
	        const maxDelayMs = 2500;
	        let delayMs = minDelayMs;
	        while (!job.closed && !job.abortController.signal.aborted) {
	          const got = await retrieveOpenAIResponse({ apiKey, responseId, signal: job.abortController.signal });
	          if (!got.ok) return { ok: false as const, text: job.fullText, error: got.error, cancelled: got.cancelled, response: got.response };

		          const raw: any = got.response as any;
		          const outputText = typeof raw?.output_text === 'string' ? String(raw.output_text) : '';
		          if (outputText && outputText !== job.fullText && outputText.length >= job.fullText.length) {
		            job.fullText = outputText;
		            scheduleJobFlush(job);
		          }

	          const status = typeof got.status === 'string' ? got.status : typeof raw?.status === 'string' ? String(raw.status) : '';
	          if (status === 'completed') return { ok: true as const, text: outputText || job.fullText, response: got.response };
	          if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
	            const error = status === 'cancelled' ? 'Canceled' : status === 'incomplete' ? 'Incomplete' : 'Failed';
	            return { ok: false as const, text: outputText || job.fullText, error, response: got.response };
	          }

	          await sleepMs(delayMs);
	          delayMs = Math.min(maxDelayMs, Math.round(delayMs * 1.25));
	        }

	        return { ok: false as const, text: job.fullText, error: 'Canceled', cancelled: true };
	      };

		      const res = backgroundEnabled
		        ? await (async () => {
		            const startNonStreamingBackground = async () => {
		              const started = await startOpenAIBackgroundResponse({
		                apiKey,
		                request: sentRequest,
		                signal: job.abortController.signal,
		              });

		              if (!started.ok)
		                return {
		                  ok: false as const,
		                  text: job.fullText,
		                  error: started.error,
		                  cancelled: started.cancelled,
		                  response: started.response,
		                };
		              if (job.closed || job.abortController.signal.aborted)
		                return { ok: false as const, text: job.fullText, error: 'Canceled', cancelled: true };

		              job.taskId = started.responseId;

		              updateStoredTextNode(chatId, job.assistantNodeId, {
		                llmTask: { provider: 'openai', kind: 'response', taskId: started.responseId, background: true, cancelable: true },
		              } as any);
		              if (activeChatIdRef.current === chatId) {
		                engineRef.current?.setTextNodeLlmState(job.assistantNodeId, {
		                  llmTask: { provider: 'openai', kind: 'response', taskId: started.responseId, background: true, cancelable: true },
		                } as any);
		              }
		              schedulePersistSoon();

		              if (started.status === 'completed') {
		                const raw: any = started.response as any;
		                const text = typeof raw?.output_text === 'string' ? String(raw.output_text) : job.fullText;
		                return { ok: true as const, text, response: started.response };
		              }

		              return await pollResponseUntilDone(started.responseId);
		            };

			            if (!streamingEnabled) return await startNonStreamingBackground();

			            let responseIdResolve!: (id: string) => void;
			            let responseIdSettled = false;
			            const responseIdPromise = new Promise<string>((resolve) => {
			              responseIdResolve = resolve;
			            });

		            const backgroundCallbacks = {
		              ...callbacks,
		              onEvent: (evt: any) => {
		                if (job.closed) return;
		                const t = typeof evt?.type === 'string' ? String(evt.type) : '';
		                if (t === 'response.created') {
		                  const responseId = typeof evt?.response?.id === 'string' ? String(evt.response.id) : '';
		                  if (responseId && !responseIdSettled) {
		                    responseIdSettled = true;
		                    responseIdResolve(responseId);
		                  }
		                  if (responseId && !job.taskId) {
		                    job.taskId = responseId;

		                    updateStoredTextNode(chatId, job.assistantNodeId, {
		                      llmTask: {
		                        provider: 'openai',
		                        kind: 'response',
		                        taskId: responseId,
		                        background: true,
		                        cancelable: true,
		                      },
		                    } as any);
		                    if (activeChatIdRef.current === chatId) {
		                      engineRef.current?.setTextNodeLlmState(job.assistantNodeId, {
		                        llmTask: {
		                          provider: 'openai',
		                          kind: 'response',
		                          taskId: responseId,
		                          background: true,
		                          cancelable: true,
		                        },
		                      } as any);
		                    }
		                    schedulePersistSoon();
		                  }
		                }

		                callbacks.onEvent?.(evt);
		              },
		            };

		            let streamAbort: AbortController | null = new AbortController();
		            if (job.abortController.signal.aborted) {
		              try {
		                streamAbort.abort();
		              } catch {
		                // ignore
		              }
		            } else {
		              job.abortController.signal.addEventListener(
		                'abort',
		                () => {
		                  try {
		                    streamAbort?.abort();
		                  } catch {
		                    // ignore
		                  }
		                },
		                { once: true },
		              );
		            }

			            const streamPromise = streamOpenAIResponse({
			              apiKey,
			              request: sentRequest,
			              signal: streamAbort.signal,
			              callbacks: backgroundCallbacks,
			            });

			            const first = await Promise.race([
			              responseIdPromise.then((id) => ({ kind: 'id' as const, id })),
			              streamPromise.then((result) => ({ kind: 'result' as const, result })),
			            ]);

			            if (first.kind === 'result') {
			              if (streamAbort) {
			                try {
			                  streamAbort.abort();
			                } catch {
			                  // ignore
			                }
			              }
			              streamAbort = null;
			              return first.result as any;
			            }

			            const responseId = first.id;
			            let activeStreamAbort: AbortController | null = streamAbort;

			            const startStreamById = (startingAfter?: number) => {
			              const nextAbort = new AbortController();
			              activeStreamAbort = nextAbort;
			              if (job.abortController.signal.aborted) {
			                try {
			                  nextAbort.abort();
			                } catch {
			                  // ignore
			                }
			              } else {
			                job.abortController.signal.addEventListener(
			                  'abort',
			                  () => {
			                    try {
			                      nextAbort.abort();
			                    } catch {
			                      // ignore
			                    }
			                  },
			                  { once: true },
			                );
			              }

			              return streamOpenAIResponseById({
			                apiKey,
			                responseId,
			                startingAfter,
			                initialText: job.fullText,
			                signal: nextAbort.signal,
			                callbacks,
			              });
			            };

			            let pollDone = false;
			            const polledPromise = (async () => {
			              const res = await pollResponseUntilDone(responseId);
			              pollDone = true;
			              return res;
			            })();

			            void (async () => {
			              let attempts = 0;
			              let currentPromise: Promise<any> = streamPromise;
			              while (!pollDone && !job.closed && !job.abortController.signal.aborted) {
			                const r: any = await currentPromise;
			                if (pollDone || job.closed || job.abortController.signal.aborted) return;
			                if (r?.cancelled) return;
			                const status = typeof r?.response?.status === 'string' ? String(r.response.status) : '';
			                const terminal = status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'incomplete';
			                if (r?.ok && terminal) return;

			                if (attempts >= 2) return;
			                attempts += 1;
			                const startingAfter = typeof job.lastEventSeq === 'number' && Number.isFinite(job.lastEventSeq) ? job.lastEventSeq : undefined;
			                await sleepMs(250 * attempts);
			                currentPromise = startStreamById(startingAfter);
			              }
			            })();

			            if (job.closed || job.abortController.signal.aborted) {
			              if (activeStreamAbort) {
			                try {
			                  activeStreamAbort.abort();
			                } catch {
			                  // ignore
			                }
			              }
			              return { ok: false as const, text: job.fullText, error: 'Canceled', cancelled: true };
			            }

			            const polled = await polledPromise;
			            if (activeStreamAbort) {
			              try {
			                activeStreamAbort.abort();
			              } catch {
			                // ignore
			              }
			            }
			            return polled;
		          })()
		        : streamingEnabled
		          ? await streamOpenAIResponse({
		              apiKey,
	              request,
	              signal: job.abortController.signal,
	              callbacks,
	            })
	          : await sendOpenAIResponse({
	              apiKey,
	              request,
	              signal: job.abortController.signal,
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

  const startGeminiGeneration = (args: {
    chatId: string;
    userNodeId: string;
    assistantNodeId: string;
    settings: GeminiChatSettings;
    nodesOverride?: ChatNode[];
  }) => {
    const chatId = args.chatId;
    if (!chatId) return;
    if (generationJobsByAssistantIdRef.current.has(args.assistantNodeId)) return;

    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      const msg = 'Gemini API key missing. Set GEMINI_API_KEY in graphchatv1/.env.local';
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
    const llmParams = { webSearchEnabled: settings.webSearchEnabled };

    const job: GenerationJob = {
      chatId,
      userNodeId: args.userNodeId,
      assistantNodeId: args.assistantNodeId,
      modelId: settings.modelId,
      llmParams,
      startedAt: Date.now(),
      abortController: new AbortController(),
      background: false,
      taskId: null,
      lastEventSeq: null,
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
      let request: any;
      let requestSnapshot: any;
      try {
        const ctx = await buildGeminiContext({
          nodes: args.nodesOverride ?? state?.nodes ?? [],
          leafUserNodeId: args.userNodeId,
          settings,
        });
        request = ctx.request;
        requestSnapshot = ctx.requestSnapshot;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finishJob(job.assistantNodeId, { finalText: job.fullText, error: msg });
        return;
      }
      if (job.closed || job.abortController.signal.aborted) return;

      const persistedRequest = requestSnapshot ?? request;
      const storedRequest = cloneRawPayloadForDisplay(persistedRequest);
      updateStoredTextNode(chatId, job.userNodeId, { apiRequest: storedRequest });
      if (activeChatIdRef.current === chatId) {
        engineRef.current?.setTextNodeApiPayload(job.userNodeId, { apiRequest: storedRequest });
      }
	      try {
	        const key = `${chatId}/${job.userNodeId}/req`;
	        await putPayload({ key, json: persistedRequest });
	        updateStoredTextNode(chatId, job.userNodeId, { apiRequestKey: key });
	        if (activeChatIdRef.current === chatId) {
	          engineRef.current?.setTextNodeApiPayload(job.userNodeId, { apiRequestKey: key });
	        }
	      } catch {
	        // ignore
	      }
      schedulePersistSoon();

      const res = await sendGeminiResponse({ request });
      if (job.closed || job.abortController.signal.aborted) return;
      if (!generationJobsByAssistantIdRef.current.has(job.assistantNodeId)) return;

      const canonicalMessage = res.canonicalMessage;
      const canonicalMeta = res.canonicalMeta;
      const finalText = (typeof res.text === 'string' ? res.text : '') || canonicalMessage?.text || '';
      const isError = res.raw == null;

      const storedResponse = res.raw != null ? cloneRawPayloadForDisplay(res.raw) : undefined;
      let responseKey: string | undefined = undefined;
      if (res.raw != null) {
        try {
          const key = `${chatId}/${job.assistantNodeId}/res`;
          await putPayload({ key, json: res.raw });
          responseKey = key;
        } catch {
          // ignore
        }
      }

      finishJob(job.assistantNodeId, {
        finalText,
        error: isError ? (finalText.trim() ? finalText : 'Gemini request failed') : null,
        apiResponse: storedResponse,
        apiResponseKey: responseKey,
        canonicalMessage,
        canonicalMeta,
      });
    })();
  };

	  const resumeOpenAIBackgroundJob = (args: {
	    chatId: string;
	    assistantNode: Extract<ChatNode, { kind: 'text' }>;
	    responseId: string;
	  }) => {
	    const chatId = args.chatId;
	    const assistantNodeId = args.assistantNode.id;
	    const responseId = args.responseId;
	    if (!chatId || !assistantNodeId || !responseId) return;
	    if (generationJobsByAssistantIdRef.current.has(assistantNodeId)) return;

	    const apiKey = getOpenAIApiKey();
	    if (!apiKey) {
	      const msg = 'OpenAI API key missing. Set OPENAI_API_KEY in graphchatv1/.env.local';
	      updateStoredTextNode(chatId, assistantNodeId, { isGenerating: false, llmError: msg, llmTask: undefined });
	      if (activeChatIdRef.current === chatId) {
	        engineRef.current?.setTextNodeLlmState(assistantNodeId, { isGenerating: false, llmError: msg, llmTask: null } as any);
	        engineRef.current?.setTextNodeContent(assistantNodeId, msg, { streaming: false });
	      }
	      schedulePersistSoon();
	      return;
	    }

	    const modelId = typeof args.assistantNode.modelId === 'string' && args.assistantNode.modelId ? args.assistantNode.modelId : DEFAULT_MODEL_ID;
		    const llmParams =
		      args.assistantNode.llmParams && typeof args.assistantNode.llmParams === 'object'
		        ? (args.assistantNode.llmParams as NonNullable<Extract<ChatNode, { kind: 'text' }>['llmParams']>)
		        : {};
		    const userNodeId = typeof args.assistantNode.parentId === 'string' ? args.assistantNode.parentId : '';

		    const modelSettings = modelUserSettingsRef.current[modelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
		    const streamingEnabled = typeof modelSettings?.streaming === 'boolean' ? modelSettings.streaming : true;
		    const resetStreamState = false;
		    const storedLastEventSeq = (() => {
		      const raw = (args.assistantNode.llmTask as any)?.lastEventSeq;
		      const n = Number(raw);
		      return Number.isFinite(n) ? n : null;
		    })();

		    const job: GenerationJob = {
		      chatId,
		      userNodeId,
		      assistantNodeId,
		      modelId,
		      llmParams,
		      startedAt: Date.now(),
		      abortController: new AbortController(),
		      background: true,
		      taskId: responseId,
		      lastEventSeq: storedLastEventSeq,
		      fullText: resetStreamState ? '' : String(args.assistantNode.content ?? ''),
		      thinkingSummary: resetStreamState ? [] : (Array.isArray(args.assistantNode.thinkingSummary) ? args.assistantNode.thinkingSummary : []),
		      lastFlushedText: '',
		      lastFlushAt: 0,
	      flushTimer: null,
	      closed: false,
	    };

	    generationJobsByAssistantIdRef.current.set(assistantNodeId, job);
	    updateStoredTextNode(chatId, assistantNodeId, {
	      ...(resetStreamState ? { content: '', thinkingSummary: undefined } : {}),
	      isGenerating: true,
	      modelId,
	      llmParams,
	      llmError: null,
	      llmTask: { provider: 'openai', kind: 'response', taskId: responseId, background: true, cancelable: true },
	    } as any);

	    if (activeChatIdRef.current === chatId) {
	      engineRef.current?.setTextNodeLlmState(assistantNodeId, {
	        isGenerating: true,
	        modelId,
	        llmParams,
	        llmError: null,
	        llmTask: { provider: 'openai', kind: 'response', taskId: responseId, background: true, cancelable: true },
	      } as any);
	      if (resetStreamState) {
	        engineRef.current?.setTextNodeThinkingSummary(assistantNodeId, undefined);
	        engineRef.current?.setTextNodeContent(assistantNodeId, '', { streaming: true });
	      }
	    }
	    schedulePersistSoon();

	    void (async () => {
		      const callbacks = {
		        onDelta: (_delta: string, fullText: string) => {
		          if (job.closed) return;
		          job.fullText = fullText;
		          scheduleJobFlush(job);
		        },
			        onEvent: (evt: any) => {
			          if (job.closed) return;
			          const seq = typeof evt?.sequence_number === 'number' ? evt.sequence_number : null;
			          if (seq != null) job.lastEventSeq = seq;
			          if (seq != null && typeof job.taskId === 'string' && job.taskId) {
			            const llmTask = {
			              provider: 'openai',
			              kind: 'response',
			              taskId: job.taskId,
			              background: true,
			              cancelable: true,
			              lastEventSeq: seq,
			            };
			            updateStoredTextNode(chatId, assistantNodeId, { llmTask } as any);
			            if (activeChatIdRef.current === chatId) {
			              engineRef.current?.setTextNodeLlmState(assistantNodeId, { llmTask } as any);
			            }
			          }
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
	            updateStoredTextNode(chatId, assistantNodeId, { thinkingSummary: nextChunks });
	            if (activeChatIdRef.current === chatId) {
	              engineRef.current?.setTextNodeThinkingSummary(assistantNodeId, nextChunks);
	            }
	          } else if (t === 'response.reasoning_summary_text.done') {
	            const idx = typeof evt?.summary_index === 'number' ? evt.summary_index : 0;
	            const chunks = job.thinkingSummary ?? [];
	            if (!chunks.length) return;
	            const nextChunks: ThinkingSummaryChunk[] = chunks.map((c) =>
	              c.summaryIndex === idx ? { ...c, done: true } : c,
	            );
	            job.thinkingSummary = nextChunks;
	            updateStoredTextNode(chatId, assistantNodeId, { thinkingSummary: nextChunks });
	            if (activeChatIdRef.current === chatId) {
	              engineRef.current?.setTextNodeThinkingSummary(assistantNodeId, nextChunks);
	            }
	          }
	        },
	      };

	      const sleepMs = (ms: number) =>
	        new Promise<void>((resolve) => {
	          if (job.abortController.signal.aborted) return resolve();
	          const handle = window.setTimeout(resolve, ms);
	          job.abortController.signal.addEventListener(
	            'abort',
	            () => {
	              try {
	                window.clearTimeout(handle);
	              } catch {
	                // ignore
	              }
	              resolve();
	            },
	            { once: true },
	          );
	        });

	      const pollResponseUntilDone = async () => {
	        const minDelayMs = 650;
	        const maxDelayMs = 2500;
	        let delayMs = minDelayMs;
	        while (!job.closed && !job.abortController.signal.aborted) {
	          const got = await retrieveOpenAIResponse({ apiKey, responseId, signal: job.abortController.signal });
	          if (!got.ok) return { ok: false as const, text: job.fullText, error: got.error, cancelled: got.cancelled, response: got.response };

		          const raw: any = got.response as any;
		          const outputText = typeof raw?.output_text === 'string' ? String(raw.output_text) : '';
		          if (outputText && outputText !== job.fullText && outputText.length >= job.fullText.length) {
		            job.fullText = outputText;
		            scheduleJobFlush(job);
		          }

	          const status = typeof got.status === 'string' ? got.status : typeof raw?.status === 'string' ? String(raw.status) : '';
	          if (status === 'completed') return { ok: true as const, text: outputText || job.fullText, response: got.response };
	          if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
	            const error = status === 'cancelled' ? 'Canceled' : status === 'incomplete' ? 'Incomplete' : 'Failed';
	            return { ok: false as const, text: outputText || job.fullText, error, response: got.response };
	          }

	          await sleepMs(delayMs);
	          delayMs = Math.min(maxDelayMs, Math.round(delayMs * 1.25));
	        }

		        return { ok: false as const, text: job.fullText, error: 'Canceled', cancelled: true };
		      };

		      let streamAbort: AbortController | null = null;
		      if (streamingEnabled) {
		        streamAbort = new AbortController();
		        if (job.abortController.signal.aborted) {
		          try {
		            streamAbort.abort();
		          } catch {
		            // ignore
		          }
		        } else {
		          job.abortController.signal.addEventListener(
		            'abort',
		            () => {
		              try {
		                streamAbort?.abort();
		              } catch {
		                // ignore
		              }
		            },
		            { once: true },
		          );
		        }

		        void streamOpenAIResponseById({
		          apiKey,
		          responseId,
		          startingAfter: job.lastEventSeq ?? undefined,
		          initialText: job.fullText,
		          signal: streamAbort.signal,
		          callbacks,
		        }).catch(() => {
		          // ignore; poll loop below is responsible for completion
		        });
		      }

		      const res = await pollResponseUntilDone();
		      if (streamAbort) {
		        try {
		          streamAbort.abort();
		        } catch {
		          // ignore
		        }
		      }

		      if (!generationJobsByAssistantIdRef.current.has(assistantNodeId)) return;

	      const usedWebSearch = Boolean(job.llmParams?.webSearchEnabled);
	      const effort = getModelInfo(modelId)?.effort;
	      const verbosity = job.llmParams?.verbosity;
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
	          const key = `${chatId}/${assistantNodeId}/res`;
	          await putPayload({ key, json: res.response });
	          responseKey = key;
	        } catch {
	          // ignore
	        }
	      }

	      if (res.ok) {
	        finishJob(assistantNodeId, {
	          finalText,
	          error: null,
	          apiResponse: storedResponse,
	          apiResponseKey: responseKey,
	          canonicalMessage,
	          canonicalMeta,
	        });
	      } else {
	        const error = res.cancelled ? 'Canceled' : res.error;
	        finishJob(assistantNodeId, {
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

	  const resumeInProgressLlmJobs = () => {
	    if (resumedLlmJobsRef.current) return;
	    resumedLlmJobsRef.current = true;

	    for (const [chatId, state] of chatStatesRef.current.entries()) {
	      const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
	      for (const n of nodes) {
	        if (!n || n.kind !== 'text') continue;
	        const textNode = n as Extract<ChatNode, { kind: 'text' }>;
	        if (!textNode.isGenerating || textNode.author !== 'assistant') continue;

	        const task = textNode.llmTask;
	        const taskProvider = typeof task?.provider === 'string' ? task.provider : '';
	        const taskKind = typeof task?.kind === 'string' ? task.kind : '';
	        const taskId = typeof task?.taskId === 'string' ? task.taskId.trim() : '';

	        if (taskProvider === 'openai' && taskKind === 'response' && taskId) {
	          resumeOpenAIBackgroundJob({ chatId, assistantNode: textNode, responseId: taskId });
	          continue;
	        }

	        const modelId = typeof textNode.modelId === 'string' && textNode.modelId ? textNode.modelId : DEFAULT_MODEL_ID;
	        const info = getModelInfo(modelId);
	        if (info?.provider !== 'openai') continue;

	        const msg = 'Interrupted (refresh). Enable Background mode to resume long-running requests.';
	        updateStoredTextNode(chatId, textNode.id, { isGenerating: false, llmError: msg, llmTask: undefined });
	        if (activeChatIdRef.current === chatId) {
	          engineRef.current?.setTextNodeLlmState(textNode.id, { isGenerating: false, llmError: msg, llmTask: null } as any);
	        }
	      }
	    }

	    schedulePersistSoon();
	  };

	  useEffect(() => {
	    const el = composerDockRef.current;
	    if (!el) return;
	    const rootEl = document.documentElement;
    const update = () => {
      const height = composerMinimized ? 38 : el.getBoundingClientRect().height;
      rootEl.style.setProperty('--composer-dock-height', `${Math.ceil(height)}px`);
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [composerMinimized]);

  useLayoutEffect(() => {
    const container = workspaceRef.current;
    const surface = worldSurfaceRef.current;
    const canvas = canvasRef.current;
    if (!container || !surface || !canvas) return;

    const engine = new WorldEngine({
      canvas,
      overlayHost: container,
      inputEl: surface,
      inputController: { enablePointerCapture: inkInputConfig.pointerCapture },
      getEditingDraft: (nodeId) => editingDraftByNodeIdRef.current.get(nodeId) ?? null,
    });
    engine.setNodeTextFontFamily(fontFamilyCss(nodeFontFamilyRef.current));
    engine.setNodeTextFontSizePx(nodeFontSizePxRef.current);
    engine.setEdgeRouter(edgeRouterIdRef.current);
    engine.setReplyArrowColor(replyArrowColorRef.current);
    engine.setReplyArrowOpacity(replyArrowOpacityRef.current);
    engine.setAllowEditingAllTextNodes(allowEditingAllTextNodesRef.current);
    engine.setSpawnEditNodeByDrawEnabled(spawnEditNodeByDrawRef.current);
    engine.setSpawnInkNodeByDrawEnabled(spawnInkNodeByDrawRef.current);
    engine.setReplySpawnKind(replySpawnKindRef.current);
    engine.onDebug = setDebug;
    engine.onUiState = (next) => {
      setUi(next);
      const editingId = typeof next.editingNodeId === 'string' ? next.editingNodeId : null;
      if (editingId !== lastEditingNodeIdRef.current) {
        lastEditingNodeIdRef.current = editingId;
        if (editingId) editingDraftByNodeIdRef.current.set(editingId, next.editingText ?? '');
      }
    };
    engine.onRequestReply = (nodeId) => {
      const chatId = activeChatIdRef.current;
      const meta = ensureChatMeta(chatId);
      const snapshot = engine.exportChatState();
      const hit = snapshot.nodes.find((n) => n.id === nodeId) ?? null;
      if (hit && hit.kind === 'pdf') {
        const storageKey = typeof (hit as any)?.storageKey === 'string' ? String((hit as any).storageKey).trim() : '';
        if (!storageKey) {
          showToast('This PDF cannot be attached (missing file storage key). Try re-importing the PDF.', 'error');
          return;
        }

        const alreadyAttached = (meta.draftAttachments ?? []).some(
          (att) => att?.kind === 'pdf' && typeof (att as any)?.storageKey === 'string' && String((att as any).storageKey).trim() === storageKey,
        );
        if (alreadyAttached) return;

        const name = typeof hit.fileName === 'string' && hit.fileName.trim() ? hit.fileName.trim() : undefined;
        const nextAtt: ChatAttachment = { kind: 'pdf', mimeType: 'application/pdf', storageKey, ...(name ? { name } : {}) };
        meta.draftAttachments = [...(meta.draftAttachments ?? []), nextAtt];
        if (activeChatIdRef.current === chatId) {
          setComposerDraftAttachments(meta.draftAttachments.slice());
        }
        if (replySpawnKindRef.current === 'ink') {
          meta.composerMode = 'ink';
          setComposerMode('ink');
        }
        schedulePersistSoon();
        return;
      }
      const preview = engine.getNodeReplyPreview(nodeId);
      const next: ReplySelection = { nodeId, preview };
      const ctx = collectContextAttachments(snapshot.nodes, nodeId);
      const keys = ctx.map((it) => it.key);
      meta.replyTo = next;
      meta.selectedAttachmentKeys = keys;
      setReplySelection(next);
      setReplyContextAttachments(ctx);
      setReplySelectedAttachmentKeys(keys);
      if (replySpawnKindRef.current === 'ink') {
        meta.composerMode = 'ink';
        setComposerMode('ink');
      }
      schedulePersistSoon();
    };
    engine.onRequestReplyToSelection = (nodeId, selectionText) => {
      const chatId = activeChatIdRef.current;
      const meta = ensureChatMeta(chatId);
      const raw = String(selectionText ?? '');
      const collapsed = raw.replace(/\s+/g, ' ').trim();
      if (!collapsed) return;
      const max = 90;
      const preview = collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
      const next: ReplySelection = { nodeId, preview, text: raw };
      const snapshot = engine.exportChatState();
      const hit = snapshot.nodes.find((n) => n.id === nodeId) ?? null;
      if (hit && hit.kind === 'pdf') {
        const storageKey = typeof (hit as any)?.storageKey === 'string' ? String((hit as any).storageKey).trim() : '';
        if (storageKey) {
          const alreadyAttached = (meta.draftAttachments ?? []).some(
            (att) =>
              att?.kind === 'pdf' &&
              typeof (att as any)?.storageKey === 'string' &&
              String((att as any).storageKey).trim() === storageKey,
          );
          if (!alreadyAttached) {
            const name = typeof hit.fileName === 'string' && hit.fileName.trim() ? hit.fileName.trim() : undefined;
            const nextAtt: ChatAttachment = { kind: 'pdf', mimeType: 'application/pdf', storageKey, ...(name ? { name } : {}) };
            meta.draftAttachments = [...(meta.draftAttachments ?? []), nextAtt];
            if (activeChatIdRef.current === chatId) {
              setComposerDraftAttachments(meta.draftAttachments.slice());
            }
          }
        }
      }
      const ctx = collectContextAttachments(snapshot.nodes, nodeId);
      const keys = ctx.map((it) => it.key);
      meta.replyTo = next;
      meta.selectedAttachmentKeys = keys;
      setReplySelection(next);
      setReplyContextAttachments(ctx);
      setReplySelectedAttachmentKeys(keys);
      schedulePersistSoon();
    };
    engine.onRequestAddToContextSelection = (_nodeId, selectionText) => {
      const chatId = activeChatIdRef.current;
      const meta = ensureChatMeta(chatId);
      const t = String(selectionText ?? '').trim();
      if (!t) return;
      const next = [...(meta.contextSelections ?? []), t];
      meta.contextSelections = next;
      setContextSelections(next);
      schedulePersistSoon();
    };
    engine.onRequestNodeMenu = (nodeId) => {
      setNodeMenuId((prev) => (prev === nodeId ? null : nodeId));
      setEditNodeSendMenuId(null);
      setReplySpawnMenuId(null);
    };
    engine.onRequestReplyMenu = (nodeId) => {
      setReplySpawnMenuId((prev) => (prev === nodeId ? null : nodeId));
      setNodeMenuId(null);
      setEditNodeSendMenuId(null);
    };
    engine.onRequestSendEditNode = (nodeId, opts) => {
      setPendingEditNodeSend({ nodeId, modelIdOverride: null, assistantRect: opts?.assistantRect ?? null });
    };
    engine.onRequestSendEditNodeModelMenu = (nodeId) => {
      setEditNodeSendMenuId((prev) => (prev === nodeId ? null : nodeId));
      setNodeMenuId(null);
      setReplySpawnMenuId(null);
    };
    engine.onRequestCancelGeneration = (nodeId) => cancelJob(nodeId);
    engine.onRequestPersist = () => schedulePersistSoon();
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
    if (!inkInputConfig.hud) return;
    const diag = inkDiagRef.current;
    diag.lastEventAt = typeof performance !== 'undefined' ? performance.now() : 0;
    diag.lastEventType = 'init';
    diag.lastEventDetail = '';
    diag.counts = {};
    diag.recent = [];

    const record = (type: string, detail: string = '') => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      diag.lastEventAt = now;
      diag.lastEventType = type;
      diag.lastEventDetail = detail;
      diag.counts[type] = (diag.counts[type] ?? 0) + 1;
      diag.recent.push({ t: now, type, detail });
      if (diag.recent.length > 24) diag.recent.splice(0, diag.recent.length - 24);
    };

    const describeTarget = (target: unknown): string => {
      if (!(target instanceof Element)) return '';
      const tag = target.tagName.toLowerCase();
      const rawClass = (target as any).className;
      const cls = typeof rawClass === 'string' ? rawClass.trim() : '';
      if (!cls) return tag;
      const parts = cls.split(/\s+/g).filter(Boolean).slice(0, 2);
      return parts.length ? `${tag}.${parts.join('.')}` : tag;
    };

    const onPointer = (e: PointerEvent) => {
      record(e.type, `${e.pointerType}#${e.pointerId}${describeTarget(e.target) ? ` ${describeTarget(e.target)}` : ''}`);
    };

    const onTouch = (e: TouchEvent) => {
      const touches = e.changedTouches ? Array.from(e.changedTouches) : [];
      const types: string[] = [];
      for (const t of touches) {
        const touchType = ((t as any).touchType ?? (t as any).type ?? '').toString().toLowerCase();
        if (touchType) types.push(touchType);
      }
      const unique = Array.from(new Set(types));
      const typeDesc = unique.length ? unique.join(',') : touches.length ? `${touches.length}touch` : '';
      const prevented = e.defaultPrevented ? ' dp' : '';
      const cancelable = e.cancelable ? '' : ' !c';
      record(e.type, `${typeDesc}${describeTarget(e.target) ? ` ${describeTarget(e.target)}` : ''}${prevented}${cancelable}`);
    };

    const onGesture = (e: Event) => record(e.type, '');
    const onSelectionChange = () => record('selectionchange', `ranges:${document.getSelection()?.rangeCount ?? 0}`);
    const onVisibilityChange = () => record('visibilitychange', document.visibilityState);
    const onBlur = () => record('blur', '');
    const onFocus = () => record('focus', '');

    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('pointerup', onPointer);
    window.addEventListener('pointercancel', onPointer);
    window.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('touchend', onTouch, { passive: true });
    window.addEventListener('touchcancel', onTouch, { passive: true });
    window.addEventListener('gesturestart', onGesture as any, true);
    window.addEventListener('gesturechange', onGesture as any, true);
    window.addEventListener('gestureend', onGesture as any, true);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);

    record('init', '');

    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('pointerup', onPointer);
      window.removeEventListener('pointercancel', onPointer);
      window.removeEventListener('touchstart', onTouch as any);
      window.removeEventListener('touchend', onTouch as any);
      window.removeEventListener('touchcancel', onTouch as any);
      window.removeEventListener('gesturestart', onGesture as any, true);
      window.removeEventListener('gesturechange', onGesture as any, true);
      window.removeEventListener('gestureend', onGesture as any, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [inkInputConfig.hud]);

  useEffect(() => {
    if (!inkInputConfig.hud) return;
    let raf = 0;
    let lastUpdateAt = 0;

    const tick = (t: number) => {
      if (t - lastUpdateAt > 200) {
        lastUpdateAt = t;
        const diag = inkDiagRef.current;
        const active = document.activeElement as HTMLElement | null;
        const activeTag = active?.tagName ? active.tagName.toLowerCase() : 'none';
        const rawClass = (active as any)?.className;
        const activeClass = typeof rawClass === 'string' ? rawClass.trim() : '';
        const activeDesc = activeClass ? `${activeTag}.${activeClass.split(/\s+/g).filter(Boolean).slice(0, 2).join('.')}` : activeTag;
        const recent = diag.recent.slice(-6).map((it) => ({ dtMs: Math.round(t - it.t), type: it.type, detail: it.detail }));

        setInkHud({
          lastEventAgoMs: Math.round(t - (diag.lastEventAt || 0)),
          lastEventType: diag.lastEventType,
          lastEventDetail: diag.lastEventDetail,
          counts: diag.counts,
          recent,
          visibilityState: document.visibilityState,
          hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
          activeEl: activeDesc,
          selectionRangeCount: document.getSelection()?.rangeCount ?? 0,
        });
      }
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => {
      try {
        window.cancelAnimationFrame(raf);
      } catch {
        // ignore
      }
    };
  }, [inkInputConfig.hud]);

  useLayoutEffect(() => {
    if (ui.tool !== 'draw' && ui.tool !== 'select') return;
    const target = inkInputConfig.layer && inkInputConfig.layerPointerEvents ? inkCaptureRef.current : worldSurfaceRef.current;
    const el = target ?? worldSurfaceRef.current;
    if (!el) return;

    if (!inkInputConfig.preventTouchStart && !inkInputConfig.preventTouchMove) return;

    const maybePreventStylus = (e: TouchEvent) => {
      if (!e.cancelable) return;
      const touches = e.changedTouches ? Array.from(e.changedTouches) : [];
      for (const t of touches) {
        const rawTouchType = ((t as any).touchType ?? (t as any).type ?? '').toString().toLowerCase();
        if (rawTouchType === 'stylus') {
          e.preventDefault();
          break;
        }
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (!inkInputConfig.preventTouchStart) return;
      maybePreventStylus(e);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!inkInputConfig.preventTouchMove) return;
      maybePreventStylus(e);
    };

    if (inkInputConfig.preventTouchStart) el.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    if (inkInputConfig.preventTouchMove) el.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart as any, true);
      el.removeEventListener('touchmove', onTouchMove as any, true);
    };
  }, [ui.tool]);

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
        if (engineRef.current.cancelPdfAnnotationPlacement()) {
          e.preventDefault();
          return;
        }
        if (engineRef.current.cancelTextAnnotationPlacement()) {
          e.preventDefault();
          return;
        }
        if (engineRef.current.cancelSpawnByDraw()) {
          e.preventDefault();
          return;
        }
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
  const editorUserPreface = ui.editingNodeId ? engineRef.current?.getTextNodeUserPreface(ui.editingNodeId) ?? null : null;
  const editorZoom = debug?.zoom ?? engineRef.current?.camera.zoom ?? 1;
  const rawAnchor = rawViewer ? engineRef.current?.getTextNodeContentScreenRect(rawViewer.nodeId) ?? null : null;
  const nodeMenuButtonRect = nodeMenuId ? getNodeMenuButtonRect(nodeMenuId) : null;
  const editNodeSendMenuButtonRect = editNodeSendMenuId ? getNodeSendMenuButtonRect(editNodeSendMenuId) : null;
  const nodeMenuRawEnabled = useMemo(() => {
    const nodeId = nodeMenuId;
    const engine = engineRef.current;
    if (!nodeId || !engine) return false;
    try {
      const snapshot = engine.exportChatState();
      const node = snapshot.nodes.find((n) => n.id === nodeId) ?? null;
      if (!node) return false;
      if (node.kind === 'ink') return true;
      if (node.kind !== 'text') return false;
      return node.author === 'user' ? (node as any).apiRequest !== undefined : (node as any).apiResponse !== undefined;
    } catch {
      return false;
    }
  }, [nodeMenuId]);

  const switchChat = (nextChatId: string, opts?: { saveCurrent?: boolean }) => {
    if (!nextChatId) return;
    const engine = engineRef.current;
    const prevChatId = activeChatId;
    if (nextChatId === prevChatId) return;

    if (prevChatId) {
      const existingMeta = chatMetaRef.current.get(prevChatId);
      if (existingMeta) {
        existingMeta.draft = composerDraft;
        existingMeta.draftInkStrokes = composerInkStrokes.slice();
        existingMeta.composerMode = composerMode;
        existingMeta.draftAttachments = composerDraftAttachments.slice();
        existingMeta.replyTo = replySelection;
        existingMeta.contextSelections = contextSelections.slice();
        existingMeta.selectedAttachmentKeys = replySelectedAttachmentKeys;
        existingMeta.llm = {
          modelId: composerModelId,
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
    setComposerMode(meta.composerMode === 'ink' ? 'ink' : 'text');
    setComposerInkStrokes(Array.isArray(meta.draftInkStrokes) ? meta.draftInkStrokes : []);
    setComposerDraftAttachments(Array.isArray(meta.draftAttachments) ? meta.draftAttachments.slice() : []);
    setReplySelection(meta.replyTo);
    setContextSelections(Array.isArray(meta.contextSelections) ? meta.contextSelections : []);
    setReplySelectedAttachmentKeys(Array.isArray(meta.selectedAttachmentKeys) ? meta.selectedAttachmentKeys : []);
    setBackgroundStorageKey(typeof meta.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : null);
    if (meta.replyTo?.nodeId) {
      const nextState = chatStatesRef.current.get(nextChatId) ?? createEmptyChatState();
      setReplyContextAttachments(collectContextAttachments(nextState.nodes, meta.replyTo.nodeId));
    } else {
      setReplyContextAttachments([]);
    }
    setComposerModelId(meta.llm.modelId || DEFAULT_MODEL_ID);
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
    setModelUserSettings(payload.llm.modelUserSettings);
    modelUserSettingsRef.current = payload.llm.modelUserSettings;
    backgroundLibraryRef.current = payload.backgroundLibrary;
    setBackgroundLibrary(payload.backgroundLibrary);

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
    edgeRouterIdRef.current = visual.edgeRouterId;
    replyArrowColorRef.current = visual.replyArrowColor;
    replyArrowOpacityRef.current = visual.replyArrowOpacity;
    replySpawnKindRef.current = visual.replySpawnKind === 'ink' ? 'ink' : 'text';
    setGlassNodesEnabled(glassNodesEnabledRef.current);
    setGlassNodesBlurCssPxWebgl(glassNodesBlurCssPxWebglRef.current);
    setGlassNodesSaturatePctWebgl(glassNodesSaturatePctWebglRef.current);
    setGlassNodesBlurCssPxCanvas(glassNodesBlurCssPxCanvasRef.current);
    setGlassNodesSaturatePctCanvas(glassNodesSaturatePctCanvasRef.current);
    setGlassNodesUnderlayAlpha(glassNodesUnderlayAlphaRef.current);
    setGlassNodesBlurBackend(glassNodesBlurBackendRef.current);
    setEdgeRouterId(edgeRouterIdRef.current);
    setReplyArrowColor(replyArrowColorRef.current);
    setReplyArrowOpacity(replyArrowOpacityRef.current);
    setReplySpawnKind(replySpawnKindRef.current);
    setUiGlassBlurCssPxWebgl(uiGlassBlurCssPxWebglRef.current);
    setUiGlassSaturatePctWebgl(uiGlassSaturatePctWebglRef.current);
    composerFontFamilyRef.current = visual.composerFontFamily;
    composerFontSizePxRef.current = visual.composerFontSizePx;
    composerMinimizedRef.current = Boolean(visual.composerMinimized);
    nodeFontFamilyRef.current = visual.nodeFontFamily;
    nodeFontSizePxRef.current = visual.nodeFontSizePx;
    sidebarFontFamilyRef.current = visual.sidebarFontFamily;
    sidebarFontSizePxRef.current = visual.sidebarFontSizePx;
    setComposerFontFamily(composerFontFamilyRef.current);
    setComposerFontSizePx(composerFontSizePxRef.current);
    setComposerMinimized(composerMinimizedRef.current);
    setNodeFontFamily(nodeFontFamilyRef.current);
    setNodeFontSizePx(nodeFontSizePxRef.current);
    setSidebarFontFamily(sidebarFontFamilyRef.current);
    setSidebarFontSizePx(sidebarFontSizePxRef.current);
    spawnEditNodeByDrawRef.current = Boolean(visual.spawnEditNodeByDraw);
    spawnInkNodeByDrawRef.current = Boolean(visual.spawnInkNodeByDraw);
    setSpawnEditNodeByDraw(spawnEditNodeByDrawRef.current);
    setSpawnInkNodeByDraw(spawnInkNodeByDrawRef.current);
    inkSendCropEnabledRef.current = Boolean(visual.inkSendCropEnabled);
    inkSendCropPaddingPxRef.current = clampNumber(visual.inkSendCropPaddingPx, 0, 200, 24);
    inkSendDownscaleEnabledRef.current = Boolean(visual.inkSendDownscaleEnabled);
    inkSendMaxPixelsRef.current = clampNumber(visual.inkSendMaxPixels, 100_000, 40_000_000, 6_000_000);
    inkSendMaxDimPxRef.current = clampNumber(visual.inkSendMaxDimPx, 256, 8192, 4096);
    setInkSendCropEnabled(inkSendCropEnabledRef.current);
    setInkSendCropPaddingPx(inkSendCropPaddingPxRef.current);
    setInkSendDownscaleEnabled(inkSendDownscaleEnabledRef.current);
    setInkSendMaxPixels(inkSendMaxPixelsRef.current);
    setInkSendMaxDimPx(inkSendMaxDimPxRef.current);

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
      engine.setEdgeRouter(edgeRouterIdRef.current);
      engine.setReplyArrowColor(replyArrowColorRef.current);
      engine.setReplyArrowOpacity(replyArrowOpacityRef.current);
      engine.setNodeTextFontFamily(fontFamilyCss(nodeFontFamilyRef.current));
      engine.setNodeTextFontSizePx(nodeFontSizePxRef.current);
      engine.setSpawnEditNodeByDrawEnabled(spawnEditNodeByDrawRef.current);
      engine.setSpawnInkNodeByDrawEnabled(spawnInkNodeByDrawRef.current);
      engine.setReplySpawnKind(replySpawnKindRef.current);
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
      setComposerMode(meta.composerMode === 'ink' ? 'ink' : 'text');
      setComposerInkStrokes(Array.isArray(meta.draftInkStrokes) ? meta.draftInkStrokes : []);
	    setComposerDraftAttachments(Array.isArray(meta.draftAttachments) ? meta.draftAttachments.slice() : []);
	    setReplySelection(meta.replyTo);
      setContextSelections(Array.isArray(meta.contextSelections) ? meta.contextSelections : []);
    setReplySelectedAttachmentKeys(Array.isArray(meta.selectedAttachmentKeys) ? meta.selectedAttachmentKeys : []);
    setBackgroundStorageKey(typeof meta.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : null);
    if (meta.replyTo?.nodeId) {
      const nextState = chatStatesRef.current.get(resolvedActive) ?? createEmptyChatState();
      setReplyContextAttachments(collectContextAttachments(nextState.nodes, meta.replyTo.nodeId));
    } else {
      setReplyContextAttachments([]);
    }
    setComposerModelId(meta.llm.modelId || DEFAULT_MODEL_ID);
	    setComposerWebSearch(Boolean(meta.llm.webSearchEnabled));

	    applyVisualSettings(resolvedActive);
	    resumeInProgressLlmJobs();
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
      const backgroundLibraryFromWorkspace = normalizeBackgroundLibrary((ws as any)?.backgroundLibrary);
      const backgroundKeysInChats = new Set<string>();

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
          const backgroundStorageKey = typeof raw?.backgroundStorageKey === 'string' ? raw.backgroundStorageKey : null;
          if (backgroundStorageKey) backgroundKeysInChats.add(backgroundStorageKey);

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
            draftInkStrokes: Array.isArray(raw?.draftInkStrokes)
              ? (raw.draftInkStrokes as any[]).map((s) => ({
                  width: Number.isFinite(Number((s as any)?.width)) ? Number((s as any).width) : 0,
                  color: typeof (s as any)?.color === 'string' ? ((s as any).color as string) : 'rgba(147,197,253,0.92)',
                  points: Array.isArray((s as any)?.points)
                    ? ((s as any).points as any[]).map((p) => ({
                        x: Number.isFinite(Number((p as any)?.x)) ? Number((p as any).x) : 0,
                        y: Number.isFinite(Number((p as any)?.y)) ? Number((p as any).y) : 0,
                      }))
                    : [],
                }))
              : [],
            composerMode: raw?.composerMode === 'ink' ? 'ink' : 'text',
            draftAttachments: Array.isArray(raw?.draftAttachments) ? (raw.draftAttachments as ChatAttachment[]) : [],
            replyTo:
              raw?.replyTo && typeof raw.replyTo === 'object' && typeof raw.replyTo.nodeId === 'string'
                ? {
                    nodeId: raw.replyTo.nodeId,
                    preview: String(raw.replyTo.preview ?? ''),
                    ...(typeof raw.replyTo.text === 'string' && raw.replyTo.text.trim()
                      ? { text: raw.replyTo.text }
                      : {}),
                  }
                : null,
            contextSelections: Array.isArray(raw?.contextSelections)
              ? (raw.contextSelections as any[]).map((t) => String(t ?? '').trim()).filter(Boolean)
              : [],
            selectedAttachmentKeys: Array.isArray(raw?.selectedAttachmentKeys)
              ? (raw.selectedAttachmentKeys as any[]).filter((k) => typeof k === 'string')
              : [],
            headNodeId: typeof raw?.headNodeId === 'string' ? raw.headNodeId : null,
            turns: Array.isArray(raw?.turns) ? (raw.turns as ChatTurnMeta[]) : [],
            llm: {
              modelId: typeof llmRaw?.modelId === 'string' ? llmRaw.modelId : DEFAULT_MODEL_ID,
              webSearchEnabled: Boolean(llmRaw?.webSearchEnabled),
            },
            backgroundStorageKey: backgroundStorageKey,
          };
          chatMeta.set(chatId, meta);
        } catch {
          // ignore missing meta
        }
      }

      const backgroundLibraryByKey = new Set(backgroundLibraryFromWorkspace.map((b) => b.storageKey));
      const backgroundLibrary = backgroundLibraryFromWorkspace.slice();
      for (const key of backgroundKeysInChats) {
        if (backgroundLibraryByKey.has(key)) continue;
        let name = '';
        let createdAt = 0;
        let mimeType = '';
        let size: number | undefined = undefined;
        try {
          const rec = await getAttachment(key);
          if (rec) {
            name = typeof rec.name === 'string' ? rec.name : '';
            createdAt = Number.isFinite(Number(rec.createdAt)) ? Number(rec.createdAt) : 0;
            mimeType = typeof rec.mimeType === 'string' ? rec.mimeType : '';
            size = Number.isFinite(Number(rec.size)) ? Number(rec.size) : undefined;
          }
        } catch {
          // ignore
        }

        const trimmedName = String(name ?? '').trim();
        const baseName = trimmedName ? trimmedName.replace(/\.[^/.]+$/, '') : `Background ${key.slice(-6)}`;
        const item: BackgroundLibraryItem = {
          id: key,
          storageKey: key,
          name: baseName,
          createdAt: Number.isFinite(createdAt) ? Math.max(0, createdAt) : 0,
          ...(mimeType ? { mimeType } : {}),
          ...(typeof size === 'number' ? { size } : {}),
        };
        backgroundLibrary.push(item);
        backgroundLibraryByKey.add(key);
      }
      backgroundLibrary.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.name.localeCompare(b.name));

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
        edgeRouterId: normalizeEdgeRouterId((visualSrc as any)?.edgeRouterId),
        replyArrowColor: normalizeHexColor((visualSrc as any)?.replyArrowColor, DEFAULT_REPLY_ARROW_COLOR),
        replyArrowOpacity: clampNumber((visualSrc as any)?.replyArrowOpacity, 0, 1, DEFAULT_REPLY_ARROW_OPACITY),
        replySpawnKind: (visualSrc as any)?.replySpawnKind === 'ink' ? ('ink' as const) : ('text' as const),
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
        composerFontFamily: normalizeFontFamilyKey(
          (visualSrc as any)?.composerFontFamily,
          DEFAULT_COMPOSER_FONT_FAMILY,
        ),
        composerFontSizePx: clampNumber(
          (visualSrc as any)?.composerFontSizePx,
          10,
          30,
          DEFAULT_COMPOSER_FONT_SIZE_PX,
        ),
        composerMinimized: Boolean((visualSrc as any)?.composerMinimized),
        nodeFontFamily: normalizeFontFamilyKey((visualSrc as any)?.nodeFontFamily, DEFAULT_NODE_FONT_FAMILY),
        nodeFontSizePx: clampNumber((visualSrc as any)?.nodeFontSizePx, 10, 30, DEFAULT_NODE_FONT_SIZE_PX),
        sidebarFontFamily: normalizeFontFamilyKey(
          (visualSrc as any)?.sidebarFontFamily,
          DEFAULT_SIDEBAR_FONT_FAMILY,
        ),
        sidebarFontSizePx: clampNumber(
          (visualSrc as any)?.sidebarFontSizePx,
          8,
          24,
          DEFAULT_SIDEBAR_FONT_SIZE_PX,
        ),
        spawnEditNodeByDraw: Boolean((visualSrc as any)?.spawnEditNodeByDraw),
        spawnInkNodeByDraw: Boolean((visualSrc as any)?.spawnInkNodeByDraw),
        inkSendCropEnabled:
          typeof (visualSrc as any)?.inkSendCropEnabled === 'boolean' ? Boolean((visualSrc as any).inkSendCropEnabled) : true,
        inkSendCropPaddingPx: clampNumber((visualSrc as any)?.inkSendCropPaddingPx, 0, 200, 24),
        inkSendDownscaleEnabled:
          typeof (visualSrc as any)?.inkSendDownscaleEnabled === 'boolean'
            ? Boolean((visualSrc as any).inkSendDownscaleEnabled)
            : true,
        inkSendMaxPixels: clampNumber((visualSrc as any)?.inkSendMaxPixels, 100_000, 40_000_000, 6_000_000),
        inkSendMaxDimPx: clampNumber((visualSrc as any)?.inkSendMaxDimPx, 256, 8192, 4096),
      };

      const modelUserSettings = buildModelUserSettings(allModels, ws.llm?.modelUserSettings);

      const payload = {
        root,
        activeChatId: desiredActiveChatId,
        focusedFolderId: typeof ws.focusedFolderId === 'string' ? ws.focusedFolderId : root.id,
        backgroundLibrary,
        llm: { modelUserSettings },
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
  }, [allModels, schedulePersistSoon]);

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
    setTreeRoot((prev) => insertItemAtTop(prev, parentFolderId, item));
    chatStatesRef.current.set(id, createEmptyChatState());
    chatMetaRef.current.set(id, {
      draft: '',
      draftInkStrokes: [],
      composerMode: 'text',
      draftAttachments: [],
      replyTo: null,
      contextSelections: [],
      selectedAttachmentKeys: [],
      headNodeId: null,
      turns: [],
      llm: { modelId: DEFAULT_MODEL_ID, webSearchEnabled: true },
      backgroundStorageKey: null,
    });
    switchChat(id);
  };

  const createFolder = (parentFolderId: string) => {
    const id = genId('folder');
    const folder: WorkspaceFolder = { kind: 'folder', id, name: 'New folder', expanded: true, children: [] };
    setTreeRoot((prev) => insertItemAtTop(prev, parentFolderId, folder));
    setFocusedFolderId(id);
    schedulePersistSoon();
  };

  const exportChat = async (chatId: string) => {
    const id = String(chatId ?? '').trim();
    if (!id) return;

    const engine = engineRef.current;
    const isActive = activeChatIdRef.current === id;

    let state: WorldEngineChatState | null = null;
    if (engine && isActive) {
      try {
        state = engine.exportChatState();
      } catch {
        state = null;
      }
    } else {
      state = chatStatesRef.current.get(id) ?? null;
    }

    if (!state) {
      try {
        const rec = await getChatStateRecord(id);
        const s = (rec?.state ?? null) as any;
        if (s && typeof s === 'object') {
          state = {
            camera: s.camera ?? { x: 0, y: 0, zoom: 1 },
            nodes: Array.isArray(s.nodes) ? (s.nodes as ChatNode[]) : [],
            worldInkStrokes: Array.isArray(s.worldInkStrokes) ? (s.worldInkStrokes as any) : [],
            pdfStates: [],
          };
        }
      } catch {
        state = null;
      }
    }

    if (!state) {
      alert('Export failed: could not load chat state.');
      return;
    }

    const info = findChatNameAndFolderPath(treeRootRef.current, id);
    const chatName = info?.name ?? `Chat ${id.slice(-4)}`;
    const folderPath = info?.folderPath ?? [];

    let meta: any = chatMetaRef.current.get(id) ?? null;
    if (!meta) {
      try {
        const rec = await getChatMetaRecord(id);
        meta = rec?.meta ?? null;
      } catch {
        meta = null;
      }
    }

    const bgKey = meta && typeof meta.backgroundStorageKey === 'string' ? String(meta.backgroundStorageKey).trim() : null;
    const bgName =
      bgKey ? (backgroundLibraryRef.current ?? []).find((b) => b.storageKey === bgKey)?.name ?? null : null;

    try {
      const mod = await import('./utils/archive');
      const { blob, filename, warnings } = await mod.exportChatArchive({
        chatId: id,
        chatName,
        folderPath,
        state: { camera: state.camera, nodes: state.nodes, worldInkStrokes: state.worldInkStrokes },
        meta,
        background: { storageKey: bgKey, name: bgName },
        appName: 'graphchatv1',
        appVersion: '0',
      });
      mod.triggerDownload(blob, filename);
      if (warnings.length) console.warn('Export warnings:', warnings);
    } catch (err: any) {
      alert(`Export failed: ${err?.message || String(err)}`);
    }
  };

  const exportAllChats = async () => {
    // Ensure active chat state + meta are up to date.
    const activeId = String(activeChatIdRef.current ?? '').trim();
    if (activeId) {
      const meta = ensureChatMeta(activeId);
      meta.draft = composerDraft;
      meta.draftAttachments = composerDraftAttachments.slice();
      meta.replyTo = replySelection;
      meta.contextSelections = contextSelections.slice();
      meta.selectedAttachmentKeys = replySelectedAttachmentKeys;
      meta.llm = {
        modelId: composerModelId || DEFAULT_MODEL_ID,
        webSearchEnabled: Boolean(composerWebSearch),
      };
      try {
        const engine = engineRef.current;
        if (engine) chatStatesRef.current.set(activeId, engine.exportChatState());
      } catch {
        // ignore
      }
    }

    const root = treeRootRef.current;
    const chatIds = collectChatIds(root);
    if (chatIds.length === 0) {
      alert('No chats to export.');
      return;
	    }
	
	    const exportArgs: any[] = [];
	    const skipped: string[] = [];
	    for (const idRaw of chatIds) {
	      const id = String(idRaw ?? '').trim();
	      if (!id) continue;

	      const info = findChatNameAndFolderPath(root, id);
	      const chatName = info?.name ?? `Chat ${id.slice(-4)}`;
	      const folderPath = info?.folderPath ?? [];

	      let state = chatStatesRef.current.get(id) ?? null;
	      if (!state) {
	        try {
	          const rec = await getChatStateRecord(id);
          const s = (rec?.state ?? null) as any;
          if (s && typeof s === 'object') {
            state = {
              camera: s.camera ?? { x: 0, y: 0, zoom: 1 },
              nodes: Array.isArray(s.nodes) ? (s.nodes as ChatNode[]) : [],
              worldInkStrokes: Array.isArray(s.worldInkStrokes) ? (s.worldInkStrokes as any) : [],
              pdfStates: [],
            };
          }
        } catch {
          state = null;
	        }
	      }
	      if (!state) {
	        skipped.push(`${chatName} (${id})`);
	        continue;
	      }

	      let meta: any = chatMetaRef.current.get(id) ?? null;
	      if (!meta) {
	        try {
          const rec = await getChatMetaRecord(id);
          meta = rec?.meta ?? null;
        } catch {
          meta = null;
	        }
	      }

	      const bgKey = meta && typeof meta.backgroundStorageKey === 'string' ? String(meta.backgroundStorageKey).trim() : null;
	      const bgName =
	        bgKey ? (backgroundLibraryRef.current ?? []).find((b) => b.storageKey === bgKey)?.name ?? null : null;

      exportArgs.push({
        chatId: id,
        chatName,
        folderPath,
        state: { camera: state.camera, nodes: state.nodes, worldInkStrokes: state.worldInkStrokes },
        meta,
        background: { storageKey: bgKey, name: bgName },
        appName: 'graphchatv1',
        appVersion: '0',
      });
    }

    if (exportArgs.length === 0) {
      alert('Export failed: could not load any chat state.');
      return;
    }

	    try {
	      const mod = await import('./utils/archive');
	      const { blob, filename, warnings } = await mod.exportAllChatArchives({
	        chats: exportArgs,
        workspace: {
          root: treeRootRef.current,
          activeChatId: String(activeChatIdRef.current ?? ''),
          focusedFolderId: String(focusedFolderIdRef.current ?? ''),
        },
	        appName: 'graphchatv1',
	        appVersion: '0',
	      });
	      mod.triggerDownload(blob, filename);
	      const allWarnings = [
	        ...(warnings ?? []),
	        ...skipped.map((s) => `Skipped chat: ${s}`),
	      ].filter(Boolean);
	      if (allWarnings.length) console.warn('Export-all warnings:', allWarnings);
	    } catch (err: any) {
	      alert(`Export failed: ${err?.message || String(err)}`);
	    }
	  };

  const requestExportChat = (chatId: string) => {
    const id = String(chatId ?? '').trim();
    if (!id) return;
    setConfirmExport({ kind: 'chat', chatId: id });
  };

  const requestExportAllChats = (opts?: { closeSettingsOnConfirm?: boolean }) => {
    setConfirmExport({ kind: 'all', closeSettingsOnConfirm: Boolean(opts?.closeSettingsOnConfirm) });
  };

  const createFolderForImport = async (parentFolderId: string) => {
    const root = treeRootRef.current;
    const pid = String(parentFolderId ?? '').trim() || root.id;
    const id = genId('folder');
    const folder: WorkspaceFolder = { kind: 'folder', id, name: 'New folder', expanded: true, children: [] };
    const nextRoot = insertItem(root, pid, folder);
    treeRootRef.current = nextRoot;
    setTreeRoot(nextRoot);
    schedulePersistSoon();
    return id;
  };

	  const importChatArchiveToFolder = async (destinationFolderId: string) => {
	    const archiveObj = pendingImportArchive;
	    if (!archiveObj) return;

    const destId = String(destinationFolderId ?? '').trim();
    if (!destId) return;

	    try {
	      const mod = await import('./utils/archive');

	      const ensureFolderPathUnder = (
	        root: WorkspaceFolder,
	        startFolderId: string,
	        segments: string[],
	      ): { root: WorkspaceFolder; folderId: string } => {
	        let nextRoot = root;
	        let parentId = startFolderId;
	        for (const segRaw of segments) {
	          const seg = String(segRaw ?? '').trim();
	          if (!seg) continue;
	          const parentItem = findItem(nextRoot, parentId);
	          const parentFolder = parentItem && parentItem.kind === 'folder' ? parentItem : nextRoot;
	          const existing = (parentFolder.children ?? []).find(
	            (c): c is WorkspaceFolder => c?.kind === 'folder' && String(c.name ?? '').trim() === seg,
	          );
	          if (existing) {
	            parentId = existing.id;
	            continue;
	          }
	          const id = genId('folder');
	          const folder: WorkspaceFolder = { kind: 'folder', id, name: seg, expanded: true, children: [] };
	          nextRoot = insertItem(nextRoot, parentId, folder);
	          parentId = id;
	        }
	        return { root: nextRoot, folderId: parentId };
	      };

	      // Build folder structure under the chosen destination folder.
	      let nextRoot = treeRootRef.current;
	      const destItem = findItem(nextRoot, destId);
	      const baseParentId = destItem && destItem.kind === 'folder' ? destId : nextRoot.id;

	      const importedChatIds: string[] = [];
	      const warnings: string[] = [];

	      const importOneChat = async (chat: ArchiveV1['chat']) => {
	        const newChatId = genId('chat');
	        const archive: ArchiveV1 = {
	          format: 'graphchatv1',
	          schemaVersion: 1,
	          exportedAt: typeof (archiveObj as any).exportedAt === 'string' ? (archiveObj as any).exportedAt : new Date().toISOString(),
	          ...(typeof (archiveObj as any).app === 'object' ? { app: (archiveObj as any).app } : {}),
	          chat,
	        };

		        const res = await mod.importArchive(archive, {
		          newChatId,
		          includeImportDateInName: importIncludeDateInName,
		          includeBackgroundFromArchive: importIncludeBackground,
		        });

	        const segments = Array.isArray(res.folderPath) ? res.folderPath : [];
	        const ensured = ensureFolderPathUnder(nextRoot, baseParentId, segments);
	        nextRoot = ensured.root;

	        const item: WorkspaceChat = { kind: 'chat', id: newChatId, name: res.chatName };
	        nextRoot = insertItem(nextRoot, ensured.folderId, item);

	        chatStatesRef.current.set(newChatId, res.state);
	        chatMetaRef.current.set(newChatId, res.meta as ChatRuntimeMeta);
	        if (res.backgroundLibraryItem) upsertBackgroundLibraryItem(res.backgroundLibraryItem);
	        if (res.warnings.length) warnings.push(...res.warnings.map((w) => `${res.chatName}: ${w}`));

	        importedChatIds.push(newChatId);
	      };

	      if (Number((archiveObj as any).schemaVersion) === 2) {
	        const chats = Array.isArray((archiveObj as any).chats) ? ((archiveObj as any).chats as ArchiveV1['chat'][]) : [];
	        for (const chat of chats) {
	          try {
	            await importOneChat(chat);
	          } catch (err: any) {
	            warnings.push(`${String((chat as any)?.name ?? 'Chat')}: import failed (${err?.message || String(err)})`);
	          }
	        }
	      } else {
	        await importOneChat((archiveObj as any).chat);
	      }

	      if (importedChatIds.length === 0) {
	        alert('Import failed: no chats were imported.');
	        return;
	      }

	      treeRootRef.current = nextRoot;
	      setTreeRoot(nextRoot);

		      setPendingImportArchive(null);
		      setImportIncludeDateInName(false);
		      setImportBackgroundAvailable(false);
		      setImportIncludeBackground(false);

	      switchChat(importedChatIds[0]);
	      schedulePersistSoon();

			      if (warnings.length) console.warn('Import warnings:', warnings);
			      showToast(`Import complete. Imported ${importedChatIds.length} chat(s).`, 'success');
			    } catch (err: any) {
			      alert(`Import failed: ${err?.message || String(err)}`);
			    }
			  };

  const requestDeleteTreeItem = (itemId: string) => {
    if (!itemId) return;
    const existing = findItem(treeRoot, itemId);
    if (!existing) return;
    if (itemId === treeRoot.id) return;
    setConfirmDelete({ kind: 'tree-item', itemId, itemType: existing.kind, name: existing.name });
  };

  const performDeleteTreeItem = (itemId: string) => {
    if (!itemId) return;
    const existing = findItem(treeRoot, itemId);
    if (!existing) return;
    if (itemId === treeRoot.id) return;

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
          draftInkStrokes: [],
          composerMode: 'text',
          draftAttachments: [],
          replyTo: null,
          contextSelections: [],
          selectedAttachmentKeys: [],
          headNodeId: null,
          turns: [],
          llm: { modelId: DEFAULT_MODEL_ID, webSearchEnabled: true },
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

  const requestDeleteNode = (nodeId: string) => {
    if (!nodeId) return;
    setConfirmDelete({ kind: 'node', nodeId });
  };

  const performDeleteNode = (nodeId: string) => {
    const engine = engineRef.current;
    if (!engine) return;

    engine.deleteNode(nodeId);
    attachmentsGcDirtyRef.current = true;
    schedulePersistSoon();

    setRawViewer((prev) => (prev?.nodeId === nodeId ? null : prev));
    const chatId = activeChatIdRef.current;
    const meta = ensureChatMeta(chatId);
    if (meta.replyTo?.nodeId === nodeId) {
      meta.replyTo = null;
      meta.selectedAttachmentKeys = [];
      setReplySelection(null);
      setReplyContextAttachments([]);
      setReplySelectedAttachmentKeys([]);
    }
  };

  const confirmDeleteTitle =
    confirmDelete?.kind === 'tree-item'
      ? `Delete ${confirmDelete.itemType === 'chat' ? 'Chat' : 'Folder'}?`
      : confirmDelete?.kind === 'node'
        ? 'Delete Node?'
        : confirmDelete?.kind === 'background'
          ? 'Delete Background?'
        : '';

  const confirmDeleteMessage =
    confirmDelete?.kind === 'tree-item'
      ? `${confirmDelete.name ? `"${confirmDelete.name}" ` : ''}This action cannot be undone.`
      : confirmDelete?.kind === 'node'
        ? 'This action cannot be undone.'
        : confirmDelete?.kind === 'background'
          ? `${confirmDelete.name ? `"${confirmDelete.name}" ` : ''}This will remove it from the library and clear it from any chats using it.`
        : '';

  const confirmDeleteNow = () => {
    const payload = confirmDelete;
    setConfirmDelete(null);
    if (!payload) return;
    if (payload.kind === 'tree-item') {
      performDeleteTreeItem(payload.itemId);
    } else if (payload.kind === 'node') {
      performDeleteNode(payload.nodeId);
    } else {
      performDeleteBackgroundLibraryItem(payload.backgroundId);
    }
  };

  const confirmExportTitle =
    confirmExport?.kind === 'all'
      ? 'Export all?'
      : confirmExport?.kind === 'chat'
        ? (() => {
            const chatId = String(confirmExport.chatId ?? '').trim();
            const info = chatId ? findChatNameAndFolderPath(treeRootRef.current, chatId) : null;
            const rawName = typeof info?.name === 'string' ? info.name.trim() : '';
            const chatName = rawName || (chatId ? `Chat ${chatId.slice(-4)}` : 'Chat');
            return `Export ${chatName}?`;
          })()
        : '';

  const confirmExportNow = () => {
    const payload = confirmExport;
    setConfirmExport(null);
    if (!payload) return;

    if (payload.kind === 'chat') {
      void exportChat(payload.chatId);
      return;
    }

    if (payload.closeSettingsOnConfirm) setSettingsOpen(false);
    void exportAllChats();
  };

  const sendTurn = (args: SendTurnArgs) => {
    const engine = engineRef.current;
    if (!engine) return;

    const raw = String(args.userText ?? '');

    const composerContextTexts = (contextSelections ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);

    const selectionReplyTo =
      replySelection && typeof replySelection.text === 'string' ? replySelection.text.trim() : '';
    const extraReplyTo =
      args.extraUserPreface && typeof args.extraUserPreface.replyTo === 'string' ? args.extraUserPreface.replyTo.trim() : '';
    const replyTo = extraReplyTo || selectionReplyTo;

    const nodeContextTexts = Array.isArray(args.extraUserPreface?.contexts)
      ? args.extraUserPreface!.contexts!.map((t) => String(t ?? '').trim()).filter(Boolean)
      : [];

    const contextTexts = (() => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const t of [...nodeContextTexts, ...composerContextTexts]) {
        if (!t) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
      return out;
    })();
    const hasPreface = Boolean(replyTo || contextTexts.length > 0);

    if (!raw.trim() && composerDraftAttachments.length === 0 && !hasPreface) return;

    const selectedModelId = String(args.modelIdOverride || composerModelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
    const assistantTitle = (() => {
      const info = getModelInfo(selectedModelId);
      const shortLabel = typeof info?.shortLabel === 'string' ? info.shortLabel.trim() : '';
      if (shortLabel) return shortLabel;
      const label = typeof info?.label === 'string' ? info.label.trim() : '';
      return label || 'Assistant';
    })();

    const chatId = activeChatIdRef.current;
    const meta = ensureChatMeta(chatId);

    let desiredParentId = replySelection?.nodeId && engine.hasNode(replySelection.nodeId) ? replySelection.nodeId : null;
    if (!desiredParentId) {
      const fallback = typeof args.defaultParentNodeId === 'string' ? args.defaultParentNodeId.trim() : '';
      if (fallback && engine.hasNode(fallback)) desiredParentId = fallback;
    }
    if (!desiredParentId && args.allowPdfAttachmentParentFallback !== false) {
      const pdfStorageKey = (composerDraftAttachments ?? []).reduce<string>((acc, att) => {
        if (acc) return acc;
        if (!att || att.kind !== 'pdf') return '';
        const key = typeof (att as any)?.storageKey === 'string' ? String((att as any).storageKey).trim() : '';
        return key;
      }, '');
      if (pdfStorageKey) {
        try {
          const snapshot = engine.exportChatState();
          const pdfNode =
            snapshot.nodes.find(
              (n): n is Extract<ChatNode, { kind: 'pdf' }> =>
                n.kind === 'pdf' && String((n as any)?.storageKey ?? '').trim() === pdfStorageKey,
            ) ?? null;
          if (pdfNode && engine.hasNode(pdfNode.id)) desiredParentId = pdfNode.id;
        } catch {
          // ignore
        }
      }
    }

    const userPreface = hasPreface
      ? {
          ...(replyTo ? { replyTo } : {}),
          ...(contextTexts.length ? { contexts: contextTexts } : {}),
        }
      : undefined;

    const res = engine.spawnChatTurn({
      userText: raw,
      parentNodeId: desiredParentId,
      userPreface,
      userAttachments: composerDraftAttachments.length ? composerDraftAttachments : undefined,
      selectedAttachmentKeys: replySelectedAttachmentKeys.length ? replySelectedAttachmentKeys : undefined,
      assistantTitle,
      assistantModelId: selectedModelId,
    });

    const ctxTargetId = String(contextTargetEditNodeIdRef.current ?? '').trim();
    if (ctxTargetId && composerContextTexts.length > 0) {
      try {
        const existingPreface = engine.getTextNodeUserPreface(ctxTargetId);
        const existingReplyTo = existingPreface?.replyTo ?? '';
        const existing = existingPreface?.contexts ?? [];
        const merged = (() => {
          const seen = new Set<string>();
          const out: string[] = [];
          for (const t of [...existing, ...composerContextTexts]) {
            const s = String(t ?? '').trim();
            if (!s) continue;
            if (seen.has(s)) continue;
            seen.add(s);
            out.push(s);
          }
          return out;
        })();
        engine.setTextNodeUserPreface(
          ctxTargetId,
          merged.length
            ? {
                ...(existingReplyTo ? { replyTo: existingReplyTo } : {}),
                contexts: merged,
              }
            : existingReplyTo
              ? { replyTo: existingReplyTo }
              : null,
          { collapseNewContexts: true },
        );
      } catch {
        // ignore
      }
    }

    meta.turns.push({
      id: genId('turn'),
      createdAt: Date.now(),
      userNodeId: res.userNodeId,
      assistantNodeId: res.assistantNodeId,
      attachmentNodeIds: [],
    });
    meta.headNodeId = res.assistantNodeId;
    meta.replyTo = null;
    meta.contextSelections = [];
    meta.draftAttachments = [];
    meta.selectedAttachmentKeys = [];
    if (args.clearComposerText !== false) meta.draft = '';
    draftAttachmentDedupeRef.current.delete(chatId);
    lastAddAttachmentFilesRef.current = { sig: '', at: 0 };
    setReplySelection(null);
    setContextSelections([]);
    setReplyContextAttachments([]);
    setReplySelectedAttachmentKeys([]);
    if (args.clearComposerText !== false) setComposerDraft('');
    setComposerDraftAttachments([]);

    const snapshot = engine.exportChatState();
    chatStatesRef.current.set(chatId, snapshot);

    const provider = getModelInfo(selectedModelId)?.provider ?? 'openai';
    if (provider === 'gemini') {
      const settings: GeminiChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startGeminiGeneration({
        chatId,
        userNodeId: res.userNodeId,
        assistantNodeId: res.assistantNodeId,
        settings,
      });
    } else {
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: OpenAIChatSettings = {
        modelId: selectedModelId,
        verbosity: modelSettings?.verbosity,
        webSearchEnabled: composerWebSearch,
        reasoningSummary: modelSettings?.reasoningSummary,
        stream: modelSettings?.streaming,
        background: modelSettings?.background,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startOpenAIGeneration({
        chatId,
        userNodeId: res.userNodeId,
        assistantNodeId: res.assistantNodeId,
        settings,
      });
    }

    schedulePersistSoon();
  };

  const sendInkTurn = (args: { strokes: InkStroke[]; viewport?: { w: number; h: number } | null; modelIdOverride?: string | null }) => {
    const engine = engineRef.current;
    if (!engine) return;

    const rawStrokes = Array.isArray(args.strokes) ? args.strokes : [];
    if (rawStrokes.length === 0) {
      showToast('Nothing to send: ink is empty.', 'error');
      return;
    }

    const composerContextTexts = (contextSelections ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);

    const selectionReplyTo =
      replySelection && typeof replySelection.text === 'string' ? replySelection.text.trim() : '';
    const replyTo = selectionReplyTo;

    const contextTexts = (() => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const t of composerContextTexts) {
        if (!t) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
      return out;
    })();
    const hasPreface = Boolean(replyTo || contextTexts.length > 0);

    const selectedModelId = String(args.modelIdOverride || composerModelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
    const assistantTitle = (() => {
      const info = getModelInfo(selectedModelId);
      const shortLabel = typeof info?.shortLabel === 'string' ? info.shortLabel.trim() : '';
      if (shortLabel) return shortLabel;
      const label = typeof info?.label === 'string' ? info.label.trim() : '';
      return label || 'Assistant';
    })();

    const modelInfo = getModelInfo(selectedModelId);
    if (modelInfo && modelInfo.supportsImageInput === false) {
      showToast('Selected model does not support image input.', 'error');
      return;
    }

    let desiredParentId = replySelection?.nodeId && engine.hasNode(replySelection.nodeId) ? replySelection.nodeId : null;
    if (!desiredParentId) {
      const pdfStorageKey = (composerDraftAttachments ?? []).reduce<string>((acc, att) => {
        if (acc) return acc;
        if (!att || att.kind !== 'pdf') return '';
        const key = typeof (att as any)?.storageKey === 'string' ? String((att as any).storageKey).trim() : '';
        return key;
      }, '');
      if (pdfStorageKey) {
        try {
          const snapshot = engine.exportChatState();
          const pdfNode =
            snapshot.nodes.find(
              (n): n is Extract<ChatNode, { kind: 'pdf' }> =>
                n.kind === 'pdf' && String((n as any)?.storageKey ?? '').trim() === pdfStorageKey,
            ) ?? null;
          if (pdfNode && engine.hasNode(pdfNode.id)) desiredParentId = pdfNode.id;
        } catch {
          // ignore
        }
      }
    }

    const userPreface = hasPreface
      ? {
          ...(replyTo ? { replyTo } : {}),
          ...(contextTexts.length ? { contexts: contextTexts } : {}),
        }
      : undefined;

    const TEXT_NODE_PAD_PX = 14;
    const TEXT_NODE_HEADER_H_PX = 44;
    const INK_NODE_MAX_W_PX = 2400;
    const INK_NODE_MAX_H_PX = 1800;

    const viewportW = clampNumber(args.viewport?.w, 1, 10_000, 392);
    const viewportH = clampNumber(args.viewport?.h, 1, 10_000, 222);

    const desiredRectW = clampNumber(viewportW + TEXT_NODE_PAD_PX * 2, 320, INK_NODE_MAX_W_PX, 420);
    const desiredRectH = clampNumber(viewportH + TEXT_NODE_HEADER_H_PX + TEXT_NODE_PAD_PX, 240, INK_NODE_MAX_H_PX, 280);
    const contentW = Math.max(1, desiredRectW - TEXT_NODE_PAD_PX * 2);
    const contentH = Math.max(1, desiredRectH - TEXT_NODE_HEADER_H_PX - TEXT_NODE_PAD_PX);
    const nodeMinDim = Math.max(1, Math.min(contentW, contentH));
    const viewportMinDim = Math.max(1, Math.min(viewportW, viewportH));
    const scaleX = contentW / viewportW;
    const scaleY = contentH / viewportH;
    const scaleW = nodeMinDim / viewportMinDim;

    const nodeStrokes: InkStroke[] = rawStrokes
      .filter((s) => s && Array.isArray(s.points) && s.points.length > 0)
      .map((s) => {
        const widthIn = Number.isFinite(Number(s.width)) ? Number(s.width) : 0;
        const color = typeof s.color === 'string' ? s.color : 'rgba(147,197,253,0.92)';
        const pts = Array.isArray(s.points) ? s.points : [];
        const isNorm =
          Number.isFinite(widthIn) &&
          widthIn >= 0 &&
          widthIn <= 1.001 &&
          pts.length > 0 &&
          pts.every((p) => {
            const x = Number((p as any)?.x);
            const y = Number((p as any)?.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
            return x >= -0.001 && x <= 1.001 && y >= -0.001 && y <= 1.001;
          });

        const width = Math.max(0, widthIn) * (isNorm ? nodeMinDim : scaleW);
        const points = pts
          .map((p) => {
            const xIn = Number((p as any)?.x);
            const yIn = Number((p as any)?.y);
            if (!Number.isFinite(xIn) || !Number.isFinite(yIn)) return null;
            const x = isNorm ? xIn * contentW : xIn * scaleX;
            const y = isNorm ? yIn * contentH : yIn * scaleY;
            return { x, y };
          })
          .filter((p): p is { x: number; y: number } => Boolean(p));
        return { width, color, points };
      });

    if (nodeStrokes.length === 0) {
      showToast('Nothing to send: ink is empty.', 'error');
      return;
    }

    const chatId = activeChatIdRef.current;
    const meta = ensureChatMeta(chatId);

    const res = engine.spawnInkChatTurn({
      strokes: nodeStrokes,
      parentNodeId: desiredParentId,
      userPreface,
      userAttachments: composerDraftAttachments.length ? composerDraftAttachments : undefined,
      selectedAttachmentKeys: replySelectedAttachmentKeys.length ? replySelectedAttachmentKeys : undefined,
      assistantTitle,
      assistantModelId: selectedModelId,
      rect: { x: 0, y: 0, w: desiredRectW, h: desiredRectH },
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
    meta.contextSelections = [];
    meta.draftAttachments = [];
    meta.selectedAttachmentKeys = [];
    meta.draftInkStrokes = [];
    draftAttachmentDedupeRef.current.delete(chatId);
    lastAddAttachmentFilesRef.current = { sig: '', at: 0 };
    setReplySelection(null);
    setContextSelections([]);
    setReplyContextAttachments([]);
    setReplySelectedAttachmentKeys([]);
    setComposerDraftAttachments([]);
    setComposerInkStrokes([]);

    const snapshot = engine.exportChatState();
    chatStatesRef.current.set(chatId, snapshot);

    const provider = getModelInfo(selectedModelId)?.provider ?? 'openai';
    if (provider === 'gemini') {
      const settings: GeminiChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startGeminiGeneration({
        chatId,
        userNodeId: res.userNodeId,
        assistantNodeId: res.assistantNodeId,
        settings,
      });
    } else {
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: OpenAIChatSettings = {
        modelId: selectedModelId,
        verbosity: modelSettings?.verbosity,
        webSearchEnabled: composerWebSearch,
        reasoningSummary: modelSettings?.reasoningSummary,
        stream: modelSettings?.streaming,
        background: modelSettings?.background,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startOpenAIGeneration({
        chatId,
        userNodeId: res.userNodeId,
        assistantNodeId: res.assistantNodeId,
        settings,
      });
    }

    schedulePersistSoon();
  };

  const sendAssistantTurnFromUserNode = (args: {
    userNodeId: string;
    modelIdOverride?: string | null;
    assistantRect?: Rect | null;
    clearComposerText?: boolean;
  }) => {
    const engine = engineRef.current;
    if (!engine) return;

    const userNodeId = String(args.userNodeId ?? '').trim();
    if (!userNodeId) return;
    contextTargetEditNodeIdRef.current = userNodeId;

    const chatId = activeChatIdRef.current;
    const meta = ensureChatMeta(chatId);

    const composerContextTexts = (contextSelections ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);

    const selectedModelId = String(args.modelIdOverride || composerModelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
    const assistantTitle = (() => {
      const info = getModelInfo(selectedModelId);
      const shortLabel = typeof info?.shortLabel === 'string' ? info.shortLabel.trim() : '';
      if (shortLabel) return shortLabel;
      const label = typeof info?.label === 'string' ? info.label.trim() : '';
      return label || 'Assistant';
    })();

    const preSnapshot = engine.exportChatState();
    const leafNode = preSnapshot.nodes.find((n) => n.id === userNodeId) ?? null;
    if (!leafNode) return;

    if (leafNode.kind === 'ink') {
      const strokes = Array.isArray((leafNode as any).strokes) ? ((leafNode as any).strokes as any[]) : [];
      if (strokes.length === 0) {
        showToast('Nothing to send: ink node is empty.', 'error');
        return;
      }

      const modelInfo = getModelInfo(selectedModelId);
      if (modelInfo && modelInfo.supportsImageInput === false) {
        showToast('Selected model does not support image input.', 'error');
        return;
      }

      // Persist the composed context back onto the ink node so the sent message matches what the node shows.
      try {
        const replyTo = typeof (leafNode as any)?.userPreface?.replyTo === 'string' ? String((leafNode as any).userPreface.replyTo).trim() : '';
        const nodeContextTexts = Array.isArray((leafNode as any)?.userPreface?.contexts)
          ? ((leafNode as any).userPreface.contexts as any[]).map((t) => String(t ?? '').trim()).filter(Boolean)
          : [];
        const mergedContexts = (() => {
          const seen = new Set<string>();
          const out: string[] = [];
          for (const t of [...nodeContextTexts, ...composerContextTexts]) {
            if (!t) continue;
            if (seen.has(t)) continue;
            seen.add(t);
            out.push(t);
          }
          return out;
        })();
        const hasPreface = Boolean(replyTo || mergedContexts.length > 0);
        engine.setInkNodeUserPreface(
          userNodeId,
          hasPreface
            ? {
                ...(replyTo ? { replyTo } : {}),
                ...(mergedContexts.length ? { contexts: mergedContexts } : {}),
              }
            : null,
          { collapseNewContexts: true },
        );
      } catch {
        // ignore
      }

      const res = engine.spawnAssistantTurn({
        userNodeId,
        assistantTitle,
        assistantModelId: selectedModelId,
        ...(args.assistantRect ? { rect: args.assistantRect } : {}),
      });
      if (!res) return;

      meta.turns.push({
        id: genId('turn'),
        createdAt: Date.now(),
        userNodeId,
        assistantNodeId: res.assistantNodeId,
        attachmentNodeIds: [],
      });
      meta.headNodeId = res.assistantNodeId;
      meta.replyTo = null;
      meta.contextSelections = [];
      meta.draftAttachments = [];
      meta.selectedAttachmentKeys = [];
      if (args.clearComposerText !== false) meta.draft = '';
      draftAttachmentDedupeRef.current.delete(chatId);
      lastAddAttachmentFilesRef.current = { sig: '', at: 0 };
      setReplySelection(null);
      setContextSelections([]);
      setReplyContextAttachments([]);
      setReplySelectedAttachmentKeys([]);
      if (args.clearComposerText !== false) setComposerDraft('');
      setComposerDraftAttachments([]);

      const snapshot = engine.exportChatState();
      chatStatesRef.current.set(chatId, snapshot);

      const provider = getModelInfo(selectedModelId)?.provider ?? 'openai';
      if (provider === 'gemini') {
        const settings: GeminiChatSettings = {
          modelId: selectedModelId,
          webSearchEnabled: composerWebSearch,
          inkExport: {
            cropEnabled: inkSendCropEnabledRef.current,
            cropPaddingPx: inkSendCropPaddingPxRef.current,
            downscaleEnabled: inkSendDownscaleEnabledRef.current,
            maxPixels: inkSendMaxPixelsRef.current,
            maxDimPx: inkSendMaxDimPxRef.current,
          },
        };
        startGeminiGeneration({
          chatId,
          userNodeId,
          assistantNodeId: res.assistantNodeId,
          settings,
        });
      } else {
        const modelSettings =
          modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
        const settings: OpenAIChatSettings = {
          modelId: selectedModelId,
          verbosity: modelSettings?.verbosity,
          webSearchEnabled: composerWebSearch,
          reasoningSummary: modelSettings?.reasoningSummary,
          stream: modelSettings?.streaming,
          background: modelSettings?.background,
          inkExport: {
            cropEnabled: inkSendCropEnabledRef.current,
            cropPaddingPx: inkSendCropPaddingPxRef.current,
            downscaleEnabled: inkSendDownscaleEnabledRef.current,
            maxPixels: inkSendMaxPixelsRef.current,
            maxDimPx: inkSendMaxDimPxRef.current,
          },
        };
        startOpenAIGeneration({
          chatId,
          userNodeId,
          assistantNodeId: res.assistantNodeId,
          settings,
        });
      }

      schedulePersistSoon();
      return;
    }

    if (leafNode.kind !== 'text') return;
    const userNode = leafNode;

    const userText = typeof userNode.content === 'string' ? userNode.content : String((userNode as any).content ?? '');
    const contextAttachmentKeys = collectContextAttachments(preSnapshot.nodes, userNodeId).map((it) => it.key);
    const contextPdfKeys = contextAttachmentKeys.filter((k) => k.startsWith('pdf:'));

    const replyTo = typeof userNode.userPreface?.replyTo === 'string' ? userNode.userPreface.replyTo.trim() : '';
    const nodeContextTexts = Array.isArray(userNode.userPreface?.contexts)
      ? userNode.userPreface!.contexts!.map((t) => String(t ?? '').trim()).filter(Boolean)
      : [];

    const contextTexts = (() => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const t of [...nodeContextTexts, ...composerContextTexts]) {
        if (!t) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
      return out;
    })();
    const hasPreface = Boolean(replyTo || contextTexts.length > 0);

    if (!userText.trim() && composerDraftAttachments.length === 0 && !hasPreface) return;

    // Persist the composed context back onto the edit node so the sent message matches what the node shows.
    try {
      engine.setTextNodeUserPreface(
        userNodeId,
        hasPreface
          ? {
              ...(replyTo ? { replyTo } : {}),
              ...(contextTexts.length ? { contexts: contextTexts } : {}),
            }
          : null,
        { collapseNewContexts: true },
      );
    } catch {
      // ignore
    }

    const res = engine.spawnAssistantTurn({
      userNodeId,
      assistantTitle,
      assistantModelId: selectedModelId,
      ...(args.assistantRect ? { rect: args.assistantRect } : {}),
    });
    if (!res) return;

    meta.turns.push({
      id: genId('turn'),
      createdAt: Date.now(),
      userNodeId,
      assistantNodeId: res.assistantNodeId,
      attachmentNodeIds: [],
    });
    meta.headNodeId = res.assistantNodeId;
    meta.replyTo = null;
    meta.contextSelections = [];
    meta.draftAttachments = [];
    meta.selectedAttachmentKeys = [];
    if (args.clearComposerText !== false) meta.draft = '';
    draftAttachmentDedupeRef.current.delete(chatId);
    lastAddAttachmentFilesRef.current = { sig: '', at: 0 };
    setReplySelection(null);
    setContextSelections([]);
    setReplyContextAttachments([]);
    setReplySelectedAttachmentKeys([]);
    if (args.clearComposerText !== false) setComposerDraft('');
    setComposerDraftAttachments([]);

    const snapshot = engine.exportChatState();
    chatStatesRef.current.set(chatId, snapshot);

    const userPreface = hasPreface
      ? {
          ...(replyTo ? { replyTo } : {}),
          ...(contextTexts.length ? { contexts: contextTexts } : {}),
        }
      : undefined;
    const nodesOverride = snapshot.nodes.map((n) => {
      if (n.kind !== 'text') return n;
      if (n.id !== userNodeId) return n;
      const next: Extract<ChatNode, { kind: 'text' }> = {
        ...n,
        content: userText,
        userPreface,
      };

      // Don't drop existing attachments/selection when the composer is empty.
      if (composerDraftAttachments.length) next.attachments = composerDraftAttachments;
      if (replySelectedAttachmentKeys.length) {
        if (!contextPdfKeys.length) {
          next.selectedAttachmentKeys = replySelectedAttachmentKeys;
        } else {
          const merged = replySelectedAttachmentKeys.slice();
          for (const k of contextPdfKeys) {
            if (!merged.includes(k)) merged.push(k);
          }
          next.selectedAttachmentKeys = merged;
        }
      } else if (!Array.isArray((n as any)?.selectedAttachmentKeys) && contextAttachmentKeys.length) {
        next.selectedAttachmentKeys = contextAttachmentKeys;
      }

      return next;
    });

    const provider = getModelInfo(selectedModelId)?.provider ?? 'openai';
    if (provider === 'gemini') {
      const settings: GeminiChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startGeminiGeneration({
        chatId,
        userNodeId,
        assistantNodeId: res.assistantNodeId,
        settings,
        nodesOverride,
      });
    } else {
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: OpenAIChatSettings = {
        modelId: selectedModelId,
        verbosity: modelSettings?.verbosity,
        webSearchEnabled: composerWebSearch,
        reasoningSummary: modelSettings?.reasoningSummary,
        stream: modelSettings?.streaming,
        background: modelSettings?.background,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startOpenAIGeneration({
        chatId,
        userNodeId,
        assistantNodeId: res.assistantNodeId,
        settings,
        nodesOverride,
      });
    }

    schedulePersistSoon();
  };

  const updateEditNodeSendMenuPosition = React.useCallback(() => {
    const nodeId = editNodeSendMenuId;
    if (!nodeId) {
      setEditNodeSendMenuPos(null);
      return;
    }

    const rect = getNodeSendMenuButtonRect(nodeId);
    if (!rect) {
      setEditNodeSendMenuPos(null);
      return;
    }

    const gap = 8;
    const viewportPadding = 8;
    const estimatedWidth = 115;
    const maxMenuH = 256;
    const itemH = 34;
    const paddingY = 14;
    const desiredH = Math.min(maxMenuH, Math.max(56, composerModelOptions.length * itemH + paddingY));

    const spaceAbove = rect.top - gap - viewportPadding;
    const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
    const openAbove = spaceAbove >= desiredH || spaceAbove >= spaceBelow;
    const top = openAbove ? undefined : rect.bottom + gap;
    const bottom = openAbove ? window.innerHeight - rect.top + gap : undefined;
    const maxHeight = Math.max(0, Math.min(maxMenuH, openAbove ? spaceAbove : spaceBelow));

    const left = Math.min(window.innerWidth - viewportPadding - estimatedWidth, Math.max(viewportPadding, rect.left));
    setEditNodeSendMenuPos({ top, bottom, left, maxHeight });
  }, [composerModelOptions.length, editNodeSendMenuId, getNodeSendMenuButtonRect]);

  const updateReplySpawnMenuPosition = React.useCallback(() => {
    const nodeId = replySpawnMenuId;
    if (!nodeId) {
      setReplySpawnMenuPos(null);
      return;
    }

    const rect = getNodeReplyMenuButtonRect(nodeId);
    if (!rect) {
      setReplySpawnMenuPos(null);
      return;
    }

    const gap = 8;
    const viewportPadding = 8;
    const estimatedWidth = 170;
    const maxMenuH = 256;
    const itemH = 34;
    const paddingY = 14;
    const desiredH = Math.min(maxMenuH, Math.max(56, 2 * itemH + paddingY));

    const spaceAbove = rect.top - gap - viewportPadding;
    const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
    const openAbove = spaceAbove >= desiredH || spaceAbove >= spaceBelow;
    const top = openAbove ? undefined : rect.bottom + gap;
    const bottom = openAbove ? window.innerHeight - rect.top + gap : undefined;
    const maxHeight = Math.max(0, Math.min(maxMenuH, openAbove ? spaceAbove : spaceBelow));

    const left = Math.min(window.innerWidth - viewportPadding - estimatedWidth, Math.max(viewportPadding, rect.left));
    setReplySpawnMenuPos({ top, bottom, left, maxHeight });
  }, [getNodeReplyMenuButtonRect, replySpawnMenuId]);

  useEffect(() => {
    if (!replySpawnMenuId) {
      setReplySpawnMenuPos(null);
      return;
    }

    updateReplySpawnMenuPosition();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReplySpawnMenuId(null);
    };

    const onReposition = () => updateReplySpawnMenuPosition();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('wheel', onReposition, { passive: true });
    const vv = window.visualViewport;
    vv?.addEventListener('resize', onReposition);
    vv?.addEventListener('scroll', onReposition);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('wheel', onReposition);
      vv?.removeEventListener('resize', onReposition);
      vv?.removeEventListener('scroll', onReposition);
    };
  }, [replySpawnMenuId, updateReplySpawnMenuPosition]);

  useEffect(() => {
    if (!editNodeSendMenuId) {
      setEditNodeSendMenuPos(null);
      return;
    }

    updateEditNodeSendMenuPosition();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditNodeSendMenuId(null);
    };

    const onReposition = () => updateEditNodeSendMenuPosition();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('wheel', onReposition, { passive: true });
    const vv = window.visualViewport;
    vv?.addEventListener('resize', onReposition);
    vv?.addEventListener('scroll', onReposition);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('wheel', onReposition);
      vv?.removeEventListener('resize', onReposition);
      vv?.removeEventListener('scroll', onReposition);
    };
  }, [editNodeSendMenuId, updateEditNodeSendMenuPosition]);

  useEffect(() => {
    const pending = pendingEditNodeSend;
    if (!pending) return;
    setPendingEditNodeSend(null);
    sendAssistantTurnFromUserNode({
      userNodeId: pending.nodeId,
      modelIdOverride: pending.modelIdOverride ?? null,
      assistantRect: pending.assistantRect ?? null,
      clearComposerText: false,
    });
  }, [pendingEditNodeSend]);

	  return (
	    <div className="app">
	      {toast && typeof document !== 'undefined' && document.body
	        ? createPortal(
	            <div className="toastHost" role="status" aria-live="polite" aria-atomic="true">
	              <div
	                className={`toast toast--${toast.kind}`}
	                onClick={() => setToast(null)}
	                onPointerDown={(e) => e.stopPropagation()}
	                onPointerMove={(e) => e.stopPropagation()}
	                onPointerUp={(e) => e.stopPropagation()}
	                onWheel={(e) => e.stopPropagation()}
	              >
	                {toast.message}
	              </div>
	            </div>,
	            document.body,
	          )
	        : null}
		      <FolderPickerDialog
		        open={pendingImportArchive != null}
		        title="Import to…"
		        confirmLabel="Import here"
		        root={treeRoot}
	        initialSelectionId={focusedFolderId}
	        onClose={() => {
	          setPendingImportArchive(null);
	          setImportIncludeDateInName(false);
	          setImportBackgroundAvailable(false);
	          setImportIncludeBackground(false);
	        }}
	        onCreateFolder={createFolderForImport}
	        footerLeft={
	          <div className="folderPickerImportOptions">
	            {importBackgroundAvailable ? (
	              <label className="folderPickerOption">
	                <input
	                  type="checkbox"
	                  className="folderPickerOption__checkbox"
	                  checked={importIncludeBackground}
	                  onChange={(e) => setImportIncludeBackground(Boolean(e.currentTarget.checked))}
	                />
	                <span>Use imported chat backgrounds</span>
	              </label>
	            ) : null}
	            <label className="folderPickerOption">
	              <input
	                type="checkbox"
	                className="folderPickerOption__checkbox"
	                checked={importIncludeDateInName}
	                onChange={(e) => setImportIncludeDateInName(Boolean(e.currentTarget.checked))}
	              />
	              <span>Append import date to chat names</span>
	            </label>
	          </div>
	        }
	        onConfirm={importChatArchiveToFolder}
	      />
      <ConfirmDialog
        open={confirmDelete != null}
        title={confirmDeleteTitle}
        message={confirmDeleteMessage}
        cancelLabel="Cancel"
        confirmLabel="Delete"
        confirmDanger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={confirmDeleteNow}
      />
      <ConfirmDialog
        open={confirmApplyBackground != null}
        title="Apply background?"
        message={
          confirmApplyBackground
            ? `Apply "${confirmApplyBackground.backgroundName}" to this chat?`
            : ''
        }
        cancelLabel="No"
        confirmLabel="Apply"
        onCancel={() => setConfirmApplyBackground(null)}
        onConfirm={() => {
          const payload = confirmApplyBackground;
          setConfirmApplyBackground(null);
          if (!payload) return;
          setChatBackgroundStorageKey(payload.chatId, payload.backgroundId);
        }}
      />
      <ConfirmDialog
        open={confirmExport != null}
        title={confirmExportTitle}
        cancelLabel="Cancel"
        confirmLabel={confirmExport?.kind === 'all' ? 'Export all' : 'Export'}
        onCancel={() => setConfirmExport(null)}
        onConfirm={confirmExportNow}
      />
      <WorkspaceSidebar
        root={treeRoot}
        activeChatId={activeChatId}
        focusedFolderId={focusedFolderId}
        backgroundLibrary={backgroundLibrary}
        getChatBackgroundStorageKey={(chatId) => {
          const meta = chatMetaRef.current.get(chatId);
          return typeof meta?.backgroundStorageKey === 'string' ? meta.backgroundStorageKey : null;
        }}
        onSetChatBackgroundStorageKey={setChatBackgroundStorageKey}
        onExportChat={requestExportChat}
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
        onDeleteItem={(itemId) => requestDeleteTreeItem(itemId)}
        onMoveItem={(itemId, folderId) => {
          setTreeRoot((prev) => moveItem(prev, itemId, folderId));
          schedulePersistSoon();
        }}
      />

	      <div className="workspace" ref={workspaceRef}>
          <div className="worldSurface" ref={worldSurfaceRef}>
	          <canvas className="stage" ref={canvasRef} />
            {(ui.tool === 'draw' || ui.tool === 'select') && inkInputConfig.layer ? (
              <div
                className={`inkCaptureLayer${inkInputConfig.layerPointerEvents ? '' : ' inkCaptureLayer--passthrough'}`}
                ref={inkCaptureRef}
              />
            ) : null}
          </div>
	          {nodeMenuId && nodeMenuButtonRect ? (
	            <NodeHeaderMenu
	              nodeId={nodeMenuId}
	              getButtonRect={getNodeMenuButtonRect}
	              rawEnabled={nodeMenuRawEnabled}
	              onRaw={() => toggleRawViewerForNode(nodeMenuId)}
	              onDelete={() => requestDeleteNode(nodeMenuId)}
	              onClose={() => setNodeMenuId(null)}
	            />
	          ) : null}
            {typeof document !== 'undefined' && replySpawnMenuId && replySpawnMenuPos
              ? createPortal(
                  <>
                    <div className="composerMenuBackdrop" onPointerDown={() => setReplySpawnMenuId(null)} aria-hidden="true" />
                    <div
                      className="composerMenu"
                      style={{
                        top: replySpawnMenuPos.top,
                        bottom: replySpawnMenuPos.bottom,
                        left: replySpawnMenuPos.left,
                        width: 170,
                        maxHeight: replySpawnMenuPos.maxHeight,
                      }}
                      role="menu"
                      aria-label="Reply spawn type"
                    >
                      {(
                        [
                          { kind: 'text' as const, label: 'Reply with text' },
                          { kind: 'ink' as const, label: 'Reply with ink' },
                        ] as const
                      ).map((item) => {
                        const active = item.kind === replySpawnKind;
                        return (
                          <button
                            key={item.kind}
                            type="button"
                            className={`composerMenu__item composerMenu__item--withCheck ${
                              active ? 'composerMenu__item--active' : ''
                            }`}
                            onClick={() => {
                              setReplySpawnMenuId(null);
                              const next = item.kind;
                              replySpawnKindRef.current = next;
                              setReplySpawnKind(next);
                              engineRef.current?.setReplySpawnKind(next);
                              schedulePersistSoon();
                            }}
                            role="menuitem"
                          >
                            <span className="composerMenu__check" aria-hidden="true">
                              {active ? '✓' : ''}
                            </span>
                            <span className="composerMenu__label">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>,
                  document.body,
                )
              : null}
            {typeof document !== 'undefined' && editNodeSendMenuId && editNodeSendMenuPos
              ? createPortal(
                  <>
                    <div className="composerMenuBackdrop" onPointerDown={() => setEditNodeSendMenuId(null)} aria-hidden="true" />
                    <div
                      className="composerMenu"
                      style={{
                        top: editNodeSendMenuPos.top,
                        bottom: editNodeSendMenuPos.bottom,
                        left: editNodeSendMenuPos.left,
                        width: 115,
                        maxHeight: editNodeSendMenuPos.maxHeight,
                      }}
                      role="menu"
                    >
                      {composerModelOptions.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className={`composerMenu__item ${m.id === composerModelId ? 'composerMenu__item--active' : ''}`}
                          onClick={() => {
                            const nodeId = String(editNodeSendMenuId ?? '').trim();
                            setEditNodeSendMenuId(null);
                            if (!nodeId) return;
                            setPendingEditNodeSend({ nodeId, modelIdOverride: m.id, assistantRect: null });
                          }}
                          role="menuitem"
                          title={m.label}
                        >
                          {String(m.shortLabel ?? m.label ?? m.id).trim()}
                        </button>
                      ))}
                    </div>
                  </>,
                  document.body,
                )
              : null}
	        {ui.editingNodeId ? (
	          <TextNodeEditor
	            nodeId={ui.editingNodeId}
	            title={editorTitle}
	            initialValue={ui.editingText}
              userPreface={editorUserPreface}
              modelId={composerModelId}
              modelOptions={composerModelOptions}
              onDraftChange={(next) => editingDraftByNodeIdRef.current.set(ui.editingNodeId as string, next)}
	            anchorRect={editorAnchor}
              getScreenRect={() => engineRef.current?.getNodeScreenRect(ui.editingNodeId as string) ?? null}
              getZoom={() => engineRef.current?.camera.zoom ?? 1}
	            viewport={viewport}
	            zoom={editorZoom}
	            baseFontSizePx={nodeFontSizePx}
              onResize={(nextRect) => engineRef.current?.setNodeScreenRect(ui.editingNodeId as string, nextRect)}
              onTogglePrefaceContext={(contextIndex) =>
                engineRef.current?.toggleTextNodePrefaceContextCollapsed(ui.editingNodeId as string, contextIndex)
              }
              onResizeEnd={() => schedulePersistSoon()}
              onSend={(text, opts) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                engineRef.current?.setEditingText(text);
                sendAssistantTurnFromUserNode({
                  userNodeId: id,
                  modelIdOverride: opts?.modelIdOverride ?? null,
                  clearComposerText: false,
                });
              }}
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
            getScreenRect={() => engineRef.current?.getTextNodeContentScreenRect(rawViewer.nodeId) ?? null}
            getZoom={() => engineRef.current?.camera.zoom ?? 1}
            viewport={viewport}
            zoom={editorZoom}
            onClose={() => setRawViewer(null)}
          />
        ) : null}

        <ChatComposer
          containerRef={composerDockRef}
          minimized={composerMinimized}
          onChangeMinimized={(next) => {
            const value = Boolean(next);
            setComposerMinimized(value);
            composerMinimizedRef.current = value;
            schedulePersistSoon();
          }}
          mode={composerMode}
          onChangeMode={(next) => {
            const value = next === 'ink' ? 'ink' : 'text';
            setComposerMode(value);
            ensureChatMeta(activeChatId).composerMode = value;
            schedulePersistSoon();
          }}
          inkTool={ui.tool}
          inkStrokes={composerInkStrokes}
          onChangeInkStrokes={(next) => {
            const strokes = Array.isArray(next) ? next : [];
            setComposerInkStrokes(strokes);
            ensureChatMeta(activeChatId).draftInkStrokes = strokes;
            schedulePersistSoon();
          }}
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
                  schedulePersistSoon();
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
            if (storageKey) {
              const dedupe = ensureDraftAttachmentDedupe(activeChatId);
              const fileSig = dedupe.byStorageKey.get(storageKey);
              if (fileSig) {
                dedupe.attached.delete(fileSig);
                dedupe.inFlight.delete(fileSig);
              }
              dedupe.byStorageKey.delete(storageKey);
            }
            if (storageKey) attachmentsGcDirtyRef.current = true;
            setComposerDraftAttachments(meta.draftAttachments.slice());
            schedulePersistSoon();
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
          modelOptions={composerModelOptions}
          onChangeModelId={(next) => {
            const value = next || DEFAULT_MODEL_ID;
            setComposerModelId(value);
            ensureChatMeta(activeChatId).llm.modelId = value;
          }}
          webSearchEnabled={composerWebSearch}
          onChangeWebSearchEnabled={(next) => {
            setComposerWebSearch(next);
            ensureChatMeta(activeChatId).llm.webSearchEnabled = next;
          }}
          replyPreview={replySelection?.preview ?? null}
          contextSelections={contextSelections}
          onRemoveContextSelection={(index) => {
            const idx = Math.max(0, Math.floor(index));
            const meta = ensureChatMeta(activeChatId);
            const next = (meta.contextSelections ?? []).filter((_t, i) => i !== idx);
            meta.contextSelections = next;
            setContextSelections(next);
            schedulePersistSoon();
          }}
          onCancelReply={() => {
            const meta = ensureChatMeta(activeChatId);
            meta.replyTo = null;
            meta.selectedAttachmentKeys = [];
            setReplySelection(null);
            setReplyContextAttachments([]);
            setReplySelectedAttachmentKeys([]);
            schedulePersistSoon();
          }}
          sendDisabled={
            composerMode === 'ink'
              ? composerInkStrokes.length === 0
              : !composerDraft.trim() &&
                composerDraftAttachments.length === 0 &&
                (contextSelections ?? []).every((t) => !String(t ?? '').trim())
          }
          onSend={() => {
            sendTurn({ userText: composerDraft, allowPdfAttachmentParentFallback: true, clearComposerText: true });
          }}
          onSendInk={({ strokes, viewport }) => {
            sendInkTurn({ strokes, viewport });
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
              let storageKey: string | null = null;
              try {
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

                if (!storageKey) return;

                const rawName = String(file.name ?? '').trim();
                const baseName = rawName ? rawName.replace(/\.[^/.]+$/, '') : '';
                const backgroundName = baseName || `Background ${storageKey.slice(-6)}`;
                upsertBackgroundLibraryItem({
                  id: storageKey,
                  storageKey,
                  name: backgroundName,
                  createdAt: Date.now(),
                  mimeType: file.type || 'image/png',
                  size: Number.isFinite(file.size) ? file.size : undefined,
                });

                setConfirmApplyBackground({ chatId, backgroundId: storageKey, backgroundName });
              } finally {
                schedulePersistSoon();
              }
            })();
	          }}
	        />
	        <input
	          ref={importInputRef}
	          className="controls__fileInput"
	          type="file"
	          accept="application/json,.json"
	          onChange={(e) => {
	            const file = e.currentTarget.files?.[0];
	            e.currentTarget.value = '';
	            if (!file) return;
	            void (async () => {
		              try {
		                const text = await file.text();
		                const mod = await import('./utils/archive');
		                const archive = mod.parseArchiveText(text);
		                const hasBg = (() => {
		                  try {
		                    const schema = Number((archive as any)?.schemaVersion ?? NaN);
		                    if (schema === 1) {
		                      const bg = (archive as any)?.chat?.background;
		                      const data = bg && typeof bg === 'object' ? String((bg as any).data ?? '') : '';
		                      return Boolean(data);
		                    }
		                    if (schema === 2) {
		                      const chats = Array.isArray((archive as any)?.chats) ? ((archive as any).chats as any[]) : [];
		                      return chats.some((c) => {
		                        const bg = c && typeof c === 'object' ? (c as any).background : null;
		                        const data = bg && typeof bg === 'object' ? String((bg as any).data ?? '') : '';
		                        return Boolean(data);
		                      });
		                    }
		                  } catch {
		                    // ignore
		                  }
		                  return false;
		                })();
		                setImportBackgroundAvailable(hasBg);
		                setImportIncludeBackground(hasBg);
		                setPendingImportArchive(archive);
		                setImportIncludeDateInName(false);
		              } catch (err: any) {
		                alert(`Import failed: ${err?.message || String(err)}`);
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
	            className="toolStrip__btn"
	            type="button"
	            title="Import PDF"
	            aria-label="Import PDF"
	            onClick={() => pdfInputRef.current?.click()}
	          >
	            <Icons.documentArrowUp className="toolStrip__icon" />
	          </button>
		          <button
		            className={`toolStrip__btn ${ui.tool === 'draw' ? 'toolStrip__btn--active' : ''}`}
		            type="button"
		            title={ui.tool === 'draw' ? 'Draw tool (click for select)' : 'Draw tool'}
		            aria-label="Draw tool"
		            aria-pressed={ui.tool === 'draw'}
		            onClick={() => engineRef.current?.setTool(ui.tool === 'draw' ? 'select' : 'draw')}
		          >
		            <Icons.pen className="toolStrip__icon" />
		          </button>
              <button
                className={`toolStrip__btn ${ui.tool === 'erase' ? 'toolStrip__btn--active' : ''}`}
                type="button"
                title={ui.tool === 'erase' ? 'Eraser tool (click for select)' : 'Eraser tool'}
                aria-label="Eraser tool"
                aria-pressed={ui.tool === 'erase'}
                onClick={() => engineRef.current?.setTool(ui.tool === 'erase' ? 'select' : 'erase')}
              >
                <Icons.eraser className="toolStrip__icon" />
              </button>
              <button
                className="toolStrip__btn"
                type="button"
                title="New text node"
                aria-label="New text node"
                onClick={() => {
                  const engine = engineRef.current;
                  if (!engine) return;
                  if (spawnEditNodeByDraw) {
                    engine.beginSpawnTextNodeByDraw({ title: 'Note' });
                    return;
                  }
                  engine.spawnTextNode({ title: 'Note' });
                  schedulePersistSoon();
                }}
              >
                <Icons.textBox className="toolStrip__icon" />
              </button>
	          <button
	            className="toolStrip__btn"
	            type="button"
	            title="New ink node"
	            aria-label="New ink node"
            onClick={() => {
              const engine = engineRef.current;
              if (!engine) return;
              if (spawnInkNodeByDraw) {
                engine.beginSpawnInkNodeByDraw();
                return;
              }
              engine.spawnInkNode();
              schedulePersistSoon();
            }}
          >
            <Icons.inkBox className="toolStrip__icon" />
          </button>
        </div>
        <SettingsModal
          open={settingsOpen}
          activePanel={settingsPanel}
          onChangePanel={setSettingsPanel}
          onClose={() => setSettingsOpen(false)}
          models={allModels}
          modelUserSettings={modelUserSettings}
          onUpdateModelUserSettings={(modelId, patch) => {
            const model = allModels.find((m) => m.id === modelId);
            if (!model) return;
            setModelUserSettings((prev) => {
              const current = prev[modelId] ?? normalizeModelUserSettings(model, null);
              const next = normalizeModelUserSettings(model, { ...(current as any), ...(patch as any) });
              const merged = { ...prev, [modelId]: next };
              modelUserSettingsRef.current = merged;
              return merged;
            });
            schedulePersistSoon();
          }}
          backgroundLibrary={backgroundLibrary}
          onUploadBackground={() => backgroundInputRef.current?.click()}
          onRenameBackground={(backgroundId, name) => renameBackgroundLibraryItem(backgroundId, name)}
          onDeleteBackground={(backgroundId) => requestDeleteBackgroundLibraryItem(backgroundId)}
	          composerFontFamily={composerFontFamily}
	          onChangeComposerFontFamily={(next) => {
	            setComposerFontFamily(next);
	            schedulePersistSoon();
	          }}
          composerFontSizePx={composerFontSizePx}
          onChangeComposerFontSizePx={(raw) => {
            setComposerFontSizePx(Math.round(clampNumber(raw, 10, 30, DEFAULT_COMPOSER_FONT_SIZE_PX)));
            schedulePersistSoon();
          }}
          nodeFontFamily={nodeFontFamily}
          onChangeNodeFontFamily={(next) => {
            setNodeFontFamily(next);
            schedulePersistSoon();
          }}
          nodeFontSizePx={nodeFontSizePx}
          onChangeNodeFontSizePx={(raw) => {
            setNodeFontSizePx(Math.round(clampNumber(raw, 10, 30, DEFAULT_NODE_FONT_SIZE_PX)));
            schedulePersistSoon();
          }}
          sidebarFontFamily={sidebarFontFamily}
          onChangeSidebarFontFamily={(next) => {
            setSidebarFontFamily(next);
            schedulePersistSoon();
          }}
          sidebarFontSizePx={sidebarFontSizePx}
          onChangeSidebarFontSizePx={(raw) => {
            setSidebarFontSizePx(Math.round(clampNumber(raw, 8, 24, DEFAULT_SIDEBAR_FONT_SIZE_PX)));
            schedulePersistSoon();
          }}
          edgeRouterId={edgeRouterId}
          edgeRouterOptions={edgeRouterOptions}
          onChangeEdgeRouterId={(raw) => {
            const next = normalizeEdgeRouterId(raw);
            edgeRouterIdRef.current = next;
            setEdgeRouterId(next);
            engineRef.current?.setEdgeRouter(next);
            schedulePersistSoon();
          }}
          replyArrowColor={replyArrowColor}
          onChangeReplyArrowColor={(raw) => {
            const next = normalizeHexColor(raw, replyArrowColorRef.current);
            replyArrowColorRef.current = next;
            setReplyArrowColor(next);
            engineRef.current?.setReplyArrowColor(next);
            schedulePersistSoon();
          }}
          replyArrowOpacityPct={replyArrowOpacity * 100}
          onChangeReplyArrowOpacityPct={(raw) => {
            const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : DEFAULT_REPLY_ARROW_OPACITY * 100;
            const next = pct / 100;
            replyArrowOpacityRef.current = next;
            setReplyArrowOpacity(next);
            engineRef.current?.setReplyArrowOpacity(next);
            schedulePersistSoon();
          }}
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
          allowEditingAllTextNodes={allowEditingAllTextNodes}
          onToggleAllowEditingAllTextNodes={() => setAllowEditingAllTextNodes((prev) => !prev)}
          spawnEditNodeByDraw={spawnEditNodeByDraw}
          onToggleSpawnEditNodeByDraw={() => {
            const next = !spawnEditNodeByDrawRef.current;
            spawnEditNodeByDrawRef.current = next;
            setSpawnEditNodeByDraw(next);
            engineRef.current?.setSpawnEditNodeByDrawEnabled(next);
            schedulePersistSoon();
          }}
          spawnInkNodeByDraw={spawnInkNodeByDraw}
          onToggleSpawnInkNodeByDraw={() => {
            const next = !spawnInkNodeByDrawRef.current;
            spawnInkNodeByDrawRef.current = next;
            setSpawnInkNodeByDraw(next);
            engineRef.current?.setSpawnInkNodeByDrawEnabled(next);
            schedulePersistSoon();
          }}
          inkSendCropEnabled={inkSendCropEnabled}
          onToggleInkSendCropEnabled={() => {
            const next = !inkSendCropEnabledRef.current;
            inkSendCropEnabledRef.current = next;
            setInkSendCropEnabled(next);
            schedulePersistSoon();
          }}
          inkSendCropPaddingPx={inkSendCropPaddingPx}
          onChangeInkSendCropPaddingPx={(raw) => {
            const next = Math.round(clampNumber(raw, 0, 200, 24));
            inkSendCropPaddingPxRef.current = next;
            setInkSendCropPaddingPx(next);
            schedulePersistSoon();
          }}
          inkSendDownscaleEnabled={inkSendDownscaleEnabled}
          onToggleInkSendDownscaleEnabled={() => {
            const next = !inkSendDownscaleEnabledRef.current;
            inkSendDownscaleEnabledRef.current = next;
            setInkSendDownscaleEnabled(next);
            schedulePersistSoon();
          }}
          inkSendMaxPixels={inkSendMaxPixels}
          onChangeInkSendMaxPixels={(raw) => {
            const next = Math.round(clampNumber(raw, 100_000, 40_000_000, 6_000_000));
            inkSendMaxPixelsRef.current = next;
            setInkSendMaxPixels(next);
            schedulePersistSoon();
          }}
          inkSendMaxDimPx={inkSendMaxDimPx}
          onChangeInkSendMaxDimPx={(raw) => {
            const next = Math.round(clampNumber(raw, 256, 8192, 4096));
            inkSendMaxDimPxRef.current = next;
            setInkSendMaxDimPx(next);
            schedulePersistSoon();
          }}
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
              onAutoResizeAllTextNodes={() => {
                engineRef.current?.autoResizeAllTextNodes();
                schedulePersistSoon();
              }}
              canonicalizeLayoutAlgorithm={canonicalizeLayoutAlgorithm}
              onChangeCanonicalizeLayoutAlgorithm={setCanonicalizeLayoutAlgorithm}
              onCanonicalizeLayout={() => {
                engineRef.current?.canonicalizeLayout(canonicalizeLayoutAlgorithm);
                schedulePersistSoon();
              }}
		          onRequestImportChat={() => {
		            setSettingsOpen(false);
		            importInputRef.current?.click();
		          }}
		          onExportAllChats={() => {
	            requestExportAllChats({ closeSettingsOnConfirm: true });
	          }}
	          onResetToDefaults={() => {
	            if (
	              !window.confirm(
	                'Reset to defaults?\n\nThis will clear the background library and delete all chats (including stored attachments and payload logs).',
	              )
            ) {
              return;
            }

            setSettingsOpen(false);
            setRawViewer(null);
            setConfirmDelete(null);
            setConfirmApplyBackground(null);

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
              draftInkStrokes: [],
              composerMode: 'text',
              draftAttachments: [],
              replyTo: null,
              contextSelections: [],
              selectedAttachmentKeys: [],
              headNodeId: null,
              turns: [],
              llm: { modelId: DEFAULT_MODEL_ID, webSearchEnabled: true },
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
            setComposerMode('text');
            setComposerInkStrokes([]);
            setComposerDraftAttachments([]);
            setReplySelection(null);
            setReplyContextAttachments([]);
            setReplySelectedAttachmentKeys([]);
            backgroundLibraryRef.current = [];
            setBackgroundLibrary([]);
            setBackgroundStorageKey(null);
            setComposerModelId(DEFAULT_MODEL_ID);
            setComposerWebSearch(true);
            setDebugHudVisible(true);
            const nextModelUserSettings = buildModelUserSettings(allModels, null);
            setModelUserSettings(nextModelUserSettings);
            modelUserSettingsRef.current = nextModelUserSettings;

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

            edgeRouterIdRef.current = DEFAULT_EDGE_ROUTER_ID;
            setEdgeRouterId(DEFAULT_EDGE_ROUTER_ID);

            replyArrowColorRef.current = DEFAULT_REPLY_ARROW_COLOR;
            replyArrowOpacityRef.current = DEFAULT_REPLY_ARROW_OPACITY;
            setReplyArrowColor(DEFAULT_REPLY_ARROW_COLOR);
            setReplyArrowOpacity(DEFAULT_REPLY_ARROW_OPACITY);

            composerFontFamilyRef.current = DEFAULT_COMPOSER_FONT_FAMILY;
            composerFontSizePxRef.current = DEFAULT_COMPOSER_FONT_SIZE_PX;
            composerMinimizedRef.current = false;
            nodeFontFamilyRef.current = DEFAULT_NODE_FONT_FAMILY;
            nodeFontSizePxRef.current = DEFAULT_NODE_FONT_SIZE_PX;
            sidebarFontFamilyRef.current = DEFAULT_SIDEBAR_FONT_FAMILY;
            sidebarFontSizePxRef.current = DEFAULT_SIDEBAR_FONT_SIZE_PX;
            setComposerFontFamily(DEFAULT_COMPOSER_FONT_FAMILY);
            setComposerFontSizePx(DEFAULT_COMPOSER_FONT_SIZE_PX);
            setComposerMinimized(false);
            setNodeFontFamily(DEFAULT_NODE_FONT_FAMILY);
            setNodeFontSizePx(DEFAULT_NODE_FONT_SIZE_PX);
            setSidebarFontFamily(DEFAULT_SIDEBAR_FONT_FAMILY);
            setSidebarFontSizePx(DEFAULT_SIDEBAR_FONT_SIZE_PX);

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
              engine.setEdgeRouter(DEFAULT_EDGE_ROUTER_ID);
              engine.setReplyArrowColor(DEFAULT_REPLY_ARROW_COLOR);
              engine.setReplyArrowOpacity(DEFAULT_REPLY_ARROW_OPACITY);
              engine.setNodeTextFontFamily(fontFamilyCss(DEFAULT_NODE_FONT_FAMILY));
              engine.setNodeTextFontSizePx(DEFAULT_NODE_FONT_SIZE_PX);
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
            {inkInputConfig.hud && inkHud ? (
              <>
                <div style={{ opacity: 0.85 }}>
                  ink cfg • layer {inkInputConfig.layer ? '1' : '0'} • pe {inkInputConfig.layerPointerEvents ? '1' : '0'} •
                  prevent{' '}
                  {inkInputConfig.preventTouchStart && inkInputConfig.preventTouchMove
                    ? 'start+move'
                    : inkInputConfig.preventTouchStart
                      ? 'start'
                      : inkInputConfig.preventTouchMove
                        ? 'move'
                        : 'none'}{' '}
                  • capture {inkInputConfig.pointerCapture ? '1' : '0'}
                </div>
                <div style={{ opacity: 0.85 }}>
                  last {inkHud.lastEventType}
                  {inkHud.lastEventDetail ? ` (${inkHud.lastEventDetail})` : ''} • {inkHud.lastEventAgoMs}ms ago
                </div>
                <div style={{ opacity: 0.75 }}>
                  pd {inkHud.counts.pointerdown ?? 0} • pu {inkHud.counts.pointerup ?? 0} • pc {inkHud.counts.pointercancel ?? 0} • ts{' '}
                  {inkHud.counts.touchstart ?? 0} • tc {inkHud.counts.touchcancel ?? 0} • sel {inkHud.counts.selectionchange ?? 0}
                </div>
                <div style={{ opacity: 0.75 }}>
                  vis {inkHud.visibilityState} • focus {inkHud.hasFocus ? 'y' : 'n'} • active {inkHud.activeEl} • ranges{' '}
                  {inkHud.selectionRangeCount}
                </div>
                {inkHud.recent.length ? (
                  <div style={{ opacity: 0.65, fontSize: 11, maxWidth: 420 }}>
                    {inkHud.recent
                      .map((it) => `${it.type}${it.detail ? `:${it.detail}` : ''}@${it.dtMs}ms`)
                      .join(' • ')}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
