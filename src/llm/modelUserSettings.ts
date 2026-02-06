import type { ModelInfo, TextVerbosity } from './registry';

export type ReasoningSummarySetting = 'auto' | 'detailed' | 'off';
export type AnthropicEffortSetting = 'low' | 'medium' | 'high' | 'max';

const BASE_ANTHROPIC_EFFORT_OPTIONS: AnthropicEffortSetting[] = ['low', 'medium', 'high'];

function isAnthropicModel(model: ModelInfo | null | undefined): model is ModelInfo {
  return Boolean(model && model.provider === 'anthropic');
}

function modelIdHints(model: ModelInfo | null | undefined): string {
  if (!isAnthropicModel(model)) return '';
  return `${String(model.id ?? '').toLowerCase()} ${String(model.apiModel ?? '').toLowerCase()}`;
}

export function supportsAnthropicAdaptiveThinking(model: ModelInfo | null | undefined): boolean {
  if (!isAnthropicModel(model)) return false;
  return modelIdHints(model).includes('opus-4-6');
}

export function supportsAnthropicEffort(model: ModelInfo | null | undefined): boolean {
  if (!isAnthropicModel(model)) return false;
  const hints = modelIdHints(model);
  return hints.includes('opus-4-6') || hints.includes('opus-4-5');
}

function supportsAnthropicMaxEffort(model: ModelInfo | null | undefined): boolean {
  if (!model || model.provider !== 'anthropic') return false;
  return supportsAnthropicAdaptiveThinking(model);
}

export function getAnthropicEffortOptions(model: ModelInfo | null | undefined): AnthropicEffortSetting[] {
  if (!supportsAnthropicEffort(model)) return [];
  if (!supportsAnthropicMaxEffort(model)) return BASE_ANTHROPIC_EFFORT_OPTIONS.slice();
  return [...BASE_ANTHROPIC_EFFORT_OPTIONS, 'max'];
}

export function getDefaultAnthropicEffort(model: ModelInfo | null | undefined): AnthropicEffortSetting | undefined {
  if (!supportsAnthropicEffort(model)) return undefined;
  return supportsAnthropicMaxEffort(model) ? 'max' : 'high';
}

export function normalizeAnthropicEffort(
  model: ModelInfo | null | undefined,
  raw: unknown,
): AnthropicEffortSetting | undefined {
  if (!supportsAnthropicEffort(model)) return undefined;
  const options = getAnthropicEffortOptions(model);
  const fallback = getDefaultAnthropicEffort(model);
  const value = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'max') {
    if (options.includes(value as AnthropicEffortSetting)) return value as AnthropicEffortSetting;
  }
  return fallback;
}

export type ModelUserSettings = {
  includeInComposer: boolean;
  streaming: boolean;
  background: boolean;
  verbosity: TextVerbosity;
  reasoningSummary: ReasoningSummarySetting;
  maxTokens?: number;
  anthropicEffort?: AnthropicEffortSetting;
};

export type ModelUserSettingsById = Record<string, ModelUserSettings>;

export function defaultModelUserSettings(model: ModelInfo): ModelUserSettings {
  const streamingDefault =
    model.parameters.streaming && typeof model.defaults?.streaming === 'boolean' ? model.defaults.streaming : Boolean(model.parameters.streaming);
  const backgroundDefault =
    model.parameters.background && typeof model.defaults?.background === 'boolean'
      ? model.defaults.background
      : Boolean(model.parameters.background);
  const verbosityDefault: TextVerbosity =
    model.defaults?.verbosity === 'low' || model.defaults?.verbosity === 'medium' || model.defaults?.verbosity === 'high'
      ? model.defaults.verbosity
      : 'medium';
  const reasoningSummaryDefault: ReasoningSummarySetting = model.effort && model.reasoningSummary ? 'auto' : 'off';

  return {
    includeInComposer: true,
    streaming: model.parameters.streaming ? streamingDefault : false,
    background: model.parameters.background ? backgroundDefault : false,
    verbosity: verbosityDefault,
    reasoningSummary: reasoningSummaryDefault,
    ...(model.provider === 'anthropic'
      ? {
          maxTokens: 4096,
          ...(supportsAnthropicEffort(model) ? { anthropicEffort: getDefaultAnthropicEffort(model) } : {}),
        }
      : {}),
  };
}

export function normalizeModelUserSettings(model: ModelInfo, raw: unknown): ModelUserSettings {
  const defaults = defaultModelUserSettings(model);
  const obj = raw && typeof raw === 'object' ? (raw as any) : {};

  const includeInComposer =
    typeof obj.includeInComposer === 'boolean' ? obj.includeInComposer : defaults.includeInComposer;

  const streaming = typeof obj.streaming === 'boolean' ? obj.streaming : defaults.streaming;
  const background = typeof obj.background === 'boolean' ? obj.background : defaults.background;

  const verbosityRaw = typeof obj.verbosity === 'string' ? obj.verbosity : defaults.verbosity;
  const verbosity: TextVerbosity =
    verbosityRaw === 'low' || verbosityRaw === 'medium' || verbosityRaw === 'high' ? verbosityRaw : defaults.verbosity;

  const summaryRaw = typeof obj.reasoningSummary === 'string' ? obj.reasoningSummary : defaults.reasoningSummary;
  const reasoningSummary: ReasoningSummarySetting =
    summaryRaw === 'auto' || summaryRaw === 'detailed' || summaryRaw === 'off' ? summaryRaw : defaults.reasoningSummary;

  const maxTokens = (() => {
    if (model.provider !== 'anthropic') return undefined;
    const rawVal = obj.maxTokens;
    const n =
      typeof rawVal === 'number'
        ? rawVal
        : typeof rawVal === 'string' && rawVal.trim()
          ? Number(rawVal)
          : undefined;
    if (typeof n !== 'number' || !Number.isFinite(n)) return defaults.maxTokens ?? 4096;
    const clamped = Math.max(1, Math.min(200000, Math.floor(n)));
    return clamped;
  })();

  const anthropicEffort = (() => {
    if (model.provider !== 'anthropic') return undefined;
    if (!supportsAnthropicEffort(model)) return undefined;
    const rawVal = obj.anthropicEffort;
    const fallback = defaults.anthropicEffort;
    return normalizeAnthropicEffort(model, typeof rawVal === 'string' ? rawVal : fallback);
  })();

  return {
    includeInComposer,
    streaming: model.parameters.streaming ? streaming : false,
    background: model.parameters.background ? background : false,
    verbosity,
    reasoningSummary: model.effort ? reasoningSummary : 'off',
    ...(model.provider === 'anthropic'
      ? {
          maxTokens,
          anthropicEffort,
        }
      : {}),
  };
}

export function buildModelUserSettings(models: ModelInfo[], raw: unknown): ModelUserSettingsById {
  const out: ModelUserSettingsById = {};
  const obj = raw && typeof raw === 'object' ? (raw as any) : {};
  for (const model of models) {
    out[model.id] = normalizeModelUserSettings(model, obj[model.id]);
  }
  return out;
}
