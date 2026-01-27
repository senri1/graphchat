export type BackgroundLibraryItem = {
  id: string;
  storageKey: string;
  name: string;
  createdAt: number;
  mimeType?: string;
  size?: number;
};

function stripExt(name: string): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return '';
  const idx = trimmed.lastIndexOf('.');
  if (idx <= 0) return trimmed;
  return trimmed.slice(0, idx);
}

function fallbackNameFromKey(storageKey: string): string {
  const tail = String(storageKey ?? '').trim().slice(-6);
  return tail ? `Background ${tail}` : 'Background';
}

export function normalizeBackgroundLibrary(raw: unknown): BackgroundLibraryItem[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: BackgroundLibraryItem[] = [];

  for (const entry of raw as any[]) {
    if (!entry || typeof entry !== 'object') continue;

    const storageKey = typeof (entry as any).storageKey === 'string' ? String((entry as any).storageKey).trim() : '';
    if (!storageKey) continue;
    if (seen.has(storageKey)) continue;
    seen.add(storageKey);

    const createdAtRaw = Number((entry as any).createdAt);
    const createdAt = Number.isFinite(createdAtRaw) ? Math.max(0, Math.floor(createdAtRaw)) : 0;

    const mimeType = typeof (entry as any).mimeType === 'string' ? String((entry as any).mimeType).trim() : '';
    const sizeRaw = Number((entry as any).size);
    const size = Number.isFinite(sizeRaw) ? Math.max(0, Math.floor(sizeRaw)) : undefined;

    const rawName = typeof (entry as any).name === 'string' ? String((entry as any).name) : '';
    const name = stripExt(rawName).trim() || fallbackNameFromKey(storageKey);

    out.push({
      id: storageKey,
      storageKey,
      name,
      createdAt,
      ...(mimeType ? { mimeType } : {}),
      ...(typeof size === 'number' ? { size } : {}),
    });
  }

  out.sort((a, b) => {
    const aAt = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const bAt = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    if (bAt !== aAt) return bAt - aAt;
    return a.name.localeCompare(b.name);
  });

  return out;
}

