export type AnthropicStreamCallbacks = {
  onDelta?: (delta: string, fullText: string) => void;
  onEvent?: (evt: unknown) => void;
};

export type AnthropicStreamResult =
  | { ok: true; text: string; response: unknown }
  | { ok: false; text: string; error: string; cancelled?: boolean; response?: unknown };

export function getAnthropicApiKey(): string | null {
  const trimmed = String(import.meta.env.ANTHROPIC_API_KEY ?? import.meta.env.VITE_ANTHROPIC_API_KEY ?? '').trim();
  return trimmed ? trimmed : null;
}

const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

function getAnthropicBetaHeader(): string | null {
  const trimmed = String(import.meta.env.ANTHROPIC_BETA ?? import.meta.env.VITE_ANTHROPIC_BETA ?? '').trim();
  return trimmed ? trimmed : null;
}

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
    'x-api-key': args.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const beta = getAnthropicBetaHeader();
  if (beta) headers['anthropic-beta'] = beta;
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

async function* iterateSseMessages(args: { res: Response; signal?: AbortSignal }): AsyncGenerator<SseMessage, void, void> {
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

function extractTextFromMessage(raw: unknown): string {
  try {
    const anyRaw: any = raw as any;
    const content = Array.isArray(anyRaw?.content) ? (anyRaw.content as any[]) : [];
    const parts = content
      .map((b) => {
        if (!b || typeof b !== 'object') return '';
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        return '';
      })
      .filter((t) => typeof t === 'string' && t.length > 0);
    return parts.join('');
  } catch {
    return '';
  }
}

export async function sendAnthropicMessage(args: {
  apiKey: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<AnthropicStreamResult> {
  try {
    const res = await fetch(`${ANTHROPIC_API_BASE_URL}/messages`, {
      method: 'POST',
      headers: buildHeaders({ apiKey: args.apiKey, json: true }),
      body: JSON.stringify(args.request ?? {}),
      signal: args.signal,
    });
    if (!res.ok) return { ok: false, text: '', error: await readErrorMessage(res) };

    const raw = (await res.json()) as any;
    const text = extractTextFromMessage(raw);
    return { ok: true, text, response: raw };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, text: '', error: 'Canceled', cancelled: true };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, text: '', error: msg };
  }
}

export async function streamAnthropicMessage(args: {
  apiKey: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
  callbacks?: AnthropicStreamCallbacks;
}): Promise<AnthropicStreamResult> {
  const req = { ...(args.request ?? {}), stream: true };
  let fullText = '';
  let message: any | null = null;
  const contentBlocks: any[] = [];
  let streamError: string | null = null;

  try {
    const res = await fetch(`${ANTHROPIC_API_BASE_URL}/messages`, {
      method: 'POST',
      headers: buildHeaders({ apiKey: args.apiKey, json: true, acceptSse: true }),
      body: JSON.stringify(req),
      signal: args.signal,
    });
    if (!res.ok) return { ok: false, text: fullText, error: await readErrorMessage(res), response: message ?? undefined };
    if (!res.body) return { ok: false, text: fullText, error: 'Streaming response had no body', response: message ?? undefined };

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

      if (t === 'message_start' && evt?.message) {
        message = evt.message;
      } else if (t === 'content_block_start') {
        const idx = typeof evt?.index === 'number' ? evt.index : null;
        if (idx != null) contentBlocks[idx] = evt?.content_block ?? null;
      } else if (t === 'content_block_delta') {
        const idx = typeof evt?.index === 'number' ? evt.index : null;
        const delta = evt?.delta;
        const deltaType = typeof delta?.type === 'string' ? String(delta.type) : '';

        if (idx != null && deltaType === 'text_delta') {
          const textDelta = typeof delta?.text === 'string' ? String(delta.text) : '';
          if (textDelta) {
            fullText += textDelta;
            args.callbacks?.onDelta?.(textDelta, fullText);

            const existingBlock = contentBlocks[idx];
            if (existingBlock && typeof existingBlock === 'object') {
              const existingText = typeof (existingBlock as any).text === 'string' ? String((existingBlock as any).text) : '';
              (existingBlock as any).text = existingText + textDelta;
            } else {
              contentBlocks[idx] = { type: 'text', text: textDelta };
            }
          }
        }
      } else if (t === 'message_delta') {
        if (message && typeof message === 'object') {
          const stopReason = typeof evt?.delta?.stop_reason === 'string' ? String(evt.delta.stop_reason) : '';
          if (stopReason) message.stop_reason = stopReason;
          if (evt?.delta && Object.prototype.hasOwnProperty.call(evt.delta, 'stop_sequence')) message.stop_sequence = evt.delta.stop_sequence;
          if (evt?.usage) message.usage = evt.usage;
        }
      } else if (t === 'error') {
        const msg = typeof evt?.error?.message === 'string' ? String(evt.error.message) : '';
        streamError = msg || 'Streaming error';
      }

      if (streamError) break;
    }

    if (streamError) return { ok: false, text: fullText, error: streamError, response: message ?? undefined };

    const response = (() => {
      const content = contentBlocks.filter((b) => b != null);
      if (message && typeof message === 'object') {
        return { ...message, ...(content.length ? { content } : {}) };
      }
      return {
        type: 'message',
        role: 'assistant',
        content: content.length ? content : [{ type: 'text', text: fullText }],
      };
    })();

    const responseText = extractTextFromMessage(response);
    const text = fullText || responseText;
    return { ok: true, text, response };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, text: fullText, error: 'Canceled', cancelled: true, response: message ?? undefined };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, text: fullText, error: msg, response: message ?? undefined };
  }
}

