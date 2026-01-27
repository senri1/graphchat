import { useEffect, useMemo, useRef, useState } from 'react';
import { getAttachment } from '../storage/attachments';

export function useAttachmentObjectUrls(keys: string[]): Record<string, string> {
  const normalizedKeys = useMemo(() => {
    const unique = new Set<string>();
    for (const key of keys ?? []) {
      const k = typeof key === 'string' ? key.trim() : '';
      if (k) unique.add(k);
    }
    return Array.from(unique).sort();
  }, [keys]);

  const keySig = useMemo(() => normalizedKeys.join('|'), [normalizedKeys]);
  const urlsRef = useRef<Map<string, string>>(new Map());
  const loadSeqRef = useRef(0);
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const desired = new Set(normalizedKeys);
    for (const [key, url] of Array.from(urlsRef.current.entries())) {
      if (desired.has(key)) continue;
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
      urlsRef.current.delete(key);
    }
    setUrls(Object.fromEntries(urlsRef.current.entries()));

    const seq = (loadSeqRef.current += 1);
    for (const key of normalizedKeys) {
      if (urlsRef.current.has(key)) continue;
      void (async () => {
        const rec = await getAttachment(key);
        if (loadSeqRef.current !== seq) return;
        if (!rec?.blob) return;
        const url = URL.createObjectURL(rec.blob);
        urlsRef.current.set(key, url);
        setUrls(Object.fromEntries(urlsRef.current.entries()));
      })();
    }
  }, [keySig]);

  useEffect(() => {
    return () => {
      for (const url of urlsRef.current.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      urlsRef.current.clear();
    };
  }, []);

  return urls;
}
