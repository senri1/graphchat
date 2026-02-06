import defaultSystemInstructionsMarkdown from './SystemInstructions.md?raw';

export const DEFAULT_SYSTEM_INSTRUCTIONS = String(defaultSystemInstructionsMarkdown ?? '');

export function normalizeSystemInstruction(value: unknown, fallback = DEFAULT_SYSTEM_INSTRUCTIONS): string {
  return typeof value === 'string' ? value : fallback;
}

export function resolveSystemInstruction(override: unknown, fallback = DEFAULT_SYSTEM_INSTRUCTIONS): string {
  return typeof override === 'string' ? override : fallback;
}
