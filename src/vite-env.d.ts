/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly OPENAI_API_KEY?: string;
  readonly GEMINI_API_KEY?: string;
  readonly XAI_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly ANTHROPIC_BETA?: string;
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_XAI_API_KEY?: string;
  readonly VITE_ANTHROPIC_API_KEY?: string;
  readonly VITE_ANTHROPIC_BETA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  gcElectron?: {
    compileLatex: (req: {
      source?: string;
      projectRoot?: string;
      mainFile?: string;
      engine?: 'pdflatex' | 'xelatex' | 'lualatex';
    }) => Promise<{
      ok: boolean;
      pdfBase64?: string;
      log?: string;
      error?: string;
    }>;
    pickLatexProject: () => Promise<{ ok: boolean; projectRoot?: string; error?: string }>;
    listLatexProjectFiles: (req: { projectRoot: string }) => Promise<{
      ok: boolean;
      files?: Array<{ path: string; kind: 'tex' | 'bib' | 'style' | 'class' | 'asset' | 'other'; editable: boolean }>;
      suggestedMainFile?: string | null;
      error?: string;
    }>;
    readLatexProjectFile: (req: { projectRoot: string; path: string }) => Promise<{ ok: boolean; content?: string; error?: string }>;
    writeLatexProjectFile: (req: { projectRoot: string; path: string; content: string }) => Promise<{ ok: boolean; error?: string }>;
    synctexForward: (req: {
      projectRoot: string;
      mainFile: string;
      sourceFile: string;
      line: number;
    }) => Promise<{ ok: boolean; page?: number; x?: number | null; y?: number | null; error?: string; log?: string }>;
    synctexInverse: (req: {
      projectRoot: string;
      mainFile: string;
      page: number;
      x: number;
      y: number;
    }) => Promise<{
      ok: boolean;
      filePath?: string | null;
      line?: number;
      column?: number | null;
      sourcePathRaw?: string;
      error?: string;
      log?: string;
    }>;
    storageGetWorkspaceSnapshot: () => Promise<{ ok: boolean; snapshot?: unknown | null; error?: string }>;
    storagePutWorkspaceSnapshot: (req: { snapshot: unknown }) => Promise<{ ok: boolean; error?: string }>;
    storageDeleteWorkspaceSnapshot: () => Promise<{ ok: boolean; error?: string }>;
    storageGetChatStateRecord: (req: { chatId: string }) => Promise<{ ok: boolean; record?: unknown | null; error?: string }>;
    storagePutChatStateRecord: (req: { chatId: string; state: unknown }) => Promise<{ ok: boolean; error?: string }>;
    storageDeleteChatStateRecord: (req: { chatId: string }) => Promise<{ ok: boolean; error?: string }>;
    storageGetChatMetaRecord: (req: { chatId: string }) => Promise<{ ok: boolean; record?: unknown | null; error?: string }>;
    storagePutChatMetaRecord: (req: { chatId: string; meta: unknown }) => Promise<{ ok: boolean; error?: string }>;
    storageDeleteChatMetaRecord: (req: { chatId: string }) => Promise<{ ok: boolean; error?: string }>;
    storageGetPayload: (req: { key: string }) => Promise<{ ok: boolean; payload?: unknown | null; error?: string }>;
    storagePutPayload: (req: { key: string; json: unknown }) => Promise<{ ok: boolean; error?: string }>;
    storageDeletePayload: (req: { key: string }) => Promise<{ ok: boolean; error?: string }>;
    storagePutAttachment: (req: {
      mimeType: string;
      name?: string;
      size?: number;
      bytes: ArrayBuffer;
    }) => Promise<{ ok: boolean; key?: string; error?: string }>;
    storageGetAttachment: (req: { key: string }) => Promise<{
      ok: boolean;
      record?: {
        key: string;
        mimeType: string;
        name?: string;
        size?: number;
        createdAt: number;
        bytes: ArrayBuffer | Uint8Array;
      } | null;
      error?: string;
    }>;
    storageDeleteAttachment: (req: { key: string }) => Promise<{ ok: boolean; error?: string }>;
    storageListAttachmentKeys: () => Promise<{ ok: boolean; keys?: string[]; error?: string }>;
    storageDeleteAttachments: (req: { keys: string[] }) => Promise<{ ok: boolean; error?: string }>;
    storageDeleteChatFolder: (req: { chatId: string }) => Promise<{ ok: boolean; error?: string }>;
    storageOpenDataDir: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    storageClearAll: () => Promise<{ ok: boolean; error?: string }>;
  };
}
