export type StoredAttachment = {
  key: string;
  mimeType: string;
  blob: Blob;
  name?: string;
  size?: number;
  createdAt: number;
};

const DB_NAME = 'graphchatv1';
const DB_VERSION = 1;
const STORE = 'attachments';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'));
  }

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'key' });
        try {
          s.createIndex('createdAt', 'createdAt', { unique: false });
        } catch {
          // ignore
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB.'));
  });

  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

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

