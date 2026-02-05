/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly OPENAI_API_KEY?: string;
  readonly GEMINI_API_KEY?: string;
  readonly XAI_API_KEY?: string;
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_XAI_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
