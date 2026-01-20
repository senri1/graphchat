import type { Rect } from '../engine/types';

export type ChatAuthor = 'user' | 'assistant';

export type ChatLlmParams = {
  verbosity?: 'low' | 'medium' | 'high';
  webSearchEnabled?: boolean;
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
      rect: Rect;
      author: ChatAuthor;
      content: string;
      isGenerating?: boolean;
      modelId?: string | null;
      llmParams?: ChatLlmParams;
      llmError?: string | null;
      attachments?: ChatAttachment[];
      selectedAttachmentKeys?: string[];
    }
  | {
      kind: 'pdf';
      id: string;
      title: string;
      parentId: string | null;
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
      rect: Rect;
      strokes: InkStroke[];
    };
