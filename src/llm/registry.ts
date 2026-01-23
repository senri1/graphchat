export type ProviderId = 'openai' | 'gemini';

export type TextVerbosity = 'low' | 'medium' | 'high';

export interface ModelInfo {
  id: string; // UI/model id used in the app (e.g. 'gpt-4o-mini')
  provider: ProviderId;
  apiModel: string; // provider model name (e.g. 'gpt-4o-mini')
  label: string;
  shortLabel?: string;
  parameters: {
    webSearch: boolean;
    streaming: boolean;
  };
  defaults?: {
    webSearch: boolean;
    streaming: boolean;
    verbosity?: TextVerbosity;
  };
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  reasoningSummary?: boolean;
  thinkingLevel?: 'low' | 'high';
}

const REGISTRY: ModelInfo[] = [
  {
    id: 'gpt-5.2-xhigh',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (xHigh)',
    shortLabel: 'GPT 5.2 xHigh',
    parameters: { webSearch: true, streaming: true },
    defaults: { webSearch: true, streaming: true, verbosity: 'medium' },
    effort: 'xhigh',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.2-high',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (High)',
    shortLabel: 'GPT 5.2 High ',
    parameters: { webSearch: true, streaming: true },
    defaults: { webSearch: true, streaming: true, verbosity: 'medium' },
    effort: 'high',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.2-medium',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (Medium)',
    shortLabel: 'GPT 5.2 Medium',
    parameters: { webSearch: true, streaming: true },
    defaults: { webSearch: true, streaming: true, verbosity: 'medium' },
    effort: 'medium',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.2-low',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (Low)',
    shortLabel: 'GPT 5.2 Low',
    parameters: { webSearch: true, streaming: true },
    defaults: { webSearch: true, streaming: true, verbosity: 'medium' },
    effort: 'low',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.2-none',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (None)',
    shortLabel: 'GPT 5.2 None',
    parameters: { webSearch: true, streaming: true },
    defaults: { webSearch: true, streaming: true, verbosity: 'medium' },
    effort: 'none',
    reasoningSummary: true,
  },
];

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return REGISTRY.find((m) => m.id === modelId);
}

export function listModels(): ModelInfo[] {
  return REGISTRY.slice();
}

export const DEFAULT_MODEL_ID: string = 'gpt-5.2-high';

