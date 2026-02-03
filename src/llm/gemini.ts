import systemInstructions from './SystemInstructions.md?raw';
import type { ChatAttachment, ChatNode } from '../model/chat';
import { DEFAULT_MODEL_ID, getModelInfo } from './registry';
import { inkNodeToPngBase64, type InkExportOptions } from './inkExport';
import { getAttachment as getStoredAttachment } from '../storage/attachments';
import { getPayload, putPayload } from '../storage/payloads';
import { GoogleGenAI } from '@google/genai';

export type GeminiFileMeta = { name: string; uri: string; mimeType: string };

const INK_NODE_IMAGE_PREFACE =
  'The contents of this message are in the provided image.';

export type GeminiMessage = {
  role: 'user' | 'model';
  parts: any[];
};

export type BuiltGeminiContext = {
  request: any;
  requestSnapshot: any;
};

export type GeminiChatSettings = {
  modelId: string;
  webSearchEnabled?: boolean;
  inkExport?: InkExportOptions;
};

function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function tryGetGeminiFile(ai: any, meta: GeminiFileMeta): Promise<GeminiFileMeta | null> {
  try {
    const files = (ai as any)?.files;
    if (!files || !files.get) return null;
    const res = await files.get(meta.name);
    const state = String(res?.state ?? res?.file?.state ?? '');
    if (state === 'ACTIVE') return meta;
    return null;
  } catch {
    return null;
  }
}

async function uploadGeminiFile(args: {
  ai: any;
  blob: Blob;
  mimeType: string;
  filename?: string;
}): Promise<GeminiFileMeta> {
  const files = (args.ai as any)?.files;
  if (!files || !files.upload) throw new Error('Gemini Files API not available in SDK.');
  const result = await files.upload({
    file: args.blob,
    mimeType: args.mimeType,
    displayName: args.filename || undefined,
  });
  const file = (result?.file ?? result) as any;
  const uri = String(file?.uri ?? file?.fileUri ?? file?.path ?? '');
  const name = String(file?.name ?? '');
  if (!uri || !name) throw new Error('Upload succeeded but file URI/name missing.');
  return { name, uri, mimeType: args.mimeType };
}

async function ensureGeminiFile(args: {
  ai: any;
  blob: Blob;
  mimeType: string;
  filename?: string;
  storageKey?: string;
}): Promise<GeminiFileMeta> {
  const storageKey = typeof args.storageKey === 'string' ? args.storageKey.trim() : '';
  if (storageKey) {
    const cacheKey = `gemini/${storageKey}`;
    try {
      const cached = await getPayload(cacheKey);
      if (cached && (cached as any).name && (cached as any).uri) {
        const ok = await tryGetGeminiFile(args.ai, cached as GeminiFileMeta);
        if (ok) return ok;
      }
    } catch {
      // ignore
    }
  }

  const meta = await uploadGeminiFile({ ai: args.ai, blob: args.blob, mimeType: args.mimeType, filename: args.filename });
  if (storageKey) {
    const cacheKey = `gemini/${storageKey}`;
    try {
      await putPayload({ key: cacheKey, json: meta });
    } catch {
      // ignore
    }
  }
  return meta;
}

async function attachmentToBlob(att: ChatAttachment): Promise<{
  blob: Blob;
  mimeType: string;
  filename?: string;
  storageKey?: string;
} | null> {
  if (!att) return null;
  if (att.kind !== 'image' && att.kind !== 'pdf') return null;

  const fallbackMimeType = att.kind === 'pdf' ? 'application/pdf' : 'image/png';
  const filename = typeof att.name === 'string' && att.name.trim() ? att.name.trim() : undefined;
  const storageKey = typeof (att as any).storageKey === 'string' ? String((att as any).storageKey).trim() : '';

  if (storageKey) {
    try {
      const rec = await getStoredAttachment(storageKey);
      if (rec?.blob) {
        const mimeType =
          (typeof rec.mimeType === 'string' && rec.mimeType) ||
          (typeof (att as any).mimeType === 'string' && (att as any).mimeType) ||
          fallbackMimeType;
        return { blob: rec.blob, mimeType, filename, storageKey };
      }
    } catch {
      // fall through to inline
    }
  }

  const b64 = typeof (att as any).data === 'string' ? String((att as any).data) : '';
  if (!b64) return null;
  try {
    const mimeType = (typeof (att as any).mimeType === 'string' && (att as any).mimeType) || fallbackMimeType;
    return { blob: base64ToBlob(b64, mimeType), mimeType, filename };
  } catch {
    return null;
  }
}

async function buildAttachmentPartsForUserNode(args: {
  node: Extract<ChatNode, { kind: 'text' }>;
  includeOwn: boolean;
  allowedKeys: Set<string>;
  ai: any | null;
}): Promise<any[]> {
  return buildAttachmentPartsForNodeAttachments({
    nodeId: args.node.id,
    attachments: Array.isArray(args.node.attachments) ? args.node.attachments : [],
    includeOwn: args.includeOwn,
    allowedKeys: args.allowedKeys,
    ai: args.ai,
  });
}

async function buildAttachmentPartsForNodeAttachments(args: {
  nodeId: string;
  attachments: ChatAttachment[];
  includeOwn: boolean;
  allowedKeys: Set<string>;
  ai: any | null;
}): Promise<any[]> {
  const parts: any[] = [];
  const nodeId = String(args.nodeId ?? '').trim();
  const attArr: ChatAttachment[] = Array.isArray(args.attachments) ? args.attachments : [];

  for (let i = 0; i < attArr.length; i += 1) {
    const att = attArr[i];
    if (!att) continue;
    if (att.kind === 'ink') continue;

    const key = `${nodeId}:${i}`;
    if (!args.includeOwn && !args.allowedKeys.has(key)) continue;

    if (!args.ai) {
      parts.push({ text: '[Attachment omitted: Gemini API client unavailable when building request.]' });
      continue;
    }

    const materialized = await attachmentToBlob(att);
    if (!materialized?.blob) {
      parts.push({
        text: att.kind === 'pdf' ? '[Attachment omitted: failed to read file from storage.]' : '[Attachment omitted: failed to read image from storage.]',
      });
      continue;
    }

    try {
      const meta = await ensureGeminiFile({
        ai: args.ai,
        blob: materialized.blob,
        mimeType: materialized.mimeType,
        filename: materialized.filename,
        storageKey: materialized.storageKey,
      });
      parts.push({ fileData: { fileUri: meta.uri, mimeType: meta.mimeType } });
    } catch {
      parts.push({
        text: att.kind === 'pdf'
          ? '[Attachment omitted: failed to upload file to Gemini Files API.]'
          : '[Attachment omitted: failed to upload image to Gemini Files API.]',
      });
    }
  }

  return parts;
}

function buildUserTurnText(node: Extract<ChatNode, { kind: 'text' }>): string {
  const lines: string[] = [];
  const replyTo = (node.userPreface?.replyTo ?? '').trim();
  if (replyTo) lines.push(`Replying to: ${replyTo}`);

  const ctxRaw = Array.isArray(node.userPreface?.contexts) ? node.userPreface!.contexts! : [];
  const ctx = ctxRaw.map((t) => String(t ?? '').trim()).filter(Boolean);
  for (let i = 0; i < ctx.length; i += 1) lines.push(`Context ${i + 1}: ${ctx[i]}`);

  const body = typeof node.content === 'string' ? node.content : '';
  if (lines.length === 0) return body;
  if (body.trim()) return `${lines.join('\n')}\n\n${body}`;
  return lines.join('\n');
}

function buildInkTurnText(node: Extract<ChatNode, { kind: 'ink' }>): string {
  const lines: string[] = [];
  const replyTo = (node.userPreface?.replyTo ?? '').trim();
  if (replyTo) lines.push(`Replying to: ${replyTo}`);

  const ctxRaw = Array.isArray(node.userPreface?.contexts) ? node.userPreface!.contexts! : [];
  const ctx = ctxRaw.map((t) => String(t ?? '').trim()).filter(Boolean);
  for (let i = 0; i < ctx.length; i += 1) lines.push(`Context ${i + 1}: ${ctx[i]}`);

  if (lines.length) lines.push('');
  lines.push(INK_NODE_IMAGE_PREFACE);
  return lines.join('\n');
}

async function buildGeminiHistory(args: {
  nodes: ChatNode[];
  leafUserNodeId: string;
  ai: any | null;
  inkExport?: InkExportOptions;
}): Promise<GeminiMessage[]> {
  const byId = new Map<string, ChatNode>();
  for (const n of args.nodes) byId.set(n.id, n);

  const chain: ChatNode[] = [];
  let cur: ChatNode | null = byId.get(args.leafUserNodeId) ?? null;
  while (cur) {
    chain.push(cur);
    const parentId = (cur as any)?.parentId as string | null | undefined;
    if (!parentId) break;
    cur = byId.get(parentId) ?? null;
  }
  chain.reverse();

  const leafSelection = (() => {
    const leaf = byId.get(args.leafUserNodeId) ?? null;
    const selected =
      leaf && (leaf.kind === 'text' || leaf.kind === 'ink') && Array.isArray((leaf as any)?.selectedAttachmentKeys)
        ? ((leaf as any).selectedAttachmentKeys as string[])
        : [];
    const set = new Set<string>(selected);

    // If the ink node is anchored under a PDF we still want the PDF file included in the request.
    if (leaf?.kind === 'ink') {
      for (const n of chain) {
        if (n.kind !== 'pdf') continue;
        set.add(`pdf:${n.id}`);
      }
    }

    return set;
  })();

  const history: GeminiMessage[] = [];
  for (const n of chain) {
    if (n.kind === 'pdf') {
      const key = `pdf:${n.id}`;
      if (!leafSelection.has(key)) continue;

      const storageKey = typeof (n as any)?.storageKey === 'string' ? String((n as any).storageKey).trim() : '';
      if (!storageKey) continue;

      if (!args.ai) {
        history.push({
          role: 'user',
          parts: [{ text: '[Attachment omitted: Gemini API client unavailable when building request.]' }],
        });
        continue;
      }

      let rec: { blob: Blob; mimeType?: string } | null = null;
      try {
        rec = await getStoredAttachment(storageKey);
      } catch {
        rec = null;
      }
      if (!rec?.blob) {
        history.push({
          role: 'user',
          parts: [{ text: '[Attachment omitted: failed to read file from storage.]' }],
        });
        continue;
      }

      const filename = typeof (n as any)?.fileName === 'string' && String((n as any).fileName).trim() ? String((n as any).fileName).trim() : undefined;
      const mimeType = (typeof (rec as any)?.mimeType === 'string' && String((rec as any).mimeType).trim()) ? String((rec as any).mimeType).trim() : 'application/pdf';

      try {
        const meta = await ensureGeminiFile({
          ai: args.ai,
          blob: rec.blob,
          mimeType,
          filename,
          storageKey,
        });
        history.push({ role: 'user', parts: [{ fileData: { fileUri: meta.uri, mimeType: meta.mimeType } }] });
      } catch {
        history.push({
          role: 'user',
          parts: [{ text: '[Attachment omitted: failed to upload file to Gemini Files API.]' }],
        });
      }
      continue;
    }

    if (n.kind === 'ink') {
      const exported = await inkNodeToPngBase64(n, args.inkExport);
      if (!exported) {
        if (n.id === args.leafUserNodeId) throw new Error('Failed to rasterize ink node for sending.');
        continue;
      }

      if (!args.ai) {
        history.push({
          role: 'user',
          parts: [{ text: '[Attachment omitted: Gemini API client unavailable when building request.]' }],
        });
        continue;
      }

      try {
        const blob = base64ToBlob(exported.base64, exported.mimeType);
        const meta = await ensureGeminiFile({
          ai: args.ai,
          blob,
          mimeType: exported.mimeType,
          filename: `ink-${n.id}.png`,
        });
        const prefaceText = buildInkTurnText(n);
        const parts: any[] = [];
        if (prefaceText.trim()) parts.push({ text: prefaceText });
        parts.push({ fileData: { fileUri: meta.uri, mimeType: meta.mimeType } });

        const includeOwn = n.id === args.leafUserNodeId;
        const atts = Array.isArray((n as any)?.attachments) ? ((n as any).attachments as ChatAttachment[]) : [];
        const attParts = await buildAttachmentPartsForNodeAttachments({
          nodeId: n.id,
          attachments: atts,
          includeOwn,
          allowedKeys: leafSelection,
          ai: args.ai,
        });
        parts.push(...attParts);
        history.push({
          role: 'user',
          parts: parts.length ? parts : [{ text: '' }],
        });
      } catch {
        history.push({
          role: 'user',
          parts: [{ text: '[Attachment omitted: failed to upload image to Gemini Files API.]' }],
        });
      }
      continue;
    }

    if (n.kind !== 'text') continue;

    if (n.author === 'user') {
      const parts: any[] = [];
      const userText = buildUserTurnText(n);
      if (userText.trim()) parts.push({ text: userText });
      const includeOwn = n.id === args.leafUserNodeId;
      const attParts = await buildAttachmentPartsForUserNode({
        node: n,
        includeOwn,
        allowedKeys: leafSelection,
        ai: args.ai,
      });
      parts.push(...attParts);
      history.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }

    const text = typeof n.content === 'string' ? n.content : String((n as any)?.content ?? '');
    const modelId = typeof (n as any)?.modelId === 'string' ? String((n as any).modelId) : '';
    const info = modelId ? getModelInfo(modelId) : undefined;
    const provider = info?.provider ?? 'openai';

    if (provider === 'gemini') {
      let raw: any = null;
      const responseKey = typeof (n as any)?.apiResponseKey === 'string' ? String((n as any).apiResponseKey).trim() : '';
      if (responseKey) {
        try {
          raw = await getPayload(responseKey);
        } catch {
          raw = null;
        }
      }
      if (!raw && (n as any).apiResponse !== undefined) raw = (n as any).apiResponse;

      const fromCandidates = raw && Array.isArray(raw.candidates) ? raw.candidates[0]?.content : undefined;
      if (fromCandidates && Array.isArray(fromCandidates.parts)) {
        history.push({
          role: fromCandidates.role === 'user' ? 'user' : 'model',
          parts: fromCandidates.parts,
        });
        continue;
      }
    }

    const canonical = (n as any).canonicalMessage;
    const canonicalText = canonical && typeof canonical.text === 'string' ? canonical.text : '';
    const assistantText = canonicalText || text;
    history.push({ role: 'model', parts: [{ text: assistantText }] });
  }

  return history;
}

export async function buildGeminiContext(args: {
  nodes: ChatNode[];
  leafUserNodeId: string;
  settings: GeminiChatSettings;
}): Promise<BuiltGeminiContext> {
  const modelId = args.settings.modelId || DEFAULT_MODEL_ID;
  const info = getModelInfo(modelId);
  const apiModel = info?.apiModel || modelId;

  const apiKey = String(import.meta.env.GEMINI_API_KEY ?? '').trim();
  let ai: any | null = null;
  if (apiKey) {
    try {
      ai = new GoogleGenAI({ apiKey });
    } catch {
      ai = null;
    }
  }

  const history = await buildGeminiHistory({
    nodes: args.nodes ?? [],
    leafUserNodeId: args.leafUserNodeId,
    ai,
    inkExport: args.settings.inkExport,
  });
  const request: any = {
    model: apiModel,
    contents: history,
  };

  const config: any = { systemInstruction: systemInstructions };
  if (args.settings.webSearchEnabled && info?.parameters.webSearch) {
    config.tools = [{ googleSearch: {} }];
  }
  if (info?.thinkingLevel) {
    config.thinkingConfig = { thinkingLevel: info.thinkingLevel === 'low' ? 'LOW' : 'HIGH' };
  }
  if (Object.keys(config).length > 0) request.config = config;

  let requestSnapshot: any = request;
  try {
    requestSnapshot = JSON.parse(JSON.stringify(request));
  } catch {
    // ignore snapshot failure and fall back to the original reference
  }

  return { request, requestSnapshot };
}
