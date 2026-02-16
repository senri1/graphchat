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
    latexToolchainStatus: () => Promise<{ ok: boolean; latexmk?: boolean; synctex?: boolean; error?: string }>;
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
    storageGetDataDirInfo: () => Promise<{
      ok: boolean;
      path?: string;
      defaultPath?: string;
      baseDir?: string;
      defaultBaseDir?: string;
      isDefault?: boolean;
      error?: string;
    }>;
    storageChooseDataDir: (req?: { moveExisting?: boolean }) => Promise<{
      ok: boolean;
      canceled?: boolean;
      path?: string;
      defaultPath?: string;
      baseDir?: string;
      defaultBaseDir?: string;
      isDefault?: boolean;
      moved?: boolean;
      error?: string;
    }>;
    storageResetDataDir: (req?: { moveExisting?: boolean }) => Promise<{
      ok: boolean;
      path?: string;
      defaultPath?: string;
      baseDir?: string;
      defaultBaseDir?: string;
      isDefault?: boolean;
      moved?: boolean;
      error?: string;
    }>;
    storageOpenDataDir: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    storageGetCloudSyncInfo: () => Promise<{
      ok: boolean;
      connected?: boolean;
      cloudDir?: string;
      lastPulledRevision?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      error?: string;
    }>;
    storageChooseCloudSyncDir: () => Promise<{
      ok: boolean;
      canceled?: boolean;
      connected?: boolean;
      cloudDir?: string;
      lastPulledRevision?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      error?: string;
    }>;
    storageUnlinkCloudSyncDir: () => Promise<{
      ok: boolean;
      connected?: boolean;
      cloudDir?: string;
      lastPulledRevision?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      error?: string;
    }>;
    storageOpenCloudSyncDir: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    storageCloudSyncPush: (req?: { force?: boolean }) => Promise<{
      ok: boolean;
      connected?: boolean;
      cloudDir?: string;
      lastPulledRevision?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      pushedRevision?: string;
      error?: string;
    }>;
    storageCloudSyncPull: () => Promise<{
      ok: boolean;
      connected?: boolean;
      cloudDir?: string;
      lastPulledRevision?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      pulledRevision?: string;
      backupPath?: string;
      error?: string;
    }>;
    storageGoogleDriveSyncInfo: () => Promise<{
      ok: boolean;
      linked?: boolean;
      clientId?: string;
      hasClientSecret?: boolean;
      folderId?: string;
      lastPulledRevision?: string;
      lastLinkError?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      remoteError?: string;
      configPath?: string;
      configExists?: boolean;
      userDataPath?: string;
      appName?: string;
      error?: string;
    }>;
    storageGoogleDriveSyncLink: (req?: { clientId?: string; clientSecret?: string }) => Promise<{
      ok: boolean;
      linked?: boolean;
      clientId?: string;
      hasClientSecret?: boolean;
      folderId?: string;
      lastPulledRevision?: string;
      lastLinkError?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      remoteError?: string;
      configPath?: string;
      configExists?: boolean;
      userDataPath?: string;
      appName?: string;
      error?: string;
    }>;
    storageGoogleDriveSyncUnlink: () => Promise<{
      ok: boolean;
      linked?: boolean;
      clientId?: string;
      hasClientSecret?: boolean;
      folderId?: string;
      lastPulledRevision?: string;
      lastLinkError?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      remoteError?: string;
      configPath?: string;
      configExists?: boolean;
      userDataPath?: string;
      appName?: string;
      error?: string;
    }>;
    storageGoogleDriveSyncOpenFolder: () => Promise<{ ok: boolean; url?: string; error?: string }>;
    storageGoogleDriveSyncPush: (req?: { force?: boolean }) => Promise<{
      ok: boolean;
      linked?: boolean;
      clientId?: string;
      hasClientSecret?: boolean;
      folderId?: string;
      lastPulledRevision?: string;
      lastLinkError?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      remoteError?: string;
      configPath?: string;
      configExists?: boolean;
      userDataPath?: string;
      appName?: string;
      pushedRevision?: string;
      pushedFileCount?: number;
      error?: string;
    }>;
    storageGoogleDriveSyncPull: () => Promise<{
      ok: boolean;
      linked?: boolean;
      clientId?: string;
      hasClientSecret?: boolean;
      folderId?: string;
      lastPulledRevision?: string;
      lastLinkError?: string;
      remoteHeadRevision?: string;
      remoteHeadUpdatedAt?: number;
      remoteError?: string;
      configPath?: string;
      configExists?: boolean;
      userDataPath?: string;
      appName?: string;
      pulledRevision?: string;
      pulledFileCount?: number;
      backupPath?: string;
      error?: string;
    }>;
    storageClearAll: () => Promise<{ ok: boolean; error?: string }>;
  };
}
