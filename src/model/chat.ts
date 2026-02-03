import type { Rect } from '../engine/types';

export type ChatAuthor = 'user' | 'assistant';

export type ChatLlmParams = {
  verbosity?: 'low' | 'medium' | 'high';
  webSearchEnabled?: boolean;
};

export type CanonicalAssistantMessage = {
  role: 'assistant';
  text: string;
};

export type ThinkingSummaryChunk = { summaryIndex: number; text: string; done: boolean };

export type ChatLlmTask = {
  provider: string;
  kind: string;
  taskId?: string;
  cancelable?: boolean;
  background?: boolean;
  lastEventSeq?: number;
};

export type ChatAttachment =
  | {
      kind: 'image';
      name?: string;
      mimeType?: string;
      data?: string;
      storageKey?: string;
      size?: number;
      detail?: 'low' | 'auto' | 'high';
    }
  | {
      kind: 'pdf';
      name?: string;
      mimeType: 'application/pdf';
      data?: string;
      storageKey?: string;
      size?: number;
    }
  | {
      kind: 'ink';
      storageKey: string;
      rev?: number;
    };

export type InkPoint = { x: number; y: number };

export type InkStroke = {
  points: InkPoint[];
  width: number;
  color: string;
};

export type ChatNode =
  | {
      kind: 'text';
      id: string;
      title: string;
      parentId: string | null;
      parentAnchor?: { kind: 'pdf-selection'; pageNumber: number; yPct: number } | null;
      rect: Rect;
      author: ChatAuthor;
      content: string;
      userPreface?: {
        replyTo?: string;
        contexts?: string[];
      };
      collapsedPrefaceContexts?: Record<number, boolean>;
      isEditNode?: boolean;
      isGenerating?: boolean;
      modelId?: string | null;
      llmParams?: ChatLlmParams;
      llmError?: string | null;
      llmTask?: ChatLlmTask;
      apiRequest?: unknown;
      apiRequestKey?: string;
      apiResponse?: unknown;
      apiResponseKey?: string;
      canonicalMessage?: CanonicalAssistantMessage;
      canonicalMeta?: unknown;
      thinkingSummary?: ThinkingSummaryChunk[];
      summaryExpanded?: boolean;
      expandedSummaryChunks?: Record<number, boolean>;
      contentScrollY?: number;
      attachments?: ChatAttachment[];
      selectedAttachmentKeys?: string[];
    }
  | {
      kind: 'pdf';
      id: string;
      title: string;
      parentId: string | null;
      parentAnchor?: { kind: 'pdf-selection'; pageNumber: number; yPct: number } | null;
      rect: Rect;
      fileName: string | null;
      storageKey?: string | null;
      pageCount: number;
      status: 'empty' | 'loading' | 'ready' | 'error';
      error: string | null;
    }
  | {
      kind: 'ink';
      id: string;
      title: string;
      parentId: string | null;
      parentAnchor?: { kind: 'pdf-selection'; pageNumber: number; yPct: number } | null;
      rect: Rect;
      userPreface?: {
        replyTo?: string;
        contexts?: string[];
      };
      collapsedPrefaceContexts?: Record<number, boolean>;
      strokes: InkStroke[];
      attachments?: ChatAttachment[];
      selectedAttachmentKeys?: string[];
    };
