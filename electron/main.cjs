const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const APP_TITLE = 'GraphChatV1';
const LATEX_TIMEOUT_MS = 60_000;
const LATEX_MAX_LOG_CHARS = 600_000;

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

function latexmkArgs(engine) {
  const selected = engine === 'xelatex' || engine === 'lualatex' ? engine : 'pdflatex';
  const engineFlag = selected === 'xelatex' ? '-xelatex' : selected === 'lualatex' ? '-lualatex' : '-pdf';
  return [
    engineFlag,
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    '-no-shell-escape',
    '-jobname=main',
    'main.tex',
  ];
}

async function runLatexCompile(req) {
  const source = typeof req?.source === 'string' ? req.source : '';
  if (!source.trim()) return { ok: false, error: 'LaTeX source is empty.' };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graphchatv1-latex-'));
  const texPath = path.join(dir, 'main.tex');
  const pdfPath = path.join(dir, 'main.pdf');
  const logPath = path.join(dir, 'main.log');
  try {
    await fs.writeFile(texPath, source, 'utf8');
    const result = await new Promise((resolve) => {
      const args = latexmkArgs(req?.engine);
      const child = spawn('latexmk', args, { cwd: dir, windowsHide: true });
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

    if (!result.ok) {
      let fileLog = '';
      try {
        fileLog = await fs.readFile(logPath, 'utf8');
      } catch {
        fileLog = '';
      }
      const mergedLog = clampLog([result.log, fileLog].filter(Boolean).join('\n'));
      const timeoutMsg = result.timedOut ? `LaTeX compile timed out after ${Math.floor(LATEX_TIMEOUT_MS / 1000)}s.` : '';
      const errMsg = trimMessage(result.error, timeoutMsg || `LaTeX compile failed (exit ${result.code ?? 'unknown'}).`);
      return { ok: false, error: errMsg, log: mergedLog };
    }

    const pdf = await fs.readFile(pdfPath);
    return { ok: true, pdfBase64: pdf.toString('base64'), log: result.log };
  } catch (err) {
    const msg = trimMessage(err?.message, 'LaTeX compile failed.');
    return { ok: false, error: msg };
  } finally {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
