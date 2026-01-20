import { openDb, txDone } from './db';

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

  const db = await openDb();
  const tx = db.transaction('payloads', 'readwrite');
  tx.objectStore('payloads').put({ key: trimmed, json: args.json, createdAt: Date.now() });
  await txDone(tx);
}

export async function deletePayload(key: string): Promise<void> {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return;

  const db = await openDb();
  const tx = db.transaction('payloads', 'readwrite');
  tx.objectStore('payloads').delete(trimmed);
  await txDone(tx);
}
