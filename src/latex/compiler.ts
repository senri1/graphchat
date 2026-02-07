export type LatexCompileRequest = {
  source?: string;
  projectRoot?: string;
  mainFile?: string;
  engine?: 'pdflatex' | 'xelatex' | 'lualatex';
};

export type LatexCompileResult = {
  ok: boolean;
  pdfBase64?: string;
  log?: string;
  error?: string;
};

type ElectronCompileApi = {
  compileLatex: (req: LatexCompileRequest) => Promise<LatexCompileResult>;
};

function getElectronApi(): ElectronCompileApi | null {
  const anyWindow = window as unknown as { gcElectron?: ElectronCompileApi };
  const api = anyWindow.gcElectron;
  return api && typeof api.compileLatex === 'function' ? api : null;
}

export async function compileLatexDocument(req: LatexCompileRequest): Promise<LatexCompileResult> {
  const source = typeof req?.source === 'string' ? req.source : '';
  const projectRoot = typeof req?.projectRoot === 'string' ? req.projectRoot.trim() : '';
  const mainFile = typeof req?.mainFile === 'string' ? req.mainFile.trim() : '';
  const projectMode = Boolean(projectRoot && mainFile);
  if (!projectMode && !source.trim()) return { ok: false, error: 'LaTeX source is empty.' };

  const api = getElectronApi();
  if (!api) {
    return {
      ok: false,
      error: 'LaTeX compile is only available in desktop mode. Start the Electron app to compile locally.',
    };
  }

  try {
    const res = await api.compileLatex({
      ...(projectMode ? { projectRoot, mainFile } : { source }),
      engine: req.engine === 'xelatex' || req.engine === 'lualatex' ? req.engine : 'pdflatex',
    });
    if (!res || typeof res !== 'object') return { ok: false, error: 'Compiler returned an invalid response.' };
    return res;
  } catch (err: any) {
    const msg = err ? String(err?.message ?? err) : 'Compile failed.';
    return { ok: false, error: msg };
  }
}
