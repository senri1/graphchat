const DB_NAME = 'graphchatv1';
const DB_VERSION = 3;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'));
  }

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('attachments')) {
        const s = db.createObjectStore('attachments', { keyPath: 'key' });
        try {
          s.createIndex('createdAt', 'createdAt', { unique: false });
        } catch {
          // ignore
        }
      }

      if (!db.objectStoreNames.contains('workspace')) {
        db.createObjectStore('workspace', { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains('chatStates')) {
        db.createObjectStore('chatStates', { keyPath: 'chatId' });
      }

      if (!db.objectStoreNames.contains('chatMeta')) {
        db.createObjectStore('chatMeta', { keyPath: 'chatId' });
      }

      if (!db.objectStoreNames.contains('payloads')) {
        const s = db.createObjectStore('payloads', { keyPath: 'key' });
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

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}
