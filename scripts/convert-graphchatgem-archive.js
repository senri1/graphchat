#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const MIN_NODE_W = 160;
const MIN_NODE_H = 110;
const DEFAULT_NODE_W = 460;
const DEFAULT_NODE_H = 240;

function usage() {
  // eslint-disable-next-line no-console
  console.log(`
Convert a graphchatgem export into a graphchatv1 importable archive.

Usage:
  node scripts/convert-graphchatgem-archive.js <input.graphchat.json> [output.graphchatv1.json] [--background none|first|all]

Examples:
  node scripts/convert-graphchatgem-archive.js ~/Downloads/my.graphchat.json
  node scripts/convert-graphchatgem-archive.js in.graphchat.json out.graphchatv1.json --background first
`.trim());
}

function fail(msg) {
  // eslint-disable-next-line no-console
  console.error(`Error: ${msg}`);
  process.exitCode = 1;
}

function safeString(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

function finiteNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampMin(n, min) {
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n;
}

function normalizeFolderPath(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => safeString(s).trim()).filter(Boolean);
}

function computeFolderPathForChat(chat, fsBlock) {
  if (!fsBlock || typeof fsBlock !== 'object') return [];

  // Selected/multi export: paths map chatId -> ['Folder', 'Subfolder']
  if ('paths' in fsBlock) {
    const paths = fsBlock.paths;
    if (paths && typeof paths === 'object') {
      const raw = paths[chat.id];
      const out = normalizeFolderPath(raw);
      if (out.length) return out;
    }
  }

  // Export-all: folder map + chat.parentId.
  if ('folders' in fsBlock) {
    const folders = fsBlock.folders;
    const rootId = typeof fsBlock.rootId === 'string' ? fsBlock.rootId : '';
    if (folders && typeof folders === 'object') {
      let folderId = typeof chat.parentId === 'string' && chat.parentId ? chat.parentId : null;
      const names = [];
      const seen = new Set();
      let guard = 0;
      while (folderId && guard++ < 500) {
        if (folderId === rootId) break;
        if (seen.has(folderId)) break;
        seen.add(folderId);
        const f = folders[folderId];
        if (!f || typeof f !== 'object') break;
        const name = safeString(f.name).trim();
        if (name) names.push(name);
        folderId = typeof f.parentId === 'string' && f.parentId ? f.parentId : null;
      }
      return names.reverse();
    }
  }

  return [];
}

function convertAttachment(att) {
  if (!att || typeof att !== 'object') return null;
  const kind = safeString(att.kind);
  if (kind === 'image') {
    const out = { kind: 'image' };
    const name = safeString(att.name).trim();
    const mimeType = safeString(att.mimeType).trim();
    const data = typeof att.data === 'string' ? att.data : '';
    const detail = safeString(att.detail).trim();
    if (name) out.name = name;
    if (mimeType) out.mimeType = mimeType;
    if (data) out.data = data;
    if (detail === 'low' || detail === 'auto' || detail === 'high') out.detail = detail;
    return out;
  }
  if (kind === 'pdf') {
    const out = { kind: 'pdf', mimeType: 'application/pdf' };
    const name = safeString(att.name).trim();
    const data = typeof att.data === 'string' ? att.data : '';
    const size = finiteNumber(att.size, NaN);
    if (name) out.name = name;
    if (data) out.data = data;
    if (Number.isFinite(size) && size >= 0) out.size = Math.floor(size);
    return out;
  }
  if (kind === 'ink') {
    const out = { kind: 'ink' };
    // Preserve inline data for graphchatv1 import (it will migrate to IDB and replace with storageKey).
    const data = typeof att.data === 'string' ? att.data : '';
    const mimeType = safeString(att.mimeType).trim();
    const rev = finiteNumber(att.rev, NaN);
    if (data) out.data = data;
    if (mimeType) out.mimeType = mimeType;
    if (Number.isFinite(rev) && rev >= 0) out.rev = Math.floor(rev);
    return out;
  }
  return null;
}

function convertChatNodes(nodesById) {
  const out = [];
  const entries = nodesById && typeof nodesById === 'object' ? Object.entries(nodesById) : [];
  for (const [entryId, rawNode] of entries) {
    if (!rawNode || typeof rawNode !== 'object') continue;

    const nodeId = safeString(rawNode.id).trim() || safeString(entryId).trim();
    if (!nodeId) continue;

    const parentIdRaw = safeString(rawNode.parentId).trim();
    const parentId = parentIdRaw ? parentIdRaw : null;

    const rawAuthor = safeString(rawNode.author).trim();
    const author = rawAuthor === 'user' ? 'user' : 'assistant';

    const x = finiteNumber(rawNode.x, 0);
    const y = finiteNumber(rawNode.y, 0);
    const w = clampMin(finiteNumber(rawNode.width, DEFAULT_NODE_W), MIN_NODE_W);
    const h = clampMin(finiteNumber(rawNode.height, DEFAULT_NODE_H), MIN_NODE_H);

    const content = typeof rawNode.content === 'string' ? rawNode.content : safeString(rawNode.content);

    const node = {
      kind: 'text',
      id: nodeId,
      title: author === 'user' ? 'User' : 'Assistant',
      parentId,
      rect: { x, y, w, h },
      author,
      content,
    };

    if (rawNode.userPreface && typeof rawNode.userPreface === 'object') {
      const replyTo = safeString(rawNode.userPreface.replyTo).trim();
      const contexts = normalizeFolderPath(rawNode.userPreface.contexts);
      const next = {};
      if (replyTo) next.replyTo = replyTo;
      if (contexts.length) next.contexts = contexts;
      if (Object.keys(next).length) node.userPreface = next;
    }

    if (rawNode.isEditable) node.isEditNode = true;

    const modelId = safeString(rawNode.model).trim();
    if (modelId) node.modelId = modelId;

    if (Object.prototype.hasOwnProperty.call(rawNode, 'apiRequest')) node.apiRequest = rawNode.apiRequest;
    if (Object.prototype.hasOwnProperty.call(rawNode, 'apiResponse')) node.apiResponse = rawNode.apiResponse;

    if (rawNode.canonicalMessage && typeof rawNode.canonicalMessage === 'object') node.canonicalMessage = rawNode.canonicalMessage;
    if (rawNode.canonicalMeta && typeof rawNode.canonicalMeta === 'object') node.canonicalMeta = rawNode.canonicalMeta;

    if (Array.isArray(rawNode.selectedAttachmentKeys)) {
      const keys = rawNode.selectedAttachmentKeys.map((k) => safeString(k).trim()).filter(Boolean);
      if (keys.length) node.selectedAttachmentKeys = keys;
    }

    if (Array.isArray(rawNode.attachments)) {
      const atts = rawNode.attachments.map(convertAttachment).filter(Boolean);
      if (atts.length) node.attachments = atts;
    }

    out.push(node);
  }
  return out;
}

function convertArchive(input, opts) {
  if (!input || typeof input !== 'object') throw new Error('Input is not an object');

  const schemaVersion = Number(input.schemaVersion ?? NaN);
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error('Unsupported graphchatgem archive schemaVersion');

  const chats = Array.isArray(input.chats) ? input.chats : [];
  if (!chats.length) throw new Error('Input archive has no chats');

  const fsBlock = input.fs && typeof input.fs === 'object' ? input.fs : null;
  const app = input.app && typeof input.app === 'object' ? input.app : null;
  const exportedAt = typeof input.exportedAt === 'string' ? input.exportedAt : new Date().toISOString();

  const backgroundMode = opts?.background ?? 'first';
  const bg = input.background && typeof input.background === 'object' ? input.background : null;
  const bgData = bg && typeof bg.image === 'string' ? bg.image : '';
  const bgMimeType = bg && typeof bg.mimeType === 'string' ? bg.mimeType : '';
  const hasBackgroundImage = Boolean(bgData);

  const outChats = [];
  let includedBackgroundCount = 0;

  for (const chat of chats) {
    if (!chat || typeof chat !== 'object') continue;

    const chatId = safeString(chat.id).trim();
    const name = safeString(chat.name).trim() || 'Imported chat';
    const folderPath = computeFolderPathForChat(chat, fsBlock);

    const viewport = chat.viewport && typeof chat.viewport === 'object' ? chat.viewport : null;
    const camera = {
      x: finiteNumber(viewport?.x, 0),
      y: finiteNumber(viewport?.y, 0),
      zoom: finiteNumber(viewport?.zoom, 1),
    };

    const nodes = convertChatNodes(chat.nodes);

    const outChat = {
      id: chatId || undefined,
      name,
      ...(folderPath.length ? { folderPath } : {}),
      state: {
        camera,
        nodes,
        worldInkStrokes: [],
      },
    };

    if (hasBackgroundImage) {
      const want =
        backgroundMode === 'all' ? true : backgroundMode === 'first' ? includedBackgroundCount === 0 : false;
      if (want) {
        outChat.background = {
          name: 'Background',
          mimeType: bgMimeType || 'image/png',
          data: bgData,
        };
        includedBackgroundCount += 1;
      }
    }

    outChats.push(outChat);
  }

  if (!outChats.length) throw new Error('No chats converted');

  return {
    format: 'graphchatv1',
    schemaVersion: 2,
    exportedAt,
    ...(app ? { app } : {}),
    chats: outChats,
  };
}

function deriveOutputPath(inputPath) {
  const p = String(inputPath ?? '');
  if (p.endsWith('.graphchat.json')) return p.replace(/\.graphchat\.json$/, '.graphchatv1.json');
  if (p.endsWith('.json')) return p.replace(/\.json$/, '.graphchatv1.json');
  return `${p}.graphchatv1.json`;
}

function parseCli(argv) {
  const out = { inputPath: '', outputPath: '', background: 'first', help: false };
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      out.help = true;
      continue;
    }
    if (arg === '--background') {
      const v = argv[i + 1];
      i += 1;
      out.background = safeString(v).trim();
      continue;
    }
    if (arg.startsWith('--background=')) {
      out.background = arg.slice('--background='.length).trim();
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    pos.push(arg);
  }

  out.inputPath = safeString(pos[0]).trim();
  out.outputPath = safeString(pos[1]).trim();

  if (!out.inputPath && !out.help) throw new Error('Missing input file');
  if (pos.length > 2) throw new Error('Too many positional arguments');

  const bg = out.background;
  if (bg !== 'none' && bg !== 'first' && bg !== 'all') throw new Error(`Invalid --background value: ${bg}`);

  return out;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    usage();
    return;
  }

  const inputPath = cli.inputPath;
  const outputPath = cli.outputPath || deriveOutputPath(inputPath);

  const absIn = path.resolve(process.cwd(), inputPath);
  const absOut = path.resolve(process.cwd(), outputPath);

  const text = await fs.readFile(absIn, 'utf8');
  let inputJson;
  try {
    inputJson = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${err?.message || String(err)}`);
  }

  const converted = convertArchive(inputJson, { background: cli.background });
  await fs.writeFile(absOut, `${JSON.stringify(converted, null, 2)}\n`, 'utf8');

  const chats = Array.isArray(converted.chats) ? converted.chats : [];
  const nodeCount = chats.reduce((sum, c) => sum + (Array.isArray(c?.state?.nodes) ? c.state.nodes.length : 0), 0);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${absOut} (${chats.length} chat(s), ${nodeCount} node(s))`);
}

try {
  await main();
} catch (err) {
  fail(err?.message || String(err));
}

