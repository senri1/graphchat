import OpenAI from 'openai';

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

function createOpenAIClient(apiKey: string) {
  return new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true,
  });
}

export async function sendOpenAIResponse(args: {
  apiKey: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<OpenAIStreamResult> {
  try {
    const client = createOpenAIClient(args.apiKey);
    const res = await client.responses.create(args.request as any, { signal: args.signal } as any);
    let raw: unknown = res;
    try {
      raw = JSON.parse(JSON.stringify(res));
    } catch {
      raw = res;
    }
    const outputText = typeof (res as any)?.output_text === 'string' ? String((res as any).output_text) : '';
    return { ok: true, text: outputText, response: raw };
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') || (err && typeof err === 'object' && (err as any).name === 'AbortError');
    if (isAbort) return { ok: false, text: '', error: 'Canceled', cancelled: true };
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

  try {
    const client = createOpenAIClient(args.apiKey);
    const stream = await client.responses.create(req as any, { signal: args.signal } as any);

    for await (const evt of stream as any) {
      args.callbacks?.onEvent?.(evt);
      const t = typeof (evt as any)?.type === 'string' ? String((evt as any).type) : '';

      if (t === 'response.output_text.delta' || t === 'response.refusal.delta') {
        const delta = typeof (evt as any)?.delta === 'string' ? String((evt as any).delta) : '';
        if (delta) {
          fullText += delta;
          args.callbacks?.onDelta?.(delta, fullText);
        }
      }

      if ((t === 'response.completed' || t === 'response.failed' || t === 'response.incomplete') && (evt as any)?.response) {
        rawFinal = (evt as any).response;
      }
    }

    const raw = rawFinal ?? { output_text: fullText };
    const outputText = typeof (raw as any)?.output_text === 'string' ? String((raw as any).output_text) : '';
    const text = fullText || outputText;
    return { ok: true, text, response: raw };
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') || (err && typeof err === 'object' && (err as any).name === 'AbortError');
    if (isAbort) return { ok: false, text: fullText, error: 'Canceled', cancelled: true, response: rawFinal ?? undefined };
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
    const client = createOpenAIClient(args.apiKey);
    const req = { ...(args.request ?? {}), background: true };
    if ((req as any).stream === true) delete (req as any).stream;
    const res = await client.responses.create(req as any, { signal: args.signal } as any);
    let raw: unknown = res;
    try {
      raw = JSON.parse(JSON.stringify(res));
    } catch {
      raw = res;
    }
    const responseId = typeof (res as any)?.id === 'string' ? String((res as any).id) : '';
    if (!responseId) return { ok: false, error: 'Missing response id' };
    const status = typeof (res as any)?.status === 'string' ? String((res as any).status) : undefined;
    return { ok: true, responseId, status, response: raw };
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') || (err && typeof err === 'object' && (err as any).name === 'AbortError');
    if (isAbort) return { ok: false, error: 'Canceled', cancelled: true };
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
    const client = createOpenAIClient(args.apiKey);
    const res = await client.responses.retrieve(args.responseId, undefined as any, { signal: args.signal } as any);
    let raw: unknown = res;
    try {
      raw = JSON.parse(JSON.stringify(res));
    } catch {
      raw = res;
    }
    const status = typeof (res as any)?.status === 'string' ? String((res as any).status) : undefined;
    return { ok: true, response: raw, status };
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') || (err && typeof err === 'object' && (err as any).name === 'AbortError');
    if (isAbort) return { ok: false, error: 'Canceled', cancelled: true };
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
    const client = createOpenAIClient(args.apiKey);
    const res = await client.responses.cancel(args.responseId, { signal: args.signal } as any);
    let raw: unknown = res;
    try {
      raw = JSON.parse(JSON.stringify(res));
    } catch {
      raw = res;
    }
    const status = typeof (res as any)?.status === 'string' ? String((res as any).status) : undefined;
    return { ok: true, response: raw, status };
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') || (err && typeof err === 'object' && (err as any).name === 'AbortError');
    if (isAbort) return { ok: false, error: 'Canceled', cancelled: true };
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

  try {
    const client = createOpenAIClient(args.apiKey);
    const stream = await client.responses.retrieve(args.responseId, { stream: true } as any, { signal: args.signal } as any);

    const startingAfter = typeof args.startingAfter === 'number' && Number.isFinite(args.startingAfter) ? args.startingAfter : null;

    for await (const evt of stream as any) {
      const seq = typeof (evt as any)?.sequence_number === 'number' ? (evt as any).sequence_number : null;
      if (startingAfter != null && seq != null && seq <= startingAfter) continue;

      args.callbacks?.onEvent?.(evt);
      const t = typeof (evt as any)?.type === 'string' ? String((evt as any).type) : '';

      if (t === 'response.output_text.delta' || t === 'response.refusal.delta') {
        const delta = typeof (evt as any)?.delta === 'string' ? String((evt as any).delta) : '';
        if (delta) {
          fullText += delta;
          args.callbacks?.onDelta?.(delta, fullText);
        }
      }

      if ((t === 'response.completed' || t === 'response.failed' || t === 'response.incomplete') && (evt as any)?.response) {
        rawFinal = (evt as any).response;
      }
    }

    const raw = rawFinal ?? { output_text: fullText };
    const outputText = typeof (raw as any)?.output_text === 'string' ? String((raw as any).output_text) : '';
    const text = fullText || outputText;
    return { ok: true, text, response: raw };
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') || (err && typeof err === 'object' && (err as any).name === 'AbortError');
    if (isAbort) return { ok: false, text: fullText, error: 'Canceled', cancelled: true, response: rawFinal ?? undefined };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, text: fullText, error: msg, response: rawFinal ?? undefined };
  }
}
