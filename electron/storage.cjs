const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const http = require('http');
const { randomUUID, randomBytes, createHash } = require('crypto');

const STORAGE_ROOT_DIRNAME = 'GraphChatV1Data';
const STORAGE_SCHEMA_DIRNAME = 'v1';
const STORAGE_LOCATION_CONFIG_FILE = 'storage-location.json';
const CLOUD_SYNC_CONFIG_FILE = 'cloud-sync.json';
const CLOUD_SYNC_SNAPSHOTS_DIRNAME = 'snapshots';
const CLOUD_SYNC_HEAD_FILE = 'HEAD.json';
const CLOUD_SYNC_SCHEMA_VERSION = 1;
const GOOGLE_DRIVE_SYNC_CONFIG_FILE = 'google-drive-sync.json';
const LOCAL_SYNC_BACKUPS_DIRNAME = 'sync-backups';
const LOCAL_SYNC_BACKUP_LATEST_DIRNAME = 'latest';
const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
];
const GOOGLE_DRIVE_ROOT_FOLDER_NAME = 'GraphChatV1 Sync';
const GOOGLE_DRIVE_HEAD_FILE = 'HEAD.json';
const GOOGLE_DRIVE_SYNC_PROGRESS_CHANNEL = 'storage:google-drive-sync-progress';

let storageBaseDirOverride = null;
let storageLocationConfigLoaded = false;
let activeStorageSyncOperation = null;

function makeSyncOperationId(prefix) {
  const p = String(prefix ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'sync';
  try {
    return `${p}_${randomUUID()}`;
  } catch {
    return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function beginStorageSyncOperation(kind) {
  if (activeStorageSyncOperation) return null;
  const op = {
    id: makeSyncOperationId(kind),
    kind: asTrimmedString(kind) || 'sync',
    startedAt: Date.now(),
  };
  activeStorageSyncOperation = op;
  return op;
}

function endStorageSyncOperation(op) {
  if (!op || !activeStorageSyncOperation) return;
  if (activeStorageSyncOperation.id === op.id) {
    activeStorageSyncOperation = null;
  }
}

function activeStorageSyncOperationMessage() {
  const op = activeStorageSyncOperation;
  if (!op || typeof op !== 'object') return 'Another sync operation is already in progress.';
  const kind = asTrimmedString(op.kind) || 'sync';
  return `Another sync operation is already in progress (${kind}).`;
}

function safeProgressReport(reporter, payload) {
  if (typeof reporter !== 'function') return;
  try {
    reporter(payload);
  } catch {
    // ignore progress callback errors
  }
}

function shortError(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!raw) return fallback;
  return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
}

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function encodeFsSegment(value, label = 'Value') {
  const raw = asTrimmedString(value);
  if (!raw) throw new Error(`${label} is missing.`);
  return encodeURIComponent(raw);
}

function decodeFsSegment(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
}

function storageLocationConfigPath(app) {
  return path.join(app.getPath('userData'), STORAGE_LOCATION_CONFIG_FILE);
}

function cloudSyncConfigPath(app) {
  return path.join(app.getPath('userData'), CLOUD_SYNC_CONFIG_FILE);
}

function googleDriveSyncConfigPath(app) {
  return path.join(app.getPath('userData'), GOOGLE_DRIVE_SYNC_CONFIG_FILE);
}

function normalizeAbsoluteDirOrNull(value) {
  const raw = asTrimmedString(value);
  if (!raw) return null;
  try {
    return path.resolve(raw);
  } catch {
    return null;
  }
}

function defaultStorageBaseDir(app) {
  return path.resolve(app.getPath('userData'));
}

function loadStorageLocationConfigOnce(app) {
  if (storageLocationConfigLoaded) return;
  storageLocationConfigLoaded = true;
  storageBaseDirOverride = null;

  try {
    const cfgPath = storageLocationConfigPath(app);
    if (!fsSync.existsSync(cfgPath)) return;
    const text = fsSync.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(text);
    const candidate = normalizeAbsoluteDirOrNull(parsed?.storageBaseDir);
    if (!candidate) return;
    const defaultBase = defaultStorageBaseDir(app);
    storageBaseDirOverride = candidate === defaultBase ? null : candidate;
  } catch {
    storageBaseDirOverride = null;
  }
}

function storageRootDirForBaseDir(baseDir) {
  return path.join(baseDir, STORAGE_ROOT_DIRNAME, STORAGE_SCHEMA_DIRNAME);
}

function isNestedPath(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(candidatePath);
  if (parent === child) return false;
  const rel = path.relative(parent, child);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function currentStorageBaseDir(app) {
  loadStorageLocationConfigOnce(app);
  return storageBaseDirOverride || defaultStorageBaseDir(app);
}

function currentStorageRootDir(app) {
  return storageRootDirForBaseDir(currentStorageBaseDir(app));
}

function storageRootDir(app) {
  return currentStorageRootDir(app);
}

function cloudSnapshotDir(cloudDir, revision) {
  return path.join(cloudDir, CLOUD_SYNC_SNAPSHOTS_DIRNAME, encodeFsSegment(revision, 'Revision id'));
}

function cloudHeadPath(cloudDir) {
  return path.join(cloudDir, CLOUD_SYNC_HEAD_FILE);
}

function normalizeCloudSyncConfig(raw) {
  const cloudDir = normalizeAbsoluteDirOrNull(raw?.cloudDir);
  const lastPulledRevision = asTrimmedString(raw?.lastPulledRevision) || null;
  return { cloudDir, lastPulledRevision };
}

async function readCloudSyncConfig(app) {
  const cfg = await readJsonOrNull(cloudSyncConfigPath(app));
  if (!cfg || typeof cfg !== 'object') return { cloudDir: null, lastPulledRevision: null };
  return normalizeCloudSyncConfig(cfg);
}

async function writeCloudSyncConfig(app, cfg) {
  const next = normalizeCloudSyncConfig(cfg);
  if (!next.cloudDir) {
    await removeFileIfExists(cloudSyncConfigPath(app));
    return { cloudDir: null, lastPulledRevision: null };
  }
  await writeJsonAtomic(cloudSyncConfigPath(app), {
    cloudDir: next.cloudDir,
    lastPulledRevision: next.lastPulledRevision,
    updatedAt: Date.now(),
  });
  return next;
}

function makeCloudRevisionId() {
  return `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readCloudHead(cloudDir) {
  const rec = await readJsonOrNull(cloudHeadPath(cloudDir));
  if (!rec || typeof rec !== 'object') return null;
  const revision = asTrimmedString(rec.revision);
  if (!revision) return null;
  const updatedAtRaw = Number(rec.updatedAt);
  return {
    revision,
    updatedAt: Number.isFinite(updatedAtRaw) ? updatedAtRaw : 0,
  };
}

function isSameOrNestedPath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (left === right) return true;
  return isNestedPath(left, right) || isNestedPath(right, left);
}

async function getCloudSyncInfo(app) {
  const cfg = await readCloudSyncConfig(app);
  const cloudDir = cfg.cloudDir;
  let remoteHead = null;
  if (cloudDir) {
    try {
      remoteHead = await readCloudHead(cloudDir);
    } catch {
      remoteHead = null;
    }
  }
  return {
    connected: Boolean(cloudDir),
    cloudDir: cloudDir || undefined,
    lastPulledRevision: cfg.lastPulledRevision || undefined,
    remoteHeadRevision: remoteHead?.revision || undefined,
    remoteHeadUpdatedAt: remoteHead ? remoteHead.updatedAt : undefined,
  };
}

async function ensureCloudSyncLayout(cloudDir) {
  await fs.mkdir(path.join(cloudDir, CLOUD_SYNC_SNAPSHOTS_DIRNAME), { recursive: true });
}

function localCloudPullBackupsDir(app) {
  return path.join(path.dirname(storageRootDir(app)), LOCAL_SYNC_BACKUPS_DIRNAME);
}

function localCloudLatestPullBackupPath(app) {
  return path.join(localCloudPullBackupsDir(app), LOCAL_SYNC_BACKUP_LATEST_DIRNAME);
}

async function removePathIfExists(absPath) {
  try {
    await fs.rm(absPath, { recursive: true, force: true });
  } catch (err) {
    if (!(err && typeof err === 'object' && err.code === 'ENOENT')) throw err;
  }
}

async function removeLocalSyncBackupsExcept(backupsDir, keepName) {
  let entries = [];
  try {
    entries = await fs.readdir(backupsDir, { withFileTypes: true });
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const name = String(entry?.name ?? '');
      if (!name || name === keepName || name === '.' || name === '..') return;
      await removePathIfExists(path.join(backupsDir, name));
    }),
  );
}

async function createSingleLocalPullBackup(app, localRoot) {
  const exists = await dirExists(localRoot);
  if (!exists) return null;

  const backupsDir = localCloudPullBackupsDir(app);
  const latestBackupPath = localCloudLatestPullBackupPath(app);
  const tmpBackupPath = `${latestBackupPath}.tmp-${process.pid}-${Date.now()}`;
  const prevBackupPath = `${latestBackupPath}.prev-${process.pid}-${Date.now()}`;

  await fs.mkdir(backupsDir, { recursive: true });
  await removePathIfExists(tmpBackupPath);
  await removePathIfExists(prevBackupPath);
  await fs.cp(localRoot, tmpBackupPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  if ((await dirExists(latestBackupPath)) || (await fileExists(latestBackupPath))) {
    await fs.rename(latestBackupPath, prevBackupPath);
  }

  try {
    await fs.rename(tmpBackupPath, latestBackupPath);
  } catch (err) {
    await removePathIfExists(tmpBackupPath);
    if (!(await dirExists(latestBackupPath)) && ((await dirExists(prevBackupPath)) || (await fileExists(prevBackupPath)))) {
      try {
        await fs.rename(prevBackupPath, latestBackupPath);
      } catch {
        // ignore rollback failure
      }
    }
    throw err;
  }

  await removePathIfExists(prevBackupPath);
  await removeLocalSyncBackupsExcept(backupsDir, LOCAL_SYNC_BACKUP_LATEST_DIRNAME);
  return latestBackupPath;
}

async function summarizePathUsage(absPath) {
  const stack = [absPath];
  let totalSizeBytes = 0;
  let updatedAt = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let stat = null;
    try {
      stat = await fs.stat(current);
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'ENOENT') continue;
      throw err;
    }
    if (!stat) continue;

    const mtimeMs = Number(stat.mtimeMs);
    if (Number.isFinite(mtimeMs) && mtimeMs > updatedAt) updatedAt = mtimeMs;

    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (err) {
        if (err && typeof err === 'object' && err.code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        const name = String(entry?.name ?? '');
        if (!name || name === '.' || name === '..') continue;
        stack.push(path.join(current, name));
      }
      continue;
    }

    if (stat.isFile()) {
      const size = Number(stat.size);
      if (Number.isFinite(size) && size > 0) totalSizeBytes += size;
    }
  }

  return {
    sizeBytes: totalSizeBytes,
    updatedAt: updatedAt > 0 ? Math.floor(updatedAt) : 0,
  };
}

async function getLocalSyncBackupInfo(app) {
  const backupPath = localCloudLatestPullBackupPath(app);
  const exists = (await dirExists(backupPath)) || (await fileExists(backupPath));
  if (!exists) {
    return {
      exists: false,
      backupPath,
      sizeBytes: 0,
      updatedAt: 0,
    };
  }

  const summary = await summarizePathUsage(backupPath);
  return {
    exists: true,
    backupPath,
    sizeBytes: summary.sizeBytes,
    updatedAt: summary.updatedAt,
  };
}

async function deleteLocalSyncBackups(app) {
  const backupsDir = localCloudPullBackupsDir(app);
  const latestBackupPath = localCloudLatestPullBackupPath(app);
  const hadAny = (await dirExists(backupsDir)) || (await fileExists(backupsDir));
  await removePathIfExists(backupsDir);
  return { deleted: hadAny, backupPath: latestBackupPath };
}

async function pushStorageToCloud(app, opts = {}) {
  const cfg = await readCloudSyncConfig(app);
  const cloudDir = cfg.cloudDir;
  if (!cloudDir) throw new Error('Cloud sync folder is not configured.');

  const localRoot = storageRootDir(app);
  if (isSameOrNestedPath(localRoot, cloudDir)) {
    throw new Error('Cloud sync folder must not be the same as, or inside, the local storage folder.');
  }

  await ensureCloudSyncLayout(cloudDir);
  const remoteHead = await readCloudHead(cloudDir);
  const remoteRevision = remoteHead?.revision ?? null;
  const lastPulled = cfg.lastPulledRevision ?? null;
  const force = opts?.force === true;

  if (!force && remoteRevision && remoteRevision !== lastPulled) {
    if (lastPulled) {
      throw new Error(`Cloud has newer revision ${remoteRevision}. Pull first (local last pulled ${lastPulled}).`);
    }
    throw new Error(`Cloud has existing revision ${remoteRevision}. Pull first on this device before pushing.`);
  }

  const revision = makeCloudRevisionId();
  const snapshotDir = cloudSnapshotDir(cloudDir, revision);
  const tmpSnapshotDir = `${snapshotDir}.tmp-${process.pid}-${Date.now()}`;
  await fs.rm(tmpSnapshotDir, { recursive: true, force: true });

  try {
    if (await dirExists(localRoot)) {
      await fs.cp(localRoot, tmpSnapshotDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    } else {
      await fs.mkdir(tmpSnapshotDir, { recursive: true });
    }
    await writeJsonAtomic(path.join(tmpSnapshotDir, 'manifest.json'), {
      schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
      revision,
      createdAt: Date.now(),
      createdAtIso: new Date().toISOString(),
      app: 'graphchatv1',
      storageSchema: STORAGE_SCHEMA_DIRNAME,
    });
    await fs.mkdir(path.dirname(snapshotDir), { recursive: true });
    await fs.rename(tmpSnapshotDir, snapshotDir);
  } catch (err) {
    await fs.rm(tmpSnapshotDir, { recursive: true, force: true });
    throw err;
  }

  await writeJsonAtomic(cloudHeadPath(cloudDir), {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    revision,
    updatedAt: Date.now(),
    updatedAtIso: new Date().toISOString(),
  });
  await writeCloudSyncConfig(app, { cloudDir, lastPulledRevision: revision });
  return { revision };
}

async function pullStorageFromCloud(app) {
  const cfg = await readCloudSyncConfig(app);
  const cloudDir = cfg.cloudDir;
  if (!cloudDir) throw new Error('Cloud sync folder is not configured.');

  const localRoot = storageRootDir(app);
  if (isSameOrNestedPath(localRoot, cloudDir)) {
    throw new Error('Cloud sync folder must not be the same as, or inside, the local storage folder.');
  }

  const remoteHead = await readCloudHead(cloudDir);
  const revision = remoteHead?.revision ?? '';
  if (!revision) throw new Error('Cloud folder has no pushed snapshot yet.');

  const snapshotDir = cloudSnapshotDir(cloudDir, revision);
  if (!(await dirExists(snapshotDir))) {
    throw new Error(`Cloud snapshot ${revision} is missing.`);
  }

  const localTmpDir = `${localRoot}.pull-tmp-${process.pid}-${Date.now()}`;
  await fs.rm(localTmpDir, { recursive: true, force: true });
  await fs.cp(snapshotDir, localTmpDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });

  let backupPath = null;
  backupPath = await createSingleLocalPullBackup(app, localRoot);

  try {
    await fs.rm(localRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(localRoot), { recursive: true });
    await fs.rename(localTmpDir, localRoot);
  } catch (err) {
    await fs.rm(localTmpDir, { recursive: true, force: true });
    throw err;
  }

  await writeCloudSyncConfig(app, { cloudDir, lastPulledRevision: revision });
  return { revision, backupPath };
}

function normalizeGoogleDriveSyncConfig(raw) {
  return {
    clientId: asTrimmedString(raw?.clientId) || null,
    clientSecret: asTrimmedString(raw?.clientSecret) || null,
    refreshToken: asTrimmedString(raw?.refreshToken) || null,
    folderId: asTrimmedString(raw?.folderId) || null,
    lastPulledRevision: asTrimmedString(raw?.lastPulledRevision) || null,
    lastLinkError: asTrimmedString(raw?.lastLinkError) || null,
  };
}

async function readGoogleDriveSyncConfig(app) {
  const cfg = await readJsonOrNull(googleDriveSyncConfigPath(app));
  if (!cfg || typeof cfg !== 'object') {
    return {
      clientId: null,
      clientSecret: null,
      refreshToken: null,
      folderId: null,
      lastPulledRevision: null,
      lastLinkError: null,
    };
  }
  return normalizeGoogleDriveSyncConfig(cfg);
}

async function writeGoogleDriveSyncConfig(app, cfg) {
  const next = normalizeGoogleDriveSyncConfig(cfg);
  if (!next.clientId && !next.clientSecret && !next.refreshToken && !next.folderId && !next.lastPulledRevision && !next.lastLinkError) {
    await removeFileIfExists(googleDriveSyncConfigPath(app));
    return {
      clientId: null,
      clientSecret: null,
      refreshToken: null,
      folderId: null,
      lastPulledRevision: null,
      lastLinkError: null,
    };
  }
  await writeJsonAtomic(googleDriveSyncConfigPath(app), {
    clientId: next.clientId,
    clientSecret: next.clientSecret,
    refreshToken: next.refreshToken,
    folderId: next.folderId,
    lastPulledRevision: next.lastPulledRevision,
    lastLinkError: next.lastLinkError,
    updatedAt: Date.now(),
  });
  return next;
}

function base64UrlNoPad(bytes) {
  const src = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return src
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function googleDriveQueryLiteral(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function googleSnapshotFileName(revision, relPath) {
  return `snapshot-${revision}--${encodeURIComponent(relPath)}`;
}

function parseGoogleSnapshotRelPath(name, revision) {
  const prefix = `snapshot-${revision}--`;
  if (!String(name ?? '').startsWith(prefix)) return null;
  const encoded = String(name).slice(prefix.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function normalizeRelativePathForWrite(relPath) {
  const raw = String(relPath ?? '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(raw).replace(/^\/+/g, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  return normalized;
}

async function collectLocalFilesRecursively(rootDir) {
  const root = path.resolve(rootDir);
  if (!(await dirExists(root))) return [];
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() ?? '';
    const absDir = path.join(root, relDir);
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
    for (const entry of entries) {
      const name = String(entry.name ?? '');
      if (!name || name === '.' || name === '..') continue;
      const relPath = relDir ? path.posix.join(relDir, name) : name;
      if (entry.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push({
        relPath,
        absPath: path.join(root, relPath),
      });
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function runWithConcurrency(items, limit, worker) {
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 1;
  if (!Array.isArray(items) || items.length === 0) return;
  let nextIndex = 0;
  const runners = new Array(Math.min(max, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= items.length) break;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function googleFetchJson(url, opts, fallbackMessage) {
  if (typeof fetch !== 'function') throw new Error('Fetch API is unavailable in this Electron runtime.');
  const res = await fetch(url, opts);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const apiMsg =
      asTrimmedString(parsed?.error?.message) ||
      asTrimmedString(parsed?.error_description) ||
      asTrimmedString(parsed?.error) ||
      asTrimmedString(text);
    throw new Error(`${fallbackMessage} (${res.status})${apiMsg ? `: ${apiMsg}` : ''}`);
  }
  return parsed || {};
}

async function googleFetchBuffer(url, opts, fallbackMessage) {
  if (typeof fetch !== 'function') throw new Error('Fetch API is unavailable in this Electron runtime.');
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const apiMsg =
      asTrimmedString(parsed?.error?.message) ||
      asTrimmedString(parsed?.error_description) ||
      asTrimmedString(parsed?.error) ||
      asTrimmedString(text);
    throw new Error(`${fallbackMessage} (${res.status})${apiMsg ? `: ${apiMsg}` : ''}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

async function googleTokenByRefreshToken(cfg) {
  const clientId = asTrimmedString(cfg?.clientId);
  const clientSecret = asTrimmedString(cfg?.clientSecret);
  const refreshToken = asTrimmedString(cfg?.refreshToken);
  if (!clientId || !refreshToken) throw new Error('Google Drive is not linked. Link Google Drive first.');
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  const token = await googleFetchJson(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    'Failed to refresh Google access token',
  );
  const accessToken = asTrimmedString(token?.access_token);
  if (!accessToken) throw new Error('Google token response did not include access_token.');
  return accessToken;
}

async function googleDriveListFiles(accessToken, q, opts = {}) {
  const pageSize = Number.isFinite(Number(opts.pageSize)) ? Math.max(1, Math.min(1000, Math.floor(Number(opts.pageSize)))) : 1000;
  const fields = asTrimmedString(opts.fields) || 'nextPageToken,files(id,name,mimeType,modifiedTime,size)';
  const out = [];
  let pageToken = '';
  while (true) {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('fields', fields);
    url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('orderBy', 'name');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await googleFetchJson(
      url.toString(),
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      'Failed to list Google Drive files',
    );
    const files = Array.isArray(res?.files) ? res.files : [];
    out.push(...files);
    const next = asTrimmedString(res?.nextPageToken);
    if (!next) break;
    pageToken = next;
  }
  return out;
}

async function googleDriveFindFileByName(accessToken, parentId, name, opts = {}) {
  const parent = asTrimmedString(parentId);
  const fileName = asTrimmedString(name);
  if (!parent || !fileName) return null;
  let q = `'${googleDriveQueryLiteral(parent)}' in parents and trashed=false and name='${googleDriveQueryLiteral(fileName)}'`;
  const mimeType = asTrimmedString(opts.mimeType);
  if (mimeType) q += ` and mimeType='${googleDriveQueryLiteral(mimeType)}'`;
  const files = await googleDriveListFiles(accessToken, q, {
    pageSize: 10,
    fields: 'files(id,name,mimeType,modifiedTime,size)',
  });
  return files[0] ?? null;
}

async function googleDriveCreateFolder(accessToken, parentId, name) {
  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  };
  const res = await googleFetchJson(
    'https://www.googleapis.com/drive/v3/files?fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(metadata),
    },
    'Failed to create Google Drive folder',
  );
  const id = asTrimmedString(res?.id);
  if (!id) throw new Error('Google Drive folder creation returned no id.');
  return id;
}

async function googleDriveEnsureFolder(accessToken, parentId, name) {
  const existing = await googleDriveFindFileByName(accessToken, parentId, name, {
    mimeType: 'application/vnd.google-apps.folder',
  });
  const existingId = asTrimmedString(existing?.id);
  if (existingId) return existingId;
  return await googleDriveCreateFolder(accessToken, parentId, name);
}

function googleMultipartBody(metadata, bytes, mimeType) {
  const boundary = `graphchatv1_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  const metaPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    'utf8',
  );
  const dataPartHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
    'utf8',
  );
  const dataPart = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    boundary,
    body: Buffer.concat([metaPart, dataPartHeader, dataPart, tail]),
  };
}

async function googleDriveCreateMultipartFile(accessToken, metadata, bytes, mimeType) {
  const { boundary, body } = googleMultipartBody(metadata, bytes, mimeType);
  const res = await googleFetchJson(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
    'Failed to upload file to Google Drive',
  );
  return res;
}

async function googleDriveUpdateMultipartFile(accessToken, fileId, metadata, bytes, mimeType) {
  const id = asTrimmedString(fileId);
  if (!id) throw new Error('Google Drive file id is missing.');
  const { boundary, body } = googleMultipartBody(metadata, bytes, mimeType);
  const res = await googleFetchJson(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=multipart&fields=id,name`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
    'Failed to update file in Google Drive',
  );
  return res;
}

async function googleDriveDownloadFile(accessToken, fileId) {
  const id = asTrimmedString(fileId);
  if (!id) throw new Error('Google Drive file id is missing.');
  return await googleFetchBuffer(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    'Failed to download file from Google Drive',
  );
}

async function googleDriveReadHead(accessToken, folderId) {
  const headFile = await googleDriveFindFileByName(accessToken, folderId, GOOGLE_DRIVE_HEAD_FILE);
  const headFileId = asTrimmedString(headFile?.id);
  if (!headFileId) return null;
  const buf = await googleDriveDownloadFile(accessToken, headFileId);
  let parsed = null;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const revision = asTrimmedString(parsed.revision);
  if (!revision) return null;
  const updatedAtRaw = Number(parsed.updatedAt);
  return {
    fileId: headFileId,
    revision,
    updatedAt: Number.isFinite(updatedAtRaw) ? updatedAtRaw : 0,
  };
}

async function googleDriveWriteHead(accessToken, folderId, payload) {
  const json = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const existing = await googleDriveFindFileByName(accessToken, folderId, GOOGLE_DRIVE_HEAD_FILE);
  const existingId = asTrimmedString(existing?.id);
  if (existingId) {
    await googleDriveUpdateMultipartFile(
      accessToken,
      existingId,
      { name: GOOGLE_DRIVE_HEAD_FILE },
      json,
      'application/json',
    );
    return existingId;
  }
  const created = await googleDriveCreateMultipartFile(
    accessToken,
    { name: GOOGLE_DRIVE_HEAD_FILE, parents: [folderId] },
    json,
    'application/json',
  );
  return asTrimmedString(created?.id);
}

async function getGoogleDriveSyncInfo(app) {
  const configPath = googleDriveSyncConfigPath(app);
  const userDataPath = asStringOrUndefined(app?.getPath?.('userData'));
  const cfg = await readGoogleDriveSyncConfig(app);
  const configExists = await fileExists(configPath);
  const linked = Boolean(cfg.clientId && cfg.refreshToken && cfg.folderId);
  let remoteHead = null;
  let remoteError = null;
  if (linked) {
    try {
      const accessToken = await googleTokenByRefreshToken(cfg);
      remoteHead = await googleDriveReadHead(accessToken, cfg.folderId);
    } catch (err) {
      remoteHead = null;
      remoteError = shortError(err?.message ?? err, 'Failed to read Google Drive head.');
    }
  }
  return {
    linked,
    clientId: cfg.clientId || undefined,
    hasClientSecret: Boolean(cfg.clientSecret),
    folderId: cfg.folderId || undefined,
    lastPulledRevision: cfg.lastPulledRevision || undefined,
    lastLinkError: cfg.lastLinkError || undefined,
    remoteHeadRevision: remoteHead?.revision || undefined,
    remoteHeadUpdatedAt: remoteHead ? remoteHead.updatedAt : undefined,
    remoteError: remoteError || undefined,
    configPath: configPath || undefined,
    configExists,
    appName: asStringOrUndefined(app?.getName?.()),
    userDataPath,
  };
}

async function runGoogleDriveOAuthFlow(args) {
  const clientId = asTrimmedString(args?.clientId);
  const clientSecret = asTrimmedString(args?.clientSecret);
  const shell = args?.shell;
  if (!clientId) throw new Error('Google OAuth client ID is required.');
  if (!shell || typeof shell.openExternal !== 'function') throw new Error('Shell API unavailable.');
  if (typeof fetch !== 'function') throw new Error('Fetch API is unavailable in this Electron runtime.');

  const codeVerifier = base64UrlNoPad(randomBytes(64));
  const codeChallenge = base64UrlNoPad(createHash('sha256').update(codeVerifier).digest());
  const state = base64UrlNoPad(randomBytes(20));

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? Number(address.port) : 0;
  if (!Number.isFinite(port) || port <= 0) {
    server.close();
    throw new Error('Failed to start OAuth callback server.');
  }

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_DRIVE_SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  const callbackResultPromise = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const timeout = setTimeout(() => {
      settle(reject, new Error('Google sign-in timed out.'));
    }, 180000);

    server.on('request', (req, res) => {
      const host = asTrimmedString(req?.headers?.host) || `127.0.0.1:${port}`;
      const parsed = new URL(req?.url || '/', `http://${host}`);
      if (parsed.pathname !== '/oauth2callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const incomingState = asTrimmedString(parsed.searchParams.get('state'));
      const code = asTrimmedString(parsed.searchParams.get('code'));
      const error = asTrimmedString(parsed.searchParams.get('error'));

      if (incomingState !== state) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<h3>State mismatch. You can close this tab.</h3>');
        clearTimeout(timeout);
        settle(reject, new Error('Google OAuth state mismatch.'));
        return;
      }

      if (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<h3>Google sign-in was canceled. You can close this tab.</h3>');
        clearTimeout(timeout);
        settle(reject, new Error(`Google sign-in failed: ${error}`));
        return;
      }

      if (!code) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<h3>Missing authorization code. You can close this tab.</h3>');
        clearTimeout(timeout);
        settle(reject, new Error('Google sign-in did not return an authorization code.'));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h3>Authorization received. Return to GraphChatV1 to finish linking.</h3>');
      clearTimeout(timeout);
      settle(resolve, { code });
    });
  });

  const openErr = await shell.openExternal(authUrl.toString());
  if (asTrimmedString(openErr)) {
    server.close();
    throw new Error(`Failed to open browser for Google sign-in: ${openErr}`);
  }

  try {
    const callback = await callbackResultPromise;
    const code = asTrimmedString(callback?.code);
    if (!code) throw new Error('Google sign-in failed: missing code.');
    const tokenBody = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });
    if (clientSecret) tokenBody.set('client_secret', clientSecret);
    const token = await googleFetchJson(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString(),
      },
      'Failed to exchange Google authorization code',
    );
    const accessToken = asTrimmedString(token?.access_token);
    const refreshToken = asTrimmedString(token?.refresh_token);
    if (!accessToken) throw new Error('Google token response did not include access_token.');
    if (!refreshToken) {
      throw new Error('Google token response did not include refresh_token. Remove existing app access and try again.');
    }
    return {
      clientId,
      clientSecret: clientSecret || null,
      accessToken,
      refreshToken,
    };
  } finally {
    try {
      server.close();
    } catch {
      // ignore
    }
  }
}

async function linkGoogleDriveSync(app, shell, req) {
  const current = await readGoogleDriveSyncConfig(app);
  const requestedClientId = asTrimmedString(req?.clientId);
  const hasRequestedClientSecret = Boolean(req && Object.prototype.hasOwnProperty.call(req, 'clientSecret'));
  const requestedClientSecret = asTrimmedString(req?.clientSecret);
  const clientId = requestedClientId || current.clientId;
  const clientSecret = hasRequestedClientSecret ? (requestedClientSecret || null) : current.clientSecret;
  if (!clientId) throw new Error('Google OAuth client ID is required.');

  const auth = await runGoogleDriveOAuthFlow({ clientId, clientSecret, shell });
  const folderId = await googleDriveEnsureFolder(auth.accessToken, 'root', GOOGLE_DRIVE_ROOT_FOLDER_NAME);
  const head = await googleDriveReadHead(auth.accessToken, folderId);
  await writeGoogleDriveSyncConfig(app, {
    clientId,
    clientSecret: auth.clientSecret || null,
    refreshToken: auth.refreshToken,
    folderId,
    lastPulledRevision: head?.revision || null,
    lastLinkError: null,
  });
  const persisted = await readGoogleDriveSyncConfig(app);
  if (!persisted.clientId || !persisted.refreshToken || !persisted.folderId) {
    throw new Error(
      `Google authorization succeeded, but credentials could not be persisted at ${googleDriveSyncConfigPath(app)}.`,
    );
  }
  return await getGoogleDriveSyncInfo(app);
}

async function pushStorageToGoogleDrive(app, opts = {}) {
  const reportProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  const emitProgress = (patch) => {
    safeProgressReport(reportProgress, {
      done: false,
      indeterminate: true,
      ...patch,
    });
  };

  emitProgress({
    stage: 'prepare',
    phaseIndex: 1,
    phaseCount: 4,
    message: 'Checking Google Drive status...',
  });

  const cfg = await readGoogleDriveSyncConfig(app);
  if (!cfg.clientId || !cfg.refreshToken || !cfg.folderId) {
    throw new Error('Google Drive is not linked. Link Google Drive first.');
  }

  const accessToken = await googleTokenByRefreshToken(cfg);
  const remoteHead = await googleDriveReadHead(accessToken, cfg.folderId);
  const remoteRevision = remoteHead?.revision || null;
  const localLastPulled = cfg.lastPulledRevision || null;
  const force = opts?.force === true;
  if (!force && remoteRevision && remoteRevision !== localLastPulled) {
    if (localLastPulled) {
      throw new Error(`Google Drive has newer revision ${remoteRevision}. Pull first (local last pulled ${localLastPulled}).`);
    }
    throw new Error(`Google Drive already has revision ${remoteRevision}. Pull first on this device before pushing.`);
  }

  emitProgress({
    stage: 'prepare',
    phaseIndex: 1,
    phaseCount: 4,
    message: 'Scanning local files...',
  });

  const revision = makeCloudRevisionId();
  const localRoot = storageRootDir(app);
  const localFiles = await collectLocalFilesRecursively(localRoot);
  const totalUploads = localFiles.length + 1;
  let uploadedCount = 0;

  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
        revision,
        createdAt: Date.now(),
        createdAtIso: new Date().toISOString(),
        app: 'graphchatv1',
        storageSchema: STORAGE_SCHEMA_DIRNAME,
        fileCount: localFiles.length,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  safeProgressReport(reportProgress, {
    done: false,
    stage: 'upload',
    phaseIndex: 2,
    phaseCount: 4,
    message: 'Uploading manifest...',
    indeterminate: false,
    completed: uploadedCount,
    total: totalUploads,
  });

  await googleDriveCreateMultipartFile(
    accessToken,
    {
      name: googleSnapshotFileName(revision, 'manifest.json'),
      parents: [cfg.folderId],
    },
    manifest,
    'application/json',
  );

  uploadedCount += 1;
  safeProgressReport(reportProgress, {
    done: false,
    stage: 'upload',
    phaseIndex: 2,
    phaseCount: 4,
    message: `Uploading files... (${uploadedCount}/${totalUploads})`,
    indeterminate: false,
    completed: uploadedCount,
    total: totalUploads,
  });

  await runWithConcurrency(localFiles, 3, async (file) => {
    const bytes = await fs.readFile(file.absPath);
    await googleDriveCreateMultipartFile(
      accessToken,
      {
        name: googleSnapshotFileName(revision, file.relPath),
        parents: [cfg.folderId],
      },
      bytes,
      'application/octet-stream',
    );

    uploadedCount += 1;
    safeProgressReport(reportProgress, {
      done: false,
      stage: 'upload',
      phaseIndex: 2,
      phaseCount: 4,
      message: `Uploading files... (${uploadedCount}/${totalUploads})`,
      indeterminate: false,
      completed: uploadedCount,
      total: totalUploads,
    });
  });

  emitProgress({
    stage: 'finalize',
    phaseIndex: 3,
    phaseCount: 4,
    message: 'Updating remote revision head...',
  });

  await googleDriveWriteHead(accessToken, cfg.folderId, {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    revision,
    updatedAt: Date.now(),
    updatedAtIso: new Date().toISOString(),
  });

  emitProgress({
    stage: 'finalize',
    phaseIndex: 4,
    phaseCount: 4,
    message: 'Finalizing local sync state...',
  });

  await writeGoogleDriveSyncConfig(app, {
    ...cfg,
    lastPulledRevision: revision,
  });
  return { revision, fileCount: localFiles.length + 1 };
}

async function pullStorageFromGoogleDrive(app, opts = {}) {
  const reportProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  const emitProgress = (patch) => {
    safeProgressReport(reportProgress, {
      done: false,
      indeterminate: true,
      ...patch,
    });
  };

  emitProgress({
    stage: 'prepare',
    phaseIndex: 1,
    phaseCount: 5,
    message: 'Reading Google Drive snapshot metadata...',
  });

  const cfg = await readGoogleDriveSyncConfig(app);
  if (!cfg.clientId || !cfg.refreshToken || !cfg.folderId) {
    throw new Error('Google Drive is not linked. Link Google Drive first.');
  }

  const accessToken = await googleTokenByRefreshToken(cfg);
  const remoteHead = await googleDriveReadHead(accessToken, cfg.folderId);
  const revision = asTrimmedString(remoteHead?.revision);
  if (!revision) throw new Error('Google Drive has no pushed snapshot yet.');

  const prefix = `snapshot-${revision}--`;
  const q = `'${googleDriveQueryLiteral(cfg.folderId)}' in parents and trashed=false and name contains '${googleDriveQueryLiteral(prefix)}'`;
  const remoteFilesRaw = await googleDriveListFiles(accessToken, q, {
    pageSize: 1000,
    fields: 'nextPageToken,files(id,name,size,modifiedTime,mimeType)',
  });
  const remoteFiles = remoteFilesRaw
    .map((f) => ({
      id: asTrimmedString(f?.id),
      name: asTrimmedString(f?.name),
      relPath: parseGoogleSnapshotRelPath(f?.name, revision),
    }))
    .filter((f) => f.id && f.name && f.relPath);
  if (remoteFiles.length === 0) throw new Error(`Google Drive snapshot ${revision} is empty or missing.`);

  let downloadedCount = 0;
  const totalDownloads = remoteFiles.length;

  const localRoot = storageRootDir(app);
  const localTmpDir = `${localRoot}.gdrive-pull-tmp-${process.pid}-${Date.now()}`;
  await fs.rm(localTmpDir, { recursive: true, force: true });
  await fs.mkdir(localTmpDir, { recursive: true });

  safeProgressReport(reportProgress, {
    done: false,
    stage: 'download',
    phaseIndex: 2,
    phaseCount: 5,
    message: `Downloading files... (${downloadedCount}/${totalDownloads})`,
    indeterminate: false,
    completed: downloadedCount,
    total: totalDownloads,
  });

  await runWithConcurrency(remoteFiles, 3, async (remoteFile) => {
    const safeRelPath = normalizeRelativePathForWrite(remoteFile.relPath);
    if (!safeRelPath) return;
    const bytes = await googleDriveDownloadFile(accessToken, remoteFile.id);
    const absPath = path.join(localTmpDir, ...safeRelPath.split('/'));
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, bytes);

    downloadedCount += 1;
    safeProgressReport(reportProgress, {
      done: false,
      stage: 'download',
      phaseIndex: 2,
      phaseCount: 5,
      message: `Downloading files... (${downloadedCount}/${totalDownloads})`,
      indeterminate: false,
      completed: downloadedCount,
      total: totalDownloads,
    });
  });

  emitProgress({
    stage: 'backup',
    phaseIndex: 3,
    phaseCount: 5,
    message: 'Creating local backup before replace...',
  });

  let backupPath = null;
  backupPath = await createSingleLocalPullBackup(app, localRoot);

  emitProgress({
    stage: 'apply',
    phaseIndex: 4,
    phaseCount: 5,
    message: 'Applying downloaded snapshot locally...',
  });

  try {
    await fs.rm(localRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(localRoot), { recursive: true });
    await fs.rename(localTmpDir, localRoot);
  } catch (err) {
    await fs.rm(localTmpDir, { recursive: true, force: true });
    throw err;
  }

  emitProgress({
    stage: 'finalize',
    phaseIndex: 5,
    phaseCount: 5,
    message: 'Finalizing local sync state...',
  });

  await writeGoogleDriveSyncConfig(app, {
    ...cfg,
    lastPulledRevision: revision,
  });
  return { revision, backupPath, fileCount: remoteFiles.length };
}

async function persistStorageLocationConfig(app) {
  const cfgPath = storageLocationConfigPath(app);
  if (!storageBaseDirOverride) {
    await removeFileIfExists(cfgPath);
    return;
  }
  await writeJsonAtomic(cfgPath, {
    storageBaseDir: storageBaseDirOverride,
    updatedAt: Date.now(),
  });
}

async function dirExists(absPath) {
  try {
    const stat = await fs.stat(absPath);
    return Boolean(stat?.isDirectory?.());
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function fileExists(absPath) {
  try {
    const stat = await fs.stat(absPath);
    return Boolean(stat?.isFile?.());
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function isDirectoryEmpty(absPath) {
  try {
    const entries = await fs.readdir(absPath);
    return entries.length === 0;
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return true;
    throw err;
  }
}

function storageLocationInfo(app) {
  const defaultBaseDir = defaultStorageBaseDir(app);
  const currentBaseDir = currentStorageBaseDir(app);
  return {
    path: storageRootDirForBaseDir(currentBaseDir),
    defaultPath: storageRootDirForBaseDir(defaultBaseDir),
    baseDir: currentBaseDir,
    defaultBaseDir,
    isDefault: !storageBaseDirOverride,
  };
}

async function setStorageBaseDir(app, nextBaseDir, opts = {}) {
  loadStorageLocationConfigOnce(app);
  const moveExisting = opts?.moveExisting !== false;
  const defaultBaseDir = defaultStorageBaseDir(app);
  const normalizedNextBase = normalizeAbsoluteDirOrNull(nextBaseDir) || defaultBaseDir;
  const normalizedOverride = normalizedNextBase === defaultBaseDir ? null : normalizedNextBase;
  const prevBaseDir = storageBaseDirOverride || defaultBaseDir;
  const prevRoot = storageRootDirForBaseDir(prevBaseDir);
  const nextRoot = storageRootDirForBaseDir(normalizedOverride || defaultBaseDir);

  if (path.resolve(prevRoot) === path.resolve(nextRoot)) {
    storageBaseDirOverride = normalizedOverride;
    await persistStorageLocationConfig(app);
    return { ...storageLocationInfo(app), moved: false };
  }

  let moved = false;
  if (moveExisting && (await dirExists(prevRoot))) {
    if (isNestedPath(prevRoot, nextRoot) || isNestedPath(nextRoot, prevRoot)) {
      throw new Error('Choose a storage location that is not inside the current storage folder.');
    }
    if (!(await isDirectoryEmpty(nextRoot))) {
      throw new Error('Target storage location is not empty. Choose an empty folder.');
    }
    await fs.mkdir(path.dirname(nextRoot), { recursive: true });
    await fs.cp(prevRoot, nextRoot, { recursive: true, force: false, errorOnExist: true });
    await fs.rm(prevRoot, { recursive: true, force: true });
    moved = true;
  }

  storageBaseDirOverride = normalizedOverride;
  await persistStorageLocationConfig(app);
  return { ...storageLocationInfo(app), moved };
}

function workspaceSnapshotPath(app) {
  return path.join(storageRootDir(app), 'Workspace', 'workspace.json');
}

function chatsRootDir(app) {
  return path.join(storageRootDir(app), 'Chats');
}

function chatDir(app, chatId) {
  return path.join(chatsRootDir(app), encodeFsSegment(chatId, 'Chat id'));
}

function chatStatePath(app, chatId) {
  return path.join(chatDir(app, chatId), 'state.json');
}

function chatMetaPath(app, chatId) {
  return path.join(chatDir(app, chatId), 'meta.json');
}

function payloadsRootDir(app) {
  return path.join(storageRootDir(app), 'Payloads');
}

function attachmentMetaRootDir(app) {
  return path.join(storageRootDir(app), 'Blobs', 'meta');
}

function attachmentBlobRootDir(app) {
  return path.join(storageRootDir(app), 'Blobs', 'data');
}

function attachmentMetaPath(app, key) {
  return path.join(attachmentMetaRootDir(app), `${encodeFsSegment(key, 'Attachment key')}.json`);
}

function attachmentBlobPath(app, key) {
  return path.join(attachmentBlobRootDir(app), `${encodeFsSegment(key, 'Attachment key')}.bin`);
}

function parsePayloadTripletKey(key) {
  const raw = asTrimmedString(key);
  const match = /^([^/]+)\/([^/]+)\/(req|res)$/.exec(raw);
  if (!match) return null;
  return {
    chatId: match[1],
    nodeId: match[2],
    kind: match[3],
  };
}

function payloadPathForKey(app, key) {
  const raw = asTrimmedString(key);
  if (!raw) throw new Error('Payload key is missing.');
  const triplet = parsePayloadTripletKey(raw);
  if (triplet) {
    return path.join(
      chatDir(app, triplet.chatId),
      'payloads',
      `${encodeFsSegment(triplet.nodeId, 'Node id')}.${triplet.kind}.json`,
    );
  }
  return path.join(payloadsRootDir(app), `${encodeFsSegment(raw, 'Payload key')}.json`);
}

function generateAttachmentKey(prefix = 'att') {
  const p = String(prefix ?? '')
    .replace(/[^a-z0-9_-]/gi, '')
    .slice(0, 12) || 'att';
  try {
    return `${p}_${randomUUID()}`;
  } catch {
    return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value && typeof value === 'object' && Array.isArray(value.data)) {
    try {
      return Buffer.from(value.data);
    } catch {
      return null;
    }
  }
  return null;
}

async function writeFileAtomic(absPath, data, opts = {}) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, data, opts);
  await fs.rename(tmpPath, absPath);
}

async function writeJsonAtomic(absPath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFileAtomic(absPath, text, { encoding: 'utf8' });
}

async function readJsonOrNull(absPath) {
  try {
    const text = await fs.readFile(absPath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function removeFileIfExists(absPath) {
  try {
    await fs.rm(absPath, { force: true });
  } catch (err) {
    if (!(err && typeof err === 'object' && err.code === 'ENOENT')) throw err;
  }
}

function ok(extra) {
  return { ok: true, ...(extra ?? {}) };
}

function fail(err, fallback) {
  return { ok: false, error: shortError(err?.message ?? err, fallback) };
}

function asStringOrUndefined(value) {
  const s = asTrimmedString(value);
  return s || undefined;
}

function asFiniteNumberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function validateRecordChatId(record, expectedChatId) {
  return Boolean(record && typeof record === 'object' && asTrimmedString(record.chatId) === expectedChatId);
}

function registerStorageIpcHandlers(args) {
  const ipcMain = args?.ipcMain;
  const app = args?.app;
  const shell = args?.shell;
  const dialog = args?.dialog;
  if (!ipcMain || !app) throw new Error('registerStorageIpcHandlers requires { ipcMain, app }.');

  ipcMain.handle('storage:get-workspace-snapshot', async () => {
    try {
      const snapshot = await readJsonOrNull(workspaceSnapshotPath(app));
      if (!snapshot || typeof snapshot !== 'object') return ok({ snapshot: null });
      return ok({ snapshot });
    } catch (err) {
      return fail(err, 'Failed to load workspace snapshot.');
    }
  });

  ipcMain.handle('storage:put-workspace-snapshot', async (_event, req) => {
    try {
      const snapshot = req?.snapshot;
      if (!snapshot || typeof snapshot !== 'object') return fail('Workspace snapshot is missing.', 'Workspace snapshot is missing.');
      const rec = { ...snapshot, updatedAt: Date.now() };
      await writeJsonAtomic(workspaceSnapshotPath(app), rec);
      return ok();
    } catch (err) {
      return fail(err, 'Failed to persist workspace snapshot.');
    }
  });

  ipcMain.handle('storage:delete-workspace-snapshot', async () => {
    try {
      await removeFileIfExists(workspaceSnapshotPath(app));
      return ok();
    } catch (err) {
      return fail(err, 'Failed to delete workspace snapshot.');
    }
  });

  ipcMain.handle('storage:get-chat-state-record', async (_event, req) => {
    try {
      const chatId = asTrimmedString(req?.chatId);
      if (!chatId) return ok({ record: null });
      const rec = await readJsonOrNull(chatStatePath(app, chatId));
      if (!validateRecordChatId(rec, chatId) || !rec.state) return ok({ record: null });
      return ok({ record: rec });
    } catch (err) {
      return fail(err, 'Failed to load chat state.');
    }
  });

  ipcMain.handle('storage:put-chat-state-record', async (_event, req) => {
    try {
      const chatId = asTrimmedString(req?.chatId);
      if (!chatId) return fail('Chat id is missing.', 'Chat id is missing.');
      const state = req?.state;
      const rec = { chatId, state, updatedAt: Date.now() };
      await writeJsonAtomic(chatStatePath(app, chatId), rec);
      return ok();
    } catch (err) {
      return fail(err, 'Failed to persist chat state.');
    }
  });

  ipcMain.handle('storage:delete-chat-state-record', async (_event, req) => {
    try {
      const chatId = asTrimmedString(req?.chatId);
      if (!chatId) return ok();
      await removeFileIfExists(chatStatePath(app, chatId));
      return ok();
    } catch (err) {
      return fail(err, 'Failed to delete chat state.');
    }
  });

  ipcMain.handle('storage:get-chat-meta-record', async (_event, req) => {
    try {
      const chatId = asTrimmedString(req?.chatId);
      if (!chatId) return ok({ record: null });
      const rec = await readJsonOrNull(chatMetaPath(app, chatId));
      if (!validateRecordChatId(rec, chatId)) return ok({ record: null });
      return ok({ record: rec });
    } catch (err) {
      return fail(err, 'Failed to load chat metadata.');
    }
  });

  ipcMain.handle('storage:put-chat-meta-record', async (_event, req) => {
    try {
      const chatId = asTrimmedString(req?.chatId);
      if (!chatId) return fail('Chat id is missing.', 'Chat id is missing.');
      const meta = req?.meta;
      const rec = { chatId, meta, updatedAt: Date.now() };
      await writeJsonAtomic(chatMetaPath(app, chatId), rec);
      return ok();
    } catch (err) {
      return fail(err, 'Failed to persist chat metadata.');
    }
  });

  ipcMain.handle('storage:delete-chat-meta-record', async (_event, req) => {
    try {
      const chatId = asTrimmedString(req?.chatId);
      if (!chatId) return ok();
      await removeFileIfExists(chatMetaPath(app, chatId));
      return ok();
    } catch (err) {
      return fail(err, 'Failed to delete chat metadata.');
    }
  });

  ipcMain.handle('storage:get-payload', async (_event, req) => {
    try {
      const key = asTrimmedString(req?.key);
      if (!key) return ok({ payload: null });
      const rec = await readJsonOrNull(payloadPathForKey(app, key));
      if (!rec || typeof rec !== 'object' || asTrimmedString(rec.key) !== key) return ok({ payload: null });
      return ok({ payload: rec.json ?? null });
    } catch (err) {
      return fail(err, 'Failed to load payload.');
    }
  });

  ipcMain.handle('storage:put-payload', async (_event, req) => {
    try {
      const key = asTrimmedString(req?.key);
      if (!key) return ok();
      const rec = { key, json: req?.json, createdAt: Date.now() };
      await writeJsonAtomic(payloadPathForKey(app, key), rec);
      return ok();
    } catch (err) {
      return fail(err, 'Failed to persist payload.');
    }
  });

  ipcMain.handle('storage:delete-payload', async (_event, req) => {
    try {
      const key = asTrimmedString(req?.key);
      if (!key) return ok();
      await removeFileIfExists(payloadPathForKey(app, key));
      return ok();
    } catch (err) {
      return fail(err, 'Failed to delete payload.');
    }
  });

  ipcMain.handle('storage:put-attachment', async (_event, req) => {
    try {
      const bytes = toBuffer(req?.bytes);
      if (!bytes) return fail('Attachment bytes are missing.', 'Attachment bytes are missing.');
      const key = generateAttachmentKey('att');
      const mimeType = asStringOrUndefined(req?.mimeType) ?? 'application/octet-stream';
      const name = asStringOrUndefined(req?.name);
      const size = asFiniteNumberOrUndefined(req?.size) ?? bytes.byteLength;
      const createdAt = Date.now();

      await writeFileAtomic(attachmentBlobPath(app, key), bytes);
      await writeJsonAtomic(attachmentMetaPath(app, key), {
        key,
        mimeType,
        ...(name ? { name } : {}),
        ...(Number.isFinite(size) ? { size } : {}),
        createdAt,
      });

      return ok({ key });
    } catch (err) {
      return fail(err, 'Failed to persist attachment.');
    }
  });

  ipcMain.handle('storage:get-attachment', async (_event, req) => {
    try {
      const key = asTrimmedString(req?.key);
      if (!key) return ok({ record: null });
      const meta = await readJsonOrNull(attachmentMetaPath(app, key));
      if (!meta || typeof meta !== 'object' || asTrimmedString(meta.key) !== key) return ok({ record: null });

      let bytes;
      try {
        bytes = await fs.readFile(attachmentBlobPath(app, key));
      } catch (err) {
        if (err && typeof err === 'object' && err.code === 'ENOENT') return ok({ record: null });
        throw err;
      }

      return ok({
        record: {
          key,
          mimeType: asStringOrUndefined(meta.mimeType) ?? 'application/octet-stream',
          ...(asStringOrUndefined(meta.name) ? { name: asStringOrUndefined(meta.name) } : {}),
          ...(Number.isFinite(Number(meta.size)) ? { size: Number(meta.size) } : {}),
          createdAt: Number.isFinite(Number(meta.createdAt)) ? Number(meta.createdAt) : 0,
          bytes,
        },
      });
    } catch (err) {
      return fail(err, 'Failed to load attachment.');
    }
  });

  ipcMain.handle('storage:delete-attachment', async (_event, req) => {
    try {
      const key = asTrimmedString(req?.key);
      if (!key) return ok();
      await Promise.all([
        removeFileIfExists(attachmentMetaPath(app, key)),
        removeFileIfExists(attachmentBlobPath(app, key)),
      ]);
      return ok();
    } catch (err) {
      return fail(err, 'Failed to delete attachment.');
    }
  });

  ipcMain.handle('storage:list-attachment-keys', async () => {
    try {
      let entries = [];
      try {
        entries = await fs.readdir(attachmentMetaRootDir(app), { withFileTypes: true });
      } catch (err) {
        if (!(err && typeof err === 'object' && err.code === 'ENOENT')) throw err;
      }
      const keys = [];
      for (const entry of entries) {
        if (!entry || !entry.isFile()) continue;
        const name = String(entry.name ?? '');
        if (!name.endsWith('.json')) continue;
        const raw = name.slice(0, -5);
        const key = decodeFsSegment(raw).trim();
        if (key) keys.push(key);
      }
      keys.sort((a, b) => a.localeCompare(b));
      return ok({ keys });
    } catch (err) {
      return fail(err, 'Failed to list attachments.');
    }
  });

  ipcMain.handle('storage:delete-attachments', async (_event, req) => {
    try {
      const keys = Array.isArray(req?.keys)
        ? Array.from(new Set(req.keys.map((k) => asTrimmedString(k)).filter(Boolean)))
        : [];
      if (keys.length === 0) return ok();
      await Promise.all(
        keys.map(async (key) => {
          await Promise.all([
            removeFileIfExists(attachmentMetaPath(app, key)),
            removeFileIfExists(attachmentBlobPath(app, key)),
          ]);
        }),
      );
      return ok();
    } catch (err) {
      return fail(err, 'Failed to delete attachments.');
    }
  });

  ipcMain.handle('storage:delete-chat-folder', async (_event, req) => {
    try {
      const chatId = asTrimmedString(req?.chatId);
      if (!chatId) return ok();
      await fs.rm(chatDir(app, chatId), { recursive: true, force: true });
      return ok();
    } catch (err) {
      return fail(err, 'Failed to delete chat folder.');
    }
  });

  ipcMain.handle('storage:get-data-dir-info', async () => {
    try {
      return ok(storageLocationInfo(app));
    } catch (err) {
      return fail(err, 'Failed to load storage location.');
    }
  });

  ipcMain.handle('storage:choose-data-dir', async (event, req) => {
    try {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') {
        return fail('Dialog API unavailable.', 'Dialog API unavailable.');
      }

      const browserWindow = event?.sender ? event.sender.getOwnerBrowserWindow?.() : null;
      const pickRes = await dialog.showOpenDialog(browserWindow ?? undefined, {
        title: 'Choose storage location',
        buttonLabel: 'Use Folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (pickRes.canceled || !Array.isArray(pickRes.filePaths) || pickRes.filePaths.length === 0) {
        return { ok: false, canceled: true, error: 'Folder selection was canceled.' };
      }

      const picked = normalizeAbsoluteDirOrNull(pickRes.filePaths[0]);
      if (!picked) return fail('Invalid folder path.', 'Invalid folder path.');
      const info = await setStorageBaseDir(app, picked, { moveExisting: req?.moveExisting !== false });
      return ok({ ...info, canceled: false });
    } catch (err) {
      return fail(err, 'Failed to change storage location.');
    }
  });

  ipcMain.handle('storage:reset-data-dir', async (_event, req) => {
    try {
      const info = await setStorageBaseDir(app, null, { moveExisting: req?.moveExisting !== false });
      return ok(info);
    } catch (err) {
      return fail(err, 'Failed to reset storage location.');
    }
  });

  ipcMain.handle('storage:open-data-dir', async () => {
    try {
      if (!shell || typeof shell.openPath !== 'function') {
        return fail('Shell API unavailable.', 'Shell API unavailable.');
      }
      const dir = storageRootDir(app);
      await fs.mkdir(dir, { recursive: true });
      const err = await shell.openPath(dir);
      if (typeof err === 'string' && err.trim()) {
        return fail(err, 'Failed to open storage folder.');
      }
      return ok({ path: dir });
    } catch (err) {
      return fail(err, 'Failed to open storage folder.');
    }
  });

  ipcMain.handle('storage:get-cloud-sync-info', async () => {
    try {
      const info = await getCloudSyncInfo(app);
      return ok(info);
    } catch (err) {
      return fail(err, 'Failed to load cloud sync settings.');
    }
  });

  ipcMain.handle('storage:choose-cloud-sync-dir', async (event) => {
    try {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') {
        return fail('Dialog API unavailable.', 'Dialog API unavailable.');
      }

      const browserWindow = event?.sender ? event.sender.getOwnerBrowserWindow?.() : null;
      const pickRes = await dialog.showOpenDialog(browserWindow ?? undefined, {
        title: 'Choose cloud sync folder',
        buttonLabel: 'Use Folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (pickRes.canceled || !Array.isArray(pickRes.filePaths) || pickRes.filePaths.length === 0) {
        return { ok: false, canceled: true, error: 'Folder selection was canceled.' };
      }

      const picked = normalizeAbsoluteDirOrNull(pickRes.filePaths[0]);
      if (!picked) return fail('Invalid folder path.', 'Invalid folder path.');

      const localRoot = storageRootDir(app);
      if (isSameOrNestedPath(localRoot, picked)) {
        return fail(
          'Cloud sync folder cannot be the same as, inside, or around the local storage folder.',
          'Invalid cloud sync folder location.',
        );
      }

      await fs.mkdir(picked, { recursive: true });
      const prev = await readCloudSyncConfig(app);
      const prevPath = prev.cloudDir ? path.resolve(prev.cloudDir) : '';
      const nextPath = path.resolve(picked);
      const keepLastPulled = Boolean(prevPath && prevPath === nextPath);

      await writeCloudSyncConfig(app, {
        cloudDir: picked,
        lastPulledRevision: keepLastPulled ? prev.lastPulledRevision : null,
      });
      await ensureCloudSyncLayout(picked);
      const info = await getCloudSyncInfo(app);
      return ok({ ...info, canceled: false });
    } catch (err) {
      return fail(err, 'Failed to set cloud sync folder.');
    }
  });

  ipcMain.handle('storage:unlink-cloud-sync-dir', async () => {
    try {
      await writeCloudSyncConfig(app, { cloudDir: null, lastPulledRevision: null });
      return ok(await getCloudSyncInfo(app));
    } catch (err) {
      return fail(err, 'Failed to unlink cloud sync folder.');
    }
  });

  ipcMain.handle('storage:open-cloud-sync-dir', async () => {
    try {
      if (!shell || typeof shell.openPath !== 'function') {
        return fail('Shell API unavailable.', 'Shell API unavailable.');
      }
      const cfg = await readCloudSyncConfig(app);
      if (!cfg.cloudDir) return fail('Cloud sync folder is not configured.', 'Cloud sync folder is not configured.');
      await fs.mkdir(cfg.cloudDir, { recursive: true });
      const err = await shell.openPath(cfg.cloudDir);
      if (typeof err === 'string' && err.trim()) {
        return fail(err, 'Failed to open cloud sync folder.');
      }
      return ok({ path: cfg.cloudDir });
    } catch (err) {
      return fail(err, 'Failed to open cloud sync folder.');
    }
  });

  ipcMain.handle('storage:cloud-sync-push', async (_event, req) => {
    const syncOp = beginStorageSyncOperation('cloud-push');
    if (!syncOp) {
      return fail(activeStorageSyncOperationMessage(), 'Another sync operation is already in progress.');
    }
    try {
      const pushed = await pushStorageToCloud(app, { force: req?.force === true });
      const info = await getCloudSyncInfo(app);
      return ok({
        ...info,
        pushedRevision: pushed.revision,
      });
    } catch (err) {
      return fail(err, 'Failed to push data to cloud folder.');
    } finally {
      endStorageSyncOperation(syncOp);
    }
  });

  ipcMain.handle('storage:cloud-sync-pull', async () => {
    const syncOp = beginStorageSyncOperation('cloud-pull');
    if (!syncOp) {
      return fail(activeStorageSyncOperationMessage(), 'Another sync operation is already in progress.');
    }
    try {
      const pulled = await pullStorageFromCloud(app);
      const info = await getCloudSyncInfo(app);
      return ok({
        ...info,
        pulledRevision: pulled.revision,
        backupPath: pulled.backupPath || undefined,
      });
    } catch (err) {
      return fail(err, 'Failed to pull data from cloud folder.');
    } finally {
      endStorageSyncOperation(syncOp);
    }
  });

  ipcMain.handle('storage:get-local-sync-backup-info', async () => {
    try {
      const info = await getLocalSyncBackupInfo(app);
      return ok({
        exists: info.exists,
        backupPath: info.backupPath,
        sizeBytes: info.sizeBytes,
        updatedAt: info.updatedAt,
      });
    } catch (err) {
      return fail(err, 'Failed to load local sync backup info.');
    }
  });

  ipcMain.handle('storage:delete-local-sync-backup', async () => {
    try {
      const del = await deleteLocalSyncBackups(app);
      const info = await getLocalSyncBackupInfo(app);
      return ok({
        deleted: del.deleted,
        exists: info.exists,
        backupPath: info.backupPath,
        sizeBytes: info.sizeBytes,
        updatedAt: info.updatedAt,
      });
    } catch (err) {
      return fail(err, 'Failed to delete local sync backup.');
    }
  });

  ipcMain.handle('storage:google-drive-sync-info', async () => {
    try {
      const info = await getGoogleDriveSyncInfo(app);
      return ok(info);
    } catch (err) {
      return fail(err, 'Failed to load Google Drive sync status.');
    }
  });

  ipcMain.handle('storage:google-drive-sync-link', async (_event, req) => {
    try {
      const info = await linkGoogleDriveSync(app, shell, req ?? {});
      return ok(info);
    } catch (err) {
      try {
        const existing = await readGoogleDriveSyncConfig(app);
        const requestedClientId = asTrimmedString(req?.clientId);
        const hasRequestedClientSecret = Boolean(req && Object.prototype.hasOwnProperty.call(req, 'clientSecret'));
        const requestedClientSecret = asTrimmedString(req?.clientSecret);
        await writeGoogleDriveSyncConfig(app, {
          ...existing,
          clientId: requestedClientId || existing.clientId,
          clientSecret: hasRequestedClientSecret ? (requestedClientSecret || null) : existing.clientSecret,
          lastLinkError: shortError(err?.message ?? err, 'Failed to link Google Drive.'),
        });
      } catch {
        // ignore secondary persistence failures
      }
      return fail(err, 'Failed to link Google Drive.');
    }
  });

  ipcMain.handle('storage:google-drive-sync-unlink', async () => {
    try {
      await writeGoogleDriveSyncConfig(app, {
        clientId: null,
        clientSecret: null,
        refreshToken: null,
        folderId: null,
        lastPulledRevision: null,
        lastLinkError: null,
      });
      return ok(await getGoogleDriveSyncInfo(app));
    } catch (err) {
      return fail(err, 'Failed to unlink Google Drive.');
    }
  });

  ipcMain.handle('storage:google-drive-sync-open-folder', async () => {
    try {
      if (!shell || typeof shell.openExternal !== 'function') {
        return fail('Shell API unavailable.', 'Shell API unavailable.');
      }
      const cfg = await readGoogleDriveSyncConfig(app);
      if (!cfg.folderId) return fail('Google Drive is not linked.', 'Google Drive is not linked.');
      const url = `https://drive.google.com/drive/folders/${encodeURIComponent(cfg.folderId)}`;
      const err = await shell.openExternal(url);
      if (asTrimmedString(err)) {
        return fail(err, 'Failed to open Google Drive folder.');
      }
      return ok({ url });
    } catch (err) {
      return fail(err, 'Failed to open Google Drive folder.');
    }
  });

  ipcMain.handle('storage:google-drive-sync-push', async (event, req) => {
    const syncOp = beginStorageSyncOperation('google-drive-push');
    if (!syncOp) {
      return fail(activeStorageSyncOperationMessage(), 'Another sync operation is already in progress.');
    }

    const reportProgress = (patch) => {
      try {
        event.sender.send(GOOGLE_DRIVE_SYNC_PROGRESS_CHANNEL, {
          opId: syncOp.id,
          op: 'push',
          at: Date.now(),
          ...patch,
        });
      } catch {
        // ignore progress delivery failures
      }
    };

    reportProgress({
      done: false,
      stage: 'start',
      phaseIndex: 1,
      phaseCount: 4,
      message: 'Starting Google Drive push...',
      indeterminate: true,
    });

    try {
      const pushed = await pushStorageToGoogleDrive(app, {
        force: req?.force === true,
        onProgress: reportProgress,
      });
      const info = await getGoogleDriveSyncInfo(app);
      reportProgress({
        done: true,
        stage: 'done',
        phaseIndex: 4,
        phaseCount: 4,
        message: 'Google Drive push complete.',
        indeterminate: false,
        completed: pushed.fileCount,
        total: pushed.fileCount,
      });
      return ok({
        ...info,
        pushedRevision: pushed.revision,
        pushedFileCount: pushed.fileCount,
      });
    } catch (err) {
      const msg = shortError(err?.message ?? err, 'Failed to push to Google Drive.');
      reportProgress({
        done: true,
        stage: 'error',
        phaseIndex: 4,
        phaseCount: 4,
        message: msg,
        error: msg,
        indeterminate: true,
      });
      return fail(err, 'Failed to push to Google Drive.');
    } finally {
      endStorageSyncOperation(syncOp);
    }
  });

  ipcMain.handle('storage:google-drive-sync-pull', async (event) => {
    const syncOp = beginStorageSyncOperation('google-drive-pull');
    if (!syncOp) {
      return fail(activeStorageSyncOperationMessage(), 'Another sync operation is already in progress.');
    }

    const reportProgress = (patch) => {
      try {
        event.sender.send(GOOGLE_DRIVE_SYNC_PROGRESS_CHANNEL, {
          opId: syncOp.id,
          op: 'pull',
          at: Date.now(),
          ...patch,
        });
      } catch {
        // ignore progress delivery failures
      }
    };

    reportProgress({
      done: false,
      stage: 'start',
      phaseIndex: 1,
      phaseCount: 5,
      message: 'Starting Google Drive pull...',
      indeterminate: true,
    });

    try {
      const pulled = await pullStorageFromGoogleDrive(app, { onProgress: reportProgress });
      const info = await getGoogleDriveSyncInfo(app);
      reportProgress({
        done: true,
        stage: 'done',
        phaseIndex: 5,
        phaseCount: 5,
        message: 'Google Drive pull complete.',
        indeterminate: false,
        completed: pulled.fileCount,
        total: pulled.fileCount,
      });
      return ok({
        ...info,
        pulledRevision: pulled.revision,
        pulledFileCount: pulled.fileCount,
        backupPath: pulled.backupPath || undefined,
      });
    } catch (err) {
      const msg = shortError(err?.message ?? err, 'Failed to pull from Google Drive.');
      reportProgress({
        done: true,
        stage: 'error',
        phaseIndex: 5,
        phaseCount: 5,
        message: msg,
        error: msg,
        indeterminate: true,
      });
      return fail(err, 'Failed to pull from Google Drive.');
    } finally {
      endStorageSyncOperation(syncOp);
    }
  });

  ipcMain.handle('storage:clear-all', async () => {
    try {
      await fs.rm(storageRootDir(app), { recursive: true, force: true });
      return ok();
    } catch (err) {
      return fail(err, 'Failed to clear storage.');
    }
  });
}

module.exports = {
  registerStorageIpcHandlers,
};
