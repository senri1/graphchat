import { openDb, txDone } from './db';

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
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(key);
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
