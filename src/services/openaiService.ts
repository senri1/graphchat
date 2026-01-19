export type OpenAIStreamCallbacks = {
  onDelta?: (delta: string, fullText: string) => void;
  onEvent?: (evt: unknown) => void;
};

export type OpenAIStreamResult =
  | { ok: true; text: string; response: unknown }
  | { ok: false; text: string; error: string; cancelled?: boolean; response?: unknown };

export function getOpenAIApiKey(): string | null {
  const trimmed = (import.meta.env.VITE_OPENAI_API_KEY ?? '').trim();
  return trimmed ? trimmed : null;
}

function parseSseEventData(block: string): string {
  // SSE spec: event data is one or more `data:` lines; concatenate with `\n`.
  // We ignore other fields (event:, id:, retry:).
  const lines = block.split('\n');
  const dataParts: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    dataParts.push(line.slice(5).replace(/^\s*/, ''));
  }
  return dataParts.join('\n');
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
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify(req),
      signal: args.signal,
    });

    if (!resp.ok) {
      let errText = `OpenAI request failed (${resp.status})`;
      try {
        const body = await resp.json();
        const msg = (body as any)?.error?.message ?? (body as any)?.message;
        if (msg) errText = String(msg);
        return { ok: false, text: '', error: errText, response: body };
      } catch {
        try {
          const txt = await resp.text();
          if (txt) errText = txt;
        } catch {
          // ignore
        }
      }
      return { ok: false, text: '', error: errText };
    }

    const reader = resp.body?.getReader?.();
    if (!reader) {
      // Fallback (non-stream): try read as JSON.
      try {
        const body = await resp.json();
        const text = typeof (body as any)?.output_text === 'string' ? String((body as any).output_text) : '';
        return { ok: true, text, response: body };
      } catch {
        const txt = await resp.text();
        return { ok: true, text: txt, response: txt };
      }
    }

    const decoder = new TextDecoder();
    let buf = '';
    let done = false;

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      if (!value) continue;

      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n');

      while (true) {
        const idx = buf.indexOf('\n\n');
        if (idx === -1) break;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        const data = parseSseEventData(block).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          done = true;
          break;
        }

        let evt: any;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }

        args.callbacks?.onEvent?.(evt);

        const t = typeof evt?.type === 'string' ? (evt.type as string) : '';
        if (t === 'response.output_text.delta' || t === 'response.refusal.delta') {
          const delta = typeof evt?.delta === 'string' ? (evt.delta as string) : '';
          if (delta) {
            fullText += delta;
            args.callbacks?.onDelta?.(delta, fullText);
          }
        }

        if (t === 'response.completed' && evt?.response) {
          rawFinal = evt.response;
        }
      }
    }

    return { ok: true, text: fullText, response: rawFinal ?? { output_text: fullText } };
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') || (err && typeof err === 'object' && (err as any).name === 'AbortError');
    if (isAbort) return { ok: false, text: fullText, error: 'Canceled', cancelled: true };
    const msg = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
    return { ok: false, text: fullText, error: msg };
  }
}
