export async function readFileAsDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

export function splitDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(dataUrl ?? '');
  if (!match) return null;
  return { mimeType: match[1] || 'application/octet-stream', base64: match[2] || '' };
}

export function base64ToBlob(base64OrDataUrl: string, mimeType: string): Blob {
  let mt = String(mimeType ?? '').trim() || 'application/octet-stream';
  let raw = String(base64OrDataUrl ?? '').trim();

  if (/^data:[^,]+,/i.test(raw)) {
    const parts = splitDataUrl(raw);
    if (parts) {
      raw = parts.base64;
      if (!String(mimeType ?? '').trim()) mt = parts.mimeType || mt;
    }
  }

  let b64 = raw.replace(/\s+/g, '');
  if (!b64) return new Blob([], { type: mt });
  const mod = b64.length % 4;
  if (mod) b64 += '='.repeat(4 - mod);
  if (typeof atob !== 'function') throw new Error('Base64 decoding is not available in this environment.');

  // Decode in chunks to avoid atob() size limits on large attachments/PDFs.
  const chunkSize = 1024 * 1024; // base64 chars; must be divisible by 4
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < b64.length; offset += chunkSize) {
    const slice = b64.slice(offset, offset + chunkSize);
    const bin = atob(slice);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    parts.push(bytes);
  }
  return new Blob(parts, { type: mt });
}
