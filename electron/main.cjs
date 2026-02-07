const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const APP_TITLE = 'GraphChatV1';
const LATEX_TIMEOUT_MS = 60_000;
const LATEX_MAX_LOG_CHARS = 600_000;
const LATEX_PROJECT_MAX_FILES = 8_000;
const LATEX_PROJECT_MAX_READ_BYTES = 2_000_000;
const LATEX_PROJECT_EDITABLE_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md']);
const LATEX_PROJECT_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next']);
const LATEX_PROJECT_ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg', '.pdf', '.eps', '.ps',
  '.csv', '.tsv', '.json', '.yaml', '.yml',
]);

function clampLog(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  if (raw.length <= LATEX_MAX_LOG_CHARS) return raw;
  return `${raw.slice(0, LATEX_MAX_LOG_CHARS)}\n\n[log truncated]`;
}

function trimMessage(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!raw) return fallback;
  return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
}

function latexmkArgs(engine, targetFile) {
  const selected = engine === 'xelatex' || engine === 'lualatex' ? engine : 'pdflatex';
  const engineFlag = selected === 'xelatex' ? '-xelatex' : selected === 'lualatex' ? '-lualatex' : '-pdf';
  return [
    engineFlag,
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    '-synctex=1',
    '-no-shell-escape',
    targetFile,
  ];
}

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function toPosixPath(value) {
  return String(value ?? '').split(path.sep).join('/');
}

function isPathInside(baseDir, maybeChild) {
  const rel = path.relative(baseDir, maybeChild);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeProjectRoot(value) {
  const root = asTrimmedString(value);
  if (!root) throw new Error('Project root is missing.');
  return path.resolve(root);
}

function normalizeProjectRelativePath(value) {
  const raw = asTrimmedString(value).replace(/\\/g, '/');
  if (!raw) throw new Error('File path is missing.');
  if (raw.startsWith('/')) throw new Error('Absolute paths are not allowed.');
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Invalid file path.');
  }
  return normalized;
}

async function resolveProjectPath(projectRoot, relativePath) {
  const root = normalizeProjectRoot(projectRoot);
  const rel = normalizeProjectRelativePath(relativePath);
  const absolutePath = path.resolve(root, rel);
  if (!isPathInside(root, absolutePath)) throw new Error('File path is outside project root.');
  return { root, rel, absolutePath };
}

function latexProjectFileKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tex') return 'tex';
  if (ext === '.bib') return 'bib';
  if (ext === '.sty' || ext === '.bst') return 'style';
  if (ext === '.cls') return 'class';
  if (LATEX_PROJECT_ASSET_EXT.has(ext)) return 'asset';
  return 'other';
}

function isLatexProjectEditableFile(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  return LATEX_PROJECT_EDITABLE_EXT.has(ext);
}

async function collectProjectFiles(projectRoot) {
  const root = normalizeProjectRoot(projectRoot);
  const out = [];
  let texMain = null;
  const stack = [''];

  while (stack.length > 0) {
    const relDir = stack.pop() ?? '';
    const absDir = path.join(root, relDir);
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    for (const entry of entries) {
      const name = String(entry.name ?? '');
      if (!name || name === '.' || name === '..') continue;
      if (entry.isDirectory()) {
        if (name.startsWith('.') || LATEX_PROJECT_SKIP_DIRS.has(name)) continue;
        const childRel = relDir ? `${relDir}/${name}` : name;
        stack.push(childRel);
        continue;
      }

      if (!entry.isFile()) continue;
      const relPath = relDir ? `${relDir}/${name}` : name;
      const editable = isLatexProjectEditableFile(relPath);

      out.push({
        path: relPath,
        kind: latexProjectFileKind(relPath),
        editable,
      });

      if (out.length > LATEX_PROJECT_MAX_FILES) {
        throw new Error(`Project has too many files (>${LATEX_PROJECT_MAX_FILES}).`);
      }
    }
  }

  out.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const texFiles = out.filter((f) => f.kind === 'tex' && f.editable).map((f) => f.path);
  if (texFiles.includes('main.tex')) {
    texMain = 'main.tex';
  } else if (texFiles.length > 0) {
    texMain = texFiles[0];
    for (const relPath of texFiles) {
      try {
        const absPath = path.join(root, relPath);
        const sample = await fs.readFile(absPath, { encoding: 'utf8' });
        if (/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(sample)) {
          texMain = relPath;
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  return { files: out, suggestedMainFile: texMain };
}

function readLogOnFailure(result, fallbackLogPath) {
  return (async () => {
    let fileLog = '';
    try {
      fileLog = await fs.readFile(fallbackLogPath, 'utf8');
    } catch {
      fileLog = '';
    }
    const mergedLog = clampLog([result.log, fileLog].filter(Boolean).join('\n'));
    const timeoutMsg = result.timedOut ? `LaTeX compile timed out after ${Math.floor(LATEX_TIMEOUT_MS / 1000)}s.` : '';
    const errMsg = trimMessage(result.error, timeoutMsg || `LaTeX compile failed (exit ${result.code ?? 'unknown'}).`);
    return { ok: false, error: errMsg, log: mergedLog };
  })();
}

async function runLatexmk(cwd, args) {
  return await new Promise((resolve) => {
    const child = spawn('latexmk', args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, LATEX_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (finished) return;
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (finished) return;
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        timedOut,
        error: trimMessage(err?.message, 'Failed to start latexmk.'),
        log: clampLog(`${stdout}\n${stderr}`),
      });
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        log: clampLog(`${stdout}\n${stderr}`),
      });
    });
  });
}

async function runLatexCompileFromProject(req) {
  const projectRoot = asTrimmedString(req?.projectRoot);
  const mainFile = asTrimmedString(req?.mainFile);
  if (!projectRoot || !mainFile) return { ok: false, error: 'Project root or main file is missing.' };

  const resolved = await resolveProjectPath(projectRoot, mainFile);
  if (path.extname(resolved.absolutePath).toLowerCase() !== '.tex') {
    return { ok: false, error: 'Main file must be a .tex file.' };
  }

  const rootStat = await fs.stat(resolved.root);
  if (!rootStat.isDirectory()) return { ok: false, error: 'Project root is not a directory.' };
  const mainStat = await fs.stat(resolved.absolutePath);
  if (!mainStat.isFile()) return { ok: false, error: 'Main file does not exist.' };

  const args = latexmkArgs(req?.engine, toPosixPath(resolved.rel));
  const result = await runLatexmk(resolved.root, args);
  const pdfPath = resolved.absolutePath.replace(/\.tex$/i, '.pdf');
  const logPath = resolved.absolutePath.replace(/\.tex$/i, '.log');
  if (!result.ok) return await readLogOnFailure(result, logPath);

  try {
    const pdf = await fs.readFile(pdfPath);
    return { ok: true, pdfBase64: pdf.toString('base64'), log: result.log };
  } catch {
    return { ok: false, error: 'Compile finished but output PDF was not found.', log: result.log };
  }
}

async function runLatexCompileFromInline(req) {
  const source = typeof req?.source === 'string' ? req.source : '';
  if (!source.trim()) return { ok: false, error: 'LaTeX source is empty.' };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graphchatv1-latex-'));
  const texPath = path.join(dir, 'main.tex');
  const pdfPath = path.join(dir, 'main.pdf');
  const logPath = path.join(dir, 'main.log');

  try {
    await fs.writeFile(texPath, source, 'utf8');
    const result = await runLatexmk(dir, latexmkArgs(req?.engine, 'main.tex'));
    if (!result.ok) return await readLogOnFailure(result, logPath);
    const pdf = await fs.readFile(pdfPath);
    return { ok: true, pdfBase64: pdf.toString('base64'), log: result.log };
  } finally {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function runLatexCompile(req) {
  const projectRoot = asTrimmedString(req?.projectRoot);
  const mainFile = asTrimmedString(req?.mainFile);
  if (projectRoot && mainFile) {
    try {
      return await runLatexCompileFromProject(req);
    } catch (err) {
      return { ok: false, error: trimMessage(err?.message, 'LaTeX compile failed.') };
    }
  }
  try {
    return await runLatexCompileFromInline(req);
  } catch (err) {
    return { ok: false, error: trimMessage(err?.message, 'LaTeX compile failed.') };
  }
}

function createWindow() {
  const preload = path.join(__dirname, 'preload.cjs');
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 980,
    minHeight: 720,
    title: APP_TITLE,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  win.loadFile(indexPath);
}

ipcMain.handle('latex:compile', async (_event, req) => {
  try {
    return await runLatexCompile(req ?? {});
  } catch (err) {
    return { ok: false, error: trimMessage(err?.message, 'LaTeX compile failed.') };
  }
});

ipcMain.handle('latex:pick-project', async (event) => {
  try {
    const browserWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const res = await dialog.showOpenDialog(browserWindow, {
      title: 'Select LaTeX project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
      return { ok: false, error: 'Project selection was canceled.' };
    }
    const projectRoot = asTrimmedString(res.filePaths[0]);
    return projectRoot ? { ok: true, projectRoot } : { ok: false, error: 'Project selection was canceled.' };
  } catch (err) {
    return { ok: false, error: trimMessage(err?.message, 'Failed to pick project folder.') };
  }
});

ipcMain.handle('latex:list-project-files', async (_event, req) => {
  try {
    const projectRoot = asTrimmedString(req?.projectRoot);
    if (!projectRoot) return { ok: false, error: 'Project root is missing.' };
    const index = await collectProjectFiles(projectRoot);
    return { ok: true, files: index.files, suggestedMainFile: index.suggestedMainFile };
  } catch (err) {
    return { ok: false, error: trimMessage(err?.message, 'Failed to list project files.') };
  }
});

ipcMain.handle('latex:read-project-file', async (_event, req) => {
  try {
    const resolved = await resolveProjectPath(req?.projectRoot, req?.path);
    if (!isLatexProjectEditableFile(resolved.rel)) {
      return { ok: false, error: 'Only editable text files are supported in the MVP.' };
    }
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isFile()) return { ok: false, error: 'File not found.' };
    if (stat.size > LATEX_PROJECT_MAX_READ_BYTES) {
      return { ok: false, error: `File is too large to open (${Math.round(stat.size / 1024)} KB).` };
    }
    const content = await fs.readFile(resolved.absolutePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: trimMessage(err?.message, 'Failed to read file.') };
  }
});

ipcMain.handle('latex:write-project-file', async (_event, req) => {
  try {
    const resolved = await resolveProjectPath(req?.projectRoot, req?.path);
    if (!isLatexProjectEditableFile(resolved.rel)) {
      return { ok: false, error: 'Only editable text files are supported in the MVP.' };
    }
    await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    const content = typeof req?.content === 'string' ? req.content : String(req?.content ?? '');
    await fs.writeFile(resolved.absolutePath, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: trimMessage(err?.message, 'Failed to write file.') };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
