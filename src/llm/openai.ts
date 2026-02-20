import type { ChatAttachment, ChatNode } from '../model/chat';
import { DEFAULT_MODEL_ID, getModelInfo, type TextVerbosity } from './registry';
import { inkNodeToPngBase64, type InkExportOptions } from './inkExport';
import { blobToDataUrl, getAttachment as getStoredAttachment } from '../storage/attachments';
import { getPayload } from '../storage/payloads';
import { resolveSystemInstruction } from './systemInstructions';

export type OpenAIChatSettings = {
  modelId: string;
  verbosity?: TextVerbosity;
  webSearchEnabled?: boolean;
  reasoningSummary?: 'auto' | 'detailed' | 'off';
  stream?: boolean;
  background?: boolean;
  systemInstruction?: string;
  inkExport?: InkExportOptions;
};

export const OPENAI_LATEX_TOOL_NAMES = {
  listFiles: 'latex_list_files',
  readFile: 'latex_read_file',
  writeFile: 'latex_write_file',
  replaceInFile: 'latex_replace_in_file',
} as const;

export type OpenAILatexToolName = (typeof OPENAI_LATEX_TOOL_NAMES)[keyof typeof OPENAI_LATEX_TOOL_NAMES];

export const OPENAI_GRAPH_TOOL_NAMES = {
  listNodes: 'graph_list_nodes',
  readNode: 'graph_read_node',
  searchNodes: 'graph_search_nodes',
  writeNode: 'graph_write_node',
  replaceInNode: 'graph_replace_in_node',
  createNode: 'graph_create_node',
} as const;

export type OpenAIGraphToolName = (typeof OPENAI_GRAPH_TOOL_NAMES)[keyof typeof OPENAI_GRAPH_TOOL_NAMES];

export type OpenAILatexToolContext = {
  latexNodeId: string;
  projectRoot: string;
  mainFile: string | null;
  activeFile: string | null;
};

const INK_NODE_IMAGE_PREFACE =
  'The contents of this message are in the provided image.';

const LATEX_FILE_KINDS = ['tex', 'bib', 'style', 'class', 'asset', 'other'] as const;

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
        const content: any[] = [];
        if (prefaceText.trim()) content.push({ type: 'input_text', text: prefaceText });
        content.push(part);

        const atts = Array.isArray((n as any)?.attachments) ? ((n as any).attachments as any[]) : [];
        for (let i = 0; i < atts.length; i += 1) {
          const nodeAtt = atts[i];
          if (!nodeAtt) continue;
          const key = `${n.id}:${i}`;
          const includeOwn = n.id === leafUserNodeId;
          if (!includeOwn && !leafSelection.has(key)) continue;
          const nodePart = await attachmentToOpenAIContent(nodeAtt);
          if (nodePart) content.push(nodePart);
        }

        if (content.length) input.push({ role: 'user', content });
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

function trimToNull(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return raw ? raw : null;
}

export function resolveOpenAILatexToolContext(args: {
  nodes: ChatNode[];
  leafUserNodeId: string;
}): OpenAILatexToolContext | null {
  const byId = new Map<string, ChatNode>();
  for (const n of args.nodes ?? []) byId.set(n.id, n);

  let cur: ChatNode | null = byId.get(args.leafUserNodeId) ?? null;
  while (cur) {
    if (cur.kind === 'text' && cur.textFormat === 'latex') {
      const projectRoot = trimToNull((cur as any).latexProjectRoot);
      if (projectRoot) {
        return {
          latexNodeId: cur.id,
          projectRoot,
          mainFile: trimToNull((cur as any).latexMainFile),
          activeFile: trimToNull((cur as any).latexActiveFile),
        };
      }
    }
    const parentId = trimToNull((cur as any)?.parentId);
    cur = parentId ? byId.get(parentId) ?? null : null;
  }

  return null;
}

function buildOpenAILatexToolDefinitions(): any[] {
  return [
    {
      type: 'function',
      name: OPENAI_LATEX_TOOL_NAMES.listFiles,
      description:
        'List files in the selected LaTeX project. Use this first to discover available editable files and likely targets.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path_prefix: { type: ['string', 'null'], description: 'Optional project-relative folder prefix to scope results.' },
          editable_only: { type: ['boolean', 'null'], description: 'If true, return only editable text files.' },
          kinds: {
            type: ['array', 'null'],
            description: 'Optional file kind filters.',
            items: { type: 'string', enum: LATEX_FILE_KINDS },
            maxItems: LATEX_FILE_KINDS.length,
          },
          limit: { type: ['integer', 'null'], minimum: 1, maximum: 5000, description: 'Maximum files returned in this page.' },
          cursor: { type: ['string', 'null'], description: 'Pagination cursor from a previous latex_list_files call.' },
        },
        required: ['path_prefix', 'editable_only', 'kinds', 'limit', 'cursor'],
      },
    },
    {
      type: 'function',
      name: OPENAI_LATEX_TOOL_NAMES.readFile,
      description:
        'Read a UTF-8 text file from the selected LaTeX project. Returns content, size, and a version hash for safe edits.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Project-relative file path.' },
          max_bytes: { type: ['integer', 'null'], minimum: 1, maximum: 2000000, description: 'Optional maximum bytes returned.' },
          start_line: { type: ['integer', 'null'], minimum: 1, maximum: 10000000, description: 'Optional 1-based start line.' },
          end_line: { type: ['integer', 'null'], minimum: 1, maximum: 10000000, description: 'Optional 1-based end line.' },
        },
        required: ['path', 'max_bytes', 'start_line', 'end_line'],
      },
    },
    {
      type: 'function',
      name: OPENAI_LATEX_TOOL_NAMES.writeFile,
      description:
        'Write full UTF-8 text content to a project file. Use expected_version from latex_read_file to avoid overwriting newer edits.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Project-relative file path.' },
          content: { type: 'string', description: 'Complete new file content.' },
          expected_version: {
            type: 'string',
            description:
              'Version hash from latex_read_file; write fails if file content changed. Use "missing" only for create_if_missing=true when creating a new file.',
          },
          create_if_missing: { type: ['boolean', 'null'], description: 'If true, allows creating the file if missing.' },
        },
        required: ['path', 'content', 'expected_version', 'create_if_missing'],
      },
    },
    {
      type: 'function',
      name: OPENAI_LATEX_TOOL_NAMES.replaceInFile,
      description:
        'Apply one or more literal text replacements in a UTF-8 project file. Prefer this over full rewrites for localized edits.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Project-relative file path.' },
          replacements: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                old_text: { type: 'string', description: 'Exact literal text to match.' },
                new_text: { type: 'string', description: 'Replacement text.' },
                replace_all: { type: ['boolean', 'null'], description: 'If true, replace every match in scope.' },
                start_line: { type: ['integer', 'null'], minimum: 1, maximum: 10000000, description: 'Optional 1-based start line scope.' },
                end_line: { type: ['integer', 'null'], minimum: 1, maximum: 10000000, description: 'Optional 1-based end line scope.' },
              },
              required: ['old_text', 'new_text', 'replace_all', 'start_line', 'end_line'],
            },
          },
          expected_version: {
            type: 'string',
            description: 'Version hash from latex_read_file; operation fails if file content changed.',
          },
          dry_run: { type: ['boolean', 'null'], description: 'If true, report what would change without writing.' },
          max_total_replacements: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 200000,
            description: 'Hard cap on total applied replacements for safety.',
          },
        },
        required: ['path', 'replacements', 'expected_version', 'dry_run', 'max_total_replacements'],
      },
    },
  ];
}

function buildOpenAIGraphToolDefinitions(): any[] {
  return [
    {
      type: 'function',
      name: OPENAI_GRAPH_TOOL_NAMES.listNodes,
      description:
        'List graph/chat nodes as compact digests with tree structure metadata. Use this first to discover relevant nodes, then request additional pages with cursor if needed.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root_id: {
            type: ['string', 'null'],
            description: 'Optional node id. When set, only list that node and its descendants.',
          },
          cursor: {
            type: ['string', 'null'],
            description: 'Pagination cursor from a previous graph_list_nodes call.',
          },
          limit: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 2000,
            description: 'Maximum nodes to return in this page.',
          },
          max_bytes: {
            type: ['integer', 'null'],
            minimum: 1024,
            maximum: 200000,
            description: 'Soft cap for serialized response size in UTF-8 bytes.',
          },
          summary_chars: {
            type: ['integer', 'null'],
            minimum: 48,
            maximum: 4000,
            description: 'Optional per-node summary character target; omitted means dynamic auto-sizing.',
          },
          include_metadata: {
            type: ['string', 'null'],
            enum: ['none', 'compact'],
            description: 'Metadata verbosity. "none" returns only structural essentials.',
          },
        },
        required: ['root_id', 'cursor', 'limit', 'max_bytes', 'summary_chars', 'include_metadata'],
      },
    },
    {
      type: 'function',
      name: OPENAI_GRAPH_TOOL_NAMES.readNode,
      description:
        'Read one graph node in detail. For text nodes this can return full content (or a line range); for non-text nodes it returns structured details.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_id: {
            type: 'string',
            description: 'Required target node id.',
          },
          max_bytes: {
            type: ['integer', 'null'],
            minimum: 1024,
            maximum: 2000000,
            description: 'Max UTF-8 bytes for returned content.',
          },
          start_line: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 10000000,
            description: 'Optional 1-based start line for text nodes.',
          },
          end_line: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 10000000,
            description: 'Optional 1-based end line for text nodes.',
          },
          include_metadata: {
            type: ['string', 'null'],
            enum: ['none', 'compact'],
            description: 'Metadata verbosity. "none" returns only essentials.',
          },
        },
        required: ['node_id', 'max_bytes', 'start_line', 'end_line', 'include_metadata'],
      },
    },
    {
      type: 'function',
      name: OPENAI_GRAPH_TOOL_NAMES.searchNodes,
      description:
        'Search graph nodes by lexical query over titles, text content, and node summaries. Use cursor for pagination and read nodes for details.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: 'Search query text.',
          },
          root_id: {
            type: ['string', 'null'],
            description: 'Optional node id scope. When set, only search that node and descendants.',
          },
          kinds: {
            type: ['array', 'null'],
            items: { type: 'string', enum: ['text', 'ink', 'pdf'] },
            minItems: 1,
            maxItems: 3,
            description: 'Optional node kind filter.',
          },
          cursor: {
            type: ['string', 'null'],
            description: 'Pagination cursor from a previous graph_search_nodes call.',
          },
          limit: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 2000,
            description: 'Maximum result rows to return.',
          },
          max_bytes: {
            type: ['integer', 'null'],
            minimum: 1024,
            maximum: 200000,
            description: 'Soft cap for serialized response size in UTF-8 bytes.',
          },
          summary_chars: {
            type: ['integer', 'null'],
            minimum: 48,
            maximum: 4000,
            description: 'Optional per-node summary character target; omitted means dynamic auto-sizing.',
          },
          include_metadata: {
            type: ['string', 'null'],
            enum: ['none', 'compact'],
            description: 'Metadata verbosity. "none" returns only structural essentials.',
          },
        },
        required: ['query', 'root_id', 'kinds', 'cursor', 'limit', 'max_bytes', 'summary_chars', 'include_metadata'],
      },
    },
    {
      type: 'function',
      name: OPENAI_GRAPH_TOOL_NAMES.writeNode,
      description:
        'Replace the full content of a text node. Requires expected_version from graph_read_node (or v from graph_list_nodes) to prevent stale writes.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_id: {
            type: 'string',
            description: 'Target text node id.',
          },
          content: {
            type: 'string',
            description: 'New full text content.',
          },
          expected_version: {
            type: 'string',
            description: 'Required version hash from graph_read_node or graph_list_nodes.v.',
          },
          include_metadata: {
            type: ['string', 'null'],
            enum: ['none', 'compact'],
            description: 'Metadata verbosity in the success response.',
          },
        },
        required: ['node_id', 'content', 'expected_version', 'include_metadata'],
      },
    },
    {
      type: 'function',
      name: OPENAI_GRAPH_TOOL_NAMES.replaceInNode,
      description:
        'Apply literal in-place replacements to a text node, with optional line ranges and dry-run support. Requires expected_version for concurrency safety.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_id: {
            type: 'string',
            description: 'Target text node id.',
          },
          replacements: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                old_text: { type: 'string', description: 'Exact literal text to match.' },
                new_text: { type: 'string', description: 'Replacement text.' },
                replace_all: { type: ['boolean', 'null'], description: 'If true, replace every match in scope.' },
                start_line: {
                  type: ['integer', 'null'],
                  minimum: 1,
                  maximum: 10000000,
                  description: 'Optional 1-based start line scope.',
                },
                end_line: {
                  type: ['integer', 'null'],
                  minimum: 1,
                  maximum: 10000000,
                  description: 'Optional 1-based end line scope.',
                },
              },
              required: ['old_text', 'new_text', 'replace_all', 'start_line', 'end_line'],
            },
          },
          expected_version: {
            type: 'string',
            description: 'Required version hash from graph_read_node or graph_list_nodes.v.',
          },
          dry_run: { type: ['boolean', 'null'], description: 'If true, report changes without writing.' },
          max_total_replacements: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 200000,
            description: 'Hard cap on total applied replacements.',
          },
          include_metadata: {
            type: ['string', 'null'],
            enum: ['none', 'compact'],
            description: 'Metadata verbosity in the success response.',
          },
        },
        required: [
          'node_id',
          'replacements',
          'expected_version',
          'dry_run',
          'max_total_replacements',
          'include_metadata',
        ],
      },
    },
    {
      type: 'function',
      name: OPENAI_GRAPH_TOOL_NAMES.createNode,
      description: 'Create a new text node in the current graph, optionally parented to an existing node.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: ['string', 'null'],
            enum: ['text'],
            description: 'Node kind. Currently only "text" is supported.',
          },
          parent_id: {
            type: ['string', 'null'],
            description: 'Optional parent node id.',
          },
          title: {
            type: ['string', 'null'],
            description: 'Optional title.',
          },
          content: {
            type: ['string', 'null'],
            description: 'Optional initial content.',
          },
          author: {
            type: ['string', 'null'],
            enum: ['user', 'assistant'],
            description: 'Optional author role; defaults to user.',
          },
          text_format: {
            type: ['string', 'null'],
            enum: ['markdown', 'latex'],
            description: 'Optional text format; defaults to markdown.',
          },
          include_metadata: {
            type: ['string', 'null'],
            enum: ['none', 'compact'],
            description: 'Metadata verbosity in the success response.',
          },
        },
        required: ['kind', 'parent_id', 'title', 'content', 'author', 'text_format', 'include_metadata'],
      },
    },
  ];
}

function buildOpenAILatexToolInstruction(context: OpenAILatexToolContext): string {
  const hints: string[] = [];
  if (context.activeFile) hints.push(`Active file hint: ${context.activeFile}`);
  if (context.mainFile) hints.push(`Main file hint: ${context.mainFile}`);

  const header = [
    'You can edit files in the selected LaTeX project via tools.',
    `Project root is preselected and not user-specified. ${hints.join(' ')}`.trim(),
    'For small/local edits, prefer latex_replace_in_file.',
    'Use latex_write_file only when a full rewrite is necessary.',
    'For latex_write_file and latex_replace_in_file, always pass expected_version from latex_read_file.',
    'Always read the target file before editing it.',
  ].join('\n');

  return header;
}

function buildOpenAIGraphToolInstruction(): string {
  return [
    'You can inspect and modify the current chat graph via graph_list_nodes, graph_search_nodes, graph_read_node, graph_write_node, graph_replace_in_node, and graph_create_node.',
    'When context is uncertain, use graph_search_nodes or graph_list_nodes first, then use graph_read_node for detailed inspection.',
    'Before graph_write_node or graph_replace_in_node, read the node first and pass expected_version to avoid conflicts.',
    'Do not assume omitted nodes are irrelevant when the response is truncated.',
  ].join('\n');
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
  const latexToolContext = resolveOpenAILatexToolContext({ nodes: args.nodes, leafUserNodeId: args.leafUserNodeId });
  const includeGraphTools = !Boolean(args.settings.background);

  const resolvedSystemInstruction = resolveSystemInstruction(args.settings.systemInstruction);
  const instructionsParts = [resolvedSystemInstruction];
  if (includeGraphTools) instructionsParts.push(buildOpenAIGraphToolInstruction());
  if (latexToolContext) instructionsParts.push(buildOpenAILatexToolInstruction(latexToolContext));
  const instructions = instructionsParts.filter((part) => part.trim()).join('\n\n');

  const body: any = {
    model: apiModel,
    input,
    instructions,
    store: true,
  };

  const verbosity = args.settings.verbosity ?? info?.defaults?.verbosity;
  if (verbosity && supportsVerbosity(apiModel)) {
    body.text = { verbosity };
  }

  const tools: any[] = [];
  if (args.settings.webSearchEnabled && info?.parameters.webSearch) tools.push({ type: 'web_search' });
  if (includeGraphTools) tools.push(...buildOpenAIGraphToolDefinitions());
  if (latexToolContext) {
    tools.push(...buildOpenAILatexToolDefinitions());
  }
  if (tools.some((tool) => tool?.type === 'function')) body.parallel_tool_calls = false;
  if (tools.length > 0) {
    body.tools = tools;
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
