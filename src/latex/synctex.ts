type ElectronSyncTexApi = {
  synctexForward: (req: {
    projectRoot: string;
    mainFile: string;
    sourceFile: string;
    line: number;
  }) => Promise<{ ok: boolean; page?: number; x?: number | null; y?: number | null; error?: string; log?: string }>;
  synctexInverse: (req: {
    projectRoot: string;
    mainFile: string;
    page: number;
    x: number;
    y: number;
  }) => Promise<{
    ok: boolean;
    filePath?: string | null;
    line?: number;
    column?: number | null;
    sourcePathRaw?: string;
    error?: string;
    log?: string;
  }>;
};

function getElectronApi(): ElectronSyncTexApi | null {
  const anyWindow = window as unknown as { gcElectron?: Partial<ElectronSyncTexApi> | null };
  const api = anyWindow.gcElectron;
  if (!api) return null;
  if (typeof api.synctexForward !== 'function' || typeof api.synctexInverse !== 'function') return null;
  return api as ElectronSyncTexApi;
}

export async function synctexForward(req: {
  projectRoot: string;
  mainFile: string;
  sourceFile: string;
  line: number;
}): Promise<{ ok: boolean; page?: number; x?: number | null; y?: number | null; error?: string; log?: string }> {
  const api = getElectronApi();
  if (!api) return { ok: false, error: 'SyncTeX is only available in desktop mode.' };
  try {
    const res = await api.synctexForward(req);
    if (!res || typeof res !== 'object') return { ok: false, error: 'SyncTeX returned an invalid response.' };
    return res;
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err ?? 'SyncTeX forward lookup failed.') };
  }
}

export async function synctexInverse(req: {
  projectRoot: string;
  mainFile: string;
  page: number;
  x: number;
  y: number;
}): Promise<{
  ok: boolean;
  filePath?: string | null;
  line?: number;
  column?: number | null;
  sourcePathRaw?: string;
  error?: string;
  log?: string;
}> {
  const api = getElectronApi();
  if (!api) return { ok: false, error: 'SyncTeX is only available in desktop mode.' };
  try {
    const res = await api.synctexInverse(req);
    if (!res || typeof res !== 'object') return { ok: false, error: 'SyncTeX returned an invalid response.' };
    return res;
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err ?? 'SyncTeX inverse lookup failed.') };
  }
}
