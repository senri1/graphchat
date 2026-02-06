import type { ChatAttachment, ChatNode } from '../model/chat';
import { DEFAULT_MODEL_ID, getModelInfo } from './registry';
import { normalizeAnthropicEffort, type AnthropicEffortSetting } from './modelUserSettings';
import { inkNodeToPngBase64, type InkExportOptions } from './inkExport';
import { blobToDataUrl, getAttachment as getStoredAttachment } from '../storage/attachments';
import { getPayload } from '../storage/payloads';
import { splitDataUrl } from '../utils/files';
import { resolveSystemInstruction } from './systemInstructions';

export type AnthropicChatSettings = {
  modelId: string;
  webSearchEnabled?: boolean;
  stream?: boolean;
  maxTokens?: number;
  effort?: AnthropicEffortSetting;
  systemInstruction?: string;
  inkExport?: InkExportOptions;
};

const INK_NODE_IMAGE_PREFACE =
  'The contents of this message are in the provided image.';

async function attachmentToAnthropicContentBlock(att: any): Promise<any | null> {
  if (!att) return null;

  const materializeBase64 = async (fallbackMimeType: string): Promise<{ mimeType: string; base64: string } | null> => {
    if (typeof att.data === 'string' && att.data) {
      const mimeType = typeof att.mimeType === 'string' && att.mimeType ? att.mimeType : fallbackMimeType;
      return { mimeType, base64: att.data };
    }

    const storageKey = typeof att.storageKey === 'string' ? (att.storageKey as string) : '';
    if (!storageKey) return null;

    try {
      const rec = await getStoredAttachment(storageKey);
      if (!rec?.blob) return null;
      const mimeType =
        (typeof rec.mimeType === 'string' && rec.mimeType) ||
        (typeof att.mimeType === 'string' && att.mimeType) ||
        fallbackMimeType;
      const dataUrl = await blobToDataUrl(rec.blob, mimeType);
      const parts = splitDataUrl(dataUrl);
      if (!parts?.base64) return null;
      return { mimeType: parts.mimeType || mimeType, base64: parts.base64 };
    } catch {
      return null;
    }
  };

  if (att.kind === 'image') {
    const got = await materializeBase64('image/png');
    if (!got) return null;
    const mediaType = typeof got.mimeType === 'string' && got.mimeType ? got.mimeType : 'image/png';
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: got.base64 },
    };
  }

  if (att.kind === 'pdf' || att.mimeType === 'application/pdf') {
    const got = await materializeBase64('application/pdf');
    if (!got) return null;
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: got.base64 },
    };
  }

  return null;
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

async function buildAnthropicMessagesFromChatNodes(
  nodes: ChatNode[],
  leafUserNodeId: string,
  opts?: { inkExport?: InkExportOptions },
): Promise<any[]> {
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

  const leafSelection = (() => {
    const leaf = byId.get(leafUserNodeId) ?? null;
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

  const messages: any[] = [];

  for (const n of chain) {
    if (n.kind === 'pdf') {
      const key = `pdf:${n.id}`;
      if (!leafSelection.has(key)) continue;
      const storageKey = typeof (n as any)?.storageKey === 'string' ? String((n as any).storageKey).trim() : '';
      if (!storageKey) continue;
      const att: ChatAttachment = { kind: 'pdf', mimeType: 'application/pdf', storageKey };
      const block = await attachmentToAnthropicContentBlock(att);
      if (block) messages.push({ role: 'user', content: [block] });
      continue;
    }

    if (n.kind === 'ink') {
      const exported = await inkNodeToPngBase64(n, opts?.inkExport);
      if (!exported) {
        if (n.id === leafUserNodeId) throw new Error('Failed to rasterize ink node for sending.');
        continue;
      }
      const att: ChatAttachment = { kind: 'image', mimeType: 'image/png', data: exported.base64, detail: 'auto' };
      const block = await attachmentToAnthropicContentBlock(att);
      if (block) {
        const prefaceText = buildInkTurnText(n);
        const content: any[] = [];
        if (prefaceText.trim()) content.push({ type: 'text', text: prefaceText });
        content.push(block);

        const atts = Array.isArray((n as any)?.attachments) ? ((n as any).attachments as any[]) : [];
        for (let i = 0; i < atts.length; i += 1) {
          const nodeAtt = atts[i];
          if (!nodeAtt) continue;
          const key = `${n.id}:${i}`;
          const includeOwn = n.id === leafUserNodeId;
          if (!includeOwn && !leafSelection.has(key)) continue;
          const nodeBlock = await attachmentToAnthropicContentBlock(nodeAtt);
          if (nodeBlock) content.push(nodeBlock);
        }

        if (content.length) messages.push({ role: 'user', content });
      }
      continue;
    }

    if (n.kind !== 'text') continue;
    if (n.author === 'user') {
      const content: any[] = [];
      const userText = buildUserTurnText(n);
      if (userText.trim()) content.push({ type: 'text', text: userText });

      const atts = Array.isArray((n as any)?.attachments) ? ((n as any).attachments as any[]) : [];
      for (let i = 0; i < atts.length; i += 1) {
        const att = atts[i];
        if (!att) continue;
        const key = `${n.id}:${i}`;
        const includeOwn = n.id === leafUserNodeId;
        if (!includeOwn && !leafSelection.has(key)) continue;
        const block = await attachmentToAnthropicContentBlock(att);
        if (block) content.push(block);
      }

      if (content.length) messages.push({ role: 'user', content });
      continue;
    }

    const text = typeof n.content === 'string' ? n.content : String((n as any)?.content ?? '');
    const modelId = typeof (n as any)?.modelId === 'string' ? String((n as any).modelId) : '';
    const info = modelId ? getModelInfo(modelId) : undefined;
    const provider = info?.provider ?? 'openai';

    if (provider === 'anthropic') {
      let raw: any = null;
      const responseKey = typeof (n as any)?.apiResponseKey === 'string' ? String((n as any).apiResponseKey).trim() : '';
      if (responseKey) {
        try {
          raw = await getPayload(responseKey);
        } catch {
          raw = null;
        }
      }

      const rawContent = raw && typeof raw === 'object' && Array.isArray((raw as any)?.content) ? ((raw as any).content as any[]) : null;
      if (rawContent && rawContent.length > 0) {
        messages.push({ role: 'assistant', content: rawContent });
        continue;
      }

      const rawText = raw ? extractTextFromAnthropicMessage(raw) : '';
      if (rawText.trim()) {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: rawText }] });
        continue;
      }
    }

    const canonical = (n as any).canonicalMessage;
    const canonicalText = canonical && typeof canonical.text === 'string' ? canonical.text : '';
    const assistantText = canonicalText || text;
    if (assistantText.trim()) messages.push({ role: 'assistant', content: [{ type: 'text', text: assistantText }] });
  }

  return messages;
}

function extractTextFromAnthropicMessage(raw: unknown): string {
  try {
    const anyRaw: any = raw as any;
    const content = Array.isArray(anyRaw?.content) ? (anyRaw.content as any[]) : [];
    return content
      .map((b) => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter((t) => typeof t === 'string' && t.length > 0)
      .join('');
  } catch {
    return '';
  }
}

export async function buildAnthropicMessageRequest(args: {
  nodes: ChatNode[];
  leafUserNodeId: string;
  settings: AnthropicChatSettings;
}): Promise<Record<string, unknown>> {
  const modelId = args.settings.modelId || DEFAULT_MODEL_ID;
  const info = getModelInfo(modelId);
  const apiModel = info?.apiModel || modelId;

  const rawMaxTokens = args.settings.maxTokens;
  const maxTokens = typeof rawMaxTokens === 'number' && Number.isFinite(rawMaxTokens) ? Math.max(1, Math.floor(rawMaxTokens)) : 4096;
  const effort = normalizeAnthropicEffort(info, args.settings.effort);
  const messages = await buildAnthropicMessagesFromChatNodes(args.nodes, args.leafUserNodeId, { inkExport: args.settings.inkExport });

  const body: any = {
    model: apiModel,
    max_tokens: maxTokens,
    system: resolveSystemInstruction(args.settings.systemInstruction),
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort },
  };

  if (args.settings.webSearchEnabled && info?.parameters.webSearch) {
    body.tools = [
      {
        type: 'web_search_20250305',
        name: 'web_search',
      },
    ];
    body.tool_choice = { type: 'auto' };
  }

  return body as Record<string, unknown>;
}
