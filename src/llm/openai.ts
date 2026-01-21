import systemInstructions from './SystemInstructions.md?raw';
import type { ChatNode } from '../model/chat';
import { DEFAULT_MODEL_ID, getModelInfo, type TextVerbosity } from './registry';
import { blobToDataUrl, getAttachment as getStoredAttachment } from '../storage/attachments';
import { getPayload } from '../storage/payloads';

export type OpenAIChatSettings = {
  modelId: string;
  verbosity?: TextVerbosity;
  webSearchEnabled?: boolean;
};

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
    const base64 = await materializeBase64('application/pdf');
    if (!base64) return null;
    const fileBlock: any = { type: 'input_file', file_data: base64 };
    if (typeof att.name === 'string' && att.name.trim()) fileBlock.filename = att.name.trim();
    return fileBlock;
  }

  return null;
}

async function buildOpenAIInputFromChatNodes(nodes: ChatNode[], leafUserNodeId: string): Promise<any[]> {
  const byId = new Map<string, ChatNode>();
  for (const n of nodes) byId.set(n.id, n);

  const leafSelection = (() => {
    const leaf = byId.get(leafUserNodeId) ?? null;
    const selected =
      leaf && leaf.kind === 'text' && Array.isArray((leaf as any)?.selectedAttachmentKeys)
        ? ((leaf as any).selectedAttachmentKeys as string[])
        : [];
    return new Set<string>(selected);
  })();

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
    if (n.author === 'user') {
      const content: any[] = [];
      if (text.trim()) content.push({ type: 'input_text', text });

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
  const input = await buildOpenAIInputFromChatNodes(args.nodes, args.leafUserNodeId);

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
    if (info.reasoningSummary) body.reasoning.summary = 'auto';
    const existingInclude = Array.isArray(body.include) ? body.include : [];
    if (!existingInclude.includes('reasoning.encrypted_content')) {
      body.include = [...existingInclude, 'reasoning.encrypted_content'];
    }
  }

  return body as Record<string, unknown>;
}
