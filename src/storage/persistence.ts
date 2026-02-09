import type { WorldEngineCameraState } from '../engine/WorldEngine';
import type { ChatNode, InkStroke } from '../model/chat';
import type { BackgroundLibraryItem } from '../model/backgrounds';
import type { FontFamilyKey } from '../ui/typography';
import type { WorkspaceFolder } from '../workspace/tree';
import { openDb, txDone } from './db';
import { getElectronStorageApi } from './electron';

export type PersistedWorkspaceSnapshot = {
  key: 'workspace';
  root: WorkspaceFolder;
  activeChatId: string;
  focusedFolderId: string;
  backgroundLibrary?: BackgroundLibraryItem[];
  llm?: {
    modelUserSettings?: Record<string, unknown>;
    systemInstructionDefault?: string;
  };
  visual?: {
    glassNodesEnabled: boolean;
    glassNodesUnderlayAlpha: number;
    edgeRouterId?: string;
    replyArrowColor?: string;
    replyArrowOpacity?: number;
    replySpawnKind?: 'text' | 'ink';
    glassNodesBlurCssPx?: number;
    glassNodesSaturatePct?: number;
    glassNodesBlurCssPxWebgl?: number;
    glassNodesSaturatePctWebgl?: number;
    glassNodesBlurCssPxCanvas?: number;
    glassNodesSaturatePctCanvas?: number;
    uiGlassBlurCssPxWebgl?: number;
    uiGlassSaturatePctWebgl?: number;
    glassNodesBlurBackend?: 'webgl' | 'canvas';
    composerFontFamily?: FontFamilyKey;
    composerFontSizePx?: number;
    composerMinimized?: boolean;
    nodeFontFamily?: FontFamilyKey;
    nodeFontSizePx?: number;
    sidebarFontFamily?: FontFamilyKey;
    sidebarFontSizePx?: number;
    spawnEditNodeByDraw?: boolean;
    spawnInkNodeByDraw?: boolean;
    inkSendCropEnabled?: boolean;
    inkSendCropPaddingPx?: number;
    inkSendDownscaleEnabled?: boolean;
    inkSendMaxPixels?: number;
    inkSendMaxDimPx?: number;
    sendAllEnabled?: boolean;
    sendAllComposerEnabled?: boolean;
    sendAllModelIds?: string[];
    cleanupChatFoldersOnDelete?: boolean;
  };
  updatedAt: number;
};

export type PersistedChatState = {
  camera: WorldEngineCameraState;
  nodes: ChatNode[];
  worldInkStrokes: InkStroke[];
};

export type PersistedChatStateRecord = {
  chatId: string;
  state: PersistedChatState;
  updatedAt: number;
};

export type PersistedChatMetaRecord = {
  chatId: string;
  meta: unknown;
  updatedAt: number;
};

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

export async function getWorkspaceSnapshot(): Promise<PersistedWorkspaceSnapshot | null> {
  const electron = getElectronStorageApi();
  if (electron?.storageGetWorkspaceSnapshot) {
    try {
      const res = await electron.storageGetWorkspaceSnapshot();
      const snapshot = (res?.snapshot ?? null) as any;
      return snapshot && snapshot.key === 'workspace' ? (snapshot as PersistedWorkspaceSnapshot) : null;
    } catch {
      return null;
    }
  }

  const db = await openDb();
  const tx = db.transaction('workspace', 'readonly');
  const store = tx.objectStore('workspace');
  let rec: PersistedWorkspaceSnapshot | null = null;
  try {
    rec = (await requestToPromise(store.get('workspace'))) as any;
  } catch {
    rec = null;
  }
  try {
    await txDone(tx);
  } catch {
    // ignore
  }
  return rec && rec.key === 'workspace' ? rec : null;
}

export async function putWorkspaceSnapshot(snapshot: Omit<PersistedWorkspaceSnapshot, 'updatedAt'>): Promise<void> {
  const electron = getElectronStorageApi();
  if (electron?.storagePutWorkspaceSnapshot) {
    const res = await electron.storagePutWorkspaceSnapshot({ snapshot });
    if (!res?.ok) throw new Error(res?.error || 'Failed to persist workspace snapshot.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction('workspace', 'readwrite');
  const store = tx.objectStore('workspace');
  store.put({ ...snapshot, updatedAt: Date.now() });
  await txDone(tx);
}

export async function deleteWorkspaceSnapshot(): Promise<void> {
  const electron = getElectronStorageApi();
  if (electron?.storageDeleteWorkspaceSnapshot) {
    const res = await electron.storageDeleteWorkspaceSnapshot();
    if (!res?.ok) throw new Error(res?.error || 'Failed to delete workspace snapshot.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction('workspace', 'readwrite');
  tx.objectStore('workspace').delete('workspace');
  await txDone(tx);
}

export async function getChatStateRecord(chatId: string): Promise<PersistedChatStateRecord | null> {
  if (!chatId) return null;

  const electron = getElectronStorageApi();
  if (electron?.storageGetChatStateRecord) {
    try {
      const res = await electron.storageGetChatStateRecord({ chatId });
      const rec = (res?.record ?? null) as any;
      return rec && rec.chatId === chatId && rec.state ? (rec as PersistedChatStateRecord) : null;
    } catch {
      return null;
    }
  }

  const db = await openDb();
  const tx = db.transaction('chatStates', 'readonly');
  const store = tx.objectStore('chatStates');
  let rec: PersistedChatStateRecord | null = null;
  try {
    rec = (await requestToPromise(store.get(chatId))) as any;
  } catch {
    rec = null;
  }
  try {
    await txDone(tx);
  } catch {
    // ignore
  }
  return rec && rec.chatId === chatId && rec.state ? rec : null;
}

export async function putChatStateRecord(chatId: string, state: PersistedChatState): Promise<void> {
  if (!chatId) return;

  const electron = getElectronStorageApi();
  if (electron?.storagePutChatStateRecord) {
    const res = await electron.storagePutChatStateRecord({ chatId, state });
    if (!res?.ok) throw new Error(res?.error || 'Failed to persist chat state.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction('chatStates', 'readwrite');
  tx.objectStore('chatStates').put({ chatId, state, updatedAt: Date.now() });
  await txDone(tx);
}

export async function deleteChatStateRecord(chatId: string): Promise<void> {
  if (!chatId) return;

  const electron = getElectronStorageApi();
  if (electron?.storageDeleteChatStateRecord) {
    const res = await electron.storageDeleteChatStateRecord({ chatId });
    if (!res?.ok) throw new Error(res?.error || 'Failed to delete chat state.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction('chatStates', 'readwrite');
  tx.objectStore('chatStates').delete(chatId);
  await txDone(tx);
}

export async function getChatMetaRecord(chatId: string): Promise<PersistedChatMetaRecord | null> {
  if (!chatId) return null;

  const electron = getElectronStorageApi();
  if (electron?.storageGetChatMetaRecord) {
    try {
      const res = await electron.storageGetChatMetaRecord({ chatId });
      const rec = (res?.record ?? null) as any;
      return rec && rec.chatId === chatId ? (rec as PersistedChatMetaRecord) : null;
    } catch {
      return null;
    }
  }

  const db = await openDb();
  const tx = db.transaction('chatMeta', 'readonly');
  const store = tx.objectStore('chatMeta');
  let rec: PersistedChatMetaRecord | null = null;
  try {
    rec = (await requestToPromise(store.get(chatId))) as any;
  } catch {
    rec = null;
  }
  try {
    await txDone(tx);
  } catch {
    // ignore
  }
  return rec && rec.chatId === chatId ? rec : null;
}

export async function putChatMetaRecord(chatId: string, meta: unknown): Promise<void> {
  if (!chatId) return;

  const electron = getElectronStorageApi();
  if (electron?.storagePutChatMetaRecord) {
    const res = await electron.storagePutChatMetaRecord({ chatId, meta });
    if (!res?.ok) throw new Error(res?.error || 'Failed to persist chat metadata.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction('chatMeta', 'readwrite');
  tx.objectStore('chatMeta').put({ chatId, meta, updatedAt: Date.now() });
  await txDone(tx);
}

export async function deleteChatMetaRecord(chatId: string): Promise<void> {
  if (!chatId) return;

  const electron = getElectronStorageApi();
  if (electron?.storageDeleteChatMetaRecord) {
    const res = await electron.storageDeleteChatMetaRecord({ chatId });
    if (!res?.ok) throw new Error(res?.error || 'Failed to delete chat metadata.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction('chatMeta', 'readwrite');
  tx.objectStore('chatMeta').delete(chatId);
  await txDone(tx);
}

export async function deleteChatStorageFolder(chatId: string): Promise<void> {
  if (!chatId) return;
  if (typeof window === 'undefined') return;
  const rawApi = (window as any)?.gcElectron;
  if (!rawApi) return;
  if (typeof rawApi.storageDeleteChatFolder !== 'function') {
    throw new Error(
      'Chat-folder cleanup API is unavailable in this Electron session. Fully restart Electron and try again.',
    );
  }
  const res = await rawApi.storageDeleteChatFolder({ chatId });
  if (!res?.ok) throw new Error(res?.error || 'Failed to delete chat folder.');
}
