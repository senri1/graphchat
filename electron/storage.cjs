const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const STORAGE_ROOT_DIRNAME = 'GraphChatV1Data';
const STORAGE_SCHEMA_DIRNAME = 'v1';

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

function storageRootDir(app) {
  return path.join(app.getPath('userData'), STORAGE_ROOT_DIRNAME, STORAGE_SCHEMA_DIRNAME);
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
