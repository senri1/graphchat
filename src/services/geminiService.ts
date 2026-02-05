import { GoogleGenAI } from '@google/genai';
import type { CanonicalAssistantMessage } from '../model/chat';

export type GeminiReply = {
  text: string;
  raw: any;
  cancelled?: boolean;
  request?: any;
  canonicalMeta?: any;
  canonicalMessage?: CanonicalAssistantMessage;
  usage?: any;
};

export type GeminiStreamCallbacks = {
  onDelta?: (delta: string, fullText: string) => void;
  onChunk?: (chunk: unknown) => void;
};

export function getGeminiApiKey(): string | null {
  const trimmed = String(import.meta.env.GEMINI_API_KEY ?? '').trim();
  return trimmed ? trimmed : null;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (!err || typeof err !== 'object') return false;
  return (err as any).name === 'AbortError';
}

// Insert inline, clickable citations based on grounding metadata.
// Starts from response.text, but additionally uses each segment.text to
// realign indices in case of encoding/normalization differences.
function addInlineCitations(response: any): string | null {
  try {
    let text: string | undefined = response?.text;
    if (typeof text !== 'string' || !text.length) return null;

    const supports = response?.candidates?.[0]?.groundingMetadata?.groundingSupports;
    const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (!Array.isArray(supports) || !Array.isArray(chunks) || supports.length === 0) {
      return text;
    }

    type SupportWithIndex = { support: any; insertAt: number };
    const enhanced: SupportWithIndex[] = [];

    for (const support of supports) {
      let insertAt: number | undefined = support?.segment?.endIndex;
      const segmentText: string | undefined = support?.segment?.text;

      // If segment.text is available, prefer aligning based on it.
      if (typeof segmentText === 'string' && segmentText.length > 0) {
        const found = text.indexOf(segmentText);
        if (found >= 0) {
          insertAt = found + segmentText.length;
        }
      }

      if (typeof insertAt === 'number' && insertAt >= 0 && insertAt <= text.length) {
        enhanced.push({ support, insertAt });
      }
    }

    if (!enhanced.length) return text;

    // Sort by the actual insertion index descending so earlier edits don't shift later ones.
    enhanced.sort((a, b) => b.insertAt - a.insertAt);

    for (const { support, insertAt } of enhanced) {
      const indices: number[] | undefined = support?.groundingChunkIndices;
      if (!Array.isArray(indices) || indices.length === 0) continue;

      const citationLinks = indices
        .map((i) => {
          const uri = chunks[i]?.web?.uri;
          if (typeof uri === 'string' && uri) {
            // Wrap the URI in angle brackets to tolerate spaces and
            // other characters that would otherwise break Markdown links.
            const safeUri = uri.replace(/>/g, '%3E');
            // Render the visible link label as "[n]" using HTML entities
            // so it is not parsed as LaTeX \\[...\\] display math.
            const label = `&#91;${i + 1}&#93;`;
            return `[${label}](<${safeUri}>)`;
          }
          return null;
        })
        .filter((v): v is string => !!v);

      if (!citationLinks.length) continue;

      const citationString = citationLinks.join(', ');
      text = text.slice(0, insertAt) + citationString + text.slice(insertAt);
    }

    return text;
  } catch {
    return null;
  }
}

function extractChunkTextDelta(chunk: any): string {
  if (!chunk) return '';
  if (typeof chunk.text === 'string') return chunk.text;
  const parts = chunk?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return '';
  return parts.map((p: any) => (typeof p?.text === 'string' ? String(p.text) : '')).join('');
}

function injectAbortSignalIntoRequest(args: { request: any; signal?: AbortSignal }): any {
  const baseRequest: any = args.request || {};
  const baseConfig: any =
    baseRequest.config && typeof baseRequest.config === 'object' && !Array.isArray(baseRequest.config) ? baseRequest.config : null;
  if (!args.signal) {
    return baseConfig ? { ...baseRequest, config: { ...baseConfig } } : { ...baseRequest };
  }
  const nextConfig = { ...(baseConfig ?? {}), abortSignal: args.signal };
  return { ...baseRequest, config: nextConfig };
}

function buildAggregatedRawFromStream(args: {
  finalChunk: any;
  fullText: string;
  request: any;
}): any {
  const base = (() => {
    try {
      return JSON.parse(JSON.stringify(args.finalChunk));
    } catch {
      return args.finalChunk;
    }
  })();

  const candidates = Array.isArray(base?.candidates) ? base.candidates : [];
  const c0 = candidates[0] && typeof candidates[0] === 'object' ? candidates[0] : {};
  const content = c0?.content && typeof c0.content === 'object' ? c0.content : {};
  const role = typeof content?.role === 'string' && content.role ? content.role : 'model';

  const nextCandidate0 = {
    ...c0,
    content: {
      ...content,
      role,
      parts: [{ text: args.fullText }],
    },
  };

  const nextCandidates = candidates.length ? [nextCandidate0, ...candidates.slice(1)] : [nextCandidate0];
  return { ...(base ?? {}), candidates: nextCandidates, request: args.request };
}

export async function sendGeminiResponse(args: { request: any; signal?: AbortSignal }): Promise<GeminiReply> {
  try {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      return { text: 'Gemini API key missing. Set GEMINI_API_KEY in graphchatv1/.env.local', raw: null };
    }

    const ai = new GoogleGenAI({ apiKey });

    // Stage 2: send the fully-constructed request from the context builder.
    const baseRequest: any = args.request || {};
    const requestForSend = injectAbortSignalIntoRequest({ request: baseRequest, signal: args.signal });
    const response = await (ai as any).models.generateContent(requestForSend);

    let raw: any = null;
    try {
      raw = JSON.parse(JSON.stringify(response));
    } catch {
      raw = response;
    }

    // Prefer citation-enriched text when grounding metadata is present.
    let text: string;
    const withCitations = addInlineCitations(response);
    if (typeof withCitations === 'string') {
      text = withCitations;
    } else if (typeof response?.text === 'string') {
      text = response.text;
    } else if (Array.isArray(response?.candidates)) {
      text = String(response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
    } else {
      text = '';
    }

    const canonicalMessage =
      text && text.trim() ? ({ role: 'assistant', text: text.trim() } as CanonicalAssistantMessage) : undefined;
    const usedWebSearch =
      !!(baseRequest.config &&
        Array.isArray((baseRequest.config as any).tools) &&
        (baseRequest.config as any).tools.some((t: any) => t && typeof t === 'object' && 'googleSearch' in t));

    const canonicalMeta = { usedWebSearch };
    const enrichedRaw = { ...raw, request: baseRequest };

    return { text, raw: enrichedRaw, request: baseRequest, canonicalMeta, canonicalMessage };
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    if (isAbortError(error)) return { text: 'Canceled', raw: null, cancelled: true };
    if (error instanceof Error) return { text: `An error occurred: ${error.message}`, raw: null };
    return { text: 'An unknown error occurred while contacting Gemini.', raw: null };
  }
}

export async function streamGeminiResponse(args: {
  request: any;
  signal?: AbortSignal;
  callbacks?: GeminiStreamCallbacks;
}): Promise<GeminiReply> {
  let fullText = '';
  let finalChunk: any = null;

  try {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      return { text: 'Gemini API key missing. Set GEMINI_API_KEY in graphchatv1/.env.local', raw: null };
    }

    const ai = new GoogleGenAI({ apiKey });
    const baseRequest: any = args.request || {};
    const requestForSend = injectAbortSignalIntoRequest({ request: baseRequest, signal: args.signal });

    const stream = (await (ai as any).models.generateContentStream(requestForSend)) as AsyncGenerator<any, any, unknown>;

    for await (const chunk of stream) {
      if (args.signal?.aborted) break;
      finalChunk = chunk ?? finalChunk;
      args.callbacks?.onChunk?.(chunk);
      const delta = extractChunkTextDelta(chunk);
      if (!delta) continue;
      fullText += delta;
      args.callbacks?.onDelta?.(delta, fullText);
    }

    if (args.signal?.aborted) return { text: 'Canceled', raw: null, cancelled: true };

    const aggregatedRaw = buildAggregatedRawFromStream({ finalChunk, fullText, request: baseRequest });

    const responseForCitations = { ...aggregatedRaw, text: fullText };
    const withCitations = addInlineCitations(responseForCitations);
    const finalText = typeof withCitations === 'string' ? withCitations : fullText;

    const canonicalMessage =
      finalText && finalText.trim()
        ? ({ role: 'assistant', text: finalText.trim() } as CanonicalAssistantMessage)
        : undefined;
    const usedWebSearch =
      !!(baseRequest.config &&
        Array.isArray((baseRequest.config as any).tools) &&
        (baseRequest.config as any).tools.some((t: any) => t && typeof t === 'object' && 'googleSearch' in t));
    const canonicalMeta = { usedWebSearch };

    return {
      text: finalText,
      raw: aggregatedRaw,
      request: baseRequest,
      canonicalMeta,
      canonicalMessage,
    };
  } catch (error) {
    console.error('Error calling Gemini streaming API:', error);
    if (isAbortError(error) || args.signal?.aborted) return { text: 'Canceled', raw: null, cancelled: true };
    if (error instanceof Error) return { text: `An error occurred: ${error.message}`, raw: null };
    return { text: 'An unknown error occurred while contacting Gemini.', raw: null };
  }
}
