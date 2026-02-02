import systemInstructions from './SystemInstructions.md?raw';
import type { ChatAttachment, ChatNode } from '../model/chat';
import { DEFAULT_MODEL_ID, getModelInfo, type TextVerbosity } from './registry';
import { inkNodeToPngBase64, type InkExportOptions } from './inkExport';
import { blobToDataUrl, getAttachment as getStoredAttachment } from '../storage/attachments';
import { getPayload } from '../storage/payloads';

export type OpenAIChatSettings = {
  modelId: string;
  verbosity?: TextVerbosity;
  webSearchEnabled?: boolean;
  reasoningSummary?: 'auto' | 'detailed' | 'off';
  stream?: boolean;
  background?: boolean;
  inkExport?: InkExportOptions;
};

const INK_NODE_IMAGE_PREFACE =
  'The contents of this message are in the provided image.';

async function attachmentToOpenAIContent(att: any): Promise<any | null> {
  if (!att) return null;

  const materializeDataUrl = async (fallbackMimeType: string): Promise<string | null> => {
    if (typeof att.data === 'string' && att.data) {
      const mimeType = typeof att.mimeType === 'string' && att.mimeType ? att.mimeType : fallbackMimeType;
      return `data:${mimeType};base64,${att.data}`;
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
      return await blobToDataUrl(rec.blob, mimeType);
    } catch {
      return null;
    }
  };

  const materializeBase64 = async (fallbackMimeType: string): Promise<string | null> => {
    if (typeof att.data === 'string' && att.data) return att.data;
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
      const comma = dataUrl.indexOf(',');
      if (comma === -1) return null;
      const base64 = dataUrl.slice(comma + 1);
      return base64 ? base64 : null;
    } catch {
      return null;
    }
  };

  if (att.kind === 'image') {
    const dataUrl = await materializeDataUrl('image/png');
    if (!dataUrl) return null;
    const detail = typeof att.detail === 'string' ? att.detail : 'auto';
    return { type: 'input_image', image_url: dataUrl, detail };
  }

  if (att.kind === 'pdf' || att.mimeType === 'application/pdf') {
    const dataUrl = await materializeDataUrl('application/pdf');
    if (!dataUrl) return null;
    const fileBlock: any = { type: 'input_file', file_data: dataUrl };
    if (typeof att.name === 'string' && att.name.trim()) fileBlock.filename = att.name.trim();
    return fileBlock;
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

async function buildOpenAIInputFromChatNodes(
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
      leaf && leaf.kind === 'text' && Array.isArray((leaf as any)?.selectedAttachmentKeys)
        ? ((leaf as any).selectedAttachmentKeys as string[])
        : [];
    const set = new Set<string>(selected);

    // Ink nodes don't currently have a per-send attachment selector, but if the ink
    // node is anchored under a PDF we still want the PDF file included in the request.
    if (leaf?.kind === 'ink') {
      for (const n of chain) {
        if (n.kind !== 'pdf') continue;
        set.add(`pdf:${n.id}`);
      }
    }

    return set;
  })();

  const input: any[] = [];

  for (const n of chain) {
    if (n.kind === 'pdf') {
      const key = `pdf:${n.id}`;
      if (!leafSelection.has(key)) continue;
      const storageKey = typeof (n as any)?.storageKey === 'string' ? String((n as any).storageKey).trim() : '';
      if (!storageKey) continue;
      const name = typeof (n as any)?.fileName === 'string' ? String((n as any).fileName).trim() : '';
      const att: ChatAttachment = {
        kind: 'pdf',
        mimeType: 'application/pdf',
        storageKey,
        ...(name ? { name } : {}),
      };
      const part = await attachmentToOpenAIContent(att);
      if (part) input.push({ role: 'user', content: [part] });
      continue;
    }
    if (n.kind === 'ink') {
      const exported = await inkNodeToPngBase64(n, opts?.inkExport);
      if (!exported) {
        if (n.id === leafUserNodeId) throw new Error('Failed to rasterize ink node for sending.');
        continue;
      }
      const att: ChatAttachment = { kind: 'image', mimeType: 'image/png', data: exported.base64, detail: 'auto' };
      const part = await attachmentToOpenAIContent(att);
      if (part) {
        const prefaceText = buildInkTurnText(n);
        input.push({
          role: 'user',
          content: [
            { type: 'input_text', text: prefaceText },
            part,
          ],
        });
      }
      continue;
    }
    if (n.kind !== 'text') continue;
    if (n.author === 'user') {
      const content: any[] = [];
      const userText = buildUserTurnText(n);
      if (userText.trim()) content.push({ type: 'input_text', text: userText });

      const atts = Array.isArray((n as any)?.attachments) ? ((n as any).attachments as any[]) : [];
      for (let i = 0; i < atts.length; i += 1) {
        const att = atts[i];
        if (!att) continue;
        const key = `${n.id}:${i}`;
        const includeOwn = n.id === leafUserNodeId;
        if (!includeOwn && !leafSelection.has(key)) continue;
        const part = await attachmentToOpenAIContent(att);
        if (part) content.push(part);
      }

      if (content.length) input.push({ role: 'user', content });
    } else {
      const text = typeof n.content === 'string' ? n.content : String((n as any)?.content ?? '');
      const modelId = typeof (n as any)?.modelId === 'string' ? String((n as any).modelId) : '';
      const info = modelId ? getModelInfo(modelId) : undefined;
      const provider = info?.provider ?? 'openai';

      if (provider === 'openai') {
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

        if (raw && Array.isArray(raw.output)) {
          input.push(...raw.output);
          continue;
        }
      }

      const canonical = (n as any).canonicalMessage;
      const canonicalText = canonical && typeof canonical.text === 'string' ? canonical.text : '';
      const assistantText = canonicalText || text;
      if (assistantText.trim()) input.push({ role: 'assistant', content: [{ type: 'output_text', text: assistantText }] });
    }
  }
  return input;
}

function supportsVerbosity(modelApiName: string): boolean {
  return typeof modelApiName === 'string' && modelApiName.startsWith('gpt-5');
}

export async function buildOpenAIResponseRequest(args: {
  nodes: ChatNode[];
  leafUserNodeId: string;
  settings: OpenAIChatSettings;
}): Promise<Record<string, unknown>> {
  const modelId = args.settings.modelId || DEFAULT_MODEL_ID;
  const info = getModelInfo(modelId);
  const apiModel = info?.apiModel || modelId;
  const input = await buildOpenAIInputFromChatNodes(args.nodes, args.leafUserNodeId, { inkExport: args.settings.inkExport });

  const body: any = {
    model: apiModel,
    input,
    instructions: systemInstructions,
    store: true,
  };

  const verbosity = args.settings.verbosity ?? info?.defaults?.verbosity;
  if (verbosity && supportsVerbosity(apiModel)) {
    body.text = { verbosity };
  }

  if (args.settings.webSearchEnabled && info?.parameters.webSearch) {
    body.tools = [{ type: 'web_search' }];
    body.tool_choice = 'auto';
  }

  if (info?.effort) {
    body.reasoning = { effort: info.effort };
    const summary = args.settings.reasoningSummary ?? (info.reasoningSummary ? 'auto' : 'off');
    if (summary && summary !== 'off') body.reasoning.summary = summary;
    const existingInclude = Array.isArray(body.include) ? body.include : [];
    if (!existingInclude.includes('reasoning.encrypted_content')) {
      body.include = [...existingInclude, 'reasoning.encrypted_content'];
    }
  }

  return body as Record<string, unknown>;
}
