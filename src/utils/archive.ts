import type { WorldEngineCameraState, WorldEngineChatState } from '../engine/WorldEngine';
import type { BackgroundLibraryItem } from '../model/backgrounds';
import type { ChatAttachment, ChatNode, InkStroke } from '../model/chat';
import type { WorkspaceFolder } from '../workspace/tree';
import { blobToDataUrl, getAttachment as getStoredAttachment, putAttachment } from '../storage/attachments';
import { getPayload, putPayload } from '../storage/payloads';
import { DEFAULT_MODEL_ID } from '../llm/registry';
import { splitDataUrl } from './files';

export type ArchiveV1 = {
  format: 'graphchatv1';
  schemaVersion: 1;
  exportedAt: string;
  app?: { name?: string; version?: string };
  chat: {
    id?: string;
    name: string;
    folderPath?: string[];
    state: {
      camera: WorldEngineCameraState;
      nodes: any[];
      worldInkStrokes: InkStroke[];
    };
    meta?: any;
    background?: {
      name: string;
      mimeType: string;
      size?: number;
      data: string; // base64
    } | null;
  };
};

export type ArchiveV2 = {
  format: 'graphchatv1';
  schemaVersion: 2;
  exportedAt: string;
  app?: { name?: string; version?: string };
  workspace?: { root: WorkspaceFolder; activeChatId: string; focusedFolderId: string };
  chats: ArchiveV1['chat'][];
};

export type Archive = ArchiveV1 | ArchiveV2;

type ExportChatArgs = {
  chatId: string;
  chatName: string;
  folderPath?: string[];
  state: { camera: WorldEngineCameraState; nodes: ChatNode[]; worldInkStrokes: InkStroke[] };
  meta?: any;
  background?: { storageKey: string | null; name?: string | null } | null;
  appName?: string;
  appVersion?: string;
};

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function safeClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // ignore
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    // last resort: shallow clone for objects/arrays
    if (Array.isArray(value)) return value.slice() as any;
    if (value && typeof value === 'object') return { ...(value as any) };
    return value;
  }
}

function stripExt(name: string): string {
  const trimmed = safeString(name).trim();
  if (!trimmed) return '';
  const idx = trimmed.lastIndexOf('.');
  if (idx <= 0) return trimmed;
  return trimmed.slice(0, idx);
}

function toIsoStamp(d = new Date()): string {
  return d.toISOString().replaceAll(':', '').replaceAll('-', '').replace('T', '-').slice(0, 15);
}

function filenameSafeBase(name: string): string {
  const base = safeString(name).trim() || 'graphchatv1-chat';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || 'graphchatv1-chat';
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const mt = safeString(mimeType).trim() || 'application/octet-stream';
  const b64 = safeString(base64).replace(/\s+/g, '');
  if (typeof atob !== 'function') throw new Error('Base64 decoding is not available in this environment.');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mt });
}

async function blobToBase64(blob: Blob, mimeTypeHint?: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const mt = safeString(mimeTypeHint).trim() || blob.type || 'application/octet-stream';
    const dataUrl = await blobToDataUrl(blob, mt);
    const parts = splitDataUrl(dataUrl);
    if (!parts?.base64) return null;
    return { base64: parts.base64, mimeType: parts.mimeType || mt };
  } catch {
    return null;
  }
}

function sanitizeNodeForExport(node: ChatNode): any {
  const out = safeClone(node) as any;
  if (!out || typeof out !== 'object') return out;

  if (out.kind === 'text') {
    // Never export live generation state.
    try {
      delete out.isGenerating;
      delete out.llmTask;
    } catch {
      // ignore
    }
  }
  return out;
}

async function rehydrateAttachmentsInPlace(value: any, warnings: string[], context: { kind: string; id: string }) {
  if (!Array.isArray(value)) return;
  for (let i = 0; i < value.length; i += 1) {
    const att = value[i] as any;
    if (!att || typeof att !== 'object') continue;

    const kind = safeString(att.kind);
    const hasData = typeof att.data === 'string' && att.data;
    const storageKey = typeof att.storageKey === 'string' ? att.storageKey : '';

    const embedBlob = async (fallbackMimeType: string) => {
      if (hasData) return;
      if (!storageKey) return;
      try {
        const rec = await getStoredAttachment(storageKey);
        if (!rec?.blob) {
          warnings.push(`Missing attachment blob (${context.kind}:${context.id})`);
          return;
        }
        const mt = safeString(att.mimeType).trim() || safeString(rec.mimeType).trim() || fallbackMimeType;
        const enc = await blobToBase64(rec.blob, mt);
        if (!enc?.base64) {
          warnings.push(`Failed to encode attachment (${context.kind}:${context.id})`);
          return;
        }
        att.data = enc.base64;
        att.mimeType = safeString(att.mimeType).trim() || enc.mimeType;
        if (att.size == null && Number.isFinite(Number(rec.size))) att.size = Number(rec.size);
        if ((!safeString(att.name).trim()) && safeString(rec.name).trim()) att.name = safeString(rec.name).trim();
      } catch {
        warnings.push(`Failed to fetch attachment (${context.kind}:${context.id})`);
      }
    };

    if (kind === 'image') {
      await embedBlob('image/png');
      try {
        delete att.storageKey;
      } catch {
        // ignore
      }
    } else if (kind === 'pdf') {
      await embedBlob('application/pdf');
      try {
        delete att.storageKey;
      } catch {
        // ignore
      }
    } else if (kind === 'ink') {
      // Ink attachments are rare in v1, but keep best-effort portability.
      await embedBlob('application/octet-stream');
      try {
        delete att.storageKey;
      } catch {
        // ignore
      }
    }
  }
}

async function rehydratePayloadsInPlace(nodes: any[], warnings: string[]) {
  for (const raw of nodes) {
    const node = raw as any;
    if (!node || typeof node !== 'object') continue;
    if (node.kind !== 'text') continue;

    const reqKey = typeof node.apiRequestKey === 'string' ? node.apiRequestKey.trim() : '';
    const resKey = typeof node.apiResponseKey === 'string' ? node.apiResponseKey.trim() : '';

    if (reqKey) {
      try {
        const payload = await getPayload(reqKey);
        if (payload != null) node.apiRequest = payload;
        else if (node.apiRequest === undefined) warnings.push(`Missing raw request payload for key ${reqKey}`);
      } catch {
        warnings.push(`Failed to fetch raw request payload for key ${reqKey}`);
      }
    }
    if (resKey) {
      try {
        const payload = await getPayload(resKey);
        if (payload != null) node.apiResponse = payload;
        else if (node.apiResponse === undefined) warnings.push(`Missing raw response payload for key ${resKey}`);
      } catch {
        warnings.push(`Failed to fetch raw response payload for key ${resKey}`);
      }
    }

    try {
      delete node.apiRequestKey;
      delete node.apiResponseKey;
    } catch {
      // ignore
    }
  }
}

async function rehydratePdfNodeFilesInPlace(nodes: any[], warnings: string[]) {
  for (const raw of nodes) {
    const node = raw as any;
    if (!node || typeof node !== 'object') continue;
    if (node.kind !== 'pdf') continue;
    const storageKey = typeof node.storageKey === 'string' ? node.storageKey.trim() : '';
    if (!storageKey) continue;

    try {
      const rec = await getStoredAttachment(storageKey);
      if (!rec?.blob) {
        warnings.push(`Missing PDF blob for key ${storageKey}`);
        continue;
      }
      const mt = safeString(rec.mimeType).trim() || 'application/pdf';
      const enc = await blobToBase64(rec.blob, mt);
      if (!enc?.base64) {
        warnings.push(`Failed to encode PDF node (${safeString(node.id)})`);
        continue;
      }
      node.fileData = {
        data: enc.base64,
        mimeType: enc.mimeType || mt,
        name: safeString(rec.name).trim() || safeString(node.fileName).trim() || 'document.pdf',
        ...(Number.isFinite(Number(rec.size)) ? { size: Number(rec.size) } : {}),
      };
    } catch {
      warnings.push(`Failed to fetch PDF blob for key ${storageKey}`);
    } finally {
      try {
        delete node.storageKey;
      } catch {
        // ignore
      }
    }
  }
}

async function buildChatExport(args: ExportChatArgs): Promise<{ chat: ArchiveV1['chat']; warnings: string[] }> {
  const warnings: string[] = [];

  const nodesCopy = (args.state.nodes ?? []).map((n) => sanitizeNodeForExport(n));
  await rehydratePayloadsInPlace(nodesCopy, warnings);
  for (const raw of nodesCopy) {
    const node = raw as any;
    if (!node || typeof node !== 'object') continue;
    if (node.kind !== 'text' && node.kind !== 'ink') continue;
    await rehydrateAttachmentsInPlace(node.attachments, warnings, { kind: 'node', id: safeString(node.id) });
  }

  await rehydratePdfNodeFilesInPlace(nodesCopy, warnings);

  const metaCopy = args.meta != null ? safeClone(args.meta) : null;
  if (metaCopy && typeof metaCopy === 'object') {
    await rehydrateAttachmentsInPlace((metaCopy as any).draftAttachments, warnings, { kind: 'meta', id: args.chatId });
    try {
      // Background is exported separately.
      delete (metaCopy as any).backgroundStorageKey;
    } catch {
      // ignore
    }
  }

  let background: ArchiveV1['chat']['background'] = null;
  const bgStorageKey = safeString(args.background?.storageKey ?? '').trim();
  if (bgStorageKey) {
    try {
      const rec = await getStoredAttachment(bgStorageKey);
      if (rec?.blob) {
        const enc = await blobToBase64(rec.blob, rec.mimeType || 'image/png');
        if (enc?.base64) {
          const rawName = safeString(args.background?.name ?? rec.name).trim() || `Background ${bgStorageKey.slice(-6)}`;
          background = {
            name: stripExt(rawName) || rawName,
            mimeType: enc.mimeType,
            ...(Number.isFinite(Number(rec.size)) ? { size: Number(rec.size) } : {}),
            data: enc.base64,
          };
        } else {
          warnings.push(`Failed to encode background for key ${bgStorageKey}`);
        }
      } else {
        warnings.push(`Missing background blob for key ${bgStorageKey}`);
      }
    } catch {
      warnings.push(`Failed to fetch background for key ${bgStorageKey}`);
    }
  }

  const chat: ArchiveV1['chat'] = {
    id: args.chatId,
    name: args.chatName,
    ...(Array.isArray(args.folderPath) && args.folderPath.length ? { folderPath: args.folderPath.slice() } : {}),
    state: {
      camera: args.state.camera,
      nodes: nodesCopy,
      worldInkStrokes: safeClone(args.state.worldInkStrokes ?? []),
    },
    ...(metaCopy != null ? { meta: metaCopy } : {}),
    ...(background ? { background } : {}),
  };

  return { chat, warnings };
}

export async function exportChatArchive(args: ExportChatArgs): Promise<{ blob: Blob; filename: string; warnings: string[] }> {
  const { chat, warnings } = await buildChatExport(args);

  const archive: ArchiveV1 = {
    format: 'graphchatv1',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    app: { name: args.appName ?? 'graphchatv1', version: args.appVersion ?? '0' },
    chat,
  };

  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
  const filename = `${filenameSafeBase(args.chatName)}.${toIsoStamp()}.graphchatv1.json`;
  return { blob, filename, warnings };
}

export async function exportAllChatArchives(args: {
  chats: ExportChatArgs[];
  workspace?: { root: WorkspaceFolder; activeChatId: string; focusedFolderId: string };
  appName?: string;
  appVersion?: string;
}): Promise<{ blob: Blob; filename: string; warnings: string[] }> {
  const warnings: string[] = [];
  const out: ArchiveV1['chat'][] = [];

  for (const chatArgs of args.chats ?? []) {
    try {
      const res = await buildChatExport(chatArgs);
      out.push(res.chat);
      if (res.warnings.length) {
        warnings.push(...res.warnings.map((w) => `${chatArgs.chatName || chatArgs.chatId}: ${w}`));
      }
    } catch (err: any) {
      warnings.push(`${chatArgs.chatName || chatArgs.chatId}: export failed (${err?.message || String(err)})`);
    }
  }

  const archive: ArchiveV2 = {
    format: 'graphchatv1',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    app: { name: args.appName ?? 'graphchatv1', version: args.appVersion ?? '0' },
    ...(args.workspace ? { workspace: safeClone(args.workspace) } : {}),
    chats: out,
  };

  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
  const filename = `graphchatv1-all.${toIsoStamp()}.graphchatv1.json`;
  return { blob, filename, warnings };
}

export function triggerDownload(blob: Blob, filename: string) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

export function parseArchiveText(text: string): Archive {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid archive JSON');
  if ((parsed as any).format !== 'graphchatv1') throw new Error('Not a graphchatv1 archive');

  const schemaVersion = Number((parsed as any).schemaVersion ?? NaN);
  if (schemaVersion === 1) {
    const chat = (parsed as any).chat;
    if (!chat || typeof chat !== 'object') throw new Error('Archive missing chat');
    const state = (chat as any).state;
    if (!state || typeof state !== 'object') throw new Error('Archive missing chat.state');
    if (!Array.isArray((state as any).nodes)) throw new Error('Archive missing chat.state.nodes');
    return parsed as ArchiveV1;
  }

  if (schemaVersion === 2) {
    const chats = (parsed as any).chats;
    if (!Array.isArray(chats)) throw new Error('Archive missing chats');
    for (const chat of chats) {
      if (!chat || typeof chat !== 'object') throw new Error('Archive has invalid chat entry');
      const state = (chat as any).state;
      if (!state || typeof state !== 'object') throw new Error('Archive chat missing state');
      if (!Array.isArray((state as any).nodes)) throw new Error('Archive chat missing state.nodes');
    }
    return parsed as ArchiveV2;
  }

  throw new Error('Unsupported archive schemaVersion');
}

export async function importArchive(
  archive: ArchiveV1,
  options: { newChatId: string; includeImportDateInName?: boolean; includeBackgroundFromArchive?: boolean } & { now?: number } = {
    newChatId: '',
  },
): Promise<{
  chatId: string;
  chatName: string;
  folderPath?: string[];
  state: WorldEngineChatState;
  meta: any;
  backgroundLibraryItem: BackgroundLibraryItem | null;
  warnings: string[];
}> {
  const warnings: string[] = [];

  const chatId = safeString(options.newChatId).trim();
  if (!chatId) throw new Error('Missing newChatId');

  const includeImportDateInName = Boolean(options.includeImportDateInName);
  const includeBackgroundFromArchive = options.includeBackgroundFromArchive !== false;
  const importStamp = new Date(options.now ?? Date.now()).toISOString().slice(0, 10);
  const makeImportedName = (name: string): string => {
    const base = safeString(name).trim() || 'Imported chat';
    return includeImportDateInName ? `${base} (imported ${importStamp})` : base;
  };

  const rawChat = archive.chat as any;
  const folderPath = Array.isArray(rawChat.folderPath) ? rawChat.folderPath.filter((s: any) => typeof s === 'string') : [];

  const rawState = rawChat.state as any;
  const camera = (rawState?.camera ?? { x: 0, y: 0, zoom: 1 }) as WorldEngineCameraState;
  const nodes = Array.isArray(rawState?.nodes) ? (safeClone(rawState.nodes) as any[]) : [];
  const worldInkStrokes = Array.isArray(rawState?.worldInkStrokes) ? (safeClone(rawState.worldInkStrokes) as InkStroke[]) : [];

  // Normalize nodes and migrate embedded data to IDB.
  for (const raw of nodes) {
    const node = raw as any;
    if (!node || typeof node !== 'object') continue;
    if (node.kind === 'text') {
      try {
        delete node.isGenerating;
        delete node.llmTask;
      } catch {
        // ignore
      }

      const atts = Array.isArray(node.attachments) ? (node.attachments as any[]) : [];
      for (let i = 0; i < atts.length; i += 1) {
        const att = atts[i];
        if (!att || typeof att !== 'object') continue;
        const kind = safeString(att.kind);
        const data = typeof att.data === 'string' ? att.data : '';
        const mimeType = safeString(att.mimeType).trim();
        if ((kind === 'image' || kind === 'pdf' || kind === 'ink') && data) {
          const fallbackMt = kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/png' : 'application/octet-stream';
          const mt = mimeType || fallbackMt;
          try {
            const blob = base64ToBlob(data, mt);
            const storageKey = await putAttachment({
              blob,
              mimeType: mt,
              name: safeString(att.name).trim() || undefined,
              size: Number.isFinite(Number(att.size)) ? Number(att.size) : undefined,
            });
            const next = { ...att, storageKey, mimeType: mt } as any;
            delete next.data;
            atts[i] = next;
          } catch {
            warnings.push(`Failed to import attachment for node ${safeString(node.id)}`);
          }
        }
        // Drop any non-portable keys that slipped through.
        try {
          delete att.storageKey;
        } catch {
          // ignore
        }
      }
      if (atts.length) node.attachments = atts;

      // Migrate raw payloads into IDB payload store and keep only keys.
      const hadReq = Object.prototype.hasOwnProperty.call(node, 'apiRequest');
      const hadRes = Object.prototype.hasOwnProperty.call(node, 'apiResponse');
      const req = node.apiRequest;
      const res = node.apiResponse;

      try {
        delete node.apiRequestKey;
        delete node.apiResponseKey;
      } catch {
        // ignore
      }

      if (hadReq && req !== undefined) {
        const key = `${chatId}/${safeString(node.id)}/req`;
        try {
          await putPayload({ key, json: req });
          node.apiRequestKey = key;
          delete node.apiRequest;
        } catch {
          warnings.push(`Failed to persist raw request payload for node ${safeString(node.id)}`);
        }
      }
      if (hadRes && res !== undefined) {
        const key = `${chatId}/${safeString(node.id)}/res`;
        try {
          await putPayload({ key, json: res });
          node.apiResponseKey = key;
          delete node.apiResponse;
        } catch {
          warnings.push(`Failed to persist raw response payload for node ${safeString(node.id)}`);
        }
      }
    } else if (node.kind === 'ink') {
      const atts = Array.isArray(node.attachments) ? (node.attachments as any[]) : [];
      for (let i = 0; i < atts.length; i += 1) {
        const att = atts[i];
        if (!att || typeof att !== 'object') continue;
        const kind = safeString(att.kind);
        const data = typeof att.data === 'string' ? att.data : '';
        const mimeType = safeString(att.mimeType).trim();
        if ((kind === 'image' || kind === 'pdf' || kind === 'ink') && data) {
          const fallbackMt = kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/png' : 'application/octet-stream';
          const mt = mimeType || fallbackMt;
          try {
            const blob = base64ToBlob(data, mt);
            const storageKey = await putAttachment({
              blob,
              mimeType: mt,
              name: safeString(att.name).trim() || undefined,
              size: Number.isFinite(Number(att.size)) ? Number(att.size) : undefined,
            });
            const next = { ...att, storageKey, mimeType: mt } as any;
            delete next.data;
            atts[i] = next;
          } catch {
            warnings.push(`Failed to import attachment for node ${safeString(node.id)}`);
          }
        }
        // Drop any non-portable keys that slipped through.
        try {
          delete att.storageKey;
        } catch {
          // ignore
        }
      }
      if (atts.length) node.attachments = atts;
    } else if (node.kind === 'pdf') {
      const fileData = node.fileData as any;
      const data = fileData && typeof fileData === 'object' ? safeString(fileData.data) : '';
      if (data) {
        const mt = safeString(fileData.mimeType).trim() || 'application/pdf';
        try {
          const blob = base64ToBlob(data, mt);
          const storageKey = await putAttachment({
            blob,
            mimeType: mt,
            name: safeString(fileData.name).trim() || safeString(node.fileName).trim() || undefined,
            size: Number.isFinite(Number(fileData.size)) ? Number(fileData.size) : undefined,
          });
          node.storageKey = storageKey;
          node.status = 'empty';
          node.error = null;
        } catch {
          warnings.push(`Failed to import PDF node ${safeString(node.id)}`);
        }
      }
      try {
        delete node.fileData;
      } catch {
        // ignore
      }
    }
  }

  // Normalize meta
  const rawMeta = rawChat.meta && typeof rawChat.meta === 'object' ? safeClone(rawChat.meta) : {};
  const meta: any = {
    draft: typeof rawMeta.draft === 'string' ? rawMeta.draft : '',
    draftAttachments: Array.isArray(rawMeta.draftAttachments) ? rawMeta.draftAttachments : [],
    replyTo: rawMeta.replyTo && typeof rawMeta.replyTo === 'object' ? rawMeta.replyTo : null,
    contextSelections: Array.isArray(rawMeta.contextSelections)
      ? rawMeta.contextSelections.map((t: any) => safeString(t).trim()).filter(Boolean)
      : [],
    selectedAttachmentKeys: Array.isArray(rawMeta.selectedAttachmentKeys)
      ? rawMeta.selectedAttachmentKeys.filter((k: any) => typeof k === 'string')
      : [],
    headNodeId: typeof rawMeta.headNodeId === 'string' ? rawMeta.headNodeId : null,
    turns: Array.isArray(rawMeta.turns) ? rawMeta.turns : [],
    llm: {
      modelId: typeof rawMeta.llm?.modelId === 'string' ? rawMeta.llm.modelId : DEFAULT_MODEL_ID,
      webSearchEnabled: Boolean(rawMeta.llm?.webSearchEnabled),
    },
    backgroundStorageKey: null as string | null,
  };

  // Migrate draft attachments (embedded base64) to IDB.
  if (Array.isArray(meta.draftAttachments)) {
    const arr = meta.draftAttachments as any[];
    for (let i = 0; i < arr.length; i += 1) {
      const att = arr[i];
      if (!att || typeof att !== 'object') continue;
      const kind = safeString(att.kind);
      const data = typeof att.data === 'string' ? att.data : '';
      if (!data) continue;
      const fallbackMt = kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/png' : 'application/octet-stream';
      const mt = safeString(att.mimeType).trim() || fallbackMt;
      try {
        const blob = base64ToBlob(data, mt);
        const storageKey = await putAttachment({
          blob,
          mimeType: mt,
          name: safeString(att.name).trim() || undefined,
          size: Number.isFinite(Number(att.size)) ? Number(att.size) : undefined,
        });
        const next = { ...att, storageKey, mimeType: mt } as any;
        delete next.data;
        arr[i] = next;
      } catch {
        warnings.push('Failed to import draft attachment');
      }
    }
    meta.draftAttachments = arr;
  }

  // Import background (per chat) as a new background-library item.
  let backgroundLibraryItem: BackgroundLibraryItem | null = null;
  const bg = rawChat.background && typeof rawChat.background === 'object' ? rawChat.background : null;
  const bgData = bg ? safeString(bg.data) : '';
  if (includeBackgroundFromArchive && bg && bgData) {
    const bgNameRaw = safeString(bg.name).trim() || 'Background';
    const bgName = stripExt(bgNameRaw) || bgNameRaw;
    const mt = safeString(bg.mimeType).trim() || 'image/png';
    try {
      const blob = base64ToBlob(bgData, mt);
      const storageKey = await putAttachment({
        blob,
        mimeType: mt,
        name: bgNameRaw,
        size: Number.isFinite(Number(bg.size)) ? Number(bg.size) : undefined,
      });
      meta.backgroundStorageKey = storageKey;
      backgroundLibraryItem = {
        id: storageKey,
        storageKey,
        name: bgName,
        createdAt: Date.now(),
        ...(mt ? { mimeType: mt } : {}),
        ...(Number.isFinite(Number(bg.size)) ? { size: Number(bg.size) } : {}),
      };
    } catch {
      warnings.push('Failed to import background image');
    }
  }

  const chatName = makeImportedName(safeString(rawChat.name));
  const state: WorldEngineChatState = {
    camera,
    nodes: nodes as ChatNode[],
    worldInkStrokes,
    pdfStates: [],
  };

  return {
    chatId,
    chatName,
    ...(folderPath.length ? { folderPath } : {}),
    state,
    meta,
    backgroundLibraryItem,
    warnings,
  };
}
