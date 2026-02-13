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
import type { WheelInputPreference } from './engine/InputController';
import type { Rect } from './engine/types';
import ChatComposer from './components/ChatComposer';
import NodeHeaderMenu from './components/NodeHeaderMenu';
import RawPayloadViewer from './components/RawPayloadViewer';
import TextNodeEditor from './components/TextNodeEditor';
import LatexNodeEditor from './components/LatexNodeEditor';
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
import { getGeminiApiKey, sendGeminiResponse, streamGeminiResponse } from './services/geminiService';
import { getAnthropicApiKey, sendAnthropicMessage, streamAnthropicMessage } from './services/anthropicService';
import { getXaiApiKey, retrieveXaiResponse, sendXaiResponse, streamXaiResponse } from './services/xaiService';
import {
  clearRuntimeApiKey,
  getRuntimeApiKeys,
  setRuntimeApiKey,
  type RuntimeApiKeys,
  type RuntimeApiProvider,
} from './services/runtimeApiKeys';
import type { ChatAttachment, ChatNode, InkStroke, ThinkingSummaryChunk } from './model/chat';
import { normalizeBackgroundLibrary, type BackgroundLibraryItem } from './model/backgrounds';
import {
  buildOpenAIResponseRequest,
  OPENAI_LATEX_TOOL_NAMES,
  resolveOpenAILatexToolContext,
  type OpenAIChatSettings,
  type OpenAILatexToolContext,
} from './llm/openai';
import { buildGeminiContext, type GeminiChatSettings } from './llm/gemini';
import { buildXaiResponseRequest, type XaiChatSettings } from './llm/xai';
import { buildAnthropicMessageRequest, type AnthropicChatSettings } from './llm/anthropic';
import { DEFAULT_MODEL_ID, getModelInfo, listModels } from './llm/registry';
import {
  DEFAULT_SYSTEM_INSTRUCTIONS,
  normalizeSystemInstruction,
  resolveSystemInstruction as resolveSystemInstructionText,
} from './llm/systemInstructions';
import { extractCanonicalMessage, extractCanonicalMeta } from './llm/openaiCanonical';
import { buildModelUserSettings, normalizeModelUserSettings, type ModelUserSettingsById } from './llm/modelUserSettings';
import { base64ToBlob, readFileAsDataUrl, splitDataUrl } from './utils/files';
import type { ArchiveV1, ArchiveV2 } from './utils/archive';
import { deleteAttachment, deleteAttachments, getAttachment, listAttachmentKeys, putAttachment } from './storage/attachments';
import { clearAllStores } from './storage/db';
import {
  deleteChatMetaRecord,
  deleteChatStorageFolder,
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
import { useAttachmentObjectUrls } from './ui/useAttachmentObjectUrls';
import { compileLatexDocument } from './latex/compiler';
import { listLatexProjectFiles, readLatexProjectFile, writeLatexProjectFile } from './latex/project';

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
  systemInstructionOverride: string | null;
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

type StorageDataDirInfo = {
  path: string;
  defaultPath: string;
  isDefault: boolean;
};

const API_PROVIDER_LABELS: Record<RuntimeApiProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  xai: 'xAI',
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

const DEFAULT_COMPOSER_FONT_FAMILY: FontFamilyKey = 'font-sans';
const DEFAULT_COMPOSER_FONT_SIZE_PX = 14;

const DEFAULT_NODE_FONT_FAMILY: FontFamilyKey = 'font-sans';
const DEFAULT_NODE_FONT_SIZE_PX = 14;

const DEFAULT_SIDEBAR_FONT_FAMILY: FontFamilyKey = 'ui-monospace';
const DEFAULT_SIDEBAR_FONT_SIZE_PX = 13;

const DEFAULT_REPLY_ARROW_COLOR = '#f5f5f5';
const DEFAULT_REPLY_ARROW_OPACITY = 0.7;
const DEFAULT_DEBUG_HUD_VISIBLE = false;
const DEFAULT_ALLOW_EDITING_ALL_TEXT_NODES = false;
const DEFAULT_SPAWN_EDIT_NODE_BY_DRAW = false;
const DEFAULT_SPAWN_INK_NODE_BY_DRAW = false;
const DEFAULT_WHEEL_INPUT_PREFERENCE: WheelInputPreference = 'auto';
const DEFAULT_MOUSE_CLICK_RECENTER_ENABLED = true;
const EDIT_NODE_SEND_MODEL_MENU_WIDTH = 160;
const DEFAULT_GLASS_NODES_ENABLED = true;
const DEFAULT_GLASS_BLUR_BACKEND: GlassBlurBackend = 'webgl';
const DEFAULT_GLASS_BLUR_CSS_PX_WEBGL = 23;
const DEFAULT_GLASS_SATURATE_PCT_WEBGL = 180;
const DEFAULT_GLASS_BLUR_CSS_PX_CANVAS = 23;
const DEFAULT_GLASS_SATURATE_PCT_CANVAS = 180;
const DEFAULT_UI_GLASS_BLUR_CSS_PX_WEBGL = 15;
const DEFAULT_UI_GLASS_SATURATE_PCT_WEBGL = 140;
const DEFAULT_GLASS_UNDERLAY_ALPHA = 1;
const DEFAULT_INK_SEND_CROP_ENABLED = false;
const DEFAULT_INK_SEND_DOWNSCALE_ENABLED = false;
const DEFAULT_SEND_ALL_ENABLED = false;
const DEFAULT_SEND_ALL_COMPOSER_ENABLED = false;
const DEFAULT_CLEANUP_CHAT_FOLDERS_ON_DELETE = false;
const MULTI_SEND_ASSISTANT_MAX_W_PX = 800;
const MULTI_SEND_ASSISTANT_GAP_X_PX = 26;

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

function normalizeSendAllModelIds(value: unknown, allModelIds: string[]): string[] {
  const known = allModelIds
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  const knownSet = new Set(known);
  const seen = new Set<string>();
  const out: string[] = [];

  if (Array.isArray(value)) {
    for (const raw of value) {
      const id = String(raw ?? '').trim();
      if (!id || !knownSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }

  return out;
}

function normalizeWheelInputPreference(value: unknown, fallback: WheelInputPreference): WheelInputPreference {
  if (value === 'mouse') return 'mouse';
  if (value === 'trackpad') return 'trackpad';
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

function isProbablyBase64(value: string): boolean {
  const s = String(value ?? '');
  if (s.length < 256) return false;
  // Base64 (or base64url) payloads are typically long and restricted to this charset.
  return /^[A-Za-z0-9+/_=-]+$/.test(s);
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

function truncateBase64ForDisplay(value: string, maxChars: number): string {
  const s = String(value ?? '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}… (${s.length} chars)`;
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
      if (isProbablyBase64(value)) return truncateBase64ForDisplay(value, maxDataUrlChars);
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

const OPENAI_TOOL_LOOP_MAX_ROUNDS = 24;
const OPENAI_TOOL_CALL_REPEAT_LIMIT = 4;
const OPENAI_LATEX_LIST_DEFAULT_LIMIT = 500;
const OPENAI_LATEX_LIST_MAX_LIMIT = 5000;
const OPENAI_LATEX_READ_MAX_BYTES = 2_000_000;
const OPENAI_LATEX_REPLACE_DEFAULT_MAX_TOTAL = 200;
const OPENAI_LATEX_LIST_CURSOR_PREFIX = 'offset:';

const OPENAI_LATEX_TOOL_NAME_SET = new Set<string>(Object.values(OPENAI_LATEX_TOOL_NAMES));

type OpenAIFunctionCall = {
  callId: string;
  name: string;
  argumentsJson: string;
};

type OpenAIFunctionCallOutput = {
  callId: string;
  output: Record<string, unknown>;
};

function buildOpenAIToolError(
  errorCode: string,
  error: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: false,
    error_code: errorCode,
    error,
    ...(extra ?? {}),
  };
}

function normalizeOpenAILatexPath(raw: unknown, opts?: { allowEmpty?: boolean }): { ok: true; value: string } | { ok: false; error: string } {
  const allowEmpty = Boolean(opts?.allowEmpty);
  const asString = typeof raw === 'string' ? raw.trim() : '';
  if (!asString) {
    if (allowEmpty) return { ok: true, value: '' };
    return { ok: false, error: 'Path is required.' };
  }
  if (asString.includes('\0')) return { ok: false, error: 'Path contains an invalid character.' };
  const slash = asString.replace(/\\/g, '/');
  if (slash.startsWith('/')) return { ok: false, error: 'Absolute paths are not allowed.' };
  if (/^[a-zA-Z]:\//.test(slash)) return { ok: false, error: 'Absolute paths are not allowed.' };

  const segments = slash.split('/').filter(Boolean);
  if (!segments.length) {
    if (allowEmpty) return { ok: true, value: '' };
    return { ok: false, error: 'Path is required.' };
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { ok: false, error: 'Path cannot contain "." or ".." segments.' };
  }
  return { ok: true, value: segments.join('/') };
}

function parseOpenAIOptionalPositiveInteger(
  raw: unknown,
  fieldName: string,
  maxValue: number,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return { ok: false, error: `${fieldName} must be a positive integer.` };
  const i = Math.floor(n);
  if (i < 1 || i > maxValue) return { ok: false, error: `${fieldName} must be <= ${maxValue}.` };
  return { ok: true, value: i };
}

function getOpenAIUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function truncateOpenAITextByUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const safeMax = Math.max(1, Math.floor(maxBytes));
  if (getOpenAIUtf8ByteLength(text) <= safeMax) return { text, truncated: false };

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid);
    if (getOpenAIUtf8ByteLength(candidate) <= safeMax) lo = mid;
    else hi = mid - 1;
  }
  return { text: text.slice(0, lo), truncated: true };
}

function buildOpenAILineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function resolveOpenAILineRangeOffsets(args: {
  content: string;
  startLine?: number;
  endLine?: number;
}): { ok: true; startOffset: number; endOffsetExclusive: number } | { ok: false; error: string } {
  const starts = buildOpenAILineStarts(args.content);
  const lineCount = Math.max(1, starts.length);
  const startLine = args.startLine ?? 1;
  const endLine = args.endLine ?? lineCount;

  if (!Number.isFinite(startLine) || startLine < 1 || startLine > lineCount) {
    return { ok: false, error: `start_line must be between 1 and ${lineCount}.` };
  }
  if (!Number.isFinite(endLine) || endLine < 1 || endLine > lineCount) {
    return { ok: false, error: `end_line must be between 1 and ${lineCount}.` };
  }
  if (endLine < startLine) return { ok: false, error: 'end_line must be greater than or equal to start_line.' };

  const startOffset = starts[startLine - 1];
  const endOffsetExclusive = endLine < lineCount ? starts[endLine] : args.content.length;
  return { ok: true, startOffset, endOffsetExclusive };
}

function countOpenAILiteralMatches(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= content.length) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

function applyOpenAILiteralReplacement(args: {
  content: string;
  oldText: string;
  newText: string;
  replaceAll: boolean;
  startLine?: number;
  endLine?: number;
}):
  | { ok: true; content: string; count: number }
  | { ok: false; errorCode: string; error: string } {
  if (!args.oldText) return { ok: false, errorCode: 'INVALID_ARGUMENT', error: 'old_text must be non-empty.' };
  const scope = resolveOpenAILineRangeOffsets({
    content: args.content,
    startLine: args.startLine,
    endLine: args.endLine,
  });
  if (!scope.ok) return { ok: false, errorCode: 'INVALID_ARGUMENT', error: scope.error };

  const head = args.content.slice(0, scope.startOffset);
  const body = args.content.slice(scope.startOffset, scope.endOffsetExclusive);
  const tail = args.content.slice(scope.endOffsetExclusive);

  const first = body.indexOf(args.oldText);
  if (first === -1) {
    return { ok: false, errorCode: 'NO_MATCH', error: 'No match found for old_text in the selected scope.' };
  }

  if (!args.replaceAll) {
    const second = body.indexOf(args.oldText, first + args.oldText.length);
    if (second !== -1) {
      return {
        ok: false,
        errorCode: 'AMBIGUOUS_MATCH',
        error: 'Found multiple matches. Set replace_all=true or narrow the line range.',
      };
    }
    const replaced = `${body.slice(0, first)}${args.newText}${body.slice(first + args.oldText.length)}`;
    return { ok: true, content: `${head}${replaced}${tail}`, count: 1 };
  }

  const count = countOpenAILiteralMatches(body, args.oldText);
  const replaced = body.split(args.oldText).join(args.newText);
  return { ok: true, content: `${head}${replaced}${tail}`, count };
}

function openAIFallbackHash(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`;
}

async function computeOpenAIContentVersion(content: string): Promise<string> {
  try {
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const data = new TextEncoder().encode(content);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
      const out = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `sha256:${out}`;
    }
  } catch {
    // ignore and fall back
  }
  return openAIFallbackHash(content);
}

function parseOpenAIListCursor(raw: unknown): number {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s.startsWith(OPENAI_LATEX_LIST_CURSOR_PREFIX)) return 0;
  const n = Number(s.slice(OPENAI_LATEX_LIST_CURSOR_PREFIX.length));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function buildOpenAIListCursor(offset: number): string {
  const safe = Math.max(0, Math.floor(offset));
  return `${OPENAI_LATEX_LIST_CURSOR_PREFIX}${safe}`;
}

function mapOpenAILatexProjectErrorCode(message: string): string {
  const msg = message.toLowerCase();
  if (msg.includes('not found') || msg.includes('no such file') || msg.includes('enoent')) return 'NOT_FOUND';
  if (msg.includes('outside project root') || msg.includes('invalid file path') || msg.includes('path')) return 'INVALID_PATH';
  if (msg.includes('editable text files')) return 'NOT_EDITABLE';
  if (msg.includes('too large')) return 'FILE_TOO_LARGE';
  if (msg.includes('project root')) return 'PROJECT_NOT_SET';
  return 'TOOL_EXECUTION_FAILED';
}

function isOpenAIMissingFileError(message: string): boolean {
  const msg = message.toLowerCase();
  return msg.includes('not found') || msg.includes('no such file') || msg.includes('enoent');
}

function parseOpenAIFunctionCallArguments(argumentsJson: string): Record<string, unknown> | null {
  const raw = typeof argumentsJson === 'string' ? argumentsJson.trim() : '';
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function requestIncludesOpenAILatexTools(request: Record<string, unknown>): boolean {
  const tools = Array.isArray((request as any)?.tools) ? ((request as any).tools as any[]) : [];
  return tools.some((tool) => {
    if (!tool || typeof tool !== 'object') return false;
    if (tool.type !== 'function') return false;
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    return OPENAI_LATEX_TOOL_NAME_SET.has(name);
  });
}

function extractOpenAIResponseId(raw: unknown): string {
  const anyRaw: any = raw as any;
  const direct = typeof anyRaw?.id === 'string' ? String(anyRaw.id).trim() : '';
  if (direct) return direct;
  const nested = typeof anyRaw?.response?.id === 'string' ? String(anyRaw.response.id).trim() : '';
  return nested || '';
}

function extractOpenAIFunctionCalls(raw: unknown): OpenAIFunctionCall[] {
  const anyRaw: any = raw as any;
  const output =
    Array.isArray(anyRaw?.output)
      ? (anyRaw.output as any[])
      : Array.isArray(anyRaw?.response?.output)
        ? (anyRaw.response.output as any[])
        : [];
  const out: OpenAIFunctionCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'function_call') continue;
    const status = typeof item.status === 'string' ? String(item.status).trim().toLowerCase() : '';
    if (status && status !== 'completed') continue;

    const callId = typeof item.call_id === 'string' ? String(item.call_id).trim() : '';
    const name = typeof item.name === 'string' ? String(item.name).trim() : '';
    if (!callId || !name) continue;
    let argumentsJson = '{}';
    if (typeof item.arguments === 'string') argumentsJson = item.arguments;
    else if (item.arguments && typeof item.arguments === 'object') {
      try {
        argumentsJson = JSON.stringify(item.arguments);
      } catch {
        argumentsJson = '{}';
      }
    }
    out.push({ callId, name, argumentsJson });
  }
  return out;
}

function buildOpenAIFunctionCallContinuationRequest(args: {
  baseRequest: Record<string, unknown>;
  responseId: string;
  outputs: OpenAIFunctionCallOutput[];
}): Record<string, unknown> {
  const base = args.baseRequest as any;
  const input = args.outputs.map((item) => ({
    type: 'function_call_output',
    call_id: item.callId,
    output: JSON.stringify(item.output),
  }));
  const next: Record<string, unknown> = {
    model: base.model,
    previous_response_id: args.responseId,
    input,
    store: true,
  };
  if (typeof base.instructions === 'string') next.instructions = base.instructions;
  if (Array.isArray(base.tools)) next.tools = base.tools;
  if (base.tool_choice !== undefined) next.tool_choice = base.tool_choice;
  if (typeof base.parallel_tool_calls === 'boolean') next.parallel_tool_calls = base.parallel_tool_calls;
  if (base.reasoning && typeof base.reasoning === 'object') next.reasoning = base.reasoning;
  if (base.text && typeof base.text === 'object') next.text = base.text;
  if (Array.isArray(base.include)) next.include = base.include;
  return next;
}

async function executeOpenAILatexListFilesTool(args: {
  toolArgs: Record<string, unknown>;
  context: OpenAILatexToolContext;
}): Promise<Record<string, unknown>> {
  const prefixParsed = normalizeOpenAILatexPath(args.toolArgs.path_prefix, { allowEmpty: true });
  if (!prefixParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', prefixParsed.error);
  const pathPrefix = prefixParsed.value;

  const editableOnly = typeof args.toolArgs.editable_only === 'boolean' ? args.toolArgs.editable_only : true;
  const kindsInput = Array.isArray(args.toolArgs.kinds) ? (args.toolArgs.kinds as unknown[]) : [];
  const kindFilter = new Set<string>();
  for (const raw of kindsInput) {
    const kind = typeof raw === 'string' ? raw.trim() : '';
    if (!kind) continue;
    kindFilter.add(kind);
  }

  const limitParsed = parseOpenAIOptionalPositiveInteger(args.toolArgs.limit, 'limit', OPENAI_LATEX_LIST_MAX_LIMIT);
  if (!limitParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', limitParsed.error);
  const limit = limitParsed.value ?? OPENAI_LATEX_LIST_DEFAULT_LIMIT;
  const offset = parseOpenAIListCursor(args.toolArgs.cursor);

  const listed = await listLatexProjectFiles(args.context.projectRoot);
  if (!listed.ok || !listed.index) {
    const error = listed.error ?? 'Failed to list project files.';
    return buildOpenAIToolError(mapOpenAILatexProjectErrorCode(error), error);
  }

  const files = (listed.index.files ?? []).filter((file) => {
    if (!file || typeof file.path !== 'string') return false;
    if (editableOnly && !file.editable) return false;
    if (kindFilter.size > 0 && !kindFilter.has(file.kind)) return false;
    if (!pathPrefix) return true;
    if (file.path === pathPrefix) return true;
    return file.path.startsWith(`${pathPrefix}/`);
  });

  const start = Math.max(0, Math.min(offset, files.length));
  const end = Math.max(start, Math.min(start + limit, files.length));
  const page = files.slice(start, end);
  const nextCursor = end < files.length ? buildOpenAIListCursor(end) : null;

  return {
    ok: true,
    files: page.map((file) => ({ path: file.path, kind: file.kind, editable: Boolean(file.editable) })),
    suggested_main_file: listed.index.suggestedMainFile ?? args.context.mainFile ?? null,
    next_cursor: nextCursor,
    truncated: Boolean(nextCursor),
  };
}

async function executeOpenAILatexReadFileTool(args: {
  toolArgs: Record<string, unknown>;
  context: OpenAILatexToolContext;
}): Promise<Record<string, unknown>> {
  const pathParsed = normalizeOpenAILatexPath(args.toolArgs.path);
  if (!pathParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', pathParsed.error);
  const path = pathParsed.value;

  const maxBytesParsed = parseOpenAIOptionalPositiveInteger(args.toolArgs.max_bytes, 'max_bytes', OPENAI_LATEX_READ_MAX_BYTES);
  if (!maxBytesParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', maxBytesParsed.error);
  const maxBytes = maxBytesParsed.value ?? OPENAI_LATEX_READ_MAX_BYTES;

  const startLineParsed = parseOpenAIOptionalPositiveInteger(args.toolArgs.start_line, 'start_line', 10_000_000);
  if (!startLineParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', startLineParsed.error);
  const endLineParsed = parseOpenAIOptionalPositiveInteger(args.toolArgs.end_line, 'end_line', 10_000_000);
  if (!endLineParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', endLineParsed.error);

  const read = await readLatexProjectFile(args.context.projectRoot, path);
  if (!read.ok) {
    const error = read.error ?? 'Failed to read file.';
    return buildOpenAIToolError(mapOpenAILatexProjectErrorCode(error), error, { path });
  }

  const fullContent = typeof read.content === 'string' ? read.content : '';
  const version = await computeOpenAIContentVersion(fullContent);
  const fullSizeBytes = getOpenAIUtf8ByteLength(fullContent);

  let selected = fullContent;
  if (startLineParsed.value !== undefined || endLineParsed.value !== undefined) {
    const scoped = resolveOpenAILineRangeOffsets({
      content: fullContent,
      startLine: startLineParsed.value,
      endLine: endLineParsed.value,
    });
    if (!scoped.ok) return buildOpenAIToolError('INVALID_ARGUMENT', scoped.error);
    selected = fullContent.slice(scoped.startOffset, scoped.endOffsetExclusive);
  }

  const truncated = truncateOpenAITextByUtf8Bytes(selected, maxBytes);
  return {
    ok: true,
    path,
    content: truncated.text,
    encoding: 'utf-8',
    size_bytes: fullSizeBytes,
    truncated: truncated.truncated,
    version,
  };
}

async function executeOpenAILatexWriteFileTool(args: {
  toolArgs: Record<string, unknown>;
  context: OpenAILatexToolContext;
}): Promise<Record<string, unknown>> {
  const pathParsed = normalizeOpenAILatexPath(args.toolArgs.path);
  if (!pathParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', pathParsed.error);
  const path = pathParsed.value;

  const content =
    typeof args.toolArgs.content === 'string' ? args.toolArgs.content : String(args.toolArgs.content ?? '');
  const expectedVersion =
    typeof args.toolArgs.expected_version === 'string' ? args.toolArgs.expected_version.trim() : '';
  if (!expectedVersion) {
    return buildOpenAIToolError('EXPECTED_VERSION_REQUIRED', 'expected_version is required for latex_write_file.');
  }
  const createIfMissing = typeof args.toolArgs.create_if_missing === 'boolean' ? args.toolArgs.create_if_missing : true;

  const current = await readLatexProjectFile(args.context.projectRoot, path);
  if (current.ok) {
    const currentVersion = await computeOpenAIContentVersion(current.content ?? '');
    if (expectedVersion !== currentVersion) {
      return buildOpenAIToolError('VERSION_CONFLICT', 'File changed since it was last read.', {
        path,
        expected_version: expectedVersion,
        current_version: currentVersion,
      });
    }
  } else {
    const readError = current.error ?? 'Failed to read file.';
    if (!isOpenAIMissingFileError(readError)) {
      return buildOpenAIToolError(mapOpenAILatexProjectErrorCode(readError), readError, { path });
    }
    if (!createIfMissing) return buildOpenAIToolError('NOT_FOUND', 'File does not exist.', { path });
    if (expectedVersion !== 'missing') {
      return buildOpenAIToolError('VERSION_CONFLICT', 'File does not exist. Use expected_version="missing" to create it.', {
        path,
        expected_version: expectedVersion,
        current_version: 'missing',
      });
    }
  }

  const written = await writeLatexProjectFile(args.context.projectRoot, path, content);
  if (!written.ok) {
    const error = written.error ?? 'Failed to write file.';
    return buildOpenAIToolError(mapOpenAILatexProjectErrorCode(error), error, { path });
  }

  const version = await computeOpenAIContentVersion(content);
  return {
    ok: true,
    path,
    bytes_written: getOpenAIUtf8ByteLength(content),
    version,
  };
}

async function executeOpenAILatexReplaceFileTool(args: {
  toolArgs: Record<string, unknown>;
  context: OpenAILatexToolContext;
}): Promise<Record<string, unknown>> {
  const pathParsed = normalizeOpenAILatexPath(args.toolArgs.path);
  if (!pathParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', pathParsed.error);
  const path = pathParsed.value;

  const replacements = Array.isArray(args.toolArgs.replacements) ? (args.toolArgs.replacements as unknown[]) : [];
  if (replacements.length === 0) {
    return buildOpenAIToolError('INVALID_ARGUMENT', 'replacements must include at least one item.');
  }

  const expectedVersion =
    typeof args.toolArgs.expected_version === 'string' ? args.toolArgs.expected_version.trim() : '';
  if (!expectedVersion) {
    return buildOpenAIToolError('EXPECTED_VERSION_REQUIRED', 'expected_version is required for latex_replace_in_file.');
  }
  const dryRun = typeof args.toolArgs.dry_run === 'boolean' ? args.toolArgs.dry_run : false;
  const maxTotalParsed = parseOpenAIOptionalPositiveInteger(
    args.toolArgs.max_total_replacements,
    'max_total_replacements',
    200_000,
  );
  if (!maxTotalParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', maxTotalParsed.error);
  const maxTotalReplacements = maxTotalParsed.value ?? OPENAI_LATEX_REPLACE_DEFAULT_MAX_TOTAL;

  const read = await readLatexProjectFile(args.context.projectRoot, path);
  if (!read.ok) {
    const error = read.error ?? 'Failed to read file.';
    return buildOpenAIToolError(mapOpenAILatexProjectErrorCode(error), error, { path });
  }

  const originalContent = typeof read.content === 'string' ? read.content : '';
  const initialVersion = await computeOpenAIContentVersion(originalContent);
  if (expectedVersion !== initialVersion) {
    return buildOpenAIToolError('VERSION_CONFLICT', 'File changed since it was last read.', {
      path,
      expected_version: expectedVersion,
      current_version: initialVersion,
    });
  }

  let nextContent = originalContent;
  let totalReplacements = 0;
  const applied: Array<{ index: number; count: number }> = [];

  for (let i = 0; i < replacements.length; i += 1) {
    const item = replacements[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return buildOpenAIToolError('INVALID_ARGUMENT', `replacements[${i}] must be an object.`);
    }
    const rep = item as Record<string, unknown>;
    const oldText = typeof rep.old_text === 'string' ? rep.old_text : '';
    const newText = typeof rep.new_text === 'string' ? rep.new_text : String(rep.new_text ?? '');
    if (!oldText) return buildOpenAIToolError('INVALID_ARGUMENT', `replacements[${i}].old_text must be non-empty.`);
    const replaceAll = typeof rep.replace_all === 'boolean' ? rep.replace_all : false;

    const startLineParsed = parseOpenAIOptionalPositiveInteger(rep.start_line, `replacements[${i}].start_line`, 10_000_000);
    if (!startLineParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', startLineParsed.error);
    const endLineParsed = parseOpenAIOptionalPositiveInteger(rep.end_line, `replacements[${i}].end_line`, 10_000_000);
    if (!endLineParsed.ok) return buildOpenAIToolError('INVALID_ARGUMENT', endLineParsed.error);

    const replaced = applyOpenAILiteralReplacement({
      content: nextContent,
      oldText,
      newText,
      replaceAll,
      startLine: startLineParsed.value,
      endLine: endLineParsed.value,
    });
    if (!replaced.ok) {
      return buildOpenAIToolError(replaced.errorCode, replaced.error, { replacement_index: i });
    }

    totalReplacements += replaced.count;
    if (totalReplacements > maxTotalReplacements) {
      return buildOpenAIToolError(
        'MAX_REPLACEMENTS_EXCEEDED',
        `Replacement cap exceeded (${maxTotalReplacements}).`,
        { replacement_index: i, total_replacements: totalReplacements },
      );
    }
    nextContent = replaced.content;
    applied.push({ index: i, count: replaced.count });
  }

  if (totalReplacements < 1) {
    return buildOpenAIToolError('NO_MATCH', 'No replacements were applied.');
  }

  if (dryRun) {
    return {
      ok: true,
      path,
      dry_run: true,
      applied,
      total_replacements: totalReplacements,
      version: initialVersion,
    };
  }

  // Best-effort guard in case local content changed between read and write.
  const latest = await readLatexProjectFile(args.context.projectRoot, path);
  if (!latest.ok) {
    const error = latest.error ?? 'Failed to read file.';
    return buildOpenAIToolError(mapOpenAILatexProjectErrorCode(error), error, { path });
  }
  const latestVersion = await computeOpenAIContentVersion(latest.content ?? '');
  if (latestVersion !== initialVersion) {
    return buildOpenAIToolError('VERSION_CONFLICT', 'File changed before replacement write.', {
      path,
      expected_version: initialVersion,
      current_version: latestVersion,
    });
  }

  const write = await writeLatexProjectFile(args.context.projectRoot, path, nextContent);
  if (!write.ok) {
    const error = write.error ?? 'Failed to write file.';
    return buildOpenAIToolError(mapOpenAILatexProjectErrorCode(error), error, { path });
  }
  const nextVersion = await computeOpenAIContentVersion(nextContent);

  return {
    ok: true,
    path,
    dry_run: false,
    applied,
    total_replacements: totalReplacements,
    bytes_written: getOpenAIUtf8ByteLength(nextContent),
    version: nextVersion,
  };
}

async function executeOpenAILatexFunctionCall(args: {
  call: OpenAIFunctionCall;
  context: OpenAILatexToolContext | null;
}): Promise<Record<string, unknown>> {
  if (!args.context) return buildOpenAIToolError('PROJECT_NOT_SET', 'No LaTeX project is currently selected.');
  const parsedArgs = parseOpenAIFunctionCallArguments(args.call.argumentsJson);
  if (!parsedArgs) return buildOpenAIToolError('INVALID_ARGUMENT', 'Tool arguments must be a JSON object.');

  if (args.call.name === OPENAI_LATEX_TOOL_NAMES.listFiles) {
    return await executeOpenAILatexListFilesTool({ toolArgs: parsedArgs, context: args.context });
  }
  if (args.call.name === OPENAI_LATEX_TOOL_NAMES.readFile) {
    return await executeOpenAILatexReadFileTool({ toolArgs: parsedArgs, context: args.context });
  }
  if (args.call.name === OPENAI_LATEX_TOOL_NAMES.writeFile) {
    return await executeOpenAILatexWriteFileTool({ toolArgs: parsedArgs, context: args.context });
  }
  if (args.call.name === OPENAI_LATEX_TOOL_NAMES.replaceInFile) {
    return await executeOpenAILatexReplaceFileTool({ toolArgs: parsedArgs, context: args.context });
  }

  return buildOpenAIToolError('UNKNOWN_TOOL', `Unsupported tool: ${args.call.name}`);
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
  const debugBridgeEnabledRef = useRef<boolean>(DEFAULT_DEBUG_HUD_VISIBLE);
  const lastEngineInteractingRef = useRef<boolean | null>(null);
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
      systemInstructionDefault: string;
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
      sendAllEnabled: boolean;
      sendAllComposerEnabled: boolean;
      sendAllModelIds: string[];
      cleanupChatFoldersOnDelete: boolean;
      wheelInputPreference: WheelInputPreference;
      mouseClickRecenterEnabled: boolean;
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
  const [editNodeSendMenuPointerLock, setEditNodeSendMenuPointerLock] = useState(false);
  const editNodeSendModelDragRef = useRef<{
    pointerId: number;
    nodeId: string;
    modelId: string;
    startClient: { x: number; y: number };
    lastClient: { x: number; y: number };
    moved: boolean;
  } | null>(null);
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
  const [storageDataDirInfo, setStorageDataDirInfo] = useState<StorageDataDirInfo | null>(null);
  const [runtimeApiKeys, setRuntimeApiKeys] = useState<RuntimeApiKeys>(() => getRuntimeApiKeys());
  const [debugHudVisible, setDebugHudVisible] = useState(DEFAULT_DEBUG_HUD_VISIBLE);
  const [sendAllEnabled, setSendAllEnabled] = useState(DEFAULT_SEND_ALL_ENABLED);
  const sendAllEnabledRef = useRef<boolean>(sendAllEnabled);
  const [sendAllComposerEnabled, setSendAllComposerEnabled] = useState(DEFAULT_SEND_ALL_COMPOSER_ENABLED);
  const sendAllComposerEnabledRef = useRef<boolean>(sendAllComposerEnabled);
  const [sendAllModelIds, setSendAllModelIds] = useState<string[]>(() => []);
  const sendAllModelIdsRef = useRef<string[]>(sendAllModelIds);
  const sendAllModelIdsInitializedRef = useRef(false);
  const [cleanupChatFoldersOnDelete, setCleanupChatFoldersOnDelete] = useState(DEFAULT_CLEANUP_CHAT_FOLDERS_ON_DELETE);
  const cleanupChatFoldersOnDeleteRef = useRef<boolean>(cleanupChatFoldersOnDelete);
  const [allowEditingAllTextNodes, setAllowEditingAllTextNodes] = useState(DEFAULT_ALLOW_EDITING_ALL_TEXT_NODES);
  const allowEditingAllTextNodesRef = useRef<boolean>(allowEditingAllTextNodes);
  const [spawnEditNodeByDraw, setSpawnEditNodeByDraw] = useState(DEFAULT_SPAWN_EDIT_NODE_BY_DRAW);
  const spawnEditNodeByDrawRef = useRef<boolean>(spawnEditNodeByDraw);
  const [spawnInkNodeByDraw, setSpawnInkNodeByDraw] = useState(DEFAULT_SPAWN_INK_NODE_BY_DRAW);
  const spawnInkNodeByDrawRef = useRef<boolean>(spawnInkNodeByDraw);
  const [wheelInputPreference, setWheelInputPreference] = useState<WheelInputPreference>(DEFAULT_WHEEL_INPUT_PREFERENCE);
  const wheelInputPreferenceRef = useRef<WheelInputPreference>(wheelInputPreference);
  const [mouseClickRecenterEnabled, setMouseClickRecenterEnabled] = useState<boolean>(DEFAULT_MOUSE_CLICK_RECENTER_ENABLED);
  const mouseClickRecenterEnabledRef = useRef<boolean>(mouseClickRecenterEnabled);
  const [inkSendCropEnabled, setInkSendCropEnabled] = useState(DEFAULT_INK_SEND_CROP_ENABLED);
  const inkSendCropEnabledRef = useRef<boolean>(inkSendCropEnabled);
  const [inkSendCropPaddingPx, setInkSendCropPaddingPx] = useState<number>(24);
  const inkSendCropPaddingPxRef = useRef<number>(inkSendCropPaddingPx);
  const [inkSendDownscaleEnabled, setInkSendDownscaleEnabled] = useState(DEFAULT_INK_SEND_DOWNSCALE_ENABLED);
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
  const [glassNodesEnabled, setGlassNodesEnabled] = useState<boolean>(() => DEFAULT_GLASS_NODES_ENABLED);
  const [glassNodesBlurCssPxWebgl, setGlassNodesBlurCssPxWebgl] = useState<number>(() => DEFAULT_GLASS_BLUR_CSS_PX_WEBGL);
  const [glassNodesSaturatePctWebgl, setGlassNodesSaturatePctWebgl] = useState<number>(() => DEFAULT_GLASS_SATURATE_PCT_WEBGL);
  const [glassNodesBlurCssPxCanvas, setGlassNodesBlurCssPxCanvas] = useState<number>(() => DEFAULT_GLASS_BLUR_CSS_PX_CANVAS);
  const [glassNodesSaturatePctCanvas, setGlassNodesSaturatePctCanvas] = useState<number>(() => DEFAULT_GLASS_SATURATE_PCT_CANVAS);
  const [glassNodesUnderlayAlpha, setGlassNodesUnderlayAlpha] = useState<number>(() => DEFAULT_GLASS_UNDERLAY_ALPHA);
  const [glassNodesBlurBackend, setGlassNodesBlurBackend] = useState<GlassBlurBackend>(() => DEFAULT_GLASS_BLUR_BACKEND);
  const [edgeRouterId, setEdgeRouterId] = useState<EdgeRouterId>(() => DEFAULT_EDGE_ROUTER_ID);
  const [replyArrowColor, setReplyArrowColor] = useState<string>(() => DEFAULT_REPLY_ARROW_COLOR);
  const [replyArrowOpacity, setReplyArrowOpacity] = useState<number>(() => DEFAULT_REPLY_ARROW_OPACITY);
  const [replySpawnKind, setReplySpawnKind] = useState<'text' | 'ink'>(() => 'text');
  const [uiGlassBlurCssPxWebgl, setUiGlassBlurCssPxWebgl] = useState<number>(() => DEFAULT_UI_GLASS_BLUR_CSS_PX_WEBGL);
  const [uiGlassSaturatePctWebgl, setUiGlassSaturatePctWebgl] = useState<number>(() => DEFAULT_UI_GLASS_SATURATE_PCT_WEBGL);
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
  const allModels = useMemo(() => listModels(), [listModels]);
  const allModelIds = useMemo(
    () => allModels.map((m) => String(m.id ?? '').trim()).filter(Boolean),
    [allModels],
  );
  const edgeRouterOptions = useMemo(
    () => listEdgeRouters().map((r) => ({ id: r.id as EdgeRouterId, label: r.label, description: r.description })),
    [],
  );
  const [modelUserSettings, setModelUserSettings] = useState<ModelUserSettingsById>(() => buildModelUserSettings(allModels, null));
  const modelUserSettingsRef = useRef<ModelUserSettingsById>(modelUserSettings);
  const [globalSystemInstruction, setGlobalSystemInstruction] = useState<string>(() => DEFAULT_SYSTEM_INSTRUCTIONS);
  const globalSystemInstructionRef = useRef<string>(globalSystemInstruction);
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
  const [activeChatSystemInstructionOverride, setActiveChatSystemInstructionOverride] = useState<string | null>(() => null);

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
      systemInstructionOverride: null,
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
      systemInstructionOverride: null,
      headNodeId: null,
      turns: [],
      llm: { modelId: DEFAULT_MODEL_ID, webSearchEnabled: true },
      backgroundStorageKey: null,
    };
    chatMetaRef.current.set(chatId, meta);
    return meta;
  };

  const resolveSystemInstructionForChat = (chatId: string): string => {
    const meta = ensureChatMeta(chatId);
    const override = typeof meta.systemInstructionOverride === 'string' ? meta.systemInstructionOverride : null;
    return resolveSystemInstructionText(override, globalSystemInstructionRef.current);
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
    globalSystemInstructionRef.current = globalSystemInstruction;
  }, [globalSystemInstruction]);

  useEffect(() => {
    backgroundLibraryRef.current = backgroundLibrary;
  }, [backgroundLibrary]);

  useEffect(() => {
    sendAllEnabledRef.current = sendAllEnabled;
  }, [sendAllEnabled]);

  useEffect(() => {
    sendAllComposerEnabledRef.current = sendAllComposerEnabled;
  }, [sendAllComposerEnabled]);

  useEffect(() => {
    sendAllModelIdsRef.current = sendAllModelIds;
  }, [sendAllModelIds]);

  useEffect(() => {
    cleanupChatFoldersOnDeleteRef.current = cleanupChatFoldersOnDelete;
  }, [cleanupChatFoldersOnDelete]);

  useEffect(() => {
    setSendAllModelIds((prev) => {
      let normalized = normalizeSendAllModelIds(prev, allModelIds);
      if (!sendAllModelIdsInitializedRef.current) {
        sendAllModelIdsInitializedRef.current = true;
        if (normalized.length === 0) normalized = allModelIds.slice();
      }
      const same =
        prev.length === normalized.length && prev.every((id, index) => id === normalized[index]);
      if (same) return prev;
      sendAllModelIdsRef.current = normalized;
      return normalized;
    });
  }, [allModelIds]);

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
    wheelInputPreferenceRef.current = wheelInputPreference;
    engineRef.current?.setWheelInputPreference(wheelInputPreference);
  }, [wheelInputPreference]);

  useEffect(() => {
    mouseClickRecenterEnabledRef.current = mouseClickRecenterEnabled;
    engineRef.current?.setMouseClickRecenterEnabled(mouseClickRecenterEnabled);
  }, [mouseClickRecenterEnabled]);

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
            llm: {
              modelUserSettings: modelUserSettingsRef.current as any,
              systemInstructionDefault: globalSystemInstructionRef.current,
            },
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
                : DEFAULT_GLASS_UNDERLAY_ALPHA,
              glassNodesBlurBackend: glassNodesBlurBackendRef.current === 'canvas' ? 'canvas' : DEFAULT_GLASS_BLUR_BACKEND,
              composerFontFamily: composerFontFamilyRef.current,
              composerFontSizePx: Math.round(clampNumber(composerFontSizePxRef.current, 10, 30, DEFAULT_COMPOSER_FONT_SIZE_PX)),
              composerMinimized: Boolean(composerMinimizedRef.current),
              nodeFontFamily: nodeFontFamilyRef.current,
              nodeFontSizePx: Math.round(clampNumber(nodeFontSizePxRef.current, 10, 30, DEFAULT_NODE_FONT_SIZE_PX)),
              sidebarFontFamily: sidebarFontFamilyRef.current,
              sidebarFontSizePx: Math.round(clampNumber(sidebarFontSizePxRef.current, 8, 24, DEFAULT_SIDEBAR_FONT_SIZE_PX)),
              spawnEditNodeByDraw: Boolean(spawnEditNodeByDrawRef.current),
              spawnInkNodeByDraw: Boolean(spawnInkNodeByDrawRef.current),
              wheelInputPreference: wheelInputPreferenceRef.current,
              mouseClickRecenterEnabled: Boolean(mouseClickRecenterEnabledRef.current),
              inkSendCropEnabled: Boolean(inkSendCropEnabledRef.current),
              inkSendCropPaddingPx: Math.round(clampNumber(inkSendCropPaddingPxRef.current, 0, 200, 24)),
              inkSendDownscaleEnabled: Boolean(inkSendDownscaleEnabledRef.current),
              inkSendMaxPixels: Math.round(clampNumber(inkSendMaxPixelsRef.current, 100_000, 40_000_000, 6_000_000)),
              inkSendMaxDimPx: Math.round(clampNumber(inkSendMaxDimPxRef.current, 256, 8192, 4096)),
              sendAllEnabled: Boolean(sendAllEnabledRef.current),
              sendAllComposerEnabled: Boolean(sendAllComposerEnabledRef.current),
              sendAllModelIds: normalizeSendAllModelIds(sendAllModelIdsRef.current, allModelIds),
              cleanupChatFoldersOnDelete: Boolean(cleanupChatFoldersOnDeleteRef.current),
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
    // Editor overlays and raw viewers follow camera movement with their own RAF loops;
    // keep the debug bridge off unless HUD/menus need React-driven repositioning.
    const shouldReceiveDebugFrames =
      debugHudVisible ||
      nodeMenuId != null ||
      editNodeSendMenuId != null ||
      replySpawnMenuId != null;

    const wasEnabled = debugBridgeEnabledRef.current;
    debugBridgeEnabledRef.current = shouldReceiveDebugFrames;

    if (!shouldReceiveDebugFrames) {
      setDebug(null);
      return;
    }

    if (!wasEnabled) {
      engineRef.current?.requestRender();
    }
  }, [debugHudVisible, nodeMenuId, editNodeSendMenuId, replySpawnMenuId]);

  const applyVisualSettings = (chatId: string) => {
    const engine = engineRef.current;
    if (!engine) return;

    const meta = ensureChatMeta(chatId);
    engine.setEdgeRouter(edgeRouterIdRef.current);
    engine.setReplyArrowColor(replyArrowColorRef.current);
    engine.setReplyArrowOpacity(replyArrowOpacityRef.current);
    const blurBackend = glassNodesBlurBackendRef.current === 'canvas' ? 'canvas' : DEFAULT_GLASS_BLUR_BACKEND;
    const blurCssPx =
      blurBackend === 'canvas' ? glassNodesBlurCssPxCanvasRef.current : glassNodesBlurCssPxWebglRef.current;
    const saturatePct =
      blurBackend === 'canvas' ? glassNodesSaturatePctCanvasRef.current : glassNodesSaturatePctWebglRef.current;
    engine.setGlassNodesEnabled(Boolean(glassNodesEnabledRef.current));
    engine.setGlassNodesBlurBackend(blurBackend);
    engine.setGlassNodesBlurCssPx(
      Number.isFinite(blurCssPx)
        ? Math.max(0, Math.min(30, blurCssPx))
        : blurBackend === 'canvas'
          ? DEFAULT_GLASS_BLUR_CSS_PX_CANVAS
          : DEFAULT_GLASS_BLUR_CSS_PX_WEBGL,
    );
    engine.setGlassNodesSaturatePct(
      Number.isFinite(saturatePct)
        ? Math.max(100, Math.min(200, saturatePct))
        : blurBackend === 'canvas'
          ? DEFAULT_GLASS_SATURATE_PCT_CANVAS
          : DEFAULT_GLASS_SATURATE_PCT_WEBGL,
    );
    engine.setGlassNodesUnderlayAlpha(
      Number.isFinite(glassNodesUnderlayAlphaRef.current) ? glassNodesUnderlayAlphaRef.current : DEFAULT_GLASS_UNDERLAY_ALPHA,
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

	    const pdfNodes = (state?.nodes ?? []).filter((n): n is Extract<ChatNode, { kind: 'pdf' }> => n.kind === 'pdf');
	    const candidates = pdfNodes.filter((n) => {
	      const storageKey = typeof (n as any)?.storageKey === 'string' ? String((n as any).storageKey).trim() : '';
	      if (storageKey) return true;
	      const fileData = (n as any)?.fileData;
	      const data = fileData && typeof fileData === 'object' ? String((fileData as any).data ?? '').trim() : '';
	      return Boolean(data);
	    });
	    if (candidates.length === 0) return;

	    hydratingPdfChatsRef.current.add(cid);
	    void (async () => {
	      try {
	        const engine = engineRef.current;
	        if (!engine) return;

	        for (const node of candidates) {
	          const storageKey = typeof (node as any)?.storageKey === 'string' ? String((node as any).storageKey).trim() : '';

	          if (storageKey) {
	            try {
	              const rec = await getAttachment(storageKey);
	              if (rec?.blob) {
	                const buf = await rec.blob.arrayBuffer();
	                await engine.hydratePdfNodeFromArrayBuffer({
	                  nodeId: node.id,
	                  buffer: buf,
	                  fileName: node.fileName ?? null,
	                  storageKey,
	                });
	                continue;
	              }
	            } catch {
	              // fall through to embedded fileData
	            }
	          }

	          const fileData = (node as any)?.fileData;
	          const data = fileData && typeof fileData === 'object' ? String((fileData as any).data ?? '').trim() : '';
	          if (!data) continue;

	          const mt = String((fileData as any)?.mimeType ?? '').trim() || 'application/pdf';
	          const name = String((fileData as any)?.name ?? '').trim() || String(node.fileName ?? '').trim() || 'document.pdf';
	          const sizeRaw = Number((fileData as any)?.size);
	          const size = Number.isFinite(sizeRaw) ? sizeRaw : undefined;

	          try {
	            const blob = base64ToBlob(data, mt);
	            const buf = await blob.arrayBuffer();

	            let storedKey: string | null = null;
	            try {
	              storedKey = await putAttachment({
	                blob,
	                mimeType: mt,
	                name,
	                size,
	              });
	            } catch {
	              storedKey = null;
	            }

	            if (storedKey) {
	              (node as any).storageKey = storedKey;
	              try {
	                delete (node as any).fileData;
	              } catch {
	                // ignore
	              }
	            }

	            await engine.hydratePdfNodeFromArrayBuffer({
	              nodeId: node.id,
	              buffer: buf,
	              fileName: node.fileName ?? name ?? null,
	              storageKey: storedKey,
	            });
	          } catch {
	            // ignore
	          }
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
      const msg = 'OpenAI API key missing. Add it in Settings -> Models -> API keys or set OPENAI_API_KEY in .env.local.';
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
      const nodesForRequest = args.nodesOverride ?? state?.nodes ?? [];
      try {
        request = await buildOpenAIResponseRequest({
          nodes: nodesForRequest,
          leafUserNodeId: args.userNodeId,
          settings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finishJob(job.assistantNodeId, { finalText: job.fullText, error: msg });
        return;
      }
	      if (job.closed || job.abortController.signal.aborted) return;

	      const hasLatexTools = requestIncludesOpenAILatexTools(request);
	      const latexToolContext = hasLatexTools
	        ? resolveOpenAILatexToolContext({ nodes: nodesForRequest, leafUserNodeId: args.userNodeId })
	        : null;
	      const latexToolLoopEnabled = hasLatexTools && Boolean(latexToolContext);
	      const streamingEnabled = typeof settings.stream === 'boolean' ? settings.stream : true;
	      const backgroundEnabled = Boolean(settings.background) && !latexToolLoopEnabled;
	      job.background = backgroundEnabled;
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

	      const runOpenAILatexToolLoop = async () => {
	        let currentRequest: Record<string, unknown> = { ...(sentRequest ?? {}) };
	        let useStreaming = Boolean((currentRequest as any)?.stream === true);
	        let lastResponse: unknown = undefined;
	        const executedCallIds = new Set<string>();
	        const repeatedCallFingerprintCount = new Map<string, number>();

	        for (let round = 0; round < OPENAI_TOOL_LOOP_MAX_ROUNDS; round += 1) {
	          const r = useStreaming
	            ? await streamOpenAIResponse({
	                apiKey,
	                request: currentRequest,
	                signal: job.abortController.signal,
	                callbacks,
	              })
	            : await sendOpenAIResponse({
	                apiKey,
	                request: currentRequest,
	                signal: job.abortController.signal,
	              });

	          if (job.closed || job.abortController.signal.aborted) {
	            return { ok: false as const, text: job.fullText, error: 'Canceled', cancelled: true, response: r.response };
	          }
	          lastResponse = r.response;
	          if (!r.ok) return r;

	          const calls = extractOpenAIFunctionCalls(r.response);
	          if (calls.length === 0) return r;
	          const pendingCalls = calls.filter((call) => !executedCallIds.has(call.callId));
	          if (pendingCalls.length === 0) return r;

	          const responseId = extractOpenAIResponseId(r.response);
	          if (!responseId) {
	            return {
	              ok: false as const,
	              text: typeof r.text === 'string' ? r.text : job.fullText,
	              error: 'Tool call response is missing a response id.',
	              response: r.response,
	            };
	          }

	          const outputs: OpenAIFunctionCallOutput[] = [];
	          for (const call of pendingCalls) {
	            executedCallIds.add(call.callId);
	            const fingerprint = `${call.name}\n${call.argumentsJson.trim()}`;
	            const repeatCount = (repeatedCallFingerprintCount.get(fingerprint) ?? 0) + 1;
	            repeatedCallFingerprintCount.set(fingerprint, repeatCount);
	            if (repeatCount > OPENAI_TOOL_CALL_REPEAT_LIMIT) {
	              return {
	                ok: false as const,
	                text: typeof r.text === 'string' ? r.text : job.fullText,
	                error: `Model repeated the same tool call too many times (${OPENAI_TOOL_CALL_REPEAT_LIMIT}).`,
	                response: r.response,
	              };
	            }
	            const output = await executeOpenAILatexFunctionCall({ call, context: latexToolContext });
	            outputs.push({ callId: call.callId, output });
	          }
	          if (outputs.length === 0) return r;

	          currentRequest = buildOpenAIFunctionCallContinuationRequest({
	            baseRequest: request,
	            responseId,
	            outputs,
	          });
	          useStreaming = false;
	        }

	        return {
	          ok: false as const,
	          text: job.fullText,
	          error: `Exceeded tool call limit (${OPENAI_TOOL_LOOP_MAX_ROUNDS}).`,
	          response: lastResponse,
	        };
	      };

		      const res = latexToolLoopEnabled
	        ? await runOpenAILatexToolLoop()
	        : backgroundEnabled
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

  const startXaiGeneration = (args: {
    chatId: string;
    userNodeId: string;
    assistantNodeId: string;
    settings: XaiChatSettings;
    nodesOverride?: ChatNode[];
  }) => {
    const chatId = args.chatId;
    if (!chatId) return;
    if (generationJobsByAssistantIdRef.current.has(args.assistantNodeId)) return;

    const apiKey = getXaiApiKey();
    if (!apiKey) {
      const msg = 'xAI API key missing. Add it in Settings -> Models -> API keys or set XAI_API_KEY in .env.local.';
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
      let request: Record<string, unknown>;
      try {
        request = await buildXaiResponseRequest({
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
      const sentRequest: Record<string, unknown> = streamingEnabled ? { ...(request ?? {}), stream: true } : { ...(request ?? {}) };
      const include = Array.isArray((sentRequest as any).include) ? [...((sentRequest as any).include as unknown[])] : [];
      const hasEncryptedInclude = include.some((v) => String(v ?? '') === 'reasoning.encrypted_content');
      if (!hasEncryptedInclude) include.push('reasoning.encrypted_content');
      (sentRequest as any).include = include;
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

      const callbacks = {
        onDelta: (_delta: string, fullText: string) => {
          if (job.closed) return;
          job.fullText = fullText;
          scheduleJobFlush(job);
        },
        onEvent: (evt: any) => {
          if (job.closed) return;
          const t = typeof evt?.type === 'string' ? String(evt.type) : '';
          if (t === 'response.created') {
            const responseId = typeof evt?.response?.id === 'string' ? String(evt.response.id) : '';
            if (responseId) job.taskId = responseId;
          }
          const idxRaw =
            typeof evt?.summary_index === 'number'
              ? evt.summary_index
              : typeof evt?.index === 'number'
                ? evt.index
                : 0;
          const idx = Number.isFinite(Number(idxRaw)) ? Number(idxRaw) : 0;
          const isSummaryDelta =
            (t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning.summary.delta') &&
            typeof evt?.delta === 'string';
          const isSummaryDone =
            t === 'response.reasoning_summary_text.done' ||
            t === 'response.reasoning.summary.done' ||
            ((t.includes('reasoning') && t.includes('summary')) && typeof evt?.done === 'boolean' && evt.done === true);

          if (isSummaryDelta) {
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
          } else if (isSummaryDone) {
            const chunks = job.thinkingSummary ?? [];
            if (!chunks.length) return;
            const nextChunks = chunks.map((c) => (c.summaryIndex === idx ? { ...c, done: true } : c));
            job.thinkingSummary = nextChunks;
            updateStoredTextNode(chatId, job.assistantNodeId, { thinkingSummary: nextChunks });
            if (activeChatIdRef.current === chatId) {
              engineRef.current?.setTextNodeThinkingSummary(job.assistantNodeId, nextChunks);
            }
          }
        },
      };

      const res = streamingEnabled
        ? await streamXaiResponse({ apiKey, request: sentRequest, signal: job.abortController.signal, callbacks })
        : await sendXaiResponse({ apiKey, request: sentRequest, signal: job.abortController.signal });
      if (job.closed || job.abortController.signal.aborted) return;
      if (!generationJobsByAssistantIdRef.current.has(job.assistantNodeId)) return;

      const hasEncryptedReasoningObject = (raw: unknown): boolean => {
        if (!raw || typeof raw !== 'object') return false;
        const output = (raw as any).output;
        if (!Array.isArray(output)) return false;
        return output.some(
          (item: any) =>
            item &&
            item.type === 'reasoning' &&
            typeof item.encrypted_content === 'string' &&
            item.encrypted_content.length > 0,
        );
      };

      let finalResponse = res.response;
      const responseIdFromRaw = typeof (res.response as any)?.id === 'string' ? String((res.response as any).id) : '';
      const responseId = responseIdFromRaw || (typeof job.taskId === 'string' ? job.taskId : '');
      const shouldHydrateFinalResponse =
        streamingEnabled &&
        res.ok &&
        Boolean(responseId) &&
        (!Array.isArray((res.response as any)?.output) || !hasEncryptedReasoningObject(res.response));
      if (shouldHydrateFinalResponse) {
        const got = await retrieveXaiResponse({ apiKey, responseId, signal: job.abortController.signal });
        if (got.ok) finalResponse = got.response;
      }

      const usedWebSearch =
        Array.isArray((request as any)?.tools) && (request as any).tools.some((tool: any) => tool && tool.type === 'web_search');
      const baseCanonicalMeta = extractCanonicalMeta(finalResponse, { usedWebSearch });
      const streamed = job.thinkingSummary ?? [];
      const canonicalMeta = (() => {
        const hasBlocks = Array.isArray((baseCanonicalMeta as any)?.reasoningSummaryBlocks) && (baseCanonicalMeta as any).reasoningSummaryBlocks.length > 0;
        const withSummary = hasBlocks || streamed.length === 0
          ? baseCanonicalMeta
          : {
              ...(baseCanonicalMeta ?? {}),
              reasoningSummaryBlocks: [...streamed]
                .sort((a, b) => (a.summaryIndex ?? 0) - (b.summaryIndex ?? 0))
                .map((c) => ({ type: 'summary_text' as const, text: c?.text ?? '' })),
            };

        const usage = (finalResponse as any)?.usage;
        const reasoningTokensRaw =
          usage?.completion_tokens_details?.reasoning_tokens ??
          usage?.output_tokens_details?.reasoning_tokens ??
          usage?.reasoning_tokens;
        const reasoningTokens = Number.isFinite(Number(reasoningTokensRaw)) ? Number(reasoningTokensRaw) : undefined;
        const hasEncryptedReasoning = hasEncryptedReasoningObject(finalResponse);

        if (reasoningTokens === undefined && !hasEncryptedReasoning) return withSummary;
        return {
          ...(withSummary ?? {}),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
          ...(hasEncryptedReasoning ? { hasEncryptedReasoning: true } : {}),
        };
      })();
      const canonicalMessage = extractCanonicalMessage(
        finalResponse,
        typeof res.text === 'string' ? res.text : job.fullText,
      );
      const finalText = (typeof res.text === 'string' ? res.text : '') || canonicalMessage?.text || job.fullText || '';
      const storedResponse = finalResponse !== undefined ? cloneRawPayloadForDisplay(finalResponse) : undefined;

      let responseKey: string | undefined = undefined;
      if (finalResponse !== undefined) {
        try {
          const key = `${chatId}/${job.assistantNodeId}/res`;
          await putPayload({ key, json: finalResponse });
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
      const msg = 'Gemini API key missing. Add it in Settings -> Models -> API keys or set GEMINI_API_KEY in .env.local.';
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
    const streamingEnabled = typeof settings.stream === 'boolean' ? settings.stream : true;

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

      const callbacks = {
        onDelta: (_delta: string, fullText: string) => {
          if (job.closed) return;
          job.fullText = fullText;
          scheduleJobFlush(job);
        },
      };
      const res = streamingEnabled
        ? await streamGeminiResponse({ request, signal: job.abortController.signal, callbacks })
        : await sendGeminiResponse({ request, signal: job.abortController.signal });
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
        cancelled: res.cancelled,
        apiResponse: storedResponse,
        apiResponseKey: responseKey,
        canonicalMessage,
        canonicalMeta,
      });
    })();
  };

  const startAnthropicGeneration = (args: {
    chatId: string;
    userNodeId: string;
    assistantNodeId: string;
    settings: AnthropicChatSettings;
    nodesOverride?: ChatNode[];
  }) => {
    const chatId = args.chatId;
    if (!chatId) return;
    if (generationJobsByAssistantIdRef.current.has(args.assistantNodeId)) return;

    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      const msg = 'Anthropic API key missing. Add it in Settings -> Models -> API keys or set ANTHROPIC_API_KEY in .env.local.';
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
      let request: Record<string, unknown>;
      try {
        request = await buildAnthropicMessageRequest({
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
      const sentRequest = streamingEnabled ? { ...(request ?? {}), stream: true } : { ...(request ?? {}) };

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

	      const callbacks = {
	        onDelta: (_delta: string, fullText: string) => {
	          if (job.closed) return;
	          job.fullText = fullText;
	          scheduleJobFlush(job);
	        },
	        onEvent: (evt: any) => {
	          if (job.closed) return;

	          const t = typeof evt?.type === 'string' ? String(evt.type) : '';
	          if (t === 'content_block_start') {
	            const idx = typeof evt?.index === 'number' ? evt.index : 0;
	            const block = evt?.content_block;
	            if (block && typeof block === 'object' && block.type === 'thinking') {
	              const initial = typeof block?.thinking === 'string' ? block.thinking : '';
	              if (!initial) return;

	              const chunks = job.thinkingSummary ?? [];
	              const existing = chunks.find((c) => c.summaryIndex === idx);
	              const nextChunks: ThinkingSummaryChunk[] = existing
	                ? chunks.map((c) => (c.summaryIndex === idx ? { ...c, text: initial, done: false } : c))
	                : [...chunks, { summaryIndex: idx, text: initial, done: false }];
	              job.thinkingSummary = nextChunks;

	              updateStoredTextNode(chatId, job.assistantNodeId, { thinkingSummary: nextChunks });
	              if (activeChatIdRef.current === chatId) {
	                engineRef.current?.setTextNodeThinkingSummary(job.assistantNodeId, nextChunks);
	              }
	            }
	            return;
	          }

	          if (t !== 'content_block_delta') return;

	          const idx = typeof evt?.index === 'number' ? evt.index : 0;
	          const delta = evt?.delta;
	          const deltaType = typeof delta?.type === 'string' ? String(delta.type) : '';

	          if (deltaType === 'thinking_delta') {
	            const text = typeof delta?.thinking === 'string' ? delta.thinking : '';
	            if (!text) return;

	            const chunks = job.thinkingSummary ?? [];
	            const existing = chunks.find((c) => c.summaryIndex === idx);
	            const nextChunks: ThinkingSummaryChunk[] = existing
	              ? chunks.map((c) => (c.summaryIndex === idx ? { ...c, text: c.text + text } : c))
	              : [...chunks, { summaryIndex: idx, text, done: false }];
	            job.thinkingSummary = nextChunks;

	            updateStoredTextNode(chatId, job.assistantNodeId, { thinkingSummary: nextChunks });
	            if (activeChatIdRef.current === chatId) {
	              engineRef.current?.setTextNodeThinkingSummary(job.assistantNodeId, nextChunks);
	            }
	            return;
	          }

	          if (deltaType === 'signature_delta') {
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

      const res = streamingEnabled
        ? await streamAnthropicMessage({
            apiKey,
            request: sentRequest,
            signal: job.abortController.signal,
            callbacks,
          })
        : await sendAnthropicMessage({ apiKey, request: sentRequest, signal: job.abortController.signal });

      if (job.closed || job.abortController.signal.aborted) return;
      if (!generationJobsByAssistantIdRef.current.has(job.assistantNodeId)) return;

	      const finalText = (typeof res.text === 'string' ? res.text : '') || job.fullText;
	      const usedWebSearch = Boolean(job.llmParams?.webSearchEnabled);
	      const canonicalMessage =
	        finalText && finalText.trim() ? ({ role: 'assistant', text: finalText.trim() } as any) : undefined;
	      const canonicalMeta = (() => {
	        const base = { usedWebSearch } as any;
	        const chunksFromResponse = (() => {
	          if (job.thinkingSummary && job.thinkingSummary.length > 0) return job.thinkingSummary;
	          const raw = res.response;
	          if (!raw || typeof raw !== 'object') return [];
	          const content = Array.isArray((raw as any)?.content) ? ((raw as any).content as any[]) : [];
	          const out: ThinkingSummaryChunk[] = [];
	          for (let i = 0; i < content.length; i += 1) {
	            const block = content[i];
	            if (!block || typeof block !== 'object') continue;
	            if (block.type !== 'thinking') continue;
	            const text = typeof (block as any)?.thinking === 'string' ? (block as any).thinking : String((block as any)?.thinking ?? '');
	            if (!text.trim()) continue;
	            out.push({ summaryIndex: i, text, done: true });
	          }
	          return out;
	        })();

	        if (chunksFromResponse.length === 0) return base;
	        return {
	          ...base,
	          reasoningSummaryBlocks: [...chunksFromResponse]
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
	      const msg = 'OpenAI API key missing. Add it in Settings -> Models -> API keys or set OPENAI_API_KEY in .env.local.';
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
		        const provider = info?.provider ?? 'openai';
		        const msg =
		          provider === 'openai'
		            ? 'Interrupted (refresh). Enable Background mode to resume long-running requests.'
		            : 'Interrupted (refresh). Request cannot be resumed.';
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
    engine.setWheelInputPreference(wheelInputPreferenceRef.current);
    engine.setMouseClickRecenterEnabled(mouseClickRecenterEnabledRef.current);
    engine.setReplySpawnKind(replySpawnKindRef.current);
    lastEngineInteractingRef.current = null;
    engine.onDebug = (next) => {
      const nextInteracting = Boolean(next?.interacting);
      if (lastEngineInteractingRef.current === true && !nextInteracting && bootedRef.current) {
        schedulePersistSoon();
      }
      lastEngineInteractingRef.current = nextInteracting;
      if (debugBridgeEnabledRef.current) setDebug(next);
    };
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
        if (e.key === 'Backspace' && !engineRef.current.shouldDeleteSelectedNodeOnBackspace()) {
          e.preventDefault();
          return;
        }
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
  const editorTextFormat = ui.editingNodeId ? engineRef.current?.getTextNodeFormat(ui.editingNodeId) ?? 'markdown' : 'markdown';
  const editorUserPreface = ui.editingNodeId ? engineRef.current?.getTextNodeUserPreface(ui.editingNodeId) ?? null : null;
  const editorLatexState =
    ui.editingNodeId && editorTextFormat === 'latex'
      ? engineRef.current?.getTextNodeLatexState(ui.editingNodeId) ?? null
      : null;
  const editorLatexCompiledPdfKey =
    editorLatexState && typeof editorLatexState.compiledPdfStorageKey === 'string'
      ? editorLatexState.compiledPdfStorageKey.trim()
      : '';
  const editorLatexCompiledPdfUrls = useAttachmentObjectUrls(editorLatexCompiledPdfKey ? [editorLatexCompiledPdfKey] : []);
  const editorLatexCompiledPdfUrl = editorLatexCompiledPdfKey ? editorLatexCompiledPdfUrls[editorLatexCompiledPdfKey] ?? null : null;
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
    setActiveChatSystemInstructionOverride(
      typeof meta.systemInstructionOverride === 'string' ? meta.systemInstructionOverride : null,
    );
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
    setGlobalSystemInstruction(payload.llm.systemInstructionDefault);
    globalSystemInstructionRef.current = payload.llm.systemInstructionDefault;
    backgroundLibraryRef.current = payload.backgroundLibrary;
    setBackgroundLibrary(payload.backgroundLibrary);

    const chatIds = collectChatIds(root);
    const active = chatIds.includes(desiredActive) ? desiredActive : findFirstChatId(root) ?? desiredActive;
    const resolvedActive = active || (chatIds[0] ?? activeChatIdRef.current);

    const visual = payload.visual;
    glassNodesEnabledRef.current = Boolean(visual.glassNodesEnabled);
    glassNodesBlurCssPxWebglRef.current = Number.isFinite(visual.glassNodesBlurCssPxWebgl)
      ? visual.glassNodesBlurCssPxWebgl
      : DEFAULT_GLASS_BLUR_CSS_PX_WEBGL;
    glassNodesSaturatePctWebglRef.current = Number.isFinite(visual.glassNodesSaturatePctWebgl)
      ? visual.glassNodesSaturatePctWebgl
      : DEFAULT_GLASS_SATURATE_PCT_WEBGL;
    glassNodesBlurCssPxCanvasRef.current = Number.isFinite(visual.glassNodesBlurCssPxCanvas)
      ? visual.glassNodesBlurCssPxCanvas
      : DEFAULT_GLASS_BLUR_CSS_PX_CANVAS;
    glassNodesSaturatePctCanvasRef.current = Number.isFinite(visual.glassNodesSaturatePctCanvas)
      ? visual.glassNodesSaturatePctCanvas
      : DEFAULT_GLASS_SATURATE_PCT_CANVAS;
    uiGlassBlurCssPxWebglRef.current = Number.isFinite(visual.uiGlassBlurCssPxWebgl)
      ? visual.uiGlassBlurCssPxWebgl
      : DEFAULT_UI_GLASS_BLUR_CSS_PX_WEBGL;
    uiGlassSaturatePctWebglRef.current = Number.isFinite(visual.uiGlassSaturatePctWebgl)
      ? visual.uiGlassSaturatePctWebgl
      : DEFAULT_UI_GLASS_SATURATE_PCT_WEBGL;
    glassNodesUnderlayAlphaRef.current = Number.isFinite(visual.glassNodesUnderlayAlpha)
      ? visual.glassNodesUnderlayAlpha
      : DEFAULT_GLASS_UNDERLAY_ALPHA;
    glassNodesBlurBackendRef.current = visual.glassNodesBlurBackend === 'canvas' ? 'canvas' : DEFAULT_GLASS_BLUR_BACKEND;
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
    wheelInputPreferenceRef.current = normalizeWheelInputPreference(
      visual.wheelInputPreference,
      DEFAULT_WHEEL_INPUT_PREFERENCE,
    );
    mouseClickRecenterEnabledRef.current = Boolean(
      visual.mouseClickRecenterEnabled ?? DEFAULT_MOUSE_CLICK_RECENTER_ENABLED,
    );
    setSpawnEditNodeByDraw(spawnEditNodeByDrawRef.current);
    setSpawnInkNodeByDraw(spawnInkNodeByDrawRef.current);
    setWheelInputPreference(wheelInputPreferenceRef.current);
    setMouseClickRecenterEnabled(mouseClickRecenterEnabledRef.current);
    inkSendCropEnabledRef.current = Boolean(visual.inkSendCropEnabled);
    inkSendCropPaddingPxRef.current = clampNumber(visual.inkSendCropPaddingPx, 0, 200, 24);
    inkSendDownscaleEnabledRef.current = Boolean(visual.inkSendDownscaleEnabled);
    inkSendMaxPixelsRef.current = clampNumber(visual.inkSendMaxPixels, 100_000, 40_000_000, 6_000_000);
    inkSendMaxDimPxRef.current = clampNumber(visual.inkSendMaxDimPx, 256, 8192, 4096);
    sendAllEnabledRef.current = Boolean(visual.sendAllEnabled);
    sendAllComposerEnabledRef.current = Boolean(visual.sendAllComposerEnabled);
    sendAllModelIdsRef.current = normalizeSendAllModelIds(visual.sendAllModelIds, allModelIds);
    cleanupChatFoldersOnDeleteRef.current = Boolean(visual.cleanupChatFoldersOnDelete);
    sendAllModelIdsInitializedRef.current = true;
    setInkSendCropEnabled(inkSendCropEnabledRef.current);
    setInkSendCropPaddingPx(inkSendCropPaddingPxRef.current);
    setInkSendDownscaleEnabled(inkSendDownscaleEnabledRef.current);
    setInkSendMaxPixels(inkSendMaxPixelsRef.current);
    setInkSendMaxDimPx(inkSendMaxDimPxRef.current);
    setSendAllEnabled(sendAllEnabledRef.current);
    setSendAllComposerEnabled(sendAllComposerEnabledRef.current);
    setSendAllModelIds(sendAllModelIdsRef.current);
    setCleanupChatFoldersOnDelete(cleanupChatFoldersOnDeleteRef.current);

    bootedRef.current = true;
    setActiveChatId(resolvedActive);

    const engine = engineRef.current;
    if (engine) {
      const blurBackend = glassNodesBlurBackendRef.current === 'canvas' ? 'canvas' : DEFAULT_GLASS_BLUR_BACKEND;
      const blurCssPx =
        blurBackend === 'canvas' ? glassNodesBlurCssPxCanvasRef.current : glassNodesBlurCssPxWebglRef.current;
      const saturatePct =
        blurBackend === 'canvas' ? glassNodesSaturatePctCanvasRef.current : glassNodesSaturatePctWebglRef.current;
      engine.setGlassNodesEnabled(glassNodesEnabledRef.current);
      engine.setGlassNodesBlurBackend(blurBackend);
      engine.setGlassNodesBlurCssPx(
        Number.isFinite(blurCssPx)
          ? Math.max(0, Math.min(30, blurCssPx))
          : blurBackend === 'canvas'
            ? DEFAULT_GLASS_BLUR_CSS_PX_CANVAS
            : DEFAULT_GLASS_BLUR_CSS_PX_WEBGL,
      );
      engine.setGlassNodesSaturatePct(
        Number.isFinite(saturatePct)
          ? Math.max(100, Math.min(200, saturatePct))
          : blurBackend === 'canvas'
            ? DEFAULT_GLASS_SATURATE_PCT_CANVAS
            : DEFAULT_GLASS_SATURATE_PCT_WEBGL,
      );
      engine.setGlassNodesUnderlayAlpha(glassNodesUnderlayAlphaRef.current);
      engine.setEdgeRouter(edgeRouterIdRef.current);
      engine.setReplyArrowColor(replyArrowColorRef.current);
      engine.setReplyArrowOpacity(replyArrowOpacityRef.current);
      engine.setNodeTextFontFamily(fontFamilyCss(nodeFontFamilyRef.current));
      engine.setNodeTextFontSizePx(nodeFontSizePxRef.current);
      engine.setSpawnEditNodeByDrawEnabled(spawnEditNodeByDrawRef.current);
      engine.setSpawnInkNodeByDrawEnabled(spawnInkNodeByDrawRef.current);
      engine.setWheelInputPreference(wheelInputPreferenceRef.current);
      engine.setMouseClickRecenterEnabled(mouseClickRecenterEnabledRef.current);
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
    setActiveChatSystemInstructionOverride(
      typeof meta.systemInstructionOverride === 'string' ? meta.systemInstructionOverride : null,
    );

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
                : DEFAULT_GLASS_BLUR_CSS_PX_WEBGL,
              glassNodesSaturatePct: Number.isFinite(Number(raw?.glassNodesSaturatePct))
                ? Math.max(100, Math.min(200, Number(raw.glassNodesSaturatePct)))
                : DEFAULT_GLASS_SATURATE_PCT_WEBGL,
              glassNodesUnderlayAlpha: Number.isFinite(Number(raw?.glassNodesUnderlayAlpha))
                ? Math.max(0, Math.min(1, Number(raw.glassNodesUnderlayAlpha)))
                : DEFAULT_GLASS_UNDERLAY_ALPHA,
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
            systemInstructionOverride: typeof raw?.systemInstructionOverride === 'string' ? raw.systemInstructionOverride : null,
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
      const glassNodesBlurBackend: GlassBlurBackend =
        visualSrc?.glassNodesBlurBackend === 'canvas' ? 'canvas' : DEFAULT_GLASS_BLUR_BACKEND;
      const legacyBlurCssPxRaw = Number((visualSrc as any)?.glassNodesBlurCssPx);
      const legacySaturatePctRaw = Number((visualSrc as any)?.glassNodesSaturatePct);
      const fallbackBlurCssPx = Number.isFinite(legacyBlurCssPxRaw)
        ? Math.max(0, Math.min(30, legacyBlurCssPxRaw))
        : glassNodesBlurBackend === 'canvas'
          ? DEFAULT_GLASS_BLUR_CSS_PX_CANVAS
          : DEFAULT_GLASS_BLUR_CSS_PX_WEBGL;
      const fallbackSaturatePct = Number.isFinite(legacySaturatePctRaw)
        ? Math.max(100, Math.min(200, legacySaturatePctRaw))
        : glassNodesBlurBackend === 'canvas'
          ? DEFAULT_GLASS_SATURATE_PCT_CANVAS
          : DEFAULT_GLASS_SATURATE_PCT_WEBGL;
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
        : DEFAULT_UI_GLASS_BLUR_CSS_PX_WEBGL;
      const uiGlassSaturatePctWebgl = Number.isFinite(uiSaturatePctWebglRaw)
        ? Math.max(100, Math.min(200, uiSaturatePctWebglRaw))
        : DEFAULT_UI_GLASS_SATURATE_PCT_WEBGL;
      const visual = {
        glassNodesEnabled:
          typeof (visualSrc as any)?.glassNodesEnabled === 'boolean'
            ? Boolean((visualSrc as any).glassNodesEnabled)
            : DEFAULT_GLASS_NODES_ENABLED,
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
          : DEFAULT_GLASS_UNDERLAY_ALPHA,
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
        spawnEditNodeByDraw:
          typeof (visualSrc as any)?.spawnEditNodeByDraw === 'boolean'
            ? Boolean((visualSrc as any).spawnEditNodeByDraw)
            : DEFAULT_SPAWN_EDIT_NODE_BY_DRAW,
        spawnInkNodeByDraw:
          typeof (visualSrc as any)?.spawnInkNodeByDraw === 'boolean'
            ? Boolean((visualSrc as any).spawnInkNodeByDraw)
            : DEFAULT_SPAWN_INK_NODE_BY_DRAW,
        wheelInputPreference: normalizeWheelInputPreference(
          (visualSrc as any)?.wheelInputPreference,
          DEFAULT_WHEEL_INPUT_PREFERENCE,
        ),
        mouseClickRecenterEnabled:
          typeof (visualSrc as any)?.mouseClickRecenterEnabled === 'boolean'
            ? Boolean((visualSrc as any).mouseClickRecenterEnabled)
            : DEFAULT_MOUSE_CLICK_RECENTER_ENABLED,
        inkSendCropEnabled:
          typeof (visualSrc as any)?.inkSendCropEnabled === 'boolean'
            ? Boolean((visualSrc as any).inkSendCropEnabled)
            : DEFAULT_INK_SEND_CROP_ENABLED,
        inkSendCropPaddingPx: clampNumber((visualSrc as any)?.inkSendCropPaddingPx, 0, 200, 24),
        inkSendDownscaleEnabled:
          typeof (visualSrc as any)?.inkSendDownscaleEnabled === 'boolean'
            ? Boolean((visualSrc as any).inkSendDownscaleEnabled)
            : DEFAULT_INK_SEND_DOWNSCALE_ENABLED,
        inkSendMaxPixels: clampNumber((visualSrc as any)?.inkSendMaxPixels, 100_000, 40_000_000, 6_000_000),
        inkSendMaxDimPx: clampNumber((visualSrc as any)?.inkSendMaxDimPx, 256, 8192, 4096),
        sendAllEnabled:
          typeof (visualSrc as any)?.sendAllEnabled === 'boolean'
            ? Boolean((visualSrc as any).sendAllEnabled)
            : DEFAULT_SEND_ALL_ENABLED,
        sendAllComposerEnabled:
          typeof (visualSrc as any)?.sendAllComposerEnabled === 'boolean'
            ? Boolean((visualSrc as any).sendAllComposerEnabled)
            : DEFAULT_SEND_ALL_COMPOSER_ENABLED,
        sendAllModelIds:
          (visualSrc as any)?.sendAllModelIds === undefined
            ? allModelIds.slice()
            : normalizeSendAllModelIds((visualSrc as any)?.sendAllModelIds, allModelIds),
        cleanupChatFoldersOnDelete:
          typeof (visualSrc as any)?.cleanupChatFoldersOnDelete === 'boolean'
            ? Boolean((visualSrc as any).cleanupChatFoldersOnDelete)
            : DEFAULT_CLEANUP_CHAT_FOLDERS_ON_DELETE,
      };

      const modelUserSettings = buildModelUserSettings(allModels, ws.llm?.modelUserSettings);
      const systemInstructionDefault = normalizeSystemInstruction(
        (ws.llm as any)?.systemInstructionDefault,
        DEFAULT_SYSTEM_INSTRUCTIONS,
      );

      const payload = {
        root,
        activeChatId: desiredActiveChatId,
        focusedFolderId: typeof ws.focusedFolderId === 'string' ? ws.focusedFolderId : root.id,
        backgroundLibrary,
        llm: {
          modelUserSettings,
          systemInstructionDefault,
        },
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
  }, [allModelIds, allModels, schedulePersistSoon]);

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
      systemInstructionOverride: null,
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
    if (cleanupChatFoldersOnDeleteRef.current && removedChatIds.length > 0) {
      void (async () => {
        let failed = 0;
        let firstError = '';
        for (const chatId of removedChatIds) {
          try {
            await deleteChatStorageFolder(chatId);
          } catch (err: any) {
            failed += 1;
            if (!firstError) firstError = String(err?.message || err || '');
          }
        }
        if (failed > 0) {
          const suffix = firstError ? ` ${firstError}` : '';
          showToast(`Failed to delete ${failed} chat folder${failed === 1 ? '' : 's'}.${suffix}`, 'error');
        }
      })();
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
          systemInstructionOverride: null,
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

  const canOpenStorageFolder = Boolean(
    typeof window !== 'undefined' &&
      typeof (window as any)?.gcElectron?.storageOpenDataDir === 'function',
  );
  const canManageStorageLocation = Boolean(
    typeof window !== 'undefined' &&
      typeof (window as any)?.gcElectron?.storageGetDataDirInfo === 'function' &&
      typeof (window as any)?.gcElectron?.storageChooseDataDir === 'function' &&
      typeof (window as any)?.gcElectron?.storageResetDataDir === 'function',
  );

  const refreshStorageDataDirInfo = () => {
    const api = (window as any)?.gcElectron;
    if (!api || typeof api.storageGetDataDirInfo !== 'function') {
      setStorageDataDirInfo(null);
      return;
    }
    void (async () => {
      try {
        const res = await api.storageGetDataDirInfo();
        if (!res?.ok) return;
        const pathValue = String(res?.path ?? '').trim();
        const defaultPathValue = String(res?.defaultPath ?? '').trim();
        if (!pathValue || !defaultPathValue) return;
        setStorageDataDirInfo({
          path: pathValue,
          defaultPath: defaultPathValue,
          isDefault: Boolean(res?.isDefault),
        });
      } catch {
        // ignore
      }
    })();
  };

  useEffect(() => {
    if (!settingsOpen || settingsPanel !== 'data') return;
    refreshStorageDataDirInfo();
  }, [settingsOpen, settingsPanel]);

  const openStorageFolder = () => {
    const api = (window as any)?.gcElectron;
    if (!api || typeof api.storageOpenDataDir !== 'function') {
      showToast('Open storage folder is only available in Electron desktop mode.', 'info');
      return;
    }
    void (async () => {
      try {
        const res = await api.storageOpenDataDir();
        if (!res?.ok) {
          showToast(`Failed to open storage folder: ${String(res?.error ?? 'unknown error')}`, 'error');
        }
      } catch (err: any) {
        showToast(`Failed to open storage folder: ${err?.message || String(err)}`, 'error');
      }
    })();
  };

  const chooseStorageLocation = () => {
    const api = (window as any)?.gcElectron;
    if (!api || typeof api.storageChooseDataDir !== 'function') {
      showToast('Storage location changes are only available in Electron desktop mode.', 'info');
      return;
    }
    const moveExisting = window.confirm(
      'Move existing chat data to the new location?\n\nPress OK to move existing data.\nPress Cancel to switch location without moving existing files.',
    );
    void (async () => {
      try {
        const res = await api.storageChooseDataDir({ moveExisting });
        if (!res?.ok) {
          if (res?.canceled) return;
          showToast(`Failed to change storage location: ${String(res?.error ?? 'unknown error')}`, 'error');
          return;
        }
        const pathValue = String(res?.path ?? '').trim();
        const defaultPathValue = String(res?.defaultPath ?? '').trim();
        if (pathValue && defaultPathValue) {
          setStorageDataDirInfo({
            path: pathValue,
            defaultPath: defaultPathValue,
            isDefault: Boolean(res?.isDefault),
          });
        } else {
          refreshStorageDataDirInfo();
        }
        showToast(
          moveExisting ? 'Storage location updated and existing data was moved.' : 'Storage location updated.',
          'success',
        );
      } catch (err: any) {
        showToast(`Failed to change storage location: ${err?.message || String(err)}`, 'error');
      }
    })();
  };

  const resetStorageLocation = () => {
    const api = (window as any)?.gcElectron;
    if (!api || typeof api.storageResetDataDir !== 'function') {
      showToast('Storage location changes are only available in Electron desktop mode.', 'info');
      return;
    }
    const moveExisting = window.confirm(
      'Move existing chat data back to the default location?\n\nPress OK to move existing data.\nPress Cancel to switch location without moving existing files.',
    );
    void (async () => {
      try {
        const res = await api.storageResetDataDir({ moveExisting });
        if (!res?.ok) {
          showToast(`Failed to reset storage location: ${String(res?.error ?? 'unknown error')}`, 'error');
          return;
        }
        const pathValue = String(res?.path ?? '').trim();
        const defaultPathValue = String(res?.defaultPath ?? '').trim();
        if (pathValue && defaultPathValue) {
          setStorageDataDirInfo({
            path: pathValue,
            defaultPath: defaultPathValue,
            isDefault: Boolean(res?.isDefault),
          });
        } else {
          refreshStorageDataDirInfo();
        }
        showToast(
          moveExisting ? 'Storage location reset and existing data was moved.' : 'Storage location reset.',
          'success',
        );
      } catch (err: any) {
        showToast(`Failed to reset storage location: ${err?.message || String(err)}`, 'error');
      }
    })();
  };

  useEffect(() => {
    if (!settingsOpen || settingsPanel !== 'models') return;
    setRuntimeApiKeys(getRuntimeApiKeys());
  }, [settingsOpen, settingsPanel]);

  const saveRuntimeProviderApiKey = (provider: RuntimeApiProvider, value: string) => {
    const next = setRuntimeApiKey(provider, value);
    setRuntimeApiKeys(next);
    const label = API_PROVIDER_LABELS[provider];
    showToast(`${label} API key saved.`, 'success');
  };

  const clearRuntimeProviderApiKey = (provider: RuntimeApiProvider) => {
    const next = clearRuntimeApiKey(provider);
    setRuntimeApiKeys(next);
    const label = API_PROVIDER_LABELS[provider];
    showToast(`${label} API key cleared.`, 'info');
  };

  useEffect(() => {
    const api = (window as any)?.gcElectron;
    if (!api || typeof api.latexToolchainStatus !== 'function') return;
    let canceled = false;
    void (async () => {
      try {
        const res = await api.latexToolchainStatus();
        if (canceled || !res?.ok) return;
        const missing: string[] = [];
        if (!res?.latexmk) missing.push('latexmk');
        if (!res?.synctex) missing.push('synctex');
        if (!missing.length) return;
        const installHint =
          navigator.platform.toLowerCase().includes('mac')
            ? 'Install MacTeX and restart the app.'
            : navigator.platform.toLowerCase().includes('win')
              ? 'Install MiKTeX or TeX Live and restart the app.'
              : 'Install a TeX distribution that provides latexmk and synctex, then restart the app.';
        showToast(`LaTeX tools missing: ${missing.join(', ')}. ${installHint}`, 'info', 12000);
      } catch {
        // ignore
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  const sendTurn = (args: SendTurnArgs): { chatId: string; userNodeId: string; assistantNodeId: string } | null => {
    const engine = engineRef.current;
    if (!engine) return null;

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

    if (!raw.trim() && composerDraftAttachments.length === 0 && !hasPreface) return null;

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
    const systemInstruction = resolveSystemInstructionForChat(chatId);

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
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: GeminiChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        stream: modelSettings?.streaming,
        systemInstruction,
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
    } else if (provider === 'anthropic') {
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: AnthropicChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        stream: modelSettings?.streaming,
        maxTokens: modelSettings?.maxTokens,
        effort: modelSettings?.anthropicEffort,
        systemInstruction,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startAnthropicGeneration({
        chatId,
        userNodeId: res.userNodeId,
        assistantNodeId: res.assistantNodeId,
        settings,
      });
    } else if (provider === 'xai') {
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: XaiChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        stream: modelSettings?.streaming,
        systemInstruction,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startXaiGeneration({
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
        systemInstruction,
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
    return { chatId, userNodeId: res.userNodeId, assistantNodeId: res.assistantNodeId };
  };

  const sendInkTurn = (args: {
    strokes: InkStroke[];
    viewport?: { w: number; h: number } | null;
    modelIdOverride?: string | null;
  }): { chatId: string; userNodeId: string; assistantNodeId: string } | null => {
    const engine = engineRef.current;
    if (!engine) return null;

    const rawStrokes = Array.isArray(args.strokes) ? args.strokes : [];
    if (rawStrokes.length === 0) {
      showToast('Nothing to send: ink is empty.', 'error');
      return null;
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
      return null;
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
      return null;
    }

    const chatId = activeChatIdRef.current;
    const meta = ensureChatMeta(chatId);
    const systemInstruction = resolveSystemInstructionForChat(chatId);

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
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: GeminiChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        stream: modelSettings?.streaming,
        systemInstruction,
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
    } else if (provider === 'anthropic') {
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: AnthropicChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        stream: modelSettings?.streaming,
        maxTokens: modelSettings?.maxTokens,
        effort: modelSettings?.anthropicEffort,
        systemInstruction,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startAnthropicGeneration({
        chatId,
        userNodeId: res.userNodeId,
        assistantNodeId: res.assistantNodeId,
        settings,
      });
    } else if (provider === 'xai') {
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: XaiChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        stream: modelSettings?.streaming,
        systemInstruction,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startXaiGeneration({
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
        systemInstruction,
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
    return { chatId, userNodeId: res.userNodeId, assistantNodeId: res.assistantNodeId };
  };

  const sendAssistantTurnFromUserNode = (args: {
    userNodeId: string;
    modelIdOverride?: string | null;
    assistantRect?: Rect | null;
    liveDraftOverride?: string | null;
    clearComposerText?: boolean;
  }): { chatId: string; assistantNodeId: string } | null => {
    const engine = engineRef.current;
    if (!engine) return null;

    const userNodeId = String(args.userNodeId ?? '').trim();
    if (!userNodeId) return null;
    contextTargetEditNodeIdRef.current = userNodeId;

    const chatId = activeChatIdRef.current;
    const meta = ensureChatMeta(chatId);
    const systemInstruction = resolveSystemInstructionForChat(chatId);

    const composerContextTexts = (contextSelections ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);

    const selectedModelId = String(args.modelIdOverride || composerModelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
    const assistantTitle = (() => {
      const info = getModelInfo(selectedModelId);
      const shortLabel = typeof info?.shortLabel === 'string' ? info.shortLabel.trim() : '';
      if (shortLabel) return shortLabel;
      const label = typeof info?.label === 'string' ? info.label.trim() : '';
      return label || 'Assistant';
    })();

    const activeEditingNodeId = engine.getUiState().editingNodeId;
    if (activeEditingNodeId === userNodeId) {
      const liveDraft =
        typeof args.liveDraftOverride === 'string'
          ? args.liveDraftOverride
          : editingDraftByNodeIdRef.current.get(userNodeId);
      if (typeof liveDraft === 'string') {
        engine.setEditingText(liveDraft);
      }
    }

    const preSnapshot = engine.exportChatState();
    const leafNode = preSnapshot.nodes.find((n) => n.id === userNodeId) ?? null;
    if (!leafNode) return null;

    if (leafNode.kind === 'ink') {
      const strokes = Array.isArray((leafNode as any).strokes) ? ((leafNode as any).strokes as any[]) : [];
      if (strokes.length === 0) {
        showToast('Nothing to send: ink node is empty.', 'error');
        return null;
      }

      const modelInfo = getModelInfo(selectedModelId);
      if (modelInfo && modelInfo.supportsImageInput === false) {
        showToast('Selected model does not support image input.', 'error');
        return null;
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
      if (!res) return null;

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
        const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
        const settings: GeminiChatSettings = {
          modelId: selectedModelId,
          webSearchEnabled: composerWebSearch,
          stream: modelSettings?.streaming,
          systemInstruction,
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
      } else if (provider === 'anthropic') {
        const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
        const settings: AnthropicChatSettings = {
          modelId: selectedModelId,
          webSearchEnabled: composerWebSearch,
          stream: modelSettings?.streaming,
          maxTokens: modelSettings?.maxTokens,
          effort: modelSettings?.anthropicEffort,
          systemInstruction,
          inkExport: {
            cropEnabled: inkSendCropEnabledRef.current,
            cropPaddingPx: inkSendCropPaddingPxRef.current,
            downscaleEnabled: inkSendDownscaleEnabledRef.current,
            maxPixels: inkSendMaxPixelsRef.current,
            maxDimPx: inkSendMaxDimPxRef.current,
          },
        };
        startAnthropicGeneration({
          chatId,
          userNodeId,
          assistantNodeId: res.assistantNodeId,
          settings,
        });
      } else if (provider === 'xai') {
        const modelSettings =
          modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
        const settings: XaiChatSettings = {
          modelId: selectedModelId,
          webSearchEnabled: composerWebSearch,
          stream: modelSettings?.streaming,
          systemInstruction,
          inkExport: {
            cropEnabled: inkSendCropEnabledRef.current,
            cropPaddingPx: inkSendCropPaddingPxRef.current,
            downscaleEnabled: inkSendDownscaleEnabledRef.current,
            maxPixels: inkSendMaxPixelsRef.current,
            maxDimPx: inkSendMaxDimPxRef.current,
          },
        };
        startXaiGeneration({
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
          systemInstruction,
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
      return { chatId, assistantNodeId: res.assistantNodeId };
    }

    if (leafNode.kind !== 'text') return null;
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

    if (!userText.trim() && composerDraftAttachments.length === 0 && !hasPreface) return null;

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
    if (!res) return null;

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
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: GeminiChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        stream: modelSettings?.streaming,
        systemInstruction,
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
    } else if (provider === 'anthropic') {
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: AnthropicChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        stream: modelSettings?.streaming,
        maxTokens: modelSettings?.maxTokens,
        effort: modelSettings?.anthropicEffort,
        systemInstruction,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startAnthropicGeneration({
        chatId,
        userNodeId,
        assistantNodeId: res.assistantNodeId,
        settings,
        nodesOverride,
      });
    } else if (provider === 'xai') {
      const modelSettings = modelUserSettingsRef.current[selectedModelId] ?? modelUserSettingsRef.current[DEFAULT_MODEL_ID];
      const settings: XaiChatSettings = {
        modelId: selectedModelId,
        webSearchEnabled: composerWebSearch,
        stream: modelSettings?.streaming,
        systemInstruction,
        inkExport: {
          cropEnabled: inkSendCropEnabledRef.current,
          cropPaddingPx: inkSendCropPaddingPxRef.current,
          downscaleEnabled: inkSendDownscaleEnabledRef.current,
          maxPixels: inkSendMaxPixelsRef.current,
          maxDimPx: inkSendMaxDimPxRef.current,
        },
      };
      startXaiGeneration({
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
        systemInstruction,
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
    return { chatId, assistantNodeId: res.assistantNodeId };
  };

  const resolveComposerSendModelIds = React.useCallback((): string[] => {
    const fallback = String(composerModelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
    if (!sendAllEnabled || !sendAllComposerEnabled) return [fallback];
    const allowed = new Set(allModelIds);
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const raw of sendAllModelIds) {
      const id = String(raw ?? '').trim();
      if (!id || !allowed.has(id) || seen.has(id)) continue;
      seen.add(id);
      picked.push(id);
    }
    if (picked.length === 0) return [fallback];
    return picked;
  }, [allModelIds, composerModelId, sendAllComposerEnabled, sendAllEnabled, sendAllModelIds]);

  const resolveSymmetricAssistantRects = React.useCallback((args: {
    chatId: string;
    userNodeId: string;
    firstAssistantNodeId: string;
    count: number;
  }): Array<Rect | null> => {
    const count = Math.max(0, Math.floor(args.count));
    if (count <= 0) return [];

    const state = chatStatesRef.current.get(args.chatId);
    if (!state) return new Array(count).fill(null);
    const userNode =
      state.nodes.find(
        (n): n is Extract<ChatNode, { kind: 'text' }> | Extract<ChatNode, { kind: 'ink' }> =>
          (n.kind === 'text' || n.kind === 'ink') && n.id === args.userNodeId,
      ) ?? null;
    const firstAssistantNode =
      state.nodes.find(
        (n): n is Extract<ChatNode, { kind: 'text' }> =>
          n.kind === 'text' && n.id === args.firstAssistantNodeId,
      ) ?? null;
    if (!userNode || !firstAssistantNode) return new Array(count).fill(null);

    const baseRect = firstAssistantNode.rect;
    const baseW = Number.isFinite(baseRect.w) ? baseRect.w : 0;
    const baseH = Number.isFinite(baseRect.h) ? baseRect.h : 0;
    const userCenterX = userNode.rect.x + userNode.rect.w * 0.5;
    const laneStep = Math.max(MULTI_SEND_ASSISTANT_MAX_W_PX, baseW) + MULTI_SEND_ASSISTANT_GAP_X_PX;
    const centerOffset = (count - 1) * 0.5;
    return new Array(count).fill(null).map((_v, index) => ({
      x: userCenterX - baseW * 0.5 + (index - centerOffset) * laneStep,
      y: baseRect.y,
      w: baseW,
      h: baseH,
    }));
  }, []);

  const applyAssistantRects = React.useCallback((args: {
    chatId: string;
    assistantNodeIds: string[];
    rects: Array<Rect | null>;
  }) => {
    const engine = engineRef.current;
    if (!engine) return;
    const zoom = Math.max(0.001, Number(engine.camera.zoom) || 1);

    const count = Math.min(args.assistantNodeIds.length, args.rects.length);
    for (let i = 0; i < count; i += 1) {
      const nodeId = String(args.assistantNodeIds[i] ?? '').trim();
      const rect = args.rects[i];
      if (!nodeId || !rect) continue;
      const screenRect: Rect = {
        x: (rect.x - engine.camera.x) * zoom,
        y: (rect.y - engine.camera.y) * zoom,
        w: rect.w * zoom,
        h: rect.h * zoom,
      };
      engine.setNodeScreenRect(nodeId, screenRect);
    }

    chatStatesRef.current.set(args.chatId, engine.exportChatState());
    schedulePersistSoon();
  }, [schedulePersistSoon]);

  const applyComposerModelSelection = React.useCallback(
    (nextModelId: string) => {
      const value = String(nextModelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
      setComposerModelId(value);
      ensureChatMeta(activeChatIdRef.current).llm.modelId = value;
    },
    [ensureChatMeta],
  );

  const clearEditNodeSendModelPreview = React.useCallback(() => {
    engineRef.current?.clearExternalHeaderPlacementPreview();
  }, []);

  const closeEditNodeSendMenu = React.useCallback(() => {
    editNodeSendModelDragRef.current = null;
    setEditNodeSendMenuPointerLock(false);
    clearEditNodeSendModelPreview();
    setEditNodeSendMenuId(null);
  }, [clearEditNodeSendModelPreview]);

  const beginEditNodeSendModelDrag = React.useCallback((e: React.PointerEvent<HTMLButtonElement>, nodeId: string, modelId: string) => {
    if (e.button !== 0) return;
    const id = String(nodeId ?? '').trim();
    const mid = String(modelId ?? '').trim();
    if (!id || !mid) return;
    e.preventDefault();
    e.stopPropagation();
    editNodeSendModelDragRef.current = {
      pointerId: e.pointerId,
      nodeId: id,
      modelId: mid,
      startClient: { x: e.clientX, y: e.clientY },
      lastClient: { x: e.clientX, y: e.clientY },
      moved: false,
    };
    setEditNodeSendMenuPointerLock(true);
    clearEditNodeSendModelPreview();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, [clearEditNodeSendModelPreview]);

  const onEditNodeSendModelDragPointerMove = React.useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const active = editNodeSendModelDragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;

    active.lastClient = { x: e.clientX, y: e.clientY };
    if (!active.moved) {
      const dx = active.lastClient.x - active.startClient.x;
      const dy = active.lastClient.y - active.startClient.y;
      if (dx * dx + dy * dy >= 16) active.moved = true;
    }

    if (!active.moved) {
      clearEditNodeSendModelPreview();
      return;
    }

    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) {
      clearEditNodeSendModelPreview();
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const screenX = active.lastClient.x - canvasRect.left;
    const screenY = active.lastClient.y - canvasRect.top;
    engine.setExternalHeaderPlacementPreview(active.nodeId, { x: screenX, y: screenY });
    e.preventDefault();
    e.stopPropagation();
  }, [clearEditNodeSendModelPreview]);

  const onEditNodeSendModelDragPointerUp = React.useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const active = editNodeSendModelDragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    editNodeSendModelDragRef.current = null;
    setEditNodeSendMenuPointerLock(false);
    clearEditNodeSendModelPreview();

    active.lastClient = { x: e.clientX, y: e.clientY };
    if (!active.moved) {
      e.preventDefault();
      e.stopPropagation();
      setEditNodeSendMenuId(null);
      applyComposerModelSelection(active.modelId);
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    setEditNodeSendMenuId(null);

    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;

    const canvasRect = canvas.getBoundingClientRect();
    const screenX = active.lastClient.x - canvasRect.left;
    const screenY = active.lastClient.y - canvasRect.top;

    const nodeScreenRect = engine.getNodeScreenRect(active.nodeId);
    const inside = Boolean(
      nodeScreenRect &&
        screenX >= nodeScreenRect.x &&
        screenX <= nodeScreenRect.x + nodeScreenRect.w &&
        screenY >= nodeScreenRect.y &&
        screenY <= nodeScreenRect.y + nodeScreenRect.h,
    );
    if (inside) return;

    const assistantRect = engine.getNodeSendAssistantSpawnRectAtScreen(active.nodeId, { x: screenX, y: screenY });
    setPendingEditNodeSend({ nodeId: active.nodeId, modelIdOverride: active.modelId, assistantRect: assistantRect ?? null });
  }, [clearEditNodeSendModelPreview]);

  const onEditNodeSendModelDragPointerCancel = React.useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const active = editNodeSendModelDragRef.current;
    if (!active || active.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    editNodeSendModelDragRef.current = null;
    setEditNodeSendMenuPointerLock(false);
    clearEditNodeSendModelPreview();
    if (active.moved) return;
  }, [clearEditNodeSendModelPreview]);

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
    const estimatedWidth = EDIT_NODE_SEND_MODEL_MENU_WIDTH;
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
      editNodeSendModelDragRef.current = null;
      setEditNodeSendMenuPointerLock(false);
      clearEditNodeSendModelPreview();
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
      editNodeSendModelDragRef.current = null;
      setEditNodeSendMenuPointerLock(false);
      clearEditNodeSendModelPreview();
    };
  }, [clearEditNodeSendModelPreview, editNodeSendMenuId, updateEditNodeSendMenuPosition]);

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
                    <div className="composerMenuBackdrop" onPointerDown={closeEditNodeSendMenu} aria-hidden="true" />
                    <div
                      className="composerMenu"
                      style={{
                        top: editNodeSendMenuPos.top,
                        bottom: editNodeSendMenuPos.bottom,
                        left: editNodeSendMenuPos.left,
                        width: EDIT_NODE_SEND_MODEL_MENU_WIDTH,
                        maxHeight: editNodeSendMenuPos.maxHeight,
                        overflowY: editNodeSendMenuPointerLock ? 'hidden' : undefined,
                        touchAction: editNodeSendMenuPointerLock ? 'none' : undefined,
                      }}
                      role="menu"
                    >
                      {composerModelOptions.map((m) => {
                        const active = m.id === composerModelId;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            className={`composerMenu__item composerMenu__item--withCheck ${active ? 'composerMenu__item--active' : ''}`}
                            onPointerDown={(e) => {
                              const nodeId = String(editNodeSendMenuId ?? '').trim();
                              if (!nodeId) return;
                              beginEditNodeSendModelDrag(e, nodeId, m.id);
                            }}
                            onPointerMove={onEditNodeSendModelDragPointerMove}
                            onPointerUp={onEditNodeSendModelDragPointerUp}
                            onPointerCancel={onEditNodeSendModelDragPointerCancel}
                            onClick={() => {
                              closeEditNodeSendMenu();
                              applyComposerModelSelection(m.id);
                            }}
                            role="menuitem"
                            title={m.label}
                          >
                            <span className="composerMenu__check" aria-hidden="true">
                              {active ? '✓' : ''}
                            </span>
                            <span className="composerMenu__label">{String(m.shortLabel ?? m.label ?? m.id).trim()}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>,
                  document.body,
                )
              : null}
        {ui.editingNodeId ? (
          editorTextFormat === 'latex' ? (
            <LatexNodeEditor
              nodeId={ui.editingNodeId}
              title={editorTitle}
              initialValue={ui.editingText}
              compiledPdfUrl={editorLatexCompiledPdfUrl}
              compileError={editorLatexState?.compileError ?? null}
              compileLog={editorLatexState?.compileLog ?? null}
              compiledAt={editorLatexState?.compiledAt ?? null}
              latexProject={{
                projectRoot: editorLatexState?.projectRoot ?? null,
                mainFile: editorLatexState?.mainFile ?? null,
                activeFile: editorLatexState?.activeFile ?? null,
              }}
              onDraftChange={(next) => editingDraftByNodeIdRef.current.set(ui.editingNodeId as string, next)}
              onProjectStateChange={(patch) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                const nextContent =
                  patch.content !== undefined ? (typeof patch.content === 'string' ? patch.content : String(patch.content ?? '')) : null;
                if (nextContent !== null) {
                  engine.setEditingText(nextContent);
                }
                engine.setTextNodeLatexState(id, {
                  ...(nextContent !== null ? { content: nextContent } : {}),
                  ...(patch.projectRoot !== undefined ? { latexProjectRoot: patch.projectRoot ?? null } : {}),
                  ...(patch.mainFile !== undefined ? { latexMainFile: patch.mainFile ?? null } : {}),
                  ...(patch.activeFile !== undefined ? { latexActiveFile: patch.activeFile ?? null } : {}),
                });
                schedulePersistSoon();
              }}
              anchorRect={editorAnchor}
              getScreenRect={() => engineRef.current?.getNodeScreenRect(ui.editingNodeId as string) ?? null}
              getZoom={() => engineRef.current?.camera.zoom ?? 1}
              viewport={viewport}
              zoom={editorZoom}
              baseFontSizePx={nodeFontSizePx}
              onResize={(nextRect) => engineRef.current?.setNodeScreenRect(ui.editingNodeId as string, nextRect)}
              onResizeEnd={() => schedulePersistSoon()}
              onCompile={async (req) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;

                const source = typeof req?.source === 'string' ? req.source : '';
                const projectRoot = typeof req?.projectRoot === 'string' ? req.projectRoot.trim() : '';
                const mainFile = typeof req?.mainFile === 'string' ? req.mainFile.trim() : '';

                engine.setEditingText(source);
                const prev = engine.getTextNodeLatexState(id);
                const previousPdfKey =
                  prev && typeof prev.compiledPdfStorageKey === 'string' ? prev.compiledPdfStorageKey.trim() : '';
                const result = await compileLatexDocument({
                  ...(projectRoot && mainFile ? { projectRoot, mainFile } : { source }),
                  engine: 'pdflatex',
                });
                const compileLog =
                  typeof result.log === 'string' && result.log.trim() ? result.log : null;
                const compileIssue =
                  typeof result.error === 'string' && result.error.trim()
                    ? result.error.trim().slice(0, 600)
                    : null;

                if (!result.ok || !result.pdfBase64) {
                  const failMsg = (result.error ?? 'Compile failed. See compiler log for details.').trim().slice(0, 600);
                  engine.setTextNodeLatexState(id, {
                    latexCompileError: failMsg || 'Compile failed.',
                    latexCompileLog: compileLog,
                  });
                  schedulePersistSoon();
                  return;
                }

                const blob = base64ToBlob(result.pdfBase64, 'application/pdf');
                let storageKey: string | null = null;
                try {
                  storageKey = await putAttachment({
                    blob,
                    mimeType: 'application/pdf',
                    name: 'latex-output.pdf',
                    size: Number.isFinite(blob.size) ? blob.size : undefined,
                  });
                } catch {
                  storageKey = null;
                }

                if (!storageKey) {
                  engine.setTextNodeLatexState(id, {
                    latexCompileError: 'Compile succeeded but failed to store PDF output.',
                    latexCompileLog: compileLog,
                  });
                  schedulePersistSoon();
                  return;
                }

                const compiledAttachment: ChatAttachment = {
                  kind: 'pdf',
                  mimeType: 'application/pdf',
                  storageKey,
                  name: 'latex-output.pdf',
                  size: Number.isFinite(blob.size) ? blob.size : undefined,
                };

                engine.setTextNodeLatexState(id, {
                  attachments: [compiledAttachment],
                  latexCompileError: compileIssue,
                  latexCompiledAt: Date.now(),
                  latexCompileLog: compileLog,
                });

                if (previousPdfKey && previousPdfKey !== storageKey) {
                  attachmentsGcDirtyRef.current = true;
                }
                schedulePersistSoon();
              }}
              onReplyToSelection={(selectionText) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.onRequestReplyToSelection?.(id, selectionText);
              }}
              onReply={(text) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.setEditingText(text);
                engine.onRequestReply?.(id);
              }}
              onAddToContextSelection={(selectionText) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.onRequestAddToContextSelection?.(id, selectionText);
              }}
              onAnnotateTextSelection={(payload) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.requestAnnotateTextNodeSelection({
                  textNodeId: id,
                  selectionText: payload.selectionText,
                  kind: 'text',
                  client: payload.client ?? null,
                });
              }}
              onAnnotateInkSelection={(payload) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.requestAnnotateTextNodeSelection({
                  textNodeId: id,
                  selectionText: payload.selectionText,
                  kind: 'ink',
                  client: payload.client ?? null,
                });
              }}
              onCommit={(next) => {
                engineRef.current?.commitEditing(next);
                schedulePersistSoon();
              }}
              onCancel={() => engineRef.current?.cancelEditing()}
            />
          ) : (
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
                const engine = engineRef.current;
                editingDraftByNodeIdRef.current.set(id, text);
                engine?.setEditingText(text);
                let assistantRect: Rect | null = null;
                const placementClient = opts?.placementClient;
                const canvas = canvasRef.current;
                if (engine && canvas && placementClient) {
                  const canvasRect = canvas.getBoundingClientRect();
                  const screenX = placementClient.clientX - canvasRect.left;
                  const screenY = placementClient.clientY - canvasRect.top;
                  assistantRect = engine.getNodeSendAssistantSpawnRectAtScreen(id, { x: screenX, y: screenY });
                }
                sendAssistantTurnFromUserNode({
                  userNodeId: id,
                  modelIdOverride: opts?.modelIdOverride ?? null,
                  assistantRect,
                  liveDraftOverride: text,
                  clearComposerText: false,
                });
              }}
              onReplyToSelection={(selectionText) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.onRequestReplyToSelection?.(id, selectionText);
              }}
              onAddToContextSelection={(selectionText) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.onRequestAddToContextSelection?.(id, selectionText);
              }}
              onAnnotateTextSelection={(payload) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.requestAnnotateTextNodeSelection({
                  textNodeId: id,
                  selectionText: payload.selectionText,
                  kind: 'text',
                  client: payload.client ?? null,
                });
              }}
              onAnnotateInkSelection={(payload) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.requestAnnotateTextNodeSelection({
                  textNodeId: id,
                  selectionText: payload.selectionText,
                  kind: 'ink',
                  client: payload.client ?? null,
                });
              }}
              onReply={(text) => {
                const id = String(ui.editingNodeId ?? '').trim();
                if (!id) return;
                const engine = engineRef.current;
                if (!engine) return;
                engine.setEditingText(text);
                engine.onRequestReply?.(id);
              }}
              onSelectModel={(nextModelId) => {
                applyComposerModelSelection(nextModelId);
              }}
              onSendPreview={(opts) => {
                const engine = engineRef.current;
                if (!engine) return;
                const id = String(ui.editingNodeId ?? '').trim();
                const placementClient = opts?.placementClient ?? null;
                if (!id || !placementClient) {
                  engine.clearExternalHeaderPlacementPreview();
                  return;
                }
                const canvas = canvasRef.current;
                if (!canvas) {
                  engine.clearExternalHeaderPlacementPreview();
                  return;
                }
                const canvasRect = canvas.getBoundingClientRect();
                const screenX = placementClient.clientX - canvasRect.left;
                const screenY = placementClient.clientY - canvasRect.top;
                engine.setExternalHeaderPlacementPreview(id, { x: screenX, y: screenY });
              }}
              onCommit={(next) => {
                engineRef.current?.commitEditing(next);
                schedulePersistSoon();
              }}
              onCancel={() => engineRef.current?.cancelEditing()}
            />
          )
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
            applyComposerModelSelection(next || DEFAULT_MODEL_ID);
          }}
          webSearchEnabled={composerWebSearch}
          onChangeWebSearchEnabled={(next) => {
            setComposerWebSearch(next);
            ensureChatMeta(activeChatId).llm.webSearchEnabled = next;
          }}
          sendAllEnabled={sendAllEnabled}
          sendAllChecked={sendAllComposerEnabled}
          onChangeSendAllChecked={(next) => {
            const value = Boolean(next);
            setSendAllComposerEnabled(value);
            sendAllComposerEnabledRef.current = value;
            schedulePersistSoon();
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
            const targetModelIds = resolveComposerSendModelIds();
            const [firstModelId, ...restModelIds] = targetModelIds;
            const first = sendTurn({
              userText: composerDraft,
              allowPdfAttachmentParentFallback: true,
              clearComposerText: true,
              modelIdOverride: firstModelId,
            });
            if (!first) return;
            const assistantNodeIds = [first.assistantNodeId];
            for (let i = 0; i < restModelIds.length; i += 1) {
              const modelId = restModelIds[i];
              const spawned = sendAssistantTurnFromUserNode({
                userNodeId: first.userNodeId,
                modelIdOverride: modelId,
                clearComposerText: false,
              });
              if (spawned?.assistantNodeId) assistantNodeIds.push(spawned.assistantNodeId);
            }
            if (assistantNodeIds.length >= 2) {
              const assistantRects = resolveSymmetricAssistantRects({
                chatId: first.chatId,
                userNodeId: first.userNodeId,
                firstAssistantNodeId: first.assistantNodeId,
                count: assistantNodeIds.length,
              });
              applyAssistantRects({
                chatId: first.chatId,
                assistantNodeIds,
                rects: assistantRects,
              });
            }
          }}
          onSendInk={({ strokes, viewport }) => {
            const targetModelIds = resolveComposerSendModelIds();
            const supportedModelIds = targetModelIds.filter((modelId) => {
              const info = getModelInfo(modelId);
              return !info || info.supportsImageInput !== false;
            });
            const skippedCount = targetModelIds.length - supportedModelIds.length;
            const dispatchModelIds = supportedModelIds.length ? supportedModelIds : targetModelIds;
            const [firstModelId, ...restModelIds] = dispatchModelIds;
            const first = sendInkTurn({ strokes, viewport, modelIdOverride: firstModelId });
            if (!first) return;
            const assistantNodeIds = [first.assistantNodeId];
            for (let i = 0; i < restModelIds.length; i += 1) {
              const modelId = restModelIds[i];
              const spawned = sendAssistantTurnFromUserNode({
                userNodeId: first.userNodeId,
                modelIdOverride: modelId,
                clearComposerText: false,
              });
              if (spawned?.assistantNodeId) assistantNodeIds.push(spawned.assistantNodeId);
            }
            if (assistantNodeIds.length >= 2) {
              const assistantRects = resolveSymmetricAssistantRects({
                chatId: first.chatId,
                userNodeId: first.userNodeId,
                firstAssistantNodeId: first.assistantNodeId,
                count: assistantNodeIds.length,
              });
              applyAssistantRects({
                chatId: first.chatId,
                assistantNodeIds,
                rects: assistantRects,
              });
            }
            if (skippedCount > 0) {
              showToast(
                `Skipped ${skippedCount} selected model${skippedCount === 1 ? '' : 's'} that do not support image input.`,
                'info',
                2600,
              );
            }
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
                title="New LaTeX node"
                aria-label="New LaTeX node"
                onClick={() => {
                  const engine = engineRef.current;
                  if (!engine) return;
                  engine.spawnLatexNode({ title: 'LaTeX' });
                  schedulePersistSoon();
                }}
              >
                <Icons.latexBox className="toolStrip__icon" />
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
          globalSystemInstruction={globalSystemInstruction}
          onChangeGlobalSystemInstruction={(next) => {
            setGlobalSystemInstruction(next);
            globalSystemInstructionRef.current = next;
            schedulePersistSoon();
          }}
          chatSystemInstructionOverride={activeChatSystemInstructionOverride}
          onChangeChatSystemInstructionOverride={(next) => {
            const chatId = String(activeChatIdRef.current ?? '').trim();
            if (!chatId) return;
            const meta = ensureChatMeta(chatId);
            meta.systemInstructionOverride = next;
            setActiveChatSystemInstructionOverride(next);
            schedulePersistSoon();
          }}
	          onResetChatSystemInstructionOverride={() => {
	            const chatId = String(activeChatIdRef.current ?? '').trim();
	            if (!chatId) return;
	            const meta = ensureChatMeta(chatId);
	            meta.systemInstructionOverride = null;
	            setActiveChatSystemInstructionOverride(null);
	            schedulePersistSoon();
	          }}
            runtimeApiKeys={runtimeApiKeys}
            onSaveRuntimeApiKey={saveRuntimeProviderApiKey}
            onClearRuntimeApiKey={clearRuntimeProviderApiKey}
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
            const value: GlassBlurBackend = next === 'canvas' ? 'canvas' : DEFAULT_GLASS_BLUR_BACKEND;
            glassNodesBlurBackendRef.current = value;
            setGlassNodesBlurBackend(value);
            const blurCssPx =
              value === 'canvas' ? glassNodesBlurCssPxCanvasRef.current : glassNodesBlurCssPxWebglRef.current;
            const saturatePct =
              value === 'canvas' ? glassNodesSaturatePctCanvasRef.current : glassNodesSaturatePctWebglRef.current;
            const engine = engineRef.current;
            engine?.setGlassNodesBlurBackend(value);
            engine?.setGlassNodesBlurCssPx(
              Number.isFinite(blurCssPx)
                ? Math.max(0, Math.min(30, blurCssPx))
                : value === 'canvas'
                  ? DEFAULT_GLASS_BLUR_CSS_PX_CANVAS
                  : DEFAULT_GLASS_BLUR_CSS_PX_WEBGL,
            );
            engine?.setGlassNodesSaturatePct(
              Number.isFinite(saturatePct)
                ? Math.max(100, Math.min(200, saturatePct))
                : value === 'canvas'
                  ? DEFAULT_GLASS_SATURATE_PCT_CANVAS
                  : DEFAULT_GLASS_SATURATE_PCT_WEBGL,
            );
            schedulePersistSoon();
          }}
          glassBlurPx={glassNodesBlurBackend === 'canvas' ? glassNodesBlurCssPxCanvas : glassNodesBlurCssPxWebgl}
          onChangeGlassBlurPx={(raw) => {
            const next = Number.isFinite(raw)
              ? Math.max(0, Math.min(30, raw))
              : glassNodesBlurBackendRef.current === 'canvas'
                ? DEFAULT_GLASS_BLUR_CSS_PX_CANVAS
                : DEFAULT_GLASS_BLUR_CSS_PX_WEBGL;
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
            const next = Number.isFinite(raw)
              ? Math.max(100, Math.min(200, raw))
              : glassNodesBlurBackendRef.current === 'canvas'
                ? DEFAULT_GLASS_SATURATE_PCT_CANVAS
                : DEFAULT_GLASS_SATURATE_PCT_WEBGL;
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
            const next = Number.isFinite(raw) ? Math.max(0, Math.min(30, raw)) : DEFAULT_UI_GLASS_BLUR_CSS_PX_WEBGL;
            uiGlassBlurCssPxWebglRef.current = next;
            setUiGlassBlurCssPxWebgl(next);
            schedulePersistSoon();
          }}
          uiGlassSaturationPctWebgl={uiGlassSaturatePctWebgl}
          onChangeUiGlassSaturationPctWebgl={(raw) => {
            const next = Number.isFinite(raw) ? Math.max(100, Math.min(200, raw)) : DEFAULT_UI_GLASS_SATURATE_PCT_WEBGL;
            uiGlassSaturatePctWebglRef.current = next;
            setUiGlassSaturatePctWebgl(next);
            schedulePersistSoon();
          }}
          glassOpacityPct={glassNodesUnderlayAlpha * 100}
          onChangeGlassOpacityPct={(raw) => {
            const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : DEFAULT_GLASS_UNDERLAY_ALPHA * 100;
            const next = pct / 100;
            glassNodesUnderlayAlphaRef.current = next;
            setGlassNodesUnderlayAlpha(next);
            engineRef.current?.setGlassNodesUnderlayAlpha(next);
            schedulePersistSoon();
          }}
          debugHudVisible={debugHudVisible}
          onToggleDebugHudVisible={() => setDebugHudVisible((prev) => !prev)}
          wheelInputPreference={wheelInputPreference}
          onChangeWheelInputPreference={(raw) => {
            const next = normalizeWheelInputPreference(raw, DEFAULT_WHEEL_INPUT_PREFERENCE);
            wheelInputPreferenceRef.current = next;
            setWheelInputPreference(next);
            engineRef.current?.setWheelInputPreference(next);
            schedulePersistSoon();
          }}
          mouseClickRecenterEnabled={mouseClickRecenterEnabled}
          onToggleMouseClickRecenterEnabled={() => {
            const next = !mouseClickRecenterEnabledRef.current;
            mouseClickRecenterEnabledRef.current = next;
            setMouseClickRecenterEnabled(next);
            engineRef.current?.setMouseClickRecenterEnabled(next);
            schedulePersistSoon();
          }}
          sendAllEnabled={sendAllEnabled}
          onToggleSendAllEnabled={() => {
            const next = !sendAllEnabledRef.current;
            sendAllEnabledRef.current = next;
            setSendAllEnabled(next);
            schedulePersistSoon();
          }}
          sendAllModelIds={sendAllModelIds}
          onToggleSendAllModelId={(rawModelId) => {
            const modelId = String(rawModelId ?? '').trim();
            if (!modelId || !allModelIds.includes(modelId)) return;
            setSendAllModelIds((prev) => {
              const exists = prev.includes(modelId);
              const next = exists ? prev.filter((id) => id !== modelId) : [...prev, modelId];
              const normalized = normalizeSendAllModelIds(next, allModelIds);
              sendAllModelIdsRef.current = normalized;
              return normalized;
            });
            schedulePersistSoon();
          }}
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
            storagePath={storageDataDirInfo?.path ?? null}
            storageDefaultPath={storageDataDirInfo?.defaultPath ?? null}
            storagePathIsDefault={storageDataDirInfo?.isDefault ?? true}
            canManageStorageLocation={canManageStorageLocation}
            onChooseStorageLocation={chooseStorageLocation}
            onResetStorageLocation={resetStorageLocation}
            canOpenStorageFolder={canOpenStorageFolder}
            onOpenStorageFolder={openStorageFolder}
            cleanupChatFoldersOnDelete={cleanupChatFoldersOnDelete}
            onToggleCleanupChatFoldersOnDelete={() => {
              const next = !cleanupChatFoldersOnDeleteRef.current;
              cleanupChatFoldersOnDeleteRef.current = next;
              setCleanupChatFoldersOnDelete(next);
              schedulePersistSoon();
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
              systemInstructionOverride: null,
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
            setActiveChatSystemInstructionOverride(null);
            setDebugHudVisible(DEFAULT_DEBUG_HUD_VISIBLE);
            sendAllEnabledRef.current = DEFAULT_SEND_ALL_ENABLED;
            sendAllComposerEnabledRef.current = DEFAULT_SEND_ALL_COMPOSER_ENABLED;
            sendAllModelIdsRef.current = allModelIds.slice();
            sendAllModelIdsInitializedRef.current = true;
            setSendAllEnabled(DEFAULT_SEND_ALL_ENABLED);
            setSendAllComposerEnabled(DEFAULT_SEND_ALL_COMPOSER_ENABLED);
            setSendAllModelIds(sendAllModelIdsRef.current);
            cleanupChatFoldersOnDeleteRef.current = DEFAULT_CLEANUP_CHAT_FOLDERS_ON_DELETE;
            setCleanupChatFoldersOnDelete(DEFAULT_CLEANUP_CHAT_FOLDERS_ON_DELETE);
            allowEditingAllTextNodesRef.current = DEFAULT_ALLOW_EDITING_ALL_TEXT_NODES;
            setAllowEditingAllTextNodes(DEFAULT_ALLOW_EDITING_ALL_TEXT_NODES);
            spawnEditNodeByDrawRef.current = DEFAULT_SPAWN_EDIT_NODE_BY_DRAW;
            setSpawnEditNodeByDraw(DEFAULT_SPAWN_EDIT_NODE_BY_DRAW);
            spawnInkNodeByDrawRef.current = DEFAULT_SPAWN_INK_NODE_BY_DRAW;
            setSpawnInkNodeByDraw(DEFAULT_SPAWN_INK_NODE_BY_DRAW);
            wheelInputPreferenceRef.current = DEFAULT_WHEEL_INPUT_PREFERENCE;
            setWheelInputPreference(DEFAULT_WHEEL_INPUT_PREFERENCE);
            mouseClickRecenterEnabledRef.current = DEFAULT_MOUSE_CLICK_RECENTER_ENABLED;
            setMouseClickRecenterEnabled(DEFAULT_MOUSE_CLICK_RECENTER_ENABLED);
            inkSendCropEnabledRef.current = DEFAULT_INK_SEND_CROP_ENABLED;
            setInkSendCropEnabled(DEFAULT_INK_SEND_CROP_ENABLED);
            inkSendCropPaddingPxRef.current = 24;
            setInkSendCropPaddingPx(24);
            inkSendDownscaleEnabledRef.current = DEFAULT_INK_SEND_DOWNSCALE_ENABLED;
            setInkSendDownscaleEnabled(DEFAULT_INK_SEND_DOWNSCALE_ENABLED);
            inkSendMaxPixelsRef.current = 6_000_000;
            setInkSendMaxPixels(6_000_000);
            inkSendMaxDimPxRef.current = 4096;
            setInkSendMaxDimPx(4096);
            const nextModelUserSettings = buildModelUserSettings(allModels, null);
            setModelUserSettings(nextModelUserSettings);
            modelUserSettingsRef.current = nextModelUserSettings;
            setGlobalSystemInstruction(DEFAULT_SYSTEM_INSTRUCTIONS);
            globalSystemInstructionRef.current = DEFAULT_SYSTEM_INSTRUCTIONS;

            glassNodesEnabledRef.current = DEFAULT_GLASS_NODES_ENABLED;
            glassNodesBlurCssPxWebglRef.current = DEFAULT_GLASS_BLUR_CSS_PX_WEBGL;
            glassNodesSaturatePctWebglRef.current = DEFAULT_GLASS_SATURATE_PCT_WEBGL;
            glassNodesBlurCssPxCanvasRef.current = DEFAULT_GLASS_BLUR_CSS_PX_CANVAS;
            glassNodesSaturatePctCanvasRef.current = DEFAULT_GLASS_SATURATE_PCT_CANVAS;
            uiGlassBlurCssPxWebglRef.current = DEFAULT_UI_GLASS_BLUR_CSS_PX_WEBGL;
            uiGlassSaturatePctWebglRef.current = DEFAULT_UI_GLASS_SATURATE_PCT_WEBGL;
            glassNodesUnderlayAlphaRef.current = DEFAULT_GLASS_UNDERLAY_ALPHA;
            glassNodesBlurBackendRef.current = DEFAULT_GLASS_BLUR_BACKEND;
            setGlassNodesEnabled(DEFAULT_GLASS_NODES_ENABLED);
            setGlassNodesBlurCssPxWebgl(DEFAULT_GLASS_BLUR_CSS_PX_WEBGL);
            setGlassNodesSaturatePctWebgl(DEFAULT_GLASS_SATURATE_PCT_WEBGL);
            setGlassNodesBlurCssPxCanvas(DEFAULT_GLASS_BLUR_CSS_PX_CANVAS);
            setGlassNodesSaturatePctCanvas(DEFAULT_GLASS_SATURATE_PCT_CANVAS);
            setGlassNodesUnderlayAlpha(DEFAULT_GLASS_UNDERLAY_ALPHA);
            setGlassNodesBlurBackend(DEFAULT_GLASS_BLUR_BACKEND);
            setUiGlassBlurCssPxWebgl(DEFAULT_UI_GLASS_BLUR_CSS_PX_WEBGL);
            setUiGlassSaturatePctWebgl(DEFAULT_UI_GLASS_SATURATE_PCT_WEBGL);

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
              engine.setGlassNodesEnabled(DEFAULT_GLASS_NODES_ENABLED);
              engine.setGlassNodesBlurCssPx(DEFAULT_GLASS_BLUR_CSS_PX_WEBGL);
              engine.setGlassNodesSaturatePct(DEFAULT_GLASS_SATURATE_PCT_WEBGL);
              engine.setGlassNodesUnderlayAlpha(DEFAULT_GLASS_UNDERLAY_ALPHA);
              engine.setGlassNodesBlurBackend(DEFAULT_GLASS_BLUR_BACKEND);
              engine.setEdgeRouter(DEFAULT_EDGE_ROUTER_ID);
              engine.setReplyArrowColor(DEFAULT_REPLY_ARROW_COLOR);
              engine.setReplyArrowOpacity(DEFAULT_REPLY_ARROW_OPACITY);
              engine.setAllowEditingAllTextNodes(DEFAULT_ALLOW_EDITING_ALL_TEXT_NODES);
              engine.setSpawnEditNodeByDrawEnabled(DEFAULT_SPAWN_EDIT_NODE_BY_DRAW);
              engine.setSpawnInkNodeByDrawEnabled(DEFAULT_SPAWN_INK_NODE_BY_DRAW);
              engine.setWheelInputPreference(DEFAULT_WHEEL_INPUT_PREFERENCE);
              engine.setMouseClickRecenterEnabled(DEFAULT_MOUSE_CLICK_RECENTER_ENABLED);
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
            {debug?.framePerf ? (
              <>
                <div style={{ opacity: 0.85 }}>
                  frame {debug.framePerf.frameMs.toFixed(1)}ms • edges {debug.framePerf.edgesMs.toFixed(1)} • nodes{' '}
                  {debug.framePerf.drawNodesMs.toFixed(1)} • overlays {debug.framePerf.overlaysMs.toFixed(1)}
                </div>
                <div style={{ opacity: 0.75 }}>
                  updates{' '}
                  {(
                    debug.framePerf.updateFullTextNodeRastersMs +
                    debug.framePerf.updateTextRastersMs +
                    debug.framePerf.updateInkPrefaceRastersMs +
                    debug.framePerf.updatePdfRastersMs
                  ).toFixed(1)}
                  ms • route cache {(debug.framePerf.edgeRouteCacheHitRate * 100).toFixed(0)}% (
                  {debug.framePerf.edgeRouteCacheHits}/{debug.framePerf.edgeRouteCacheHits + debug.framePerf.edgeRouteCacheMisses}) • size{' '}
                  {debug.framePerf.edgeRouteCacheSize}
                </div>
              </>
            ) : null}
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
