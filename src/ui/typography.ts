export type FontFamilyKey = 'ui-monospace' | 'ui-sans-serif' | 'font-sans';

export type FontFamilyOption = { key: FontFamilyKey; label: string; css: string };

export const FONT_FAMILY_OPTIONS: FontFamilyOption[] = [
  {
    key: 'ui-monospace',
    label: 'UI Monospace',
    css: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  {
    key: 'ui-sans-serif',
    label: 'UI Sans',
    css: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  },
  {
    key: 'font-sans',
    label: 'Font Sans',
    css: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
  },
];

export function normalizeFontFamilyKey(value: unknown, fallback: FontFamilyKey): FontFamilyKey {
  const raw = typeof value === 'string' ? value : '';
  switch (raw) {
    case 'ui-monospace':
    case 'ui-sans-serif':
    case 'font-sans':
      return raw;
    default:
      return fallback;
  }
}

export function fontFamilyCss(key: FontFamilyKey): string {
  const found = FONT_FAMILY_OPTIONS.find((opt) => opt.key === key);
  return found?.css ?? FONT_FAMILY_OPTIONS[0]!.css;
}

