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
    compileLatex: (req: {
      source?: string;
      projectRoot?: string;
      mainFile?: string;
      engine?: 'pdflatex' | 'xelatex' | 'lualatex';
    }) => Promise<{
      ok: boolean;
      pdfBase64?: string;
      log?: string;
      error?: string;
    }>;
    pickLatexProject: () => Promise<{ ok: boolean; projectRoot?: string; error?: string }>;
    listLatexProjectFiles: (req: { projectRoot: string }) => Promise<{
      ok: boolean;
      files?: Array<{ path: string; kind: 'tex' | 'bib' | 'style' | 'class' | 'asset' | 'other'; editable: boolean }>;
      suggestedMainFile?: string | null;
      error?: string;
    }>;
    readLatexProjectFile: (req: { projectRoot: string; path: string }) => Promise<{ ok: boolean; content?: string; error?: string }>;
    writeLatexProjectFile: (req: { projectRoot: string; path: string; content: string }) => Promise<{ ok: boolean; error?: string }>;
  };
}
