import systemInstructions from './SystemInstructions.md?raw';
import type { ChatAttachment, ChatNode } from '../model/chat';
import { DEFAULT_MODEL_ID, getModelInfo } from './registry';
import { inkNodeToPngBase64, type InkExportOptions } from './inkExport';
import { blobToDataUrl, getAttachment as getStoredAttachment } from '../storage/attachments';

export type XaiChatSettings = {
  modelId: string;
  webSearchEnabled?: boolean;
  inkExport?: InkExportOptions;
};

const INK_NODE_IMAGE_PREFACE =
  'The contents of this message are in the provided image.';

async function attachmentToXaiContent(att: ChatAttachment): Promise<any | null> {
  if (!att) return null;
  if (att.kind !== 'image') return null;

  const materializeDataUrl = async (fallbackMimeType: string): Promise<string | null> => {
    if (typeof (att as any).data === 'string' && (att as any).data) {
      const mimeType = typeof att.mimeType === 'string' && att.mimeType ? att.mimeType : fallbackMimeType;
      return `data:${mimeType};base64,${(att as any).data}`;
    }
    const storageKey = typeof (att as any).storageKey === 'string' ? String((att as any).storageKey).trim() : '';
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

  const dataUrl = await materializeDataUrl('image/png');
  if (!dataUrl) return null;
  const detail = typeof (att as any).detail === 'string' ? (att as any).detail : 'auto';
  return { type: 'input_image', image_url: dataUrl, detail };
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

async function buildXaiInputFromChatNodes(args: {
  nodes: ChatNode[];
  leafUserNodeId: string;
  inkExport?: InkExportOptions;
}): Promise<any[]> {
  const nodes = Array.isArray(args.nodes) ? args.nodes : [];
  const leafUserNodeId = String(args.leafUserNodeId ?? '').trim();

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

  const input: any[] = [{ role: 'system', content: systemInstructions }];

  for (const n of chain) {
    if (n.kind === 'pdf') {
      const key = `pdf:${n.id}`;
      if (!leafSelection.has(key)) continue;
      const fileName = typeof (n as any)?.fileName === 'string' ? String((n as any).fileName).trim() : '';
      const label = fileName ? `PDF attachment omitted for xAI: ${fileName}` : 'PDF attachment omitted for xAI.';
      input.push({ role: 'user', content: [{ type: 'input_text', text: `[${label}]` }] });
      continue;
    }

    if (n.kind === 'ink') {
      const exported = await inkNodeToPngBase64(n, args.inkExport);
      if (!exported) {
        if (n.id === leafUserNodeId) throw new Error('Failed to rasterize ink node for sending.');
        continue;
      }

      const content: any[] = [];
      const prefaceText = buildInkTurnText(n);
      if (prefaceText.trim()) content.push({ type: 'input_text', text: prefaceText });
      const att: ChatAttachment = { kind: 'image', mimeType: 'image/png', data: exported.base64, detail: 'auto' };
      const part = await attachmentToXaiContent(att);
      if (part) content.push(part);

      const atts = Array.isArray((n as any)?.attachments) ? ((n as any).attachments as ChatAttachment[]) : [];
      for (let i = 0; i < atts.length; i += 1) {
        const nodeAtt = atts[i];
        if (!nodeAtt) continue;
        if (nodeAtt.kind === 'ink') continue;
        const key = `${n.id}:${i}`;
        const includeOwn = n.id === leafUserNodeId;
        if (!includeOwn && !leafSelection.has(key)) continue;

        if (nodeAtt.kind === 'image') {
          const p = await attachmentToXaiContent(nodeAtt);
          if (p) content.push(p);
        } else if (nodeAtt.kind === 'pdf') {
          const name = typeof (nodeAtt as any)?.name === 'string' ? String((nodeAtt as any).name).trim() : '';
          const label = name ? `PDF attachment omitted for xAI: ${name}` : 'PDF attachment omitted for xAI.';
          content.push({ type: 'input_text', text: `[${label}]` });
        }
      }

      if (content.length) input.push({ role: 'user', content });
      continue;
    }

    if (n.kind !== 'text') continue;

    if (n.author === 'user') {
      const content: any[] = [];
      const userText = buildUserTurnText(n);
      if (userText.trim()) content.push({ type: 'input_text', text: userText });

      const atts = Array.isArray((n as any)?.attachments) ? ((n as any).attachments as ChatAttachment[]) : [];
      for (let i = 0; i < atts.length; i += 1) {
        const att = atts[i];
        if (!att) continue;
        if (att.kind === 'ink') continue;
        const key = `${n.id}:${i}`;
        const includeOwn = n.id === leafUserNodeId;
        if (!includeOwn && !leafSelection.has(key)) continue;

        if (att.kind === 'image') {
          const part = await attachmentToXaiContent(att);
          if (part) content.push(part);
        } else if (att.kind === 'pdf') {
          const name = typeof (att as any)?.name === 'string' ? String((att as any).name).trim() : '';
          const label = name ? `PDF attachment omitted for xAI: ${name}` : 'PDF attachment omitted for xAI.';
          content.push({ type: 'input_text', text: `[${label}]` });
        }
      }

      if (content.length) input.push({ role: 'user', content });
      continue;
    }

    const text = typeof n.content === 'string' ? n.content : String((n as any)?.content ?? '');
    const canonical = (n as any).canonicalMessage;
    const canonicalText = canonical && typeof canonical.text === 'string' ? canonical.text : '';
    const assistantText = canonicalText || text;
    if (assistantText.trim()) input.push({ role: 'assistant', content: assistantText });
  }

  return input;
}

export async function buildXaiResponseRequest(args: {
  nodes: ChatNode[];
  leafUserNodeId: string;
  settings: XaiChatSettings;
}): Promise<Record<string, unknown>> {
  const modelId = args.settings.modelId || DEFAULT_MODEL_ID;
  const info = getModelInfo(modelId);
  const apiModel = info?.apiModel || modelId;

  const input = await buildXaiInputFromChatNodes({
    nodes: args.nodes ?? [],
    leafUserNodeId: args.leafUserNodeId,
    inkExport: args.settings.inkExport,
  });

  const body: any = {
    model: apiModel,
    input,
    store: false,
  };

  if (args.settings.webSearchEnabled && info?.parameters.webSearch) {
    body.tools = [{ type: 'web_search' }];
    body.tool_choice = 'auto';
  }

  return body as Record<string, unknown>;
}

