export type XaiResult =
  | { ok: true; text: string; response: unknown }
  | { ok: false; text: string; error: string; cancelled?: boolean; response?: unknown };

export function getXaiApiKey(): string | null {
  const trimmed = String(import.meta.env.XAI_API_KEY ?? import.meta.env.VITE_XAI_API_KEY ?? '').trim();
  return trimmed ? trimmed : null;
}

const XAI_API_BASE_URL = 'https://api.x.ai/v1';

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (!err || typeof err !== 'object') return false;
  return (err as any).name === 'AbortError';
}

async function readErrorMessage(res: Response): Promise<string> {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    bodyText = '';
  }

  const fallback = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  if (!bodyText) return fallback;

  try {
    const parsed = JSON.parse(bodyText) as any;
    const msg =
      (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) ||
      (typeof parsed?.message === 'string' && parsed.message.trim()) ||
      '';
    if (msg) return msg;
  } catch {
    // ignore
  }

  const snippet = bodyText.length > 240 ? `${bodyText.slice(0, 240)}…` : bodyText;
  return `${fallback}: ${snippet}`;
}

function buildHeaders(args: { apiKey: string; json?: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.apiKey}`,
  };
  if (args.json) headers['Content-Type'] = 'application/json';
  return headers;
}

function extractText(raw: any): string {
  if (typeof raw?.output_text === 'string' && raw.output_text.trim()) return String(raw.output_text);
  if (typeof raw?.text === 'string' && raw.text.trim()) return String(raw.text);

  try {
    if (Array.isArray(raw?.output)) {
      const outputArr: any[] = raw.output;
      for (const item of outputArr) {
        if (!item || !Array.isArray(item.content)) continue;
        for (const c of item.content) {
          if (typeof c?.output_text === 'string' && c.output_text.trim()) return String(c.output_text);
          if (typeof c?.text === 'string' && c.text.trim()) return String(c.text);
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const fromChoices = raw?.choices?.[0]?.message?.content;
    if (typeof fromChoices === 'string' && fromChoices.trim()) return String(fromChoices);
  } catch {
    // ignore
  }

  return '';
}

export async function sendXaiResponse(args: {
  apiKey: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<XaiResult> {
  try {
    const res = await fetch(`${XAI_API_BASE_URL}/responses`, {
      method: 'POST',
      headers: buildHeaders({ apiKey: args.apiKey, json: true }),
      body: JSON.stringify(args.request ?? {}),
      signal: args.signal,
    });
    if (!res.ok) return { ok: false, text: '', error: await readErrorMessage(res) };

    const raw = (await res.json()) as any;
    const text = extractText(raw);
    return { ok: true, text, response: raw };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, text: '', error: 'Canceled', cancelled: true };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, text: '', error: msg };
  }
}

