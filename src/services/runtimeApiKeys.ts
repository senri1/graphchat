export type RuntimeApiProvider = 'openai' | 'gemini' | 'anthropic' | 'xai';

export type RuntimeApiKeys = Record<RuntimeApiProvider, string>;

const RUNTIME_API_KEYS_STORAGE_KEY = 'graphchatv1.runtimeApiKeys.v1';

const EMPTY_RUNTIME_API_KEYS: RuntimeApiKeys = {
  openai: '',
  gemini: '',
  anthropic: '',
  xai: '',
};

let cachedRuntimeApiKeys: RuntimeApiKeys | null = null;

function cleanApiKey(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return raw;
}

function ensureRuntimeApiKeysShape(value: unknown): RuntimeApiKeys {
  const obj = value && typeof value === 'object' ? (value as any) : {};
  return {
    openai: cleanApiKey(obj.openai),
    gemini: cleanApiKey(obj.gemini),
    anthropic: cleanApiKey(obj.anthropic),
    xai: cleanApiKey(obj.xai),
  };
}

function readRuntimeApiKeysFromStorage(): RuntimeApiKeys {
  if (typeof window === 'undefined') return { ...EMPTY_RUNTIME_API_KEYS };
  try {
    const raw = window.localStorage.getItem(RUNTIME_API_KEYS_STORAGE_KEY);
    if (!raw) return { ...EMPTY_RUNTIME_API_KEYS };
    const parsed = JSON.parse(raw);
    return ensureRuntimeApiKeysShape(parsed);
  } catch {
    return { ...EMPTY_RUNTIME_API_KEYS };
  }
}

function writeRuntimeApiKeysToStorage(keys: RuntimeApiKeys): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RUNTIME_API_KEYS_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // ignore localStorage write failures (private mode, quota, etc.)
  }
}

function runtimeApiKeys(): RuntimeApiKeys {
  if (cachedRuntimeApiKeys) return cachedRuntimeApiKeys;
  cachedRuntimeApiKeys = readRuntimeApiKeysFromStorage();
  return cachedRuntimeApiKeys;
}

export function getRuntimeApiKey(provider: RuntimeApiProvider): string | null {
  const value = cleanApiKey(runtimeApiKeys()[provider]);
  return value || null;
}

export function getRuntimeApiKeys(): RuntimeApiKeys {
  return { ...runtimeApiKeys() };
}

export function setRuntimeApiKey(provider: RuntimeApiProvider, value: string): RuntimeApiKeys {
  const next: RuntimeApiKeys = { ...runtimeApiKeys(), [provider]: cleanApiKey(value) };
  cachedRuntimeApiKeys = next;
  writeRuntimeApiKeysToStorage(next);
  return { ...next };
}

export function clearRuntimeApiKey(provider: RuntimeApiProvider): RuntimeApiKeys {
  return setRuntimeApiKey(provider, '');
}
