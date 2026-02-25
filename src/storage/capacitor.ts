import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { ElectronStorageApi } from './electron';

const STORAGE_BASE_DIRNAME = 'GraphChatV1Data';
const STORAGE_SCHEMA_DIRNAME = 'v1';
const STORAGE_ROOT_DIR = `${STORAGE_BASE_DIRNAME}/${STORAGE_SCHEMA_DIRNAME}`;
const LEGACY_STORAGE_ROOT_DIR = 'graphchatv1-mobile-storage-v1';

const CLOUD_SYNC_SCHEMA_VERSION = 1;
const GOOGLE_DRIVE_SYNC_CONFIG_PATH = `${STORAGE_BASE_DIRNAME}/google-drive-sync.json`;
const GOOGLE_DRIVE_SNAPSHOT_ARTIFACT_EXT = '.gcsnap';
const GOOGLE_DRIVE_SNAPSHOT_ARTIFACT_MAGIC = 'GCSNAP01';
const GOOGLE_DRIVE_MAX_REMOTE_REVISIONS = 3;
const GOOGLE_DRIVE_SNAPSHOT_APPEAR_TIMEOUT_MS = 20_000;
const GOOGLE_DRIVE_SNAPSHOT_APPEAR_POLL_MS = 1_000;
const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];
const GOOGLE_DRIVE_ROOT_FOLDER_NAME = 'GraphChatV1 Sync';
const GOOGLE_DRIVE_HEAD_FILE = 'HEAD.json';
const GOOGLE_DRIVE_OAUTH_MARKER_PARAM = 'gc_gdrive_auth';
const GOOGLE_DRIVE_OAUTH_LOCALHOST_HOST = 'localhost';
const GOOGLE_DRIVE_OAUTH_LOCALHOST_HOST_ALT = '127.0.0.1';

const JSON_EXT = '.json';
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const GOOGLE_DRIVE_PROGRESS_PHASES = { push: 5, pull: 6 } as const;

let cachedCapacitorStorageApi: ElectronStorageApi | null = null;
let legacyMigrationPromise: Promise<void> | null = null;
let activeGoogleDriveSyncOperation: { id: string; mode: 'push' | 'pull' } | null = null;
let googleDriveAppUrlListenerRegistered = false;
let googleDrivePendingAppCallback: GoogleDriveOAuthCallback | null = null;

const googleDriveProgressListeners = new Set<(
  payload: {
    opId?: string;
    op?: 'push' | 'pull' | string;
    at?: number;
    done?: boolean;
    stage?: string;
    phaseIndex?: number;
    phaseCount?: number;
    message?: string;
    error?: string;
    indeterminate?: boolean;
    completed?: number;
    total?: number;
  },
) => void>();

type OkResult<T extends Record<string, unknown> = {}> = { ok: true } & T;
type FailResult = { ok: false; error: string };

type GoogleDriveSyncConfig = {
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  folderId: string | null;
  lastPulledRevision: string | null;
  lastLinkError: string | null;
  oauthState: string | null;
  oauthCodeVerifier: string | null;
  oauthRedirectUri: string | null;
  oauthStartedAt: number | null;
};

type GoogleDriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string | number;
};

type SnapshotFileRecord = {
  relPath: string;
  size: number;
};

type SnapshotSegment = {
  relPath: string;
  start: number;
  end: number;
};

type GoogleDriveOAuthCallback = {
  marker: boolean;
  code: string | null;
  state: string | null;
  error: string | null;
};

function ok<T extends Record<string, unknown> = {}>(payload?: T): OkResult<T> {
  return { ok: true, ...(payload ?? ({} as T)) };
}

function fail(err: unknown, fallback: string): FailResult {
  return { ok: false, error: shortError(err, fallback) };
}

function shortError(value: unknown, fallback: string): string {
  const raw =
    typeof value === 'string'
      ? value.trim()
      : value && typeof value === 'object' && typeof (value as any).message === 'string'
        ? String((value as any).message).trim()
        : String(value ?? '').trim();
  if (!raw) return fallback;
  return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function asOptionalTrimmedString(value: unknown): string | undefined {
  const raw = asTrimmedString(value);
  return raw ? raw : undefined;
}

function asFiniteNumberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function isNotFoundError(err: unknown): boolean {
  const msg = shortError(err, '').toLowerCase();
  return (
    msg.includes('not found') ||
    msg.includes('no such file') ||
    msg.includes('no such directory') ||
    msg.includes('does not exist') ||
    msg.includes('file does not exist') ||
    msg.includes('directory does not exist') ||
    msg.includes('enoent')
  );
}

function isDirectoryTypeError(err: unknown): boolean {
  const msg = shortError(err, '').toLowerCase();
  return msg.includes('is a directory') || msg.includes('is directory');
}

function isAlreadyExistsError(err: unknown): boolean {
  const msg = shortError(err, '').toLowerCase();
  return msg.includes('already exists') || msg.includes('cannot be overwritten') || msg.includes('eexist');
}

function encodeFsSegment(value: unknown, label: string): string {
  const raw = asTrimmedString(value);
  if (!raw) throw new Error(`${label} is missing.`);
  return encodeURIComponent(raw);
}

function decodeFsSegment(value: unknown): string {
  const raw = String(value ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function joinRelPath(base: string, leaf: string): string {
  const lhs = String(base ?? '').replace(/\\/g, '/').replace(/\/+$/g, '');
  const rhs = String(leaf ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!lhs) return rhs;
  if (!rhs) return lhs;
  return `${lhs}/${rhs}`;
}

function workspaceSnapshotPath(): string {
  return joinRelPath(STORAGE_ROOT_DIR, 'Workspace/workspace.json');
}

function chatsRootDir(): string {
  return joinRelPath(STORAGE_ROOT_DIR, 'Chats');
}

function chatDir(chatId: string): string {
  return joinRelPath(chatsRootDir(), encodeFsSegment(chatId, 'Chat id'));
}

function chatStatePath(chatId: string): string {
  return joinRelPath(chatDir(chatId), 'state.json');
}

function chatMetaPath(chatId: string): string {
  return joinRelPath(chatDir(chatId), 'meta.json');
}

function payloadsRootDir(): string {
  return joinRelPath(STORAGE_ROOT_DIR, 'Payloads');
}

function attachmentMetaRootDir(): string {
  return joinRelPath(STORAGE_ROOT_DIR, 'Blobs/meta');
}

function attachmentBlobRootDir(): string {
  return joinRelPath(STORAGE_ROOT_DIR, 'Blobs/data');
}

function attachmentMetaPath(key: string): string {
  return joinRelPath(attachmentMetaRootDir(), `${encodeFsSegment(key, 'Attachment key')}${JSON_EXT}`);
}

function attachmentBlobPath(key: string): string {
  return joinRelPath(attachmentBlobRootDir(), `${encodeFsSegment(key, 'Attachment key')}.bin`);
}

function parsePayloadTripletKey(key: string): { chatId: string; nodeId: string; kind: 'req' | 'res' } | null {
  const raw = asTrimmedString(key);
  const match = /^([^/]+)\/([^/]+)\/(req|res)$/.exec(raw);
  if (!match) return null;
  return {
    chatId: match[1],
    nodeId: match[2],
    kind: match[3] as 'req' | 'res',
  };
}

function payloadPathForKey(key: string): string {
  const raw = asTrimmedString(key);
  if (!raw) throw new Error('Payload key is missing.');
  const triplet = parsePayloadTripletKey(raw);
  if (triplet) {
    return joinRelPath(chatDir(triplet.chatId), `payloads/${encodeFsSegment(triplet.nodeId, 'Node id')}.${triplet.kind}.json`);
  }
  return joinRelPath(payloadsRootDir(), `${encodeFsSegment(raw, 'Payload key')}.json`);
}

function genAttachmentKey(prefix = 'att'): string {
  const p = prefix.replace(/[^a-z0-9_-]/gi, '').slice(0, 12) || 'att';
  try {
    const uuid = (crypto as any)?.randomUUID?.() as string | undefined;
    if (uuid) return `${p}_${uuid}`;
  } catch {
    // ignore
  }
  return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function base64ToBytes(base64Raw: string): Uint8Array {
  let b64 = String(base64Raw ?? '').trim().replace(/\s+/g, '');
  if (!b64) return new Uint8Array(0);
  const mod = b64.length % 4;
  if (mod) b64 += '='.repeat(4 - mod);
  if (typeof atob !== 'function') throw new Error('Base64 decoding is unavailable in this environment.');

  const chunkSize = 1024 * 1024;
  const parts: Uint8Array[] = [];
  let total = 0;

  for (let offset = 0; offset < b64.length; offset += chunkSize) {
    const slice = b64.slice(offset, offset + chunkSize);
    const bin = atob(slice);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    parts.push(bytes);
    total += bytes.length;
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function bytesToBase64(bytesLike: ArrayBuffer | Uint8Array): string {
  const bytes = bytesLike instanceof Uint8Array ? bytesLike : new Uint8Array(bytesLike);
  if (bytes.length === 0) return '';
  if (typeof btoa !== 'function') throw new Error('Base64 encoding is unavailable in this environment.');

  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function utf8BytesToString(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

function utf8StringToBytes(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, part) => acc + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function safeProgressReport(payload: {
  opId?: string;
  op?: 'push' | 'pull' | string;
  at?: number;
  done?: boolean;
  stage?: string;
  phaseIndex?: number;
  phaseCount?: number;
  message?: string;
  error?: string;
  indeterminate?: boolean;
  completed?: number;
  total?: number;
}): void {
  for (const listener of Array.from(googleDriveProgressListeners)) {
    try {
      listener(payload);
    } catch {
      // ignore listener errors
    }
  }
}

function makeSyncOperationId(prefix: string): string {
  const p = String(prefix ?? '')
    .replace(/[^a-z0-9_-]/gi, '')
    .slice(0, 20) || 'sync';
  try {
    const uuid = (crypto as any)?.randomUUID?.() as string | undefined;
    if (uuid) return `${p}_${uuid}`;
  } catch {
    // ignore
  }
  return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function activeStorageSyncOperationMessage(): string {
  const op = activeGoogleDriveSyncOperation;
  if (!op) return 'Another sync operation is already in progress.';
  if (op.mode === 'push') return 'Google Drive push is already in progress.';
  if (op.mode === 'pull') return 'Google Drive pull is already in progress.';
  return 'Another sync operation is already in progress.';
}

function beginStorageSyncOperation(mode: 'push' | 'pull'): { id: string; mode: 'push' | 'pull' } | null {
  if (activeGoogleDriveSyncOperation) return null;
  const op = { id: makeSyncOperationId(`gdrive-${mode}`), mode };
  activeGoogleDriveSyncOperation = op;
  return op;
}

function endStorageSyncOperation(op: { id: string } | null): void {
  if (!op) return;
  if (activeGoogleDriveSyncOperation && activeGoogleDriveSyncOperation.id === op.id) {
    activeGoogleDriveSyncOperation = null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    const res = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    if (typeof res.data === 'string') return res.data;
    if (res.data instanceof Blob) return await res.data.text();
    return null;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

async function readBinaryFile(path: string): Promise<Uint8Array | null> {
  try {
    const res = await Filesystem.readFile({
      path,
      directory: Directory.Data,
    });
    if (typeof res.data === 'string') return base64ToBytes(res.data);
    if (res.data instanceof Blob) {
      const buf = await res.data.arrayBuffer();
      return new Uint8Array(buf);
    }
    return null;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

async function writeTextFile(path: string, text: string): Promise<void> {
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: text,
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

async function writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: bytesToBase64(bytes),
    recursive: true,
  });
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  const raw = await readTextFile(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, JSON.stringify(value));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Filesystem.stat({ path, directory: Directory.Data });
    return String((stat as any)?.type ?? 'file').toLowerCase() === 'file';
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Filesystem.stat({ path, directory: Directory.Data });
    return String((stat as any)?.type ?? '').toLowerCase() === 'directory';
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

function delayMs(ms: number): Promise<void> {
  const timeoutMs = Math.max(0, Math.floor(Number(ms) || 0));
  return new Promise((resolve) => {
    setTimeout(() => resolve(), timeoutMs);
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Data });
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

async function clearPathWithRetry(path: string, opts?: { attempts?: number; waitMs?: number }): Promise<void> {
  const attemptsRaw = Number(opts?.attempts);
  const attempts = Number.isFinite(attemptsRaw) && attemptsRaw > 0 ? Math.floor(attemptsRaw) : 4;
  const waitRaw = Number(opts?.waitMs);
  const waitMs = Number.isFinite(waitRaw) && waitRaw >= 0 ? Math.floor(waitRaw) : 90;

  for (let i = 0; i < attempts; i += 1) {
    await removePathIfExists(path);
    if (!(await pathExists(path))) return;
    if (i + 1 < attempts) {
      await delayMs(waitMs * (i + 1));
    }
  }

  throw new Error(`Failed to clear path before replace: ${path}`);
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true });
    return;
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      if (await dirExists(path)) return;
    }
    throw err;
  }
}

async function copyDirectoryTree(sourceRoot: string, targetRoot: string): Promise<void> {
  if (!(await dirExists(sourceRoot))) {
    throw new Error(`Temporary snapshot directory is missing: ${sourceRoot}`);
  }

  const walk = async (srcDir: string, dstDir: string): Promise<void> => {
    const entries = await readDirEntriesOrEmpty(srcDir);
    for (const entry of entries) {
      const name = asTrimmedString((entry as any)?.name);
      if (!name) continue;

      const srcPath = joinRelPath(srcDir, name);
      const dstPath = joinRelPath(dstDir, name);
      let type = asTrimmedString((entry as any)?.type).toLowerCase();

      if (!type) {
        try {
          const stat = await Filesystem.stat({ path: srcPath, directory: Directory.Data });
          type = asTrimmedString((stat as any)?.type).toLowerCase();
        } catch {
          type = '';
        }
      }

      if (type === 'directory') {
        await walk(srcPath, dstPath);
        continue;
      }

      if (type && type !== 'file') continue;

      const bytes = await readBinaryFile(srcPath);
      if (!bytes) continue;
      await writeBinaryFile(dstPath, bytes);
    }
  };

  await walk(sourceRoot, targetRoot);
}

async function replaceStorageRootFromTmp(tmpRoot: string): Promise<void> {
  try {
    await clearPathWithRetry(STORAGE_ROOT_DIR, { attempts: 4, waitMs: 90 });
  } catch (err) {
    throw new Error(`Failed to clear existing local snapshot directory (${STORAGE_ROOT_DIR}): ${shortError(err, 'clear failed')}`);
  }

  try {
    await copyDirectoryTree(tmpRoot, STORAGE_ROOT_DIR);
  } catch (err) {
    await clearPathWithRetry(STORAGE_ROOT_DIR, { attempts: 3, waitMs: 70 }).catch(() => {});
    throw new Error(`Failed to materialize pulled snapshot into ${STORAGE_ROOT_DIR}: ${shortError(err, 'copy failed')}`);
  }

  await removePathIfExists(tmpRoot).catch(() => {});
}

async function readDirEntriesOrEmpty(path: string): Promise<Array<{ name: string; type?: string }>> {
  try {
    const res = await Filesystem.readdir({ path, directory: Directory.Data });
    return Array.isArray(res.files) ? (res.files as any[]) : [];
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

async function removePathIfExists(path: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
    return;
  } catch (err) {
    if (!isNotFoundError(err) && !isDirectoryTypeError(err)) {
      // continue to directory removal attempt; this can still be a directory path
    }
  }

  try {
    await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true });
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw err;
  }
}

async function ensureStorageRootParentExists(): Promise<void> {
  await ensureDirectory(STORAGE_BASE_DIRNAME);
}

function legacyWorkspacePath(): string {
  return joinRelPath(LEGACY_STORAGE_ROOT_DIR, 'workspace.json');
}

function legacyChatStatesDir(): string {
  return joinRelPath(LEGACY_STORAGE_ROOT_DIR, 'chatStates');
}

function legacyChatMetaDir(): string {
  return joinRelPath(LEGACY_STORAGE_ROOT_DIR, 'chatMeta');
}

function legacyPayloadsDir(): string {
  return joinRelPath(LEGACY_STORAGE_ROOT_DIR, 'payloads');
}

function legacyAttachmentsDir(): string {
  return joinRelPath(LEGACY_STORAGE_ROOT_DIR, 'attachments');
}

function legacyChatStatePathByFileName(name: string): string {
  return joinRelPath(legacyChatStatesDir(), name);
}

function legacyChatMetaPathByFileName(name: string): string {
  return joinRelPath(legacyChatMetaDir(), name);
}

function legacyPayloadPathByFileName(name: string): string {
  return joinRelPath(legacyPayloadsDir(), name);
}

function legacyAttachmentPathByFileName(name: string): string {
  return joinRelPath(legacyAttachmentsDir(), name);
}

async function hasAnyNewStorageData(): Promise<boolean> {
  if (await fileExists(workspaceSnapshotPath())) return true;
  if ((await readDirEntriesOrEmpty(chatsRootDir())).length > 0) return true;
  if ((await readDirEntriesOrEmpty(payloadsRootDir())).length > 0) return true;
  if ((await readDirEntriesOrEmpty(attachmentMetaRootDir())).length > 0) return true;
  if ((await readDirEntriesOrEmpty(attachmentBlobRootDir())).length > 0) return true;
  return false;
}

async function hasLegacyStorageData(): Promise<boolean> {
  if (await fileExists(legacyWorkspacePath())) return true;
  if ((await readDirEntriesOrEmpty(legacyChatStatesDir())).length > 0) return true;
  if ((await readDirEntriesOrEmpty(legacyChatMetaDir())).length > 0) return true;
  if ((await readDirEntriesOrEmpty(legacyPayloadsDir())).length > 0) return true;
  if ((await readDirEntriesOrEmpty(legacyAttachmentsDir())).length > 0) return true;
  return false;
}

async function migrateLegacyStorageLayoutIfNeeded(): Promise<void> {
  if (legacyMigrationPromise) {
    await legacyMigrationPromise;
    return;
  }

  legacyMigrationPromise = (async () => {
    const hasLegacy = await hasLegacyStorageData();
    if (!hasLegacy) return;

    const hasNew = await hasAnyNewStorageData();
    if (hasNew) return;

    await ensureStorageRootParentExists();

    const workspace = await readJsonOrNull(legacyWorkspacePath());
    if (workspace && typeof workspace === 'object') {
      await writeJson(workspaceSnapshotPath(), workspace);
    }

    const legacyStateEntries = await readDirEntriesOrEmpty(legacyChatStatesDir());
    for (const entry of legacyStateEntries) {
      const type = asTrimmedString((entry as any)?.type).toLowerCase();
      if (type && type !== 'file') continue;
      const name = asTrimmedString((entry as any)?.name);
      if (!name.endsWith(JSON_EXT)) continue;
      const rec = await readJsonOrNull(legacyChatStatePathByFileName(name));
      if (!rec || typeof rec !== 'object') continue;
      const byFile = decodeFsSegment(name.slice(0, -JSON_EXT.length));
      const chatId = asTrimmedString((rec as any)?.chatId) || asTrimmedString(byFile);
      if (!chatId) continue;
      await writeJson(chatStatePath(chatId), { ...(rec as any), chatId });
    }

    const legacyMetaEntries = await readDirEntriesOrEmpty(legacyChatMetaDir());
    for (const entry of legacyMetaEntries) {
      const type = asTrimmedString((entry as any)?.type).toLowerCase();
      if (type && type !== 'file') continue;
      const name = asTrimmedString((entry as any)?.name);
      if (!name.endsWith(JSON_EXT)) continue;
      const rec = await readJsonOrNull(legacyChatMetaPathByFileName(name));
      if (!rec || typeof rec !== 'object') continue;
      const byFile = decodeFsSegment(name.slice(0, -JSON_EXT.length));
      const chatId = asTrimmedString((rec as any)?.chatId) || asTrimmedString(byFile);
      if (!chatId) continue;
      await writeJson(chatMetaPath(chatId), { ...(rec as any), chatId });
    }

    const legacyPayloadEntries = await readDirEntriesOrEmpty(legacyPayloadsDir());
    for (const entry of legacyPayloadEntries) {
      const type = asTrimmedString((entry as any)?.type).toLowerCase();
      if (type && type !== 'file') continue;
      const name = asTrimmedString((entry as any)?.name);
      if (!name.endsWith(JSON_EXT)) continue;
      const rec = await readJsonOrNull(legacyPayloadPathByFileName(name));
      if (!rec || typeof rec !== 'object') continue;
      const byFile = decodeFsSegment(name.slice(0, -JSON_EXT.length));
      const key = asTrimmedString((rec as any)?.key) || asTrimmedString(byFile);
      if (!key) continue;
      await writeJson(payloadPathForKey(key), {
        key,
        json: (rec as any)?.json ?? null,
        createdAt: Number.isFinite(Number((rec as any)?.createdAt)) ? Number((rec as any).createdAt) : Date.now(),
      });
    }

    const legacyAttachmentEntries = await readDirEntriesOrEmpty(legacyAttachmentsDir());
    for (const entry of legacyAttachmentEntries) {
      const type = asTrimmedString((entry as any)?.type).toLowerCase();
      if (type && type !== 'file') continue;
      const name = asTrimmedString((entry as any)?.name);
      if (!name.endsWith(JSON_EXT)) continue;
      const rec = await readJsonOrNull(legacyAttachmentPathByFileName(name));
      if (!rec || typeof rec !== 'object') continue;

      const byFile = decodeFsSegment(name.slice(0, -JSON_EXT.length));
      const key = asTrimmedString((rec as any)?.key) || asTrimmedString(byFile);
      if (!key) continue;

      const mimeType = asOptionalTrimmedString((rec as any)?.mimeType) ?? 'application/octet-stream';
      const nameValue = asOptionalTrimmedString((rec as any)?.name);
      const sizeValue = asFiniteNumberOrUndefined((rec as any)?.size);
      const createdAt = asFiniteNumberOrUndefined((rec as any)?.createdAt) ?? Date.now();
      const base64 = asTrimmedString((rec as any)?.base64);
      if (!base64) continue;

      await writeJson(attachmentMetaPath(key), {
        key,
        mimeType,
        ...(nameValue ? { name: nameValue } : {}),
        ...(Number.isFinite(sizeValue) ? { size: sizeValue } : {}),
        createdAt,
      });
      await writeBinaryFile(attachmentBlobPath(key), base64ToBytes(base64));
    }
  })();

  await legacyMigrationPromise;
}

async function ensureStorageReady(): Promise<void> {
  await migrateLegacyStorageLayoutIfNeeded();
}

function normalizeGoogleDriveSyncConfig(raw: unknown): GoogleDriveSyncConfig {
  const obj = raw && typeof raw === 'object' ? (raw as any) : {};
  return {
    clientId: asTrimmedString(obj.clientId) || null,
    clientSecret: asTrimmedString(obj.clientSecret) || null,
    refreshToken: asTrimmedString(obj.refreshToken) || null,
    folderId: asTrimmedString(obj.folderId) || null,
    lastPulledRevision: asTrimmedString(obj.lastPulledRevision) || null,
    lastLinkError: asTrimmedString(obj.lastLinkError) || null,
    oauthState: asTrimmedString(obj.oauthState) || null,
    oauthCodeVerifier: asTrimmedString(obj.oauthCodeVerifier) || null,
    oauthRedirectUri: asTrimmedString(obj.oauthRedirectUri) || null,
    oauthStartedAt: Number.isFinite(Number(obj.oauthStartedAt)) ? Number(obj.oauthStartedAt) : null,
  };
}

async function readGoogleDriveSyncConfig(): Promise<GoogleDriveSyncConfig> {
  const raw = await readJsonOrNull(GOOGLE_DRIVE_SYNC_CONFIG_PATH);
  return normalizeGoogleDriveSyncConfig(raw);
}

async function writeGoogleDriveSyncConfig(cfg: GoogleDriveSyncConfig): Promise<GoogleDriveSyncConfig> {
  const next = normalizeGoogleDriveSyncConfig(cfg);
  const hasPersistableValue = Boolean(
    next.clientId ||
      next.clientSecret ||
      next.refreshToken ||
      next.folderId ||
      next.lastPulledRevision ||
      next.lastLinkError ||
      next.oauthState ||
      next.oauthCodeVerifier ||
      next.oauthRedirectUri,
  );
  if (!hasPersistableValue) {
    await removePathIfExists(GOOGLE_DRIVE_SYNC_CONFIG_PATH);
    return normalizeGoogleDriveSyncConfig({});
  }
  await writeJson(GOOGLE_DRIVE_SYNC_CONFIG_PATH, {
    ...next,
    updatedAt: Date.now(),
  });
  return next;
}

function base64UrlNoPad(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomBase64Url(byteLength: number): string {
  const len = Math.max(1, Math.floor(byteLength));
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64UrlNoPad(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8StringToBytes(input));
  return base64UrlNoPad(new Uint8Array(digest));
}

function googleDriveQueryLiteral(value: string): string {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function googleSnapshotArtifactFileName(revision: string): string {
  return `snapshot-${revision}${GOOGLE_DRIVE_SNAPSHOT_ARTIFACT_EXT}`;
}

function parseGoogleSnapshotRevisionFromFileName(name: string): string | null {
  const raw = asTrimmedString(name);
  if (!raw || !raw.startsWith('snapshot-')) return null;
  const body = raw.slice('snapshot-'.length);
  if (!body) return null;
  if (body.endsWith(GOOGLE_DRIVE_SNAPSHOT_ARTIFACT_EXT)) {
    const rev = body.slice(0, -GOOGLE_DRIVE_SNAPSHOT_ARTIFACT_EXT.length).trim();
    return rev || null;
  }
  const legacySep = body.indexOf('--');
  if (legacySep > 0) {
    const rev = body.slice(0, legacySep).trim();
    return rev || null;
  }
  return null;
}

function revisionTimestampFromRevisionId(revision: string): number {
  const raw = asTrimmedString(revision);
  if (!raw) return 0;
  const match = /^rev_([0-9a-z]+)_/i.exec(raw);
  if (!match) return 0;
  const parsed = parseInt(match[1], 36);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeRelativePathForWrite(relPath: string): string | null {
  const raw = String(relPath ?? '').replace(/\\/g, '/');
  const parts = raw.split('/');
  const out: string[] = [];
  for (const part of parts) {
    const seg = part.trim();
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join('/');
}

async function googleFetchJson(url: string, init: RequestInit, fallbackMessage: string): Promise<any> {
  if (typeof fetch !== 'function') throw new Error('Fetch API is unavailable in this runtime.');
  const res = await fetch(url, init);
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    let apiMsg = '';
    try {
      const parsed = bodyText ? (JSON.parse(bodyText) as any) : null;
      apiMsg =
        asTrimmedString(parsed?.error_description) ||
        asTrimmedString(parsed?.error?.message) ||
        asTrimmedString(parsed?.error) ||
        asTrimmedString(parsed?.message);
    } catch {
      apiMsg = '';
    }
    throw new Error(`${fallbackMessage} (${res.status})${apiMsg ? `: ${apiMsg}` : ''}`);
  }
  if (!bodyText) return {};
  try {
    return JSON.parse(bodyText);
  } catch {
    return {};
  }
}

async function googleFetchBytes(url: string, init: RequestInit, fallbackMessage: string): Promise<Uint8Array> {
  if (typeof fetch !== 'function') throw new Error('Fetch API is unavailable in this runtime.');
  const res = await fetch(url, init);
  if (!res.ok) {
    let apiMsg = '';
    try {
      const parsed = (await res.json()) as any;
      apiMsg =
        asTrimmedString(parsed?.error?.message) ||
        asTrimmedString(parsed?.error_description) ||
        asTrimmedString(parsed?.message);
    } catch {
      apiMsg = '';
    }
    throw new Error(`${fallbackMessage} (${res.status})${apiMsg ? `: ${apiMsg}` : ''}`);
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

async function googleTokenByRefreshToken(cfg: GoogleDriveSyncConfig): Promise<string> {
  const clientId = asTrimmedString(cfg.clientId);
  const refreshToken = asTrimmedString(cfg.refreshToken);
  const clientSecret = asTrimmedString(cfg.clientSecret);
  if (!clientId || !refreshToken) throw new Error('Google Drive is not linked. Link Google Drive first.');

  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const token = await googleFetchJson(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    'Failed to refresh Google Drive access token',
  );

  const accessToken = asTrimmedString(token?.access_token);
  if (!accessToken) throw new Error('Google token response did not include access_token.');
  return accessToken;
}

async function googleDriveListFiles(accessToken: string, q: string, opts?: { pageSize?: number; fields?: string; orderBy?: string }): Promise<GoogleDriveFile[]> {
  const pageSize = Number.isFinite(Number(opts?.pageSize)) ? Math.max(1, Math.min(200, Number(opts?.pageSize))) : 50;
  const fields = asTrimmedString(opts?.fields) || 'files(id,name,mimeType,modifiedTime,size)';
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', q);
  url.searchParams.set('fields', fields);
  url.searchParams.set('pageSize', String(pageSize));
  if (asTrimmedString(opts?.orderBy)) url.searchParams.set('orderBy', asTrimmedString(opts?.orderBy));

  const json = await googleFetchJson(
    url.toString(),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    'Failed to list Google Drive files',
  );

  return Array.isArray(json?.files) ? (json.files as GoogleDriveFile[]) : [];
}

async function googleDriveFindFileByName(
  accessToken: string,
  parentId: string,
  name: string,
  opts?: { mimeType?: string },
): Promise<GoogleDriveFile | null> {
  const parent = asTrimmedString(parentId);
  const fileName = asTrimmedString(name);
  if (!parent || !fileName) return null;
  let q = `'${googleDriveQueryLiteral(parent)}' in parents and trashed=false and name='${googleDriveQueryLiteral(fileName)}'`;
  const mimeType = asTrimmedString(opts?.mimeType);
  if (mimeType) q += ` and mimeType='${googleDriveQueryLiteral(mimeType)}'`;
  const files = await googleDriveListFiles(accessToken, q, { pageSize: 1 });
  return files[0] ?? null;
}

async function googleDriveCreateFolder(accessToken: string, parentId: string, name: string): Promise<string> {
  const parent = asTrimmedString(parentId);
  const folderName = asTrimmedString(name);
  if (!parent || !folderName) throw new Error('Google Drive folder parameters are missing.');

  const json = await googleFetchJson(
    'https://www.googleapis.com/drive/v3/files',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parent],
      }),
    },
    'Failed to create Google Drive folder',
  );

  const id = asTrimmedString(json?.id);
  if (!id) throw new Error('Google Drive folder creation returned no id.');
  return id;
}

async function googleDriveEnsureFolder(accessToken: string, parentId: string, name: string): Promise<string> {
  const existing = await googleDriveFindFileByName(accessToken, parentId, name, {
    mimeType: 'application/vnd.google-apps.folder',
  });
  const existingId = asTrimmedString(existing?.id);
  if (existingId) return existingId;
  return await googleDriveCreateFolder(accessToken, parentId, name);
}

async function googleDriveCreateMultipartFile(
  accessToken: string,
  metadata: Record<string, unknown>,
  bytes: Uint8Array,
  mimeType: string,
): Promise<GoogleDriveFile> {
  const boundary = `gc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const pre =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${asTrimmedString(mimeType) || 'application/octet-stream'}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: new Blob([pre, bytes, post]),
  });

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    let apiMsg = '';
    try {
      const parsed = bodyText ? (JSON.parse(bodyText) as any) : null;
      apiMsg = asTrimmedString(parsed?.error?.message) || asTrimmedString(parsed?.message);
    } catch {
      apiMsg = '';
    }
    throw new Error(`Failed to upload file to Google Drive (${res.status})${apiMsg ? `: ${apiMsg}` : ''}`);
  }

  try {
    return bodyText ? (JSON.parse(bodyText) as GoogleDriveFile) : {};
  } catch {
    return {};
  }
}

async function googleDriveUpdateMultipartFile(
  accessToken: string,
  fileId: string,
  metadata: Record<string, unknown>,
  bytes: Uint8Array,
  mimeType: string,
): Promise<GoogleDriveFile> {
  const id = asTrimmedString(fileId);
  if (!id) throw new Error('Google Drive file id is missing.');

  const boundary = `gc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const pre =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${asTrimmedString(mimeType) || 'application/octet-stream'}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;

  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=multipart`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: new Blob([pre, bytes, post]),
  });

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    let apiMsg = '';
    try {
      const parsed = bodyText ? (JSON.parse(bodyText) as any) : null;
      apiMsg = asTrimmedString(parsed?.error?.message) || asTrimmedString(parsed?.message);
    } catch {
      apiMsg = '';
    }
    throw new Error(`Failed to update file in Google Drive (${res.status})${apiMsg ? `: ${apiMsg}` : ''}`);
  }

  try {
    return bodyText ? (JSON.parse(bodyText) as GoogleDriveFile) : {};
  } catch {
    return {};
  }
}

async function googleDriveDownloadFile(accessToken: string, fileId: string): Promise<Uint8Array> {
  const id = asTrimmedString(fileId);
  if (!id) throw new Error('Google Drive file id is missing.');
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
  return await googleFetchBytes(
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    'Failed to download file from Google Drive',
  );
}

async function googleDriveDeleteFile(accessToken: string, fileId: string): Promise<void> {
  const id = asTrimmedString(fileId);
  if (!id) throw new Error('Google Drive file id is missing.');
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404 || res.status === 410) return;
  if (!res.ok) {
    let apiMsg = '';
    try {
      const parsed = (await res.json()) as any;
      apiMsg = asTrimmedString(parsed?.error?.message) || asTrimmedString(parsed?.message);
    } catch {
      apiMsg = '';
    }
    throw new Error(`Failed to delete file from Google Drive (${res.status})${apiMsg ? `: ${apiMsg}` : ''}`);
  }
}

async function googleDriveReadHead(accessToken: string, folderId: string): Promise<{ fileId: string; revision: string; updatedAt: number } | null> {
  const headFile = await googleDriveFindFileByName(accessToken, folderId, GOOGLE_DRIVE_HEAD_FILE);
  const headFileId = asTrimmedString(headFile?.id);
  if (!headFileId) return null;
  const bytes = await googleDriveDownloadFile(accessToken, headFileId);
  let parsed: any = null;
  try {
    parsed = JSON.parse(utf8BytesToString(bytes));
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

async function googleDriveWriteHead(accessToken: string, folderId: string, payload: unknown): Promise<string> {
  const bytes = utf8StringToBytes(`${JSON.stringify(payload, null, 2)}\n`);
  const existing = await googleDriveFindFileByName(accessToken, folderId, GOOGLE_DRIVE_HEAD_FILE);
  const existingId = asTrimmedString(existing?.id);
  if (existingId) {
    await googleDriveUpdateMultipartFile(accessToken, existingId, { name: GOOGLE_DRIVE_HEAD_FILE }, bytes, 'application/json');
    return existingId;
  }
  const created = await googleDriveCreateMultipartFile(
    accessToken,
    { name: GOOGLE_DRIVE_HEAD_FILE, parents: [folderId] },
    bytes,
    'application/json',
  );
  return asTrimmedString(created?.id);
}

function makeCloudRevisionId(): string {
  return `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function collectLocalFilesRecursively(rootPath: string): Promise<Array<{ relPath: string; path: string }>> {
  const out: Array<{ relPath: string; path: string }> = [];

  const walk = async (dirPath: string, relPrefix: string): Promise<void> => {
    const entries = await readDirEntriesOrEmpty(dirPath);
    for (const entry of entries) {
      const name = asTrimmedString((entry as any)?.name);
      if (!name) continue;
      const type = asTrimmedString((entry as any)?.type).toLowerCase();
      const absPath = joinRelPath(dirPath, name);
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;

      if (type === 'directory') {
        await walk(absPath, relPath);
        continue;
      }
      if (type === 'file') {
        out.push({ relPath, path: absPath });
        continue;
      }

      try {
        const stat = await Filesystem.stat({ path: absPath, directory: Directory.Data });
        const statType = asTrimmedString((stat as any)?.type).toLowerCase();
        if (statType === 'directory') {
          await walk(absPath, relPath);
        } else {
          out.push({ relPath, path: absPath });
        }
      } catch {
        // ignore unreadable entry
      }
    }
  };

  await walk(rootPath, '');
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function createGoogleDriveSnapshotArtifact(args: {
  files: Array<{ relPath: string; path: string }>;
  revision: string;
  onProgress?: (patch: any) => void;
}): Promise<{ artifactBytes: Uint8Array; artifactName: string; fileCount: number; totalBytes: number }> {
  const revision = asTrimmedString(args.revision);
  if (!revision) throw new Error('Revision is missing.');

  const onProgress = typeof args.onProgress === 'function' ? args.onProgress : null;
  const emit = (payload: any) => {
    if (!onProgress) return;
    try {
      onProgress(payload);
    } catch {
      // ignore progress listener issues
    }
  };

  const entries: Array<{ relPath: string; size: number; bytes: Uint8Array }> = [];
  let totalBytes = 0;

  for (const file of args.files) {
    const relPath = asTrimmedString(file?.relPath);
    const path = asTrimmedString(file?.path);
    if (!relPath || !path) continue;
    const bytes = await readBinaryFile(path);
    if (!bytes) continue;
    const size = bytes.length;
    entries.push({ relPath, size, bytes });
    totalBytes += size;
  }

  const meta = {
    format: 'graphchatv1-gdrive-snapshot',
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    storageSchema: STORAGE_SCHEMA_DIRNAME,
    revision,
    createdAt: Date.now(),
    createdAtIso: new Date().toISOString(),
    fileCount: entries.length,
    totalBytes,
    files: entries.map((entry) => ({
      path: entry.relPath,
      size: entry.size,
    })),
  };

  const magicBytes = utf8StringToBytes(GOOGLE_DRIVE_SNAPSHOT_ARTIFACT_MAGIC);
  const metaBytes = utf8StringToBytes(JSON.stringify(meta));
  const header = new Uint8Array(magicBytes.length + 4);
  header.set(magicBytes, 0);
  new DataView(header.buffer, header.byteOffset, header.byteLength).setUint32(magicBytes.length, metaBytes.length, false);

  const parts: Uint8Array[] = [header, metaBytes];
  let packed = 0;
  for (const entry of entries) {
    parts.push(entry.bytes);
    packed += 1;
    emit({
      done: false,
      stage: 'package',
      phaseIndex: 2,
      phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
      message: `Packing snapshot... (${packed}/${entries.length})`,
      indeterminate: false,
      completed: packed,
      total: entries.length,
    });
  }

  return {
    artifactBytes: concatBytes(parts),
    artifactName: googleSnapshotArtifactFileName(revision),
    fileCount: entries.length,
    totalBytes,
  };
}

function parseGoogleDriveSnapshotArtifact(bytes: Uint8Array): { meta: any; segments: SnapshotSegment[] } {
  const magicBytes = utf8StringToBytes(GOOGLE_DRIVE_SNAPSHOT_ARTIFACT_MAGIC);
  if (bytes.length < magicBytes.length + 4) {
    throw new Error('Snapshot artifact is too small.');
  }

  for (let i = 0; i < magicBytes.length; i += 1) {
    if (bytes[i] !== magicBytes[i]) {
      throw new Error('Snapshot artifact format is not supported.');
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLength = view.getUint32(magicBytes.length, false);
  const metaStart = magicBytes.length + 4;
  const metaEnd = metaStart + metaLength;
  if (metaEnd > bytes.length) throw new Error('Snapshot artifact metadata is truncated.');

  let meta: any = null;
  try {
    meta = JSON.parse(utf8BytesToString(bytes.subarray(metaStart, metaEnd)));
  } catch {
    meta = null;
  }
  if (!meta || typeof meta !== 'object') throw new Error('Snapshot artifact metadata is invalid.');

  const filesRaw = Array.isArray(meta.files) ? (meta.files as any[]) : null;
  if (!filesRaw) throw new Error('Snapshot artifact is missing files list.');

  const files: SnapshotFileRecord[] = filesRaw
    .map((rec) => ({
      relPath: asTrimmedString(rec?.path),
      size: Number(rec?.size),
    }))
    .filter((rec) => rec.relPath && Number.isFinite(rec.size) && rec.size >= 0)
    .map((rec) => ({ relPath: rec.relPath, size: Math.floor(rec.size) }));

  let offset = metaEnd;
  const segments: SnapshotSegment[] = [];
  for (const file of files) {
    const nextOffset = offset + file.size;
    if (!Number.isFinite(nextOffset) || nextOffset > bytes.length) {
      throw new Error(`Snapshot artifact data is truncated for ${file.relPath}.`);
    }
    segments.push({
      relPath: file.relPath,
      start: offset,
      end: nextOffset,
    });
    offset = nextOffset;
  }

  if (offset !== bytes.length) {
    throw new Error('Snapshot artifact has unexpected trailing bytes.');
  }

  return { meta, segments };
}

async function extractGoogleDriveSnapshotArtifactToDir(bytes: Uint8Array, targetRoot: string): Promise<{ revision: string | null; fileCount: number }> {
  const parsed = parseGoogleDriveSnapshotArtifact(bytes);
  const revision = asTrimmedString(parsed.meta?.revision) || null;

  for (const segment of parsed.segments) {
    const normalized = normalizeRelativePathForWrite(segment.relPath);
    if (!normalized) continue;
    const chunk = bytes.subarray(segment.start, segment.end);
    await writeBinaryFile(joinRelPath(targetRoot, normalized), chunk);
  }

  return {
    revision,
    fileCount: parsed.segments.length,
  };
}

function parseGoogleDriveCallbackParamsFromUrl(rawUrl: string): GoogleDriveOAuthCallback {
  const fallback: GoogleDriveOAuthCallback = { marker: false, code: null, state: null, error: null };
  const source = asTrimmedString(rawUrl);
  if (!source) return fallback;

  try {
    const url = new URL(source);
    const code = asTrimmedString(url.searchParams.get('code')) || null;
    const state = asTrimmedString(url.searchParams.get('state')) || null;
    const error = asTrimmedString(url.searchParams.get('error')) || null;

    const scheme = asTrimmedString(url.protocol).replace(/:$/g, '').toLowerCase();
    const host = asTrimmedString(url.hostname).toLowerCase();
    const hasAuthResponse = Boolean(code || state || error);
    const isLocalhostOauthCallback =
      (scheme === 'http' || scheme === 'https') &&
      hasAuthResponse &&
      (host === GOOGLE_DRIVE_OAUTH_LOCALHOST_HOST || host === GOOGLE_DRIVE_OAUTH_LOCALHOST_HOST_ALT);

    return {
      marker: url.searchParams.get(GOOGLE_DRIVE_OAUTH_MARKER_PARAM) === '1' || isLocalhostOauthCallback,
      code,
      state,
      error,
    };
  } catch {
    return fallback;
  }
}

function getGoogleDriveCallbackParamsFromUrl(): GoogleDriveOAuthCallback {
  if (typeof window === 'undefined') return { marker: false, code: null, state: null, error: null };
  return parseGoogleDriveCallbackParamsFromUrl(window.location.href);
}

function consumeGoogleDrivePendingAppCallback(): GoogleDriveOAuthCallback | null {
  const callback = googleDrivePendingAppCallback;
  googleDrivePendingAppCallback = null;
  return callback;
}

function ensureGoogleDriveAppUrlListener(): void {
  if (googleDriveAppUrlListenerRegistered) return;
  if (!isAndroidCapacitorRuntime()) return;
  if (!Capacitor.isPluginAvailable('App')) return;

  googleDriveAppUrlListenerRegistered = true;
  try {
    const registration = App.addListener('appUrlOpen', (event: { url?: string }) => {
      const callback = parseGoogleDriveCallbackParamsFromUrl(asTrimmedString(event?.url));
      if (!callback.marker) return;
      googleDrivePendingAppCallback = callback;
    }) as unknown;
    if (registration && typeof (registration as any).then === 'function') {
      (registration as Promise<unknown>).catch(() => {
        googleDriveAppUrlListenerRegistered = false;
      });
    }
  } catch {
    googleDriveAppUrlListenerRegistered = false;
  }
}

function clearGoogleDriveCallbackParamsInUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('scope');
    url.searchParams.delete('authuser');
    url.searchParams.delete('prompt');
    url.searchParams.delete('error');
    url.searchParams.delete(GOOGLE_DRIVE_OAUTH_MARKER_PARAM);
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, '', next);
  } catch {
    // ignore URL cleanup failures
  }
}

function buildGoogleDriveRedirectUri(): string {
  if (typeof window === 'undefined') throw new Error('Window is unavailable for OAuth redirect.');
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('scope');
  url.searchParams.delete('authuser');
  url.searchParams.delete('prompt');
  url.searchParams.delete('error');
  url.searchParams.set(GOOGLE_DRIVE_OAUTH_MARKER_PARAM, '1');
  return url.toString();
}

async function beginGoogleDriveOAuthRedirect(cfg: GoogleDriveSyncConfig): Promise<void> {
  const clientId = asTrimmedString(cfg.clientId);
  const clientSecret = asTrimmedString(cfg.clientSecret);
  if (!clientId) throw new Error('Google OAuth client ID is required.');
  if (typeof window === 'undefined') throw new Error('Window is unavailable for OAuth redirect.');
  if (isAndroidCapacitorRuntime()) ensureGoogleDriveAppUrlListener();

  const codeVerifier = randomBase64Url(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomBase64Url(20);
  const redirectUri = buildGoogleDriveRedirectUri();

  await writeGoogleDriveSyncConfig({
    ...cfg,
    clientId,
    clientSecret: clientSecret || null,
    oauthState: state,
    oauthCodeVerifier: codeVerifier,
    oauthRedirectUri: redirectUri,
    oauthStartedAt: Date.now(),
    lastLinkError: null,
  });

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

  window.location.assign(authUrl.toString());
}

async function completeGoogleDriveOAuthIfPresent(
  cfg: GoogleDriveSyncConfig,
  incomingCallback?: GoogleDriveOAuthCallback | null,
): Promise<{ cfg: GoogleDriveSyncConfig; accessToken?: string }> {
  const callback = incomingCallback ?? getGoogleDriveCallbackParamsFromUrl();
  const shouldClearWindowCallbackParams = true;
  if (!callback.marker) return { cfg };

  const clientId = asTrimmedString(cfg.clientId);
  const clientSecret = asTrimmedString(cfg.clientSecret);

  if (callback.error) {
    if (shouldClearWindowCallbackParams) clearGoogleDriveCallbackParamsInUrl();
    const next = await writeGoogleDriveSyncConfig({
      ...cfg,
      oauthState: null,
      oauthCodeVerifier: null,
      oauthRedirectUri: null,
      oauthStartedAt: null,
      lastLinkError: `Google sign-in failed: ${callback.error}`,
    });
    return { cfg: next };
  }

  if (!callback.code || !callback.state) return { cfg };
  if (!clientId) {
    if (shouldClearWindowCallbackParams) clearGoogleDriveCallbackParamsInUrl();
    const next = await writeGoogleDriveSyncConfig({
      ...cfg,
      oauthState: null,
      oauthCodeVerifier: null,
      oauthRedirectUri: null,
      oauthStartedAt: null,
      lastLinkError: 'Google OAuth client ID is required.',
    });
    return { cfg: next };
  }

  const expectedState = asTrimmedString(cfg.oauthState);
  const codeVerifier = asTrimmedString(cfg.oauthCodeVerifier);
  const redirectUri = asTrimmedString(cfg.oauthRedirectUri) || buildGoogleDriveRedirectUri();

  if (!expectedState || callback.state !== expectedState) {
    if (shouldClearWindowCallbackParams) clearGoogleDriveCallbackParamsInUrl();
    const next = await writeGoogleDriveSyncConfig({
      ...cfg,
      oauthState: null,
      oauthCodeVerifier: null,
      oauthRedirectUri: null,
      oauthStartedAt: null,
      lastLinkError: 'Google OAuth state mismatch. Please try linking again.',
    });
    return { cfg: next };
  }

  if (!codeVerifier) {
    if (shouldClearWindowCallbackParams) clearGoogleDriveCallbackParamsInUrl();
    const next = await writeGoogleDriveSyncConfig({
      ...cfg,
      oauthState: null,
      oauthCodeVerifier: null,
      oauthRedirectUri: null,
      oauthStartedAt: null,
      lastLinkError: 'Google OAuth verifier is missing. Please try linking again.',
    });
    return { cfg: next };
  }

  try {
    const tokenBody = new URLSearchParams({
      code: callback.code,
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
    const refreshToken = asTrimmedString(token?.refresh_token) || asTrimmedString(cfg.refreshToken);
    if (!accessToken) throw new Error('Google token response did not include access_token.');
    if (!refreshToken) {
      throw new Error('Google token response did not include refresh_token. Remove existing app access and try again.');
    }

    const next = await writeGoogleDriveSyncConfig({
      ...cfg,
      clientId,
      clientSecret: clientSecret || null,
      refreshToken,
      oauthState: null,
      oauthCodeVerifier: null,
      oauthRedirectUri: null,
      oauthStartedAt: null,
      lastLinkError: null,
    });

    if (shouldClearWindowCallbackParams) clearGoogleDriveCallbackParamsInUrl();
    return { cfg: next, accessToken };
  } catch (err) {
    const next = await writeGoogleDriveSyncConfig({
      ...cfg,
      oauthState: null,
      oauthCodeVerifier: null,
      oauthRedirectUri: null,
      oauthStartedAt: null,
      lastLinkError: shortError(err, 'Failed to link Google Drive.'),
    });
    if (shouldClearWindowCallbackParams) clearGoogleDriveCallbackParamsInUrl();
    return { cfg: next };
  }
}

async function waitForGoogleDriveFileByName(
  accessToken: string,
  parentId: string,
  name: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<GoogleDriveFile | null> {
  const timeoutRaw = Number(opts?.timeoutMs);
  const pollRaw = Number(opts?.pollMs);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 0 ? Math.floor(timeoutRaw) : GOOGLE_DRIVE_SNAPSHOT_APPEAR_TIMEOUT_MS;
  const pollMs = Number.isFinite(pollRaw) && pollRaw > 0 ? Math.floor(pollRaw) : GOOGLE_DRIVE_SNAPSHOT_APPEAR_POLL_MS;

  const start = Date.now();
  while (true) {
    const found = await googleDriveFindFileByName(accessToken, parentId, name);
    if (found && asTrimmedString(found.id)) return found;

    if (Date.now() - start >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return null;
}

async function listGoogleDriveSnapshotArtifactNames(accessToken: string, parentId: string, limit = 8): Promise<string[]> {
  const parent = asTrimmedString(parentId);
  if (!parent) return [];
  const q = `'${googleDriveQueryLiteral(parent)}' in parents and trashed=false and name contains 'snapshot-' and name contains '${googleDriveQueryLiteral(
    GOOGLE_DRIVE_SNAPSHOT_ARTIFACT_EXT,
  )}'`;

  const files = await googleDriveListFiles(accessToken, q, {
    pageSize: Math.max(1, Math.min(50, limit * 3)),
    fields: 'files(name,modifiedTime)',
    orderBy: 'modifiedTime desc',
  });

  const names = files
    .map((file) => asTrimmedString(file?.name))
    .filter(Boolean)
    .slice(0, Math.max(1, limit));

  return names;
}

async function pruneGoogleDriveSnapshotRevisions(
  accessToken: string,
  parentId: string,
  opts?: { keepLatest?: number; protectedRevision?: string },
): Promise<void> {
  const parent = asTrimmedString(parentId);
  if (!parent) return;

  const keepLatestRaw = Number(opts?.keepLatest);
  const keepLatest = Number.isFinite(keepLatestRaw) && keepLatestRaw > 0 ? Math.floor(keepLatestRaw) : GOOGLE_DRIVE_MAX_REMOTE_REVISIONS;
  const protectedRevision = asTrimmedString(opts?.protectedRevision);

  const q = `'${googleDriveQueryLiteral(parent)}' in parents and trashed=false and name contains 'snapshot-'`;
  const files = await googleDriveListFiles(accessToken, q, {
    pageSize: 200,
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
  });

  const byRevision = new Map<string, GoogleDriveFile[]>();
  for (const file of files) {
    const name = asTrimmedString(file?.name);
    const revision = parseGoogleSnapshotRevisionFromFileName(name);
    if (!revision) continue;
    const bucket = byRevision.get(revision) ?? [];
    bucket.push(file);
    byRevision.set(revision, bucket);
  }

  const revisions = Array.from(byRevision.keys())
    .sort((a, b) => {
      const at = revisionTimestampFromRevisionId(a);
      const bt = revisionTimestampFromRevisionId(b);
      if (at !== bt) return bt - at;
      return b.localeCompare(a);
    })
    .filter((revision) => revision !== protectedRevision);

  if (revisions.length <= keepLatest) return;

  const removeRevisions = revisions.slice(keepLatest);
  for (const revision of removeRevisions) {
    const filesForRevision = byRevision.get(revision) ?? [];
    for (const file of filesForRevision) {
      const fileId = asTrimmedString(file?.id);
      if (!fileId) continue;
      try {
        await googleDriveDeleteFile(accessToken, fileId);
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

async function ensureGoogleDriveFolderAndHead(cfg: GoogleDriveSyncConfig, accessToken?: string): Promise<GoogleDriveSyncConfig> {
  const token = asTrimmedString(accessToken) || (await googleTokenByRefreshToken(cfg));
  const folderId = asTrimmedString(cfg.folderId) || (await googleDriveEnsureFolder(token, 'root', GOOGLE_DRIVE_ROOT_FOLDER_NAME));
  const head = await googleDriveReadHead(token, folderId);
  return await writeGoogleDriveSyncConfig({
    ...cfg,
    folderId,
    lastPulledRevision: cfg.lastPulledRevision || head?.revision || null,
    lastLinkError: null,
  });
}

async function getGoogleDriveSyncInfo(): Promise<{
  linked: boolean;
  clientId?: string;
  hasClientSecret?: boolean;
  folderId?: string;
  lastPulledRevision?: string;
  lastLinkError?: string;
  remoteHeadRevision?: string;
  remoteHeadUpdatedAt?: number;
  remoteError?: string;
  configPath?: string;
  configExists?: boolean;
}> {
  await ensureStorageReady();
  ensureGoogleDriveAppUrlListener();
  let cfg = await readGoogleDriveSyncConfig();

  const pendingAppCallback = consumeGoogleDrivePendingAppCallback();
  const callback = pendingAppCallback ?? getGoogleDriveCallbackParamsFromUrl();
  if (callback.marker && (callback.code || callback.error)) {
    const completed = await completeGoogleDriveOAuthIfPresent(cfg, pendingAppCallback);
    cfg = completed.cfg;
    if (completed.accessToken || cfg.refreshToken) {
      try {
        cfg = await ensureGoogleDriveFolderAndHead(cfg, completed.accessToken);
      } catch (err) {
        cfg = await writeGoogleDriveSyncConfig({
          ...cfg,
          lastLinkError: shortError(err, 'Failed to finalize Google Drive link.'),
        });
      }
    }
  }

  const configExists = await fileExists(GOOGLE_DRIVE_SYNC_CONFIG_PATH);
  const linked = Boolean(cfg.clientId && cfg.refreshToken && cfg.folderId);

  let remoteHeadRevision: string | undefined;
  let remoteHeadUpdatedAt: number | undefined;
  let remoteError: string | undefined;

  if (linked) {
    try {
      const accessToken = await googleTokenByRefreshToken(cfg);
      const head = await googleDriveReadHead(accessToken, asTrimmedString(cfg.folderId));
      remoteHeadRevision = head?.revision || undefined;
      remoteHeadUpdatedAt = head ? head.updatedAt : undefined;
    } catch (err) {
      remoteError = shortError(err, 'Failed to read Google Drive head.');
    }
  }

  return {
    linked,
    clientId: cfg.clientId || undefined,
    hasClientSecret: Boolean(cfg.clientSecret),
    folderId: cfg.folderId || undefined,
    lastPulledRevision: cfg.lastPulledRevision || undefined,
    lastLinkError: cfg.lastLinkError || undefined,
    remoteHeadRevision,
    remoteHeadUpdatedAt,
    remoteError,
    configPath: GOOGLE_DRIVE_SYNC_CONFIG_PATH,
    configExists,
  };
}

async function pushStorageToGoogleDrive(opts?: { force?: boolean; onProgress?: (patch: any) => void }): Promise<{ revision: string; fileCount: number }> {
  await ensureStorageReady();

  const emitProgress = (patch: any) => {
    const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
    if (!onProgress) return;
    try {
      onProgress({ done: false, indeterminate: true, ...patch });
    } catch {
      // ignore
    }
  };

  emitProgress({
    stage: 'prepare',
    phaseIndex: 1,
    phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
    message: 'Checking Google Drive status...',
  });

  let cfg = await readGoogleDriveSyncConfig();
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
    phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
    message: 'Scanning local files...',
  });

  const revision = makeCloudRevisionId();
  const localFiles = await collectLocalFilesRecursively(STORAGE_ROOT_DIR);

  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  if (onProgress) {
    try {
      onProgress({
        done: false,
        stage: 'package',
        phaseIndex: 2,
        phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
        message: `Packing snapshot... (0/${localFiles.length})`,
        indeterminate: localFiles.length === 0,
        completed: 0,
        total: localFiles.length,
      });
    } catch {
      // ignore
    }
  }

  const artifact = await createGoogleDriveSnapshotArtifact({
    files: localFiles,
    revision,
    onProgress: onProgress ?? undefined,
  });

  if (onProgress) {
    try {
      onProgress({
        done: false,
        stage: 'upload',
        phaseIndex: 3,
        phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
        message: 'Uploading snapshot artifact...',
        indeterminate: false,
        completed: 0,
        total: 1,
      });
    } catch {
      // ignore
    }
  }

  await googleDriveCreateMultipartFile(
    accessToken,
    {
      name: artifact.artifactName,
      parents: [cfg.folderId],
    },
    artifact.artifactBytes,
    'application/octet-stream',
  );

  emitProgress({
    stage: 'finalize',
    phaseIndex: 4,
    phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
    message: 'Updating remote revision head...',
  });

  await googleDriveWriteHead(accessToken, cfg.folderId, {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    revision,
    snapshotFile: artifact.artifactName,
    snapshotFormat: 'graphchatv1-gdrive-snapshot',
    updatedAt: Date.now(),
    updatedAtIso: new Date().toISOString(),
  });

  emitProgress({
    stage: 'finalize',
    phaseIndex: 5,
    phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
    message: 'Pruning older remote snapshots...',
  });
  try {
    await pruneGoogleDriveSnapshotRevisions(accessToken, cfg.folderId, {
      keepLatest: GOOGLE_DRIVE_MAX_REMOTE_REVISIONS,
      protectedRevision: revision,
    });
  } catch {
    // keep push successful even if cleanup fails
  }

  emitProgress({
    stage: 'finalize',
    phaseIndex: 5,
    phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
    message: 'Finalizing local sync state...',
  });

  cfg = await writeGoogleDriveSyncConfig({
    ...cfg,
    lastPulledRevision: revision,
  });

  return {
    revision,
    fileCount: artifact.fileCount + 1,
  };
}

async function pullStorageFromGoogleDrive(opts?: { onProgress?: (patch: any) => void }): Promise<{ revision: string; backupPath: string | null; fileCount: number }> {
  await ensureStorageReady();

  const emitProgress = (patch: any) => {
    const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
    if (!onProgress) return;
    try {
      onProgress({ done: false, indeterminate: true, ...patch });
    } catch {
      // ignore
    }
  };

  emitProgress({
    stage: 'prepare',
    phaseIndex: 1,
    phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
    message: 'Reading Google Drive snapshot metadata...',
  });

  let cfg = await readGoogleDriveSyncConfig();
  if (!cfg.clientId || !cfg.refreshToken || !cfg.folderId) {
    throw new Error('Google Drive is not linked. Link Google Drive first.');
  }

  const accessToken = await googleTokenByRefreshToken(cfg);
  const remoteHead = await googleDriveReadHead(accessToken, cfg.folderId);
  const revision = asTrimmedString(remoteHead?.revision);
  if (!revision) throw new Error('Google Drive has no pushed snapshot yet.');

  const snapshotFileName = googleSnapshotArtifactFileName(revision);
  const snapshotFile = await waitForGoogleDriveFileByName(accessToken, cfg.folderId, snapshotFileName, {
    timeoutMs: GOOGLE_DRIVE_SNAPSHOT_APPEAR_TIMEOUT_MS,
    pollMs: GOOGLE_DRIVE_SNAPSHOT_APPEAR_POLL_MS,
  });
  const snapshotFileId = asTrimmedString(snapshotFile?.id);
  if (!snapshotFileId) {
    const available = await listGoogleDriveSnapshotArtifactNames(accessToken, cfg.folderId, 8).catch(() => []);
    const suffix = available.length > 0 ? ` Available: ${available.join(', ')}` : ' Available: none';
    throw new Error(`Google Drive snapshot artifact is missing for revision ${revision} (expected ${snapshotFileName}).${suffix}`);
  }

  const tmpRoot = `${STORAGE_BASE_DIRNAME}/.gdrive-pull-tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await removePathIfExists(tmpRoot);

  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  if (onProgress) {
    try {
      onProgress({
        done: false,
        stage: 'download',
        phaseIndex: 2,
        phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
        message: 'Downloading snapshot artifact...',
        indeterminate: false,
        completed: 0,
        total: 1,
      });
    } catch {
      // ignore
    }
  }

  let fileCount = 0;
  try {
    const artifactBytes = await googleDriveDownloadFile(accessToken, snapshotFileId);

    if (onProgress) {
      try {
        onProgress({
          done: false,
          stage: 'download',
          phaseIndex: 2,
          phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
          message: 'Downloading snapshot artifact...',
          indeterminate: false,
          completed: 1,
          total: 1,
        });
      } catch {
        // ignore
      }
    }

    emitProgress({
      stage: 'extract',
      phaseIndex: 3,
      phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
      message: 'Extracting snapshot artifact...',
    });

    const extracted = await extractGoogleDriveSnapshotArtifactToDir(artifactBytes, tmpRoot);
    if (extracted.revision && extracted.revision !== revision) {
      throw new Error(`Snapshot artifact revision mismatch (expected ${revision}, got ${extracted.revision}).`);
    }
    fileCount = extracted.fileCount;
  } catch (err) {
    await removePathIfExists(tmpRoot);
    throw err;
  }

  emitProgress({
    stage: 'backup',
    phaseIndex: 4,
    phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
    message: 'Preparing local storage replace...',
  });

  emitProgress({
    stage: 'apply',
    phaseIndex: 5,
    phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
    message: 'Applying downloaded snapshot locally...',
  });

  await replaceStorageRootFromTmp(tmpRoot);

  emitProgress({
    stage: 'finalize',
    phaseIndex: 6,
    phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
    message: 'Finalizing local sync state...',
  });

  cfg = await writeGoogleDriveSyncConfig({
    ...cfg,
    lastPulledRevision: revision,
  });

  return {
    revision,
    backupPath: null,
    fileCount,
  };
}

function isAndroidCapacitorRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('Filesystem');
  } catch {
    return false;
  }
}

function createCapacitorStorageApi(): ElectronStorageApi {
  return {
    storageGetWorkspaceSnapshot: async () => {
      try {
        await ensureStorageReady();
        const snapshot = await readJsonOrNull(workspaceSnapshotPath());
        if (!snapshot || typeof snapshot !== 'object') return ok({ snapshot: null });
        return ok({ snapshot });
      } catch (err) {
        return fail(err, 'Failed to load workspace snapshot.');
      }
    },

    storagePutWorkspaceSnapshot: async (req) => {
      try {
        await ensureStorageReady();
        const snapshot = req?.snapshot;
        if (!snapshot || typeof snapshot !== 'object') return fail('Workspace snapshot is missing.', 'Workspace snapshot is missing.');
        await writeJson(workspaceSnapshotPath(), { ...snapshot, updatedAt: Date.now() });
        return ok();
      } catch (err) {
        return fail(err, 'Failed to persist workspace snapshot.');
      }
    },

    storageDeleteWorkspaceSnapshot: async () => {
      try {
        await ensureStorageReady();
        await removePathIfExists(workspaceSnapshotPath());
        return ok();
      } catch (err) {
        return fail(err, 'Failed to delete workspace snapshot.');
      }
    },

    storageGetChatStateRecord: async (req) => {
      try {
        await ensureStorageReady();
        const chatId = asTrimmedString(req?.chatId);
        if (!chatId) return ok({ record: null });
        const rec = await readJsonOrNull(chatStatePath(chatId));
        if (!rec || typeof rec !== 'object') return ok({ record: null });
        if (asTrimmedString((rec as any)?.chatId) !== chatId || !(rec as any)?.state) return ok({ record: null });
        return ok({ record: rec });
      } catch (err) {
        return fail(err, 'Failed to load chat state.');
      }
    },

    storagePutChatStateRecord: async (req) => {
      try {
        await ensureStorageReady();
        const chatId = asTrimmedString(req?.chatId);
        if (!chatId) return fail('Chat id is missing.', 'Chat id is missing.');
        await writeJson(chatStatePath(chatId), {
          chatId,
          state: req?.state,
          updatedAt: Date.now(),
        });
        return ok();
      } catch (err) {
        return fail(err, 'Failed to persist chat state.');
      }
    },

    storageDeleteChatStateRecord: async (req) => {
      try {
        await ensureStorageReady();
        const chatId = asTrimmedString(req?.chatId);
        if (!chatId) return ok();
        await removePathIfExists(chatStatePath(chatId));
        return ok();
      } catch (err) {
        return fail(err, 'Failed to delete chat state.');
      }
    },

    storageGetChatMetaRecord: async (req) => {
      try {
        await ensureStorageReady();
        const chatId = asTrimmedString(req?.chatId);
        if (!chatId) return ok({ record: null });
        const rec = await readJsonOrNull(chatMetaPath(chatId));
        if (!rec || typeof rec !== 'object') return ok({ record: null });
        if (asTrimmedString((rec as any)?.chatId) !== chatId) return ok({ record: null });
        return ok({ record: rec });
      } catch (err) {
        return fail(err, 'Failed to load chat metadata.');
      }
    },

    storagePutChatMetaRecord: async (req) => {
      try {
        await ensureStorageReady();
        const chatId = asTrimmedString(req?.chatId);
        if (!chatId) return fail('Chat id is missing.', 'Chat id is missing.');
        await writeJson(chatMetaPath(chatId), {
          chatId,
          meta: req?.meta,
          updatedAt: Date.now(),
        });
        return ok();
      } catch (err) {
        return fail(err, 'Failed to persist chat metadata.');
      }
    },

    storageDeleteChatMetaRecord: async (req) => {
      try {
        await ensureStorageReady();
        const chatId = asTrimmedString(req?.chatId);
        if (!chatId) return ok();
        await removePathIfExists(chatMetaPath(chatId));
        return ok();
      } catch (err) {
        return fail(err, 'Failed to delete chat metadata.');
      }
    },

    storageGetPayload: async (req) => {
      try {
        await ensureStorageReady();
        const key = asTrimmedString(req?.key);
        if (!key) return ok({ payload: null });
        const rec = await readJsonOrNull(payloadPathForKey(key));
        if (!rec || typeof rec !== 'object') return ok({ payload: null });
        if (asTrimmedString((rec as any)?.key) !== key) return ok({ payload: null });
        return ok({ payload: (rec as any)?.json ?? null });
      } catch (err) {
        return fail(err, 'Failed to load payload.');
      }
    },

    storagePutPayload: async (req) => {
      try {
        await ensureStorageReady();
        const key = asTrimmedString(req?.key);
        if (!key) return ok();
        await writeJson(payloadPathForKey(key), {
          key,
          json: req?.json,
          createdAt: Date.now(),
        });
        return ok();
      } catch (err) {
        return fail(err, 'Failed to persist payload.');
      }
    },

    storageDeletePayload: async (req) => {
      try {
        await ensureStorageReady();
        const key = asTrimmedString(req?.key);
        if (!key) return ok();
        await removePathIfExists(payloadPathForKey(key));
        return ok();
      } catch (err) {
        return fail(err, 'Failed to delete payload.');
      }
    },

    storagePutAttachment: async (req) => {
      try {
        await ensureStorageReady();
        const bytes = req?.bytes;
        if (!(bytes instanceof ArrayBuffer)) return fail('Attachment bytes are missing.', 'Attachment bytes are missing.');

        const key = genAttachmentKey('att');
        const mimeType = asOptionalTrimmedString(req?.mimeType) ?? 'application/octet-stream';
        const name = asOptionalTrimmedString(req?.name);
        const size = asFiniteNumberOrUndefined(req?.size) ?? bytes.byteLength;
        const createdAt = Date.now();

        await writeBinaryFile(attachmentBlobPath(key), new Uint8Array(bytes));
        await writeJson(attachmentMetaPath(key), {
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
    },

    storageGetAttachment: async (req) => {
      try {
        await ensureStorageReady();
        const key = asTrimmedString(req?.key);
        if (!key) return ok({ record: null });

        const meta = await readJsonOrNull(attachmentMetaPath(key));
        if (!meta || typeof meta !== 'object' || asTrimmedString((meta as any)?.key) !== key) return ok({ record: null });

        const bytes = await readBinaryFile(attachmentBlobPath(key));
        if (!bytes) return ok({ record: null });

        return ok({
          record: {
            key,
            mimeType: asOptionalTrimmedString((meta as any)?.mimeType) ?? 'application/octet-stream',
            ...(asOptionalTrimmedString((meta as any)?.name) ? { name: asOptionalTrimmedString((meta as any)?.name) } : {}),
            ...(Number.isFinite(Number((meta as any)?.size)) ? { size: Number((meta as any).size) } : {}),
            createdAt: Number.isFinite(Number((meta as any)?.createdAt)) ? Number((meta as any).createdAt) : 0,
            bytes,
          },
        });
      } catch (err) {
        return fail(err, 'Failed to load attachment.');
      }
    },

    storageDeleteAttachment: async (req) => {
      try {
        await ensureStorageReady();
        const key = asTrimmedString(req?.key);
        if (!key) return ok();
        await Promise.all([removePathIfExists(attachmentMetaPath(key)), removePathIfExists(attachmentBlobPath(key))]);
        return ok();
      } catch (err) {
        return fail(err, 'Failed to delete attachment.');
      }
    },

    storageListAttachmentKeys: async () => {
      try {
        await ensureStorageReady();
        const files = await readDirEntriesOrEmpty(attachmentMetaRootDir());
        const keys: string[] = [];
        for (const entry of files) {
          const type = asTrimmedString((entry as any)?.type).toLowerCase();
          if (type && type !== 'file') continue;
          const name = asTrimmedString((entry as any)?.name);
          if (!name.endsWith(JSON_EXT)) continue;
          const raw = name.slice(0, -JSON_EXT.length);
          const key = asTrimmedString(decodeFsSegment(raw));
          if (key) keys.push(key);
        }
        keys.sort((a, b) => a.localeCompare(b));
        return ok({ keys });
      } catch (err) {
        return fail(err, 'Failed to list attachments.');
      }
    },

    storageDeleteAttachments: async (req) => {
      try {
        await ensureStorageReady();
        const keys = Array.isArray(req?.keys) ? Array.from(new Set(req.keys.map((k) => asTrimmedString(k)).filter(Boolean))) : [];
        if (keys.length === 0) return ok();
        await Promise.all(
          keys.map(async (key) => {
            await Promise.all([removePathIfExists(attachmentMetaPath(key)), removePathIfExists(attachmentBlobPath(key))]);
          }),
        );
        return ok();
      } catch (err) {
        return fail(err, 'Failed to delete attachments.');
      }
    },

    storageGoogleDriveSyncInfo: async () => {
      try {
        const info = await getGoogleDriveSyncInfo();
        return ok(info);
      } catch (err) {
        return fail(err, 'Failed to load Google Drive sync status.');
      }
    },

    storageGoogleDriveSyncLink: async (req) => {
      try {
        await ensureStorageReady();
        const current = await readGoogleDriveSyncConfig();
        const requestedClientId = asTrimmedString(req?.clientId);
        const hasRequestedClientSecret = Boolean(req && Object.prototype.hasOwnProperty.call(req, 'clientSecret'));
        const requestedClientSecret = asTrimmedString(req?.clientSecret);

        const clientId = requestedClientId || current.clientId;
        const clientSecret = hasRequestedClientSecret ? (requestedClientSecret || null) : current.clientSecret;
        if (!clientId) return fail('Google OAuth client ID is required.', 'Google OAuth client ID is required.');

        let cfg = await writeGoogleDriveSyncConfig({
          ...current,
          clientId,
          clientSecret,
          lastLinkError: null,
        });

        ensureGoogleDriveAppUrlListener();
        const pendingAppCallback = consumeGoogleDrivePendingAppCallback();
        const callback = pendingAppCallback ?? getGoogleDriveCallbackParamsFromUrl();
        if (callback.marker && (callback.code || callback.error)) {
          const completed = await completeGoogleDriveOAuthIfPresent(cfg, pendingAppCallback);
          cfg = completed.cfg;
          if (completed.accessToken || cfg.refreshToken) {
            cfg = await ensureGoogleDriveFolderAndHead(cfg, completed.accessToken);
          }
          return ok(await getGoogleDriveSyncInfo());
        }

        await beginGoogleDriveOAuthRedirect(cfg);
        return ok(await getGoogleDriveSyncInfo());
      } catch (err) {
        const existing = await readGoogleDriveSyncConfig().catch(() => normalizeGoogleDriveSyncConfig({}));
        await writeGoogleDriveSyncConfig({
          ...existing,
          lastLinkError: shortError(err, 'Failed to link Google Drive.'),
        }).catch(() => {});
        return fail(err, 'Failed to link Google Drive.');
      }
    },

    storageGoogleDriveSyncUnlink: async () => {
      try {
        await ensureStorageReady();
        await writeGoogleDriveSyncConfig({
          clientId: null,
          clientSecret: null,
          refreshToken: null,
          folderId: null,
          lastPulledRevision: null,
          lastLinkError: null,
          oauthState: null,
          oauthCodeVerifier: null,
          oauthRedirectUri: null,
          oauthStartedAt: null,
        });
        return ok(await getGoogleDriveSyncInfo());
      } catch (err) {
        return fail(err, 'Failed to unlink Google Drive.');
      }
    },

    storageGoogleDriveSyncOpenFolder: async () => {
      try {
        await ensureStorageReady();
        const cfg = await readGoogleDriveSyncConfig();
        if (!cfg.folderId) return fail('Google Drive is not linked.', 'Google Drive is not linked.');
        const url = `https://drive.google.com/drive/folders/${encodeURIComponent(cfg.folderId)}`;
        if (typeof window !== 'undefined') {
          window.open(url, '_blank');
        }
        return ok({ url });
      } catch (err) {
        return fail(err, 'Failed to open Google Drive folder.');
      }
    },

    storageGoogleDriveSyncPush: async (req) => {
      const syncOp = beginStorageSyncOperation('push');
      if (!syncOp) {
        return fail(activeStorageSyncOperationMessage(), 'Another sync operation is already in progress.');
      }

      const reportProgress = (patch: any) => {
        safeProgressReport({
          opId: syncOp.id,
          op: 'push',
          at: Date.now(),
          ...patch,
        });
      };

      reportProgress({
        done: false,
        stage: 'start',
        phaseIndex: 1,
        phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
        message: 'Starting Google Drive push...',
        indeterminate: true,
      });

      try {
        const pushed = await pushStorageToGoogleDrive({
          force: req?.force === true,
          onProgress: reportProgress,
        });
        const info = await getGoogleDriveSyncInfo();

        reportProgress({
          done: true,
          stage: 'done',
          phaseIndex: GOOGLE_DRIVE_PROGRESS_PHASES.push,
          phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
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
        const msg = shortError(err, 'Failed to push to Google Drive.');
        reportProgress({
          done: true,
          stage: 'error',
          phaseIndex: GOOGLE_DRIVE_PROGRESS_PHASES.push,
          phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.push,
          message: msg,
          error: msg,
          indeterminate: true,
        });
        return fail(err, 'Failed to push to Google Drive.');
      } finally {
        endStorageSyncOperation(syncOp);
      }
    },

    storageGoogleDriveSyncPull: async () => {
      const syncOp = beginStorageSyncOperation('pull');
      if (!syncOp) {
        return fail(activeStorageSyncOperationMessage(), 'Another sync operation is already in progress.');
      }

      const reportProgress = (patch: any) => {
        safeProgressReport({
          opId: syncOp.id,
          op: 'pull',
          at: Date.now(),
          ...patch,
        });
      };

      reportProgress({
        done: false,
        stage: 'start',
        phaseIndex: 1,
        phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
        message: 'Starting Google Drive pull...',
        indeterminate: true,
      });

      try {
        const pulled = await pullStorageFromGoogleDrive({ onProgress: reportProgress });
        const info = await getGoogleDriveSyncInfo();

        reportProgress({
          done: true,
          stage: 'done',
          phaseIndex: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
          phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
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
        const msg = shortError(err, 'Failed to pull from Google Drive.');
        reportProgress({
          done: true,
          stage: 'error',
          phaseIndex: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
          phaseCount: GOOGLE_DRIVE_PROGRESS_PHASES.pull,
          message: msg,
          error: msg,
          indeterminate: true,
        });
        return fail(err, 'Failed to pull from Google Drive.');
      } finally {
        endStorageSyncOperation(syncOp);
      }
    },

    storageGoogleDriveSyncOnProgress: (cb) => {
      if (typeof cb !== 'function') return () => {};
      googleDriveProgressListeners.add(cb as any);
      return () => {
        googleDriveProgressListeners.delete(cb as any);
      };
    },

    storageClearAll: async () => {
      try {
        await ensureStorageReady();
        await Promise.all([removePathIfExists(STORAGE_ROOT_DIR), removePathIfExists(LEGACY_STORAGE_ROOT_DIR)]);
        return ok();
      } catch (err) {
        return fail(err, 'Failed to clear filesystem storage.');
      }
    },
  };
}

export function getCapacitorStorageApi(): ElectronStorageApi | null {
  if (cachedCapacitorStorageApi) return cachedCapacitorStorageApi;
  if (!isAndroidCapacitorRuntime()) return null;
  ensureGoogleDriveAppUrlListener();
  cachedCapacitorStorageApi = createCapacitorStorageApi();
  return cachedCapacitorStorageApi;
}
