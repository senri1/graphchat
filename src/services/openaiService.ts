export type OpenAIStreamCallbacks = {
  onDelta?: (delta: string, fullText: string) => void;
  onEvent?: (evt: unknown) => void;
};

export type OpenAIStreamResult =
  | { ok: true; text: string; response: unknown }
  | { ok: false; text: string; error: string; cancelled?: boolean; response?: unknown };

export type OpenAIBackgroundStartResult =
  | { ok: true; responseId: string; status?: string; response: unknown }
  | { ok: false; error: string; cancelled?: boolean; response?: unknown };

export type OpenAIRetrieveResult =
  | { ok: true; response: unknown; status?: string }
  | { ok: false; error: string; cancelled?: boolean; response?: unknown };

export function getOpenAIApiKey(): string | null {
  const trimmed = (import.meta.env.VITE_OPENAI_API_KEY ?? '').trim();
  return trimmed ? trimmed : null;
}

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

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

function buildHeaders(args: { apiKey: string; acceptSse?: boolean; json?: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.apiKey}`,
  };
  if (args.acceptSse) headers.Accept = 'text/event-stream';
  if (args.json) headers['Content-Type'] = 'application/json';
  return headers;
}

type SseMessage = { event: string | null; data: string };

function parseSseBlock(block: string): SseMessage | null {
  const trimmed = block.trim();
  if (!trimmed) return null;
  const lines = trimmed.split('\n');
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      event = value || null;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  const data = dataLines.join('\n');
  if (!data) return null;
  return { event, data };
}

async function* iterateSseMessages(args: {
  res: Response;
  signal?: AbortSignal;
}): AsyncGenerator<SseMessage, void, void> {
  if (!args.res.body) return;
  const reader = args.res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (args.signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      while (true) {
        const delim = buffer.indexOf('\n\n');
        if (delim === -1) break;
        const block = buffer.slice(0, delim);
        buffer = buffer.slice(delim + 2);
        const msg = parseSseBlock(block);
        if (msg) yield msg;
      }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');
    while (true) {
      const delim = buffer.indexOf('\n\n');
      if (delim === -1) break;
      const block = buffer.slice(0, delim);
      buffer = buffer.slice(delim + 2);
      const msg = parseSseBlock(block);
      if (msg) yield msg;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

export async function sendOpenAIResponse(args: {
  apiKey: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<OpenAIStreamResult> {
  try {
    const res = await fetch(`${OPENAI_API_BASE_URL}/responses`, {
      method: 'POST',
      headers: buildHeaders({ apiKey: args.apiKey, json: true }),
      body: JSON.stringify(args.request ?? {}),
      signal: args.signal,
    });
    if (!res.ok) return { ok: false, text: '', error: await readErrorMessage(res) };

    const raw = (await res.json()) as any;
    const outputText = typeof raw?.output_text === 'string' ? String(raw.output_text) : '';
    return { ok: true, text: outputText, response: raw };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, text: '', error: 'Canceled', cancelled: true };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, text: '', error: msg };
  }
}

export async function streamOpenAIResponse(args: {
  apiKey: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
  callbacks?: OpenAIStreamCallbacks;
}): Promise<OpenAIStreamResult> {
  const req = { ...(args.request ?? {}), stream: true };
  let fullText = '';
  let rawFinal: unknown = null;
  let streamError: string | null = null;

  try {
    const res = await fetch(`${OPENAI_API_BASE_URL}/responses`, {
      method: 'POST',
      headers: buildHeaders({ apiKey: args.apiKey, json: true, acceptSse: true }),
      body: JSON.stringify(req),
      signal: args.signal,
    });

    if (!res.ok) return { ok: false, text: fullText, error: await readErrorMessage(res), response: rawFinal ?? undefined };
    if (!res.body) return { ok: false, text: fullText, error: 'Streaming response had no body', response: rawFinal ?? undefined };

    for await (const msg of iterateSseMessages({ res, signal: args.signal })) {
      if (args.signal?.aborted) break;
      const data = typeof msg.data === 'string' ? msg.data : '';
      if (!data) continue;
      if (data.trim() === '[DONE]') break;

      let evt: any = null;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }

      args.callbacks?.onEvent?.(evt);
      const t =
        typeof evt?.type === 'string'
          ? String(evt.type)
          : typeof msg.event === 'string'
            ? String(msg.event)
            : '';

      if (t === 'response.output_text.delta' || t === 'response.refusal.delta') {
        const delta = typeof evt?.delta === 'string' ? String(evt.delta) : '';
        if (delta) {
          fullText += delta;
          args.callbacks?.onDelta?.(delta, fullText);
        }
      } else if (t === 'error') {
        const msg = typeof evt?.error?.message === 'string' ? String(evt.error.message) : '';
        streamError = msg || 'Streaming error';
      }

      if ((t === 'response.completed' || t === 'response.failed' || t === 'response.incomplete') && evt?.response) {
        rawFinal = evt.response;
      }

      if (streamError) break;
    }

    if (streamError) return { ok: false, text: fullText, error: streamError, response: rawFinal ?? undefined };
    const raw = rawFinal ?? { output_text: fullText };
    const outputText = typeof (raw as any)?.output_text === 'string' ? String((raw as any).output_text) : '';
    const text = fullText || outputText;
    return { ok: true, text, response: raw };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, text: fullText, error: 'Canceled', cancelled: true, response: rawFinal ?? undefined };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, text: fullText, error: msg, response: rawFinal ?? undefined };
  }
}

export async function startOpenAIBackgroundResponse(args: {
  apiKey: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<OpenAIBackgroundStartResult> {
  try {
    const req = { ...(args.request ?? {}), background: true };
    if ((req as any).stream === true) delete (req as any).stream;
    const res = await fetch(`${OPENAI_API_BASE_URL}/responses`, {
      method: 'POST',
      headers: buildHeaders({ apiKey: args.apiKey, json: true }),
      body: JSON.stringify(req),
      signal: args.signal,
    });
    if (!res.ok) return { ok: false, error: await readErrorMessage(res) };

    const raw = (await res.json()) as any;
    const responseId = typeof raw?.id === 'string' ? String(raw.id) : '';
    if (!responseId) return { ok: false, error: 'Missing response id' };
    const status = typeof raw?.status === 'string' ? String(raw.status) : undefined;
    return { ok: true, responseId, status, response: raw };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, error: 'Canceled', cancelled: true };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, error: msg };
  }
}

export async function retrieveOpenAIResponse(args: {
  apiKey: string;
  responseId: string;
  signal?: AbortSignal;
}): Promise<OpenAIRetrieveResult> {
  try {
    const res = await fetch(`${OPENAI_API_BASE_URL}/responses/${encodeURIComponent(args.responseId)}`, {
      method: 'GET',
      headers: buildHeaders({ apiKey: args.apiKey }),
      signal: args.signal,
    });
    if (!res.ok) return { ok: false, error: await readErrorMessage(res) };

    const raw = (await res.json()) as any;
    const status = typeof raw?.status === 'string' ? String(raw.status) : undefined;
    return { ok: true, response: raw, status };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, error: 'Canceled', cancelled: true };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, error: msg };
  }
}

export async function cancelOpenAIResponse(args: {
  apiKey: string;
  responseId: string;
  signal?: AbortSignal;
}): Promise<OpenAIRetrieveResult> {
  try {
    const res = await fetch(`${OPENAI_API_BASE_URL}/responses/${encodeURIComponent(args.responseId)}/cancel`, {
      method: 'POST',
      headers: buildHeaders({ apiKey: args.apiKey, json: true }),
      body: JSON.stringify({}),
      signal: args.signal,
    });
    if (!res.ok) return { ok: false, error: await readErrorMessage(res) };

    const raw = (await res.json()) as any;
    const status = typeof raw?.status === 'string' ? String(raw.status) : undefined;
    return { ok: true, response: raw, status };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, error: 'Canceled', cancelled: true };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, error: msg };
  }
}

export async function streamOpenAIResponseById(args: {
  apiKey: string;
  responseId: string;
  startingAfter?: number;
  initialText?: string;
  signal?: AbortSignal;
  callbacks?: OpenAIStreamCallbacks;
}): Promise<OpenAIStreamResult> {
  let fullText = typeof args.initialText === 'string' ? args.initialText : '';
  let rawFinal: unknown = null;
  let streamError: string | null = null;

  try {
    const startingAfter = typeof args.startingAfter === 'number' && Number.isFinite(args.startingAfter) ? args.startingAfter : null;
    const url = new URL(`${OPENAI_API_BASE_URL}/responses/${encodeURIComponent(args.responseId)}`);
    url.searchParams.set('stream', 'true');
    if (startingAfter != null) url.searchParams.set('starting_after', String(startingAfter));

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: buildHeaders({ apiKey: args.apiKey, acceptSse: true }),
      signal: args.signal,
    });
    if (!res.ok) return { ok: false, text: fullText, error: await readErrorMessage(res), response: rawFinal ?? undefined };
    if (!res.body) return { ok: false, text: fullText, error: 'Streaming response had no body', response: rawFinal ?? undefined };

    for await (const msg of iterateSseMessages({ res, signal: args.signal })) {
      if (args.signal?.aborted) break;
      const data = typeof msg.data === 'string' ? msg.data : '';
      if (!data) continue;
      if (data.trim() === '[DONE]') break;

      let evt: any = null;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }

      const seq = typeof evt?.sequence_number === 'number' ? evt.sequence_number : null;
      if (startingAfter != null && seq != null && seq <= startingAfter) continue;

      args.callbacks?.onEvent?.(evt);
      const t =
        typeof evt?.type === 'string'
          ? String(evt.type)
          : typeof msg.event === 'string'
            ? String(msg.event)
            : '';

      if (t === 'response.output_text.delta' || t === 'response.refusal.delta') {
        const delta = typeof evt?.delta === 'string' ? String(evt.delta) : '';
        if (delta) {
          fullText += delta;
          args.callbacks?.onDelta?.(delta, fullText);
        }
      } else if (t === 'error') {
        const msg = typeof evt?.error?.message === 'string' ? String(evt.error.message) : '';
        streamError = msg || 'Streaming error';
      }

      if ((t === 'response.completed' || t === 'response.failed' || t === 'response.incomplete') && evt?.response) {
        rawFinal = evt.response;
      }

      if (streamError) break;
    }

    if (streamError) return { ok: false, text: fullText, error: streamError, response: rawFinal ?? undefined };
    const raw = rawFinal ?? { output_text: fullText };
    const outputText = typeof (raw as any)?.output_text === 'string' ? String((raw as any).output_text) : '';
    const text = fullText || outputText;
    return { ok: true, text, response: raw };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, text: fullText, error: 'Canceled', cancelled: true, response: rawFinal ?? undefined };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, text: fullText, error: msg, response: rawFinal ?? undefined };
  }
}
