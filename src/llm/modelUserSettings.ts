import type { ModelInfo, TextVerbosity } from './registry';

export type ReasoningSummarySetting = 'auto' | 'detailed' | 'off';

export type ModelUserSettings = {
  includeInComposer: boolean;
  streaming: boolean;
  background: boolean;
  verbosity: TextVerbosity;
  reasoningSummary: ReasoningSummarySetting;
  maxTokens?: number;
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
  const maxTokensDefault = model.provider === 'anthropic' ? 4096 : undefined;

  return {
    includeInComposer: true,
    streaming: model.parameters.streaming ? streamingDefault : false,
    background: model.parameters.background ? backgroundDefault : false,
    verbosity: verbosityDefault,
    reasoningSummary: reasoningSummaryDefault,
    ...(maxTokensDefault != null ? { maxTokens: maxTokensDefault } : {}),
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

  return {
    includeInComposer,
    streaming: model.parameters.streaming ? streaming : false,
    background: model.parameters.background ? background : false,
    verbosity,
    reasoningSummary: model.effort ? reasoningSummary : 'off',
    ...(model.provider === 'anthropic' ? { maxTokens } : {}),
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
