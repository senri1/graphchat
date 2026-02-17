export type ElectronStorageApi = {
  storageGetWorkspaceSnapshot?: () => Promise<{ ok: boolean; snapshot?: unknown | null; error?: string }>;
  storagePutWorkspaceSnapshot?: (req: { snapshot: unknown }) => Promise<{ ok: boolean; error?: string }>;
  storageDeleteWorkspaceSnapshot?: () => Promise<{ ok: boolean; error?: string }>;
  storageGetChatStateRecord?: (req: { chatId: string }) => Promise<{ ok: boolean; record?: unknown | null; error?: string }>;
  storagePutChatStateRecord?: (req: { chatId: string; state: unknown }) => Promise<{ ok: boolean; error?: string }>;
  storageDeleteChatStateRecord?: (req: { chatId: string }) => Promise<{ ok: boolean; error?: string }>;
  storageGetChatMetaRecord?: (req: { chatId: string }) => Promise<{ ok: boolean; record?: unknown | null; error?: string }>;
  storagePutChatMetaRecord?: (req: { chatId: string; meta: unknown }) => Promise<{ ok: boolean; error?: string }>;
  storageDeleteChatMetaRecord?: (req: { chatId: string }) => Promise<{ ok: boolean; error?: string }>;
  storageGetPayload?: (req: { key: string }) => Promise<{ ok: boolean; payload?: unknown | null; error?: string }>;
  storagePutPayload?: (req: { key: string; json: unknown }) => Promise<{ ok: boolean; error?: string }>;
  storageDeletePayload?: (req: { key: string }) => Promise<{ ok: boolean; error?: string }>;
  storagePutAttachment?: (req: {
    mimeType: string;
    name?: string;
    size?: number;
    bytes: ArrayBuffer;
  }) => Promise<{ ok: boolean; key?: string; error?: string }>;
  storageGetAttachment?: (req: {
    key: string;
  }) => Promise<{
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
  storageDeleteAttachment?: (req: { key: string }) => Promise<{ ok: boolean; error?: string }>;
  storageListAttachmentKeys?: () => Promise<{ ok: boolean; keys?: string[]; error?: string }>;
  storageDeleteAttachments?: (req: { keys: string[] }) => Promise<{ ok: boolean; error?: string }>;
  storageDeleteChatFolder?: (req: { chatId: string }) => Promise<{ ok: boolean; error?: string }>;
  storageGetDataDirInfo?: () => Promise<{
    ok: boolean;
    path?: string;
    defaultPath?: string;
    baseDir?: string;
    defaultBaseDir?: string;
    isDefault?: boolean;
    error?: string;
  }>;
  storageChooseDataDir?: (req?: { moveExisting?: boolean }) => Promise<{
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
  storageResetDataDir?: (req?: { moveExisting?: boolean }) => Promise<{
    ok: boolean;
    path?: string;
    defaultPath?: string;
    baseDir?: string;
    defaultBaseDir?: string;
    isDefault?: boolean;
    moved?: boolean;
    error?: string;
  }>;
  storageOpenDataDir?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  storageGetCloudSyncInfo?: () => Promise<{
    ok: boolean;
    connected?: boolean;
    cloudDir?: string;
    lastPulledRevision?: string;
    remoteHeadRevision?: string;
    remoteHeadUpdatedAt?: number;
    error?: string;
  }>;
  storageChooseCloudSyncDir?: () => Promise<{
    ok: boolean;
    canceled?: boolean;
    connected?: boolean;
    cloudDir?: string;
    lastPulledRevision?: string;
    remoteHeadRevision?: string;
    remoteHeadUpdatedAt?: number;
    error?: string;
  }>;
  storageUnlinkCloudSyncDir?: () => Promise<{
    ok: boolean;
    connected?: boolean;
    cloudDir?: string;
    lastPulledRevision?: string;
    remoteHeadRevision?: string;
    remoteHeadUpdatedAt?: number;
    error?: string;
  }>;
  storageOpenCloudSyncDir?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  storageCloudSyncPush?: (req?: { force?: boolean }) => Promise<{
    ok: boolean;
    connected?: boolean;
    cloudDir?: string;
    lastPulledRevision?: string;
    remoteHeadRevision?: string;
    remoteHeadUpdatedAt?: number;
    pushedRevision?: string;
    error?: string;
  }>;
  storageCloudSyncPull?: () => Promise<{
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
  storageGoogleDriveSyncInfo?: () => Promise<{
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
  storageGoogleDriveSyncLink?: (req?: { clientId?: string; clientSecret?: string }) => Promise<{
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
  storageGoogleDriveSyncUnlink?: () => Promise<{
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
  storageGoogleDriveSyncOpenFolder?: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  storageGoogleDriveSyncPush?: (req?: { force?: boolean }) => Promise<{
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
  storageGoogleDriveSyncPull?: () => Promise<{
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
  storageGoogleDriveSyncOnProgress?: (cb: (payload: {
    opId?: string;
    op?: 'push' | 'pull' | string;
    at?: number;
    done?: boolean;
    stage?: string;
    phaseIndex?: number;
    phaseCount?: number;
    message?: string;
    error?: string;
    indeterminate?: boolean;
    completed?: number;
    total?: number;
  }) => void) => () => void;
  storageClearAll?: () => Promise<{ ok: boolean; error?: string }>;
};

function hasFsStorageApi(api: ElectronStorageApi | null | undefined): boolean {
  return Boolean(
    api &&
      typeof api.storageGetWorkspaceSnapshot === 'function' &&
      typeof api.storagePutWorkspaceSnapshot === 'function' &&
      typeof api.storageGetChatStateRecord === 'function' &&
      typeof api.storagePutChatStateRecord === 'function' &&
      typeof api.storageGetChatMetaRecord === 'function' &&
      typeof api.storagePutChatMetaRecord === 'function' &&
      typeof api.storageGetPayload === 'function' &&
      typeof api.storagePutPayload === 'function' &&
      typeof api.storagePutAttachment === 'function' &&
      typeof api.storageGetAttachment === 'function' &&
      typeof api.storageListAttachmentKeys === 'function' &&
      typeof api.storageClearAll === 'function',
  );
}

export function getElectronStorageApi(): ElectronStorageApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { gcElectron?: ElectronStorageApi | null }).gcElectron;
  return hasFsStorageApi(api) ? (api as ElectronStorageApi) : null;
}
