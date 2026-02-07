export type LatexProjectFile = {
  path: string;
  kind: 'tex' | 'bib' | 'style' | 'class' | 'other';
};

export type LatexProjectIndex = {
  files: LatexProjectFile[];
  suggestedMainFile: string | null;
};

type ElectronProjectApi = {
  pickLatexProject?: () => Promise<{ ok: boolean; projectRoot?: string; error?: string }>;
  listLatexProjectFiles?: (req: { projectRoot: string }) => Promise<{
    ok: boolean;
    files?: LatexProjectFile[];
    suggestedMainFile?: string | null;
    error?: string;
  }>;
  readLatexProjectFile?: (req: { projectRoot: string; path: string }) => Promise<{ ok: boolean; content?: string; error?: string }>;
  writeLatexProjectFile?: (req: { projectRoot: string; path: string; content: string }) => Promise<{ ok: boolean; error?: string }>;
};

function getElectronApi(): ElectronProjectApi | null {
  const anyWindow = window as unknown as { gcElectron?: ElectronProjectApi | null };
  const api = anyWindow.gcElectron;
  return api ?? null;
}

function missingDesktopMessage(methodName: keyof Required<ElectronProjectApi>): string {
  const anyWindow = window as unknown as { gcElectron?: ElectronProjectApi | null };
  const api = anyWindow.gcElectron;
  if (!api) {
    return 'LaTeX project mode requires Electron desktop mode. Start with `npm run electron:dev`.';
  }
  if (typeof api[methodName] !== 'function') {
    return 'LaTeX project APIs are unavailable in this Electron session. Fully restart Electron (`npm run electron:dev`) to load the latest preload.';
  }
  return '';
}

export async function pickLatexProject(): Promise<{ ok: boolean; projectRoot?: string; error?: string }> {
  const api = getElectronApi();
  const missingMsg = missingDesktopMessage('pickLatexProject');
  if (!api || missingMsg) return { ok: false, error: missingMsg || 'LaTeX project mode is only available in desktop mode.' };
  try {
    const res = await api.pickLatexProject!();
    if (!res || typeof res !== 'object') return { ok: false, error: 'Project picker returned an invalid response.' };
    return res;
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err ?? 'Failed to pick project.') };
  }
}

export async function listLatexProjectFiles(projectRoot: string): Promise<{ ok: boolean; index?: LatexProjectIndex; error?: string }> {
  const root = typeof projectRoot === 'string' ? projectRoot.trim() : '';
  if (!root) return { ok: false, error: 'Project root is missing.' };
  const api = getElectronApi();
  const missingMsg = missingDesktopMessage('listLatexProjectFiles');
  if (!api || missingMsg) return { ok: false, error: missingMsg || 'LaTeX project mode is only available in desktop mode.' };
  try {
    const res = await api.listLatexProjectFiles!({ projectRoot: root });
    if (!res || typeof res !== 'object') return { ok: false, error: 'Project index returned an invalid response.' };
    if (!res.ok) return { ok: false, error: res.error ?? 'Failed to list project files.' };
    const files = Array.isArray(res.files) ? res.files : [];
    const suggestedMainFile = typeof res.suggestedMainFile === 'string' && res.suggestedMainFile.trim() ? res.suggestedMainFile : null;
    return { ok: true, index: { files, suggestedMainFile } };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err ?? 'Failed to list project files.') };
  }
}

export async function readLatexProjectFile(
  projectRoot: string,
  filePath: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const root = typeof projectRoot === 'string' ? projectRoot.trim() : '';
  const nextPath = typeof filePath === 'string' ? filePath.trim() : '';
  if (!root || !nextPath) return { ok: false, error: 'Project root or file path is missing.' };
  const api = getElectronApi();
  const missingMsg = missingDesktopMessage('readLatexProjectFile');
  if (!api || missingMsg) return { ok: false, error: missingMsg || 'LaTeX project mode is only available in desktop mode.' };
  try {
    const res = await api.readLatexProjectFile!({ projectRoot: root, path: nextPath });
    if (!res || typeof res !== 'object') return { ok: false, error: 'File read returned an invalid response.' };
    return res.ok ? { ok: true, content: typeof res.content === 'string' ? res.content : '' } : { ok: false, error: res.error ?? 'Failed to read file.' };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err ?? 'Failed to read file.') };
  }
}

export async function writeLatexProjectFile(
  projectRoot: string,
  filePath: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const root = typeof projectRoot === 'string' ? projectRoot.trim() : '';
  const nextPath = typeof filePath === 'string' ? filePath.trim() : '';
  if (!root || !nextPath) return { ok: false, error: 'Project root or file path is missing.' };
  const api = getElectronApi();
  const missingMsg = missingDesktopMessage('writeLatexProjectFile');
  if (!api || missingMsg) return { ok: false, error: missingMsg || 'LaTeX project mode is only available in desktop mode.' };
  try {
    const res = await api.writeLatexProjectFile!({
      projectRoot: root,
      path: nextPath,
      content: typeof content === 'string' ? content : String(content ?? ''),
    });
    if (!res || typeof res !== 'object') return { ok: false, error: 'File write returned an invalid response.' };
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Failed to write file.' };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err ?? 'Failed to write file.') };
  }
}
