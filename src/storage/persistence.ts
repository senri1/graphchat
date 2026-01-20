import type { WorldEngineCameraState } from '../engine/WorldEngine';
import type { ChatNode, InkStroke } from '../model/chat';
import type { WorkspaceFolder } from '../workspace/tree';
import { openDb, txDone } from './db';

export type PersistedWorkspaceSnapshot = {
  key: 'workspace';
  root: WorkspaceFolder;
  activeChatId: string;
  focusedFolderId: string;
  visual?: {
    glassNodesEnabled: boolean;
    glassNodesBlurCssPx: number;
    glassNodesSaturatePct: number;
    glassNodesUnderlayAlpha: number;
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
  const db = await openDb();
  const tx = db.transaction('workspace', 'readwrite');
  const store = tx.objectStore('workspace');
  store.put({ ...snapshot, updatedAt: Date.now() });
  await txDone(tx);
}

export async function deleteWorkspaceSnapshot(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('workspace', 'readwrite');
  tx.objectStore('workspace').delete('workspace');
  await txDone(tx);
}

export async function getChatStateRecord(chatId: string): Promise<PersistedChatStateRecord | null> {
  if (!chatId) return null;
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
  const db = await openDb();
  const tx = db.transaction('chatStates', 'readwrite');
  tx.objectStore('chatStates').put({ chatId, state, updatedAt: Date.now() });
  await txDone(tx);
}

export async function deleteChatStateRecord(chatId: string): Promise<void> {
  if (!chatId) return;
  const db = await openDb();
  const tx = db.transaction('chatStates', 'readwrite');
  tx.objectStore('chatStates').delete(chatId);
  await txDone(tx);
}

export async function getChatMetaRecord(chatId: string): Promise<PersistedChatMetaRecord | null> {
  if (!chatId) return null;
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
  const db = await openDb();
  const tx = db.transaction('chatMeta', 'readwrite');
  tx.objectStore('chatMeta').put({ chatId, meta, updatedAt: Date.now() });
  await txDone(tx);
}

export async function deleteChatMetaRecord(chatId: string): Promise<void> {
  if (!chatId) return;
  const db = await openDb();
  const tx = db.transaction('chatMeta', 'readwrite');
  tx.objectStore('chatMeta').delete(chatId);
  await txDone(tx);
}
