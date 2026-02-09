import { openDb, txDone } from './db';
import { getElectronStorageApi } from './electron';

type PersistedPayloadRecord = {
  key: string;
  json: unknown;
  createdAt: number;
};

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

export async function getPayload(key: string): Promise<unknown | null> {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return null;

  const electron = getElectronStorageApi();
  if (electron?.storageGetPayload) {
    try {
      const res = await electron.storageGetPayload({ key: trimmed });
      return res?.ok ? (res.payload ?? null) : null;
    } catch {
      return null;
    }
  }

  const db = await openDb();
  const tx = db.transaction('payloads', 'readonly');
  const store = tx.objectStore('payloads');
  let rec: PersistedPayloadRecord | null = null;
  try {
    rec = (await requestToPromise(store.get(trimmed))) as any;
  } catch {
    rec = null;
  }
  try {
    await txDone(tx);
  } catch {
    // ignore
  }
  return rec && rec.key === trimmed ? rec.json : null;
}

export async function putPayload(args: { key: string; json: unknown }): Promise<void> {
  const trimmed = String(args?.key ?? '').trim();
  if (!trimmed) return;

  const electron = getElectronStorageApi();
  if (electron?.storagePutPayload) {
    const res = await electron.storagePutPayload({ key: trimmed, json: args.json });
    if (!res?.ok) throw new Error(res?.error || 'Failed to persist payload.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction('payloads', 'readwrite');
  tx.objectStore('payloads').put({ key: trimmed, json: args.json, createdAt: Date.now() });
  await txDone(tx);
}

export async function deletePayload(key: string): Promise<void> {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return;

  const electron = getElectronStorageApi();
  if (electron?.storageDeletePayload) {
    const res = await electron.storageDeletePayload({ key: trimmed });
    if (!res?.ok) throw new Error(res?.error || 'Failed to delete payload.');
    return;
  }

  const db = await openDb();
  const tx = db.transaction('payloads', 'readwrite');
  tx.objectStore('payloads').delete(trimmed);
  await txDone(tx);
}
