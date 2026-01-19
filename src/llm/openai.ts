import systemInstructions from './SystemInstructions.md?raw';
import type { ChatNode } from '../model/chat';
import { DEFAULT_MODEL_ID, getModelInfo, type TextVerbosity } from './registry';

export type OpenAIChatSettings = {
  modelId: string;
  verbosity?: TextVerbosity;
  webSearchEnabled?: boolean;
};

function buildOpenAIInputFromChatNodes(nodes: ChatNode[], leafUserNodeId: string): any[] {
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

        if (att.kind === 'image') {
          const data = typeof att.data === 'string' ? att.data : '';
          if (!data) continue;
          const mimeType = typeof att.mimeType === 'string' ? att.mimeType : 'image/png';
          const detail = typeof att.detail === 'string' ? att.detail : 'auto';
          const dataUrl = `data:${mimeType};base64,${data}`;
          content.push({ type: 'input_image', image_url: dataUrl, detail });
          continue;
        }

        if (att.kind === 'pdf' || att.mimeType === 'application/pdf') {
          const data = typeof att.data === 'string' ? att.data : '';
          if (!data) continue;
          const mimeType = typeof att.mimeType === 'string' ? att.mimeType : 'application/pdf';
          const dataUrl = `data:${mimeType};base64,${data}`;
          const fileBlock: any = { type: 'input_file', file_data: dataUrl };
          if (typeof att.name === 'string' && att.name.trim()) fileBlock.filename = att.name.trim();
          content.push(fileBlock);
          continue;
        }
      }

      if (content.length) input.push({ role: 'user', content });
    } else {
      if (text.trim()) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    }
  }
  return input;
}

function supportsVerbosity(modelApiName: string): boolean {
  return typeof modelApiName === 'string' && modelApiName.startsWith('gpt-5');
}

export function buildOpenAIResponseRequest(args: {
  nodes: ChatNode[];
  leafUserNodeId: string;
  settings: OpenAIChatSettings;
}): Record<string, unknown> {
  const modelId = args.settings.modelId || DEFAULT_MODEL_ID;
  const info = getModelInfo(modelId);
  const apiModel = info?.apiModel || modelId;
  const input = buildOpenAIInputFromChatNodes(args.nodes, args.leafUserNodeId);

  const body: any = {
    model: apiModel,
    input,
    instructions: systemInstructions,
    store: false,
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
  }

  return body as Record<string, unknown>;
}
