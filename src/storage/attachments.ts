import { openDb, txDone } from './db';
import { getElectronStorageApi } from './electron';

export type StoredAttachment = {
  key: string;
  mimeType: string;
  blob: Blob;
  name?: string;
  size?: number;
  createdAt: number;
};

const STORE = 'attachments';

function genAttachmentKey(prefix = 'att'): string {
  const p = prefix.replace(/[^a-z0-9_-]/gi, '').slice(0, 12) || 'att';
  try {
    const uuid = (crypto as any)?.randomUUID?.() as string | undefined;
    if (uuid) return `${p}_${uuid}`;
  } catch {
    // ignore
  }
  return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function putAttachment(args: { blob: Blob; mimeType: string; name?: string; size?: number }): Promise<string> {
  const electron = getElectronStorageApi();
  if (electron?.storagePutAttachment) {
    const bytes = await args.blob.arrayBuffer();
    const res = await electron.storagePutAttachment({
      bytes,
      mimeType: args.mimeType,
      name: args.name,
      size: args.size,
    });
    const key = typeof res?.key === 'string' ? res.key.trim() : '';
    if (res?.ok && key) return key;
    throw new Error(res?.error || 'Failed to persist attachment.');
  }

  const db = await openDb();
  const key = genAttachmentKey();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const rec: StoredAttachment = {
    key,
    blob: args.blob,
    mimeType: args.mimeType,
    name: args.name,
    size: args.size,
    createdAt: Date.now(),
  };
  store.put(rec);
  await txDone(tx);
  return key;
}

export async function getAttachment(key: string): Promise<StoredAttachment | null> {
  if (!key) return null;

  const electron = getElectronStorageApi();
  if (electron?.storageGetAttachment) {
    try {
      const res = await electron.storageGetAttachment({ key });
      const rec = (res?.record ?? null) as any;
      if (!res?.ok || !rec || typeof rec.key !== 'string') return null;
      const mimeType = typeof rec.mimeType === 'string' && rec.mimeType.trim() ? rec.mimeType : 'application/octet-stream';
      const bytes = rec.bytes as ArrayBuffer | Uint8Array | null | undefined;
      if (!bytes) return null;
      const blob = new Blob([bytes], { type: mimeType });
      return {
        key: rec.key,
        mimeType,
        blob,
        ...(typeof rec.name === 'string' && rec.name.trim() ? { name: rec.name } : {}),
        ...(Number.isFinite(Number(rec.size)) ? { size: Number(rec.size) } : {}),
        createdAt: Number.isFinite(Number(rec.createdAt)) ? Number(rec.createdAt) : 0,
      };
    } catch {
      return null;
    }
  }

  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  const req = store.get(key);
  const rec = await new Promise<StoredAttachment | null>((resolve) => {
    req.onsuccess = () => resolve((req.result as StoredAttachment | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
  return rec;
}

export async function deleteAttachment(key: string): Promise<void> {
  if (!key) return;

  const electron = getElectronStorageApi();
  if (electron?.storageDeleteAttachment) {
    const res = await electron.storageDeleteAttachment({ key });
    if (!res?.ok) throw new Error(res?.error || 'Failed to delete attachment.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(key);
  await txDone(tx);
}

export async function listAttachmentKeys(): Promise<string[]> {
  const electron = getElectronStorageApi();
  if (electron?.storageListAttachmentKeys) {
    try {
      const res = await electron.storageListAttachmentKeys();
      return res?.ok && Array.isArray(res.keys) ? res.keys.filter((k) => typeof k === 'string' && k) : [];
    } catch {
      return [];
    }
  }

  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  const keys: string[] = [];

  await new Promise<void>((resolve) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result as IDBCursorWithValue | null;
      if (!cur) {
        resolve();
        return;
      }
      const key = typeof cur.key === 'string' ? cur.key : '';
      if (key) keys.push(key);
      cur.continue();
    };
    req.onerror = () => resolve();
  });

  try {
    await txDone(tx);
  } catch {
    // ignore
  }

  return keys;
}

export async function deleteAttachments(keys: string[]): Promise<void> {
  const unique = Array.from(new Set((keys ?? []).filter((k) => typeof k === 'string' && k)));
  if (unique.length === 0) return;

  const electron = getElectronStorageApi();
  if (electron?.storageDeleteAttachments) {
    const res = await electron.storageDeleteAttachments({ keys: unique });
    if (!res?.ok) throw new Error(res?.error || 'Failed to delete attachments.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const key of unique) store.delete(key);
  await txDone(tx);
}

export async function blobToDataUrl(blob: Blob, mimeType?: string): Promise<string> {
  const mt = (mimeType ?? blob.type ?? '').trim() || 'application/octet-stream';
  const normalized = blob.type === mt ? blob : new Blob([blob], { type: mt });

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read Blob.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(normalized);
  });
}
