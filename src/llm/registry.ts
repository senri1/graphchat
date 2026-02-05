export type ProviderId = 'openai' | 'gemini' | 'anthropic';

export type TextVerbosity = 'low' | 'medium' | 'high';

export interface ModelInfo {
  id: string; // UI/model id used in the app (e.g. 'gpt-4o-mini')
  provider: ProviderId;
  apiModel: string; // provider model name (e.g. 'gpt-4o-mini')
  label: string;
  shortLabel?: string;
  supportsImageInput: boolean;
  parameters: {
    webSearch: boolean;
    streaming: boolean;
    background: boolean;
  };
  defaults?: {
    webSearch: boolean;
    streaming: boolean;
    background: boolean;
    verbosity?: TextVerbosity;
  };
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  reasoningSummary?: boolean;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
}

const REGISTRY: ModelInfo[] = [
  {
    id: 'gpt-5.2-xhigh',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (xHigh)',
    shortLabel: 'GPT 5.2 xHigh',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: true },
    defaults: { webSearch: true, streaming: true, background: false, verbosity: 'medium' },
    effort: 'xhigh',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.2-high',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (High)',
    shortLabel: 'GPT 5.2 High ',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: true },
    defaults: { webSearch: true, streaming: true, background: false, verbosity: 'medium' },
    effort: 'high',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.2-medium',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (Medium)',
    shortLabel: 'GPT 5.2 Medium',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: true },
    defaults: { webSearch: true, streaming: true, background: false, verbosity: 'medium' },
    effort: 'medium',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.2-low',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (Low)',
    shortLabel: 'GPT 5.2 Low',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: false },
    defaults: { webSearch: true, streaming: true, background: false, verbosity: 'medium' },
    effort: 'low',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.2-none',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    label: 'OpenAI - GPT-5.2 (None)',
    shortLabel: 'GPT 5.2 None',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: false },
    defaults: { webSearch: true, streaming: true, background: false, verbosity: 'medium' },
    effort: 'none',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.1-medium',
    provider: 'openai',
    apiModel: 'gpt-5.1',
    label: 'OpenAI - GPT5.1-Medium',
    shortLabel: 'GPT5.1-Medium',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: true },
    defaults: { webSearch: true, streaming: true, verbosity: 'medium', background: false },
    effort: 'medium',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.1-low',
    provider: 'openai',
    apiModel: 'gpt-5.1',
    label: 'OpenAI - GPT5.1-Low',
    shortLabel: 'GPT5.1-Low',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: false },
    defaults: { webSearch: true, streaming: true, verbosity: 'medium', background: false },
    effort: 'low',
    reasoningSummary: true,
  },
  {
    id: 'gpt-5.1-none',
    provider: 'openai',
    apiModel: 'gpt-5.1',
    label: 'OpenAI - GPT5.1-None',
    shortLabel: 'GPT5.1-None',
    supportsImageInput: true,
    parameters: { webSearch: false, streaming: true, background: false },
    defaults: { webSearch: false, streaming: true, verbosity: 'medium', background: false },
    effort: 'none',
  },
  {
    id: 'gemini-3-pro-high',
    provider: 'gemini',
    apiModel: 'gemini-3-pro-preview',
    label: 'Gemini - 3 Pro (High)',
    shortLabel: 'Gemini 3 Pro High',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: false, background: false },
    defaults: { webSearch: true, streaming: false, background: false },
    thinkingLevel: 'high',
  },
  {
    id: 'gemini-3-pro-low',
    provider: 'gemini',
    apiModel: 'gemini-3-pro-preview',
    label: 'Gemini - 3 Pro (Low)',
    shortLabel: 'Gemini 3 Pro Low',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: false, background: false },
    defaults: { webSearch: true, streaming: false, background: false },
    thinkingLevel: 'low',
  },
  {
    id: 'gemini-3-flash-high',
    provider: 'gemini',
    apiModel: 'gemini-3-flash-preview',
    label: 'Gemini - 3 Pro (High)',
    shortLabel: 'Gemini 3 Flash High',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: false, background: false },
    defaults: { webSearch: true, streaming: false, background: false },
    thinkingLevel: 'high',
  },
  {
    id: 'gemini-3-flash-medium',
    provider: 'gemini',
    apiModel: 'gemini-3-flash-preview',
    label: 'Gemini - 3 Flash (Medium)',
    shortLabel: 'Gemini 3 Flash Medium',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: false, background: false },
    defaults: { webSearch: true, streaming: false, background: false },
    thinkingLevel: 'medium',
  },
  {
    id: 'gemini-3-flash-low',
    provider: 'gemini',
    apiModel: 'gemini-3-flash-preview',
    label: 'Gemini - 3 Flash (Low)',
    shortLabel: 'Gemini 3 Flash Low',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: false, background: false },
    defaults: { webSearch: true, streaming: false, background: false },
    thinkingLevel: 'low',
  },
  {
    id: 'gemini-3-flash-minimal',
    provider: 'gemini',
    apiModel: 'gemini-3-flash-preview',
    label: 'Gemini - 3 Flash (Minimal)',
    shortLabel: 'Gemini 3 Flash Minimal',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: false, background: false },
    defaults: { webSearch: true, streaming: false, background: false },
    thinkingLevel: 'minimal',
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    apiModel: 'gemini-2.5-pro',
    label: 'Gemini - 2.5 Pro',
    shortLabel: 'Gemini 2.5 Pro',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: false, background: false },
    defaults: { webSearch: true, streaming: false, background: false },
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    apiModel: 'gemini-2.5-flash',
    label: 'Gemini - 2.5 Flash',
    shortLabel: 'Gemini 2.5 Flash',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: false, background: false },
    defaults: { webSearch: true, streaming: false, background: false },
  },
  {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-5',
    label: 'Anthropic - Claude Sonnet 4.5',
    shortLabel: 'Sonnet 4.5',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: false },
    defaults: { webSearch: true, streaming: true, background: false },
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    apiModel: 'claude-haiku-4-5',
    label: 'Anthropic - Claude Haiku 4.5',
    shortLabel: 'Haiku 4.5',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: false },
    defaults: { webSearch: true, streaming: true, background: false },
  },
  {
    id: 'claude-opus-4-5',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-5',
    label: 'Anthropic - Claude Opus 4.5',
    shortLabel: 'Opus 4.5',
    supportsImageInput: true,
    parameters: { webSearch: true, streaming: true, background: false },
    defaults: { webSearch: true, streaming: true, background: false },
  },
];

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return REGISTRY.find((m) => m.id === modelId);
}

export function listModels(): ModelInfo[] {
  return REGISTRY.slice();
}

export const DEFAULT_MODEL_ID: string = 'gpt-5.2-high';
