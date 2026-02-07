/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly OPENAI_API_KEY?: string;
  readonly GEMINI_API_KEY?: string;
  readonly XAI_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly ANTHROPIC_BETA?: string;
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_XAI_API_KEY?: string;
  readonly VITE_ANTHROPIC_API_KEY?: string;
  readonly VITE_ANTHROPIC_BETA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  gcElectron?: {
    compileLatex: (req: { source: string; engine?: 'pdflatex' | 'xelatex' | 'lualatex' }) => Promise<{
      ok: boolean;
      pdfBase64?: string;
      log?: string;
      error?: string;
    }>;
  };
}
