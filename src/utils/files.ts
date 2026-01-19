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

