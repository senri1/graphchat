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
  storageOpenDataDir?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
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
