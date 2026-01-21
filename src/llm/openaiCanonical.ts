import type { CanonicalAssistantMessage } from '../model/chat';

export type ReasoningSummaryBlock = { type: 'summary_text'; text: string };

export type CanonicalMeta = {
  usedWebSearch?: boolean;
  effort?: unknown;
  verbosity?: unknown;
  reasoningSummaryBlocks?: ReasoningSummaryBlock[];
};

export function extractCanonicalMeta(
  raw: unknown,
  opts?: { usedWebSearch?: boolean; effort?: unknown; verbosity?: unknown },
): CanonicalMeta {
  let reasoningSummaryBlocks: ReasoningSummaryBlock[] | undefined;
  try {
    const anyRaw: any = raw as any;
    let source: any;
    if (anyRaw && anyRaw.reasoning && Array.isArray(anyRaw.reasoning.summary)) source = anyRaw.reasoning.summary;
    else if (anyRaw?.response?.reasoning && Array.isArray(anyRaw.response.reasoning.summary)) source = anyRaw.response.reasoning.summary;
    else if (Array.isArray(anyRaw?.output)) {
      const reasoningItem = (anyRaw.output as any[]).find((item) => item && item.type === 'reasoning' && Array.isArray(item.summary));
      if (reasoningItem) source = reasoningItem.summary;
    }
    if (Array.isArray(source)) {
      reasoningSummaryBlocks = source
        .map((b: any) => ({ type: 'summary_text' as const, text: typeof b?.text === 'string' ? b.text : String(b?.text ?? '') }))
        .filter((b: any) => typeof b?.text === 'string' && b.text.trim().length > 0);
    }
  } catch {
    // ignore
  }

  return {
    usedWebSearch: opts?.usedWebSearch,
    effort: opts?.effort,
    verbosity: opts?.verbosity,
    reasoningSummaryBlocks,
  };
}

export function extractCanonicalMessage(raw: unknown, fallbackText: string): CanonicalAssistantMessage | undefined {
  try {
    const anyRaw: any = raw as any;
    let text: string | undefined;

    if (typeof anyRaw?.output_text === 'string' && anyRaw.output_text.trim()) {
      text = anyRaw.output_text;
    } else if (Array.isArray(anyRaw?.output)) {
      const outputArr: any[] = anyRaw.output;
      outer: for (const item of outputArr) {
        if (Array.isArray(item?.content)) {
          for (const c of item.content) {
            if (typeof c?.output_text === 'string' && c.output_text.trim()) {
              text = c.output_text;
              break outer;
            }
            if (typeof c?.text === 'string' && c.text.trim()) {
              text = c.text;
              break outer;
            }
          }
        }
      }
    }

    if (!text && typeof fallbackText === 'string' && fallbackText.trim()) text = fallbackText.trim();
    if (!text) return undefined;
    return { role: 'assistant', text };
  } catch {
    return undefined;
  }
}

