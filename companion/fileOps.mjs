import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { readdir, lstat, mkdir, rename, copyFile, unlink, rmdir } from 'node:fs/promises';
import { ToolError } from '../tools/errors.mjs';
import { containsPath } from '../tools/pathGuard.mjs';
import { assertPathPolicy, isLocalOnly } from '../safety/pathRules.mjs';
import { classify } from '../search/ranking.mjs';

const RESERVED_WIN_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function assertSafeSimpleName(name, blockedExtensions = new Set(), { allowExtensionless = false } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120) {
    throw new ToolError('INVALID_PATH', 'Provide a valid name between 1 and 120 characters.');
  }
  const clean = name.trim();
  if (clean === '.' || clean === '..' || clean.includes('..')) {
    throw new ToolError('PATH_TRAVERSAL', 'Names cannot contain parent-directory traversal.');
  }
  if (/[\x00-\x1f<>"|?*:\/\\]/.test(clean)) {
    throw new ToolError('INVALID_PATH', 'Names cannot contain folder separators, wildcards, or control characters.');
  }
  if (/[. ]$/.test(clean)) {
    throw new ToolError('INVALID_PATH', 'Names cannot end with a trailing dot or space.');
  }
  if (RESERVED_WIN_NAMES.test(clean)) {
    throw new ToolError('INVALID_PATH', 'Reserved Windows device names are not allowed.');
  }
  if (!allowExtensionless) {
    const ext = path.extname(clean).toLowerCase();
    if (!ext) {
      throw new ToolError('BLOCKED_EXTENSION', 'Files must keep an approved file extension.');
    }
    if (blockedExtensions.has(ext)) {
      throw new ToolError('BLOCKED_EXTENSION', `Executable or blocked extension "${ext}" is not permitted.`);
    }
  }
  return clean;
}

export function assertSafeSubFolder(subFolder, blockedExtensions = new Set()) {
  if (subFolder === undefined || subFolder === null || subFolder === '') return [];
  if (typeof subFolder !== 'string' || subFolder.length > 160) {
    throw new ToolError('INVALID_PATH', 'Subfolder path is invalid or too long.');
  }
  const parts = subFolder.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.length > 2) {
    throw new ToolError('INVALID_PATH', 'Subfolder must contain at most 2 relative folder levels.');
  }
  return parts.map((segment) => assertSafeSimpleName(segment, blockedExtensions, { allowExtensionless: true }));
}

function assertItemUnchanged(item, statInfo) {
  if (
    statInfo.mtimeMs !== item.mtimeMs ||
    (!item.isDirectory && statInfo.size !== item.size) ||
    statInfo.ino !== item.ino ||
    statInfo.dev !== item.dev
  ) {
    throw new ToolError('FILE_CHANGED', 'That file changed on disk since the last scan. Search again before modifying it.');
  }
}

async function ensureNotExists(targetPath) {
  try {
    await lstat(targetPath);
    throw new ToolError('FILE_EXISTS', 'A file or folder already exists at the destination. Existing items will not be overwritten.');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
}

async function safeUpdateIndex(files, { removePath, upsertPath } = {}) {
  try {
    if (!files?.index?.initialized) return;
    if (removePath) await files.index.remove(removePath);
    if (upsertPath) await files.index.upsert(upsertPath);
  } catch {
    // Index reconciliation catches up asynchronously
  }
}

async function walkAuthorizedFiles(files, roots, { maxScanEntries = 5000 } = {}) {
  const entries = [];
  let truncated = false;
  let scanned = 0;

  for (const root of roots) {
    let checkedRoot;
    try {
      checkedRoot = await files.guard.inspect(root.path, { directory: true });
    } catch {
      continue;
    }
    const queue = [checkedRoot.path];
    while (queue.length) {
      if (scanned >= maxScanEntries) {
        truncated = true;
        break;
      }
      const dirPath = queue.shift();
      let dirEntries;
      try {
        dirEntries = await readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of dirEntries) {
        if (scanned >= maxScanEntries) {
          truncated = true;
          break;
        }
        scanned += 1;
        const full = path.join(dirPath, entry.name);
        if (entry.isSymbolicLink()) continue;
        try {
          if (files.guard.storageRoots?.some((sr) => containsPath(sr, full))) continue;
          assertPathPolicy(full, files.guard.security);
          const info = await lstat(full);
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) {
            queue.push(full);
          } else if (info.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (files.guard.blocked.has(ext)) continue;
            const relDir = path.relative(checkedRoot.path, dirPath) || '.';
            entries.push({
              path: full,
              name: entry.name,
              folder: dirPath,
              rootId: root.id,
              driveId: path.parse(full).root.slice(0, 2).toUpperCase(),
              extension: ext,
              fileType: classify(ext),
              isDirectory: false,
              size: info.size,
              mtimeMs: info.mtimeMs,
              ino: info.ino,
              dev: info.dev,
              createdAt: new Date(info.birthtimeMs || info.mtimeMs).toISOString(),
              modifiedAt: new Date(info.mtimeMs).toISOString(),
              relativeFolder: relDir,
              localOnly: isLocalOnly(full, files.guard.security)
            });
          }
        } catch {
          // Skip protected/excluded/unreadable entries cleanly
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  return { entries, scanned, truncated };
}

export async function scanLargeFiles(files, session, { folder, minSizeBytes = 5 * 1024 * 1024, limit = 15, maxScanEntries = 5000 } = {}) {
  files.requireEnabled();
  const roots = await files.guard.folders(folder);
  const { entries, scanned, truncated } = await walkAuthorizedFiles(files, roots, { maxScanEntries });
  const large = entries
    .filter((e) => e.size >= minSizeBytes)
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((e) => ({ ...e, matchReason: `Large file (${e.size} bytes)` }));

  const registered = large.length ? files.results.put(session, large) : [];
  return {
    totalScanned: scanned,
    truncated,
    minSizeBytes,
    files: registered.map((r, idx) => ({
      resultId: r.resultId,
      ordinal: r.ordinal,
      name: r.name,
      rootId: r.rootId,
      relativeFolder: large[idx].relativeFolder,
      sizeBytes: r.size,
      modifiedAt: r.modifiedAt
    }))
  };
}

export async function scanDuplicateFiles(
  files,
  session,
  { folder, nameFilter, extensions, minSizeBytes = 1, maxFiles = 500, maxFileBytes = 100 * 1024 * 1024, maxScanEntries = 5000 } = {}
) {
  files.requireEnabled();
  const roots = await files.guard.folders(folder);
  const { entries, scanned, truncated } = await walkAuthorizedFiles(files, roots, { maxScanEntries });

  const filterNeedle = nameFilter ? String(nameFilter).trim().toLowerCase() : '';
  const extSet = Array.isArray(extensions) && extensions.length
    ? new Set(extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)))
    : null;

  const filtered = entries.filter((e) => {
    if (e.size < minSizeBytes || e.size > maxFileBytes) return false;
    if (filterNeedle && !e.name.toLowerCase().includes(filterNeedle)) return false;
    if (extSet && !extSet.has(e.extension)) return false;
    return true;
  });

  const bySize = new Map();
  for (const item of filtered) {
    if (!bySize.has(item.size)) bySize.set(item.size, []);
    bySize.get(item.size).push(item);
  }

  const sizeCandidates = [];
  for (const list of bySize.values()) {
    if (list.length >= 2) {
      for (const item of list) {
        if (sizeCandidates.length >= maxFiles) break;
        sizeCandidates.push(item);
      }
    }
    if (sizeCandidates.length >= maxFiles) break;
  }

  const byHash = new Map();
  for (const candidate of sizeCandidates) {
    try {
      const digest = await computeFileSha256(candidate.path);
      const key = `${candidate.size}:${digest}`;
      if (!byHash.has(key)) byHash.set(key, { digest, size: candidate.size, items: [] });
      byHash.get(key).items.push({ ...candidate, matchReason: `Duplicate SHA-256 (${digest.slice(0, 12)})` });
    } catch {
      // Skip files that disappeared during scan
    }
  }

  const dupGroups = [...byHash.values()].filter((g) => g.items.length >= 2);
  dupGroups.sort((a, b) => b.size * (b.items.length - 1) - a.size * (a.items.length - 1));

  const flattened = dupGroups.flatMap((g) => g.items);
  const registered = flattened.length ? files.results.put(session, flattened) : [];
  const regByPath = new Map(flattened.map((item, idx) => [item.path, registered[idx]]));

  let duplicateFileCount = 0;
  let totalWastedBytes = 0;
  const groups = dupGroups.map((g) => {
    duplicateFileCount += g.items.length;
    const wastedBytes = g.size * (g.items.length - 1);
    totalWastedBytes += wastedBytes;
    return {
      hashPrefix: g.digest.slice(0, 12),
      sizeBytes: g.size,
      wastedBytes,
      count: g.items.length,
      files: g.items.map((item) => {
        const reg = regByPath.get(item.path);
        return {
          resultId: reg.resultId,
          name: item.name,
          rootId: item.rootId,
          relativeFolder: item.relativeFolder,
          modifiedAt: item.modifiedAt
        };
      })
    };
  });

  return {
    readOnly: true,
    deletedCount: 0,
    totalScanned: scanned,
    truncated,
    groupCount: groups.length,
    duplicateFileCount,
    totalWastedBytes,
    groups
  };
}

export async function executeCreateDirectory(files, destCap, { folder, directoryName }) {
  const revalidated = await files.guard.revalidate(destCap);
  await ensureNotExists(revalidated.path);
  try {
    await mkdir(revalidated.path, { recursive: false });
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new ToolError('FILE_EXISTS', 'That folder already exists.');
    }
    throw err;
  }
  const dirStat = await lstat(revalidated.path);
  const roots = await files.guard.folders(folder);
  const rootId = roots[0]?.id || folder;
  await safeUpdateIndex(files, { upsertPath: revalidated.path });
  return {
    publicResult: {
      status: 'created',
      rootId,
      directoryName,
      verified: dirStat.isDirectory()
    },
    undoRecord: {
      actionType: 'create_directory',
      undoAvailable: true,
      summary: `Created folder "${directoryName}" in ${rootId}`,
      payload: {
        path: revalidated.path,
        rootId,
        directoryName
      }
    }
  };
}

export async function executeRenameFile(files, session, srcCap, destCap, { resultId, newName }) {
  const item = files.results.get(session, resultId);
  const src = await files.guard.revalidate(srcCap, { opening: false, directory: false });
  assertItemUnchanged(item, src.stat);
  const dest = await files.guard.revalidate(destCap);
  await ensureNotExists(dest.path);

  await rename(src.path, dest.path);
  await safeUpdateIndex(files, { removePath: src.path, upsertPath: dest.path });

  return {
    publicResult: {
      status: 'renamed',
      rootId: item.rootId,
      oldName: item.name,
      newName,
      verified: true
    },
    undoRecord: {
      actionType: 'rename_file',
      undoAvailable: true,
      summary: `Renamed "${item.name}" to "${newName}" in ${item.rootId}`,
      payload: {
        fromPath: src.path,
        toPath: dest.path,
        originalName: item.name,
        newName,
        rootId: item.rootId
      }
    }
  };
}

export async function executeMoveFile(files, session, srcCap, destCap, { resultId, targetFolder, subFolder }) {
  const item = files.results.get(session, resultId);
  const src = await files.guard.revalidate(srcCap, { opening: false, directory: false });
  assertItemUnchanged(item, src.stat);
  const dest = await files.guard.revalidate(destCap);
  await mkdir(path.dirname(dest.path), { recursive: true });
  await ensureNotExists(dest.path);

  try {
    await rename(src.path, dest.path);
  } catch (err) {
    if (err.code === 'EXDEV') {
      const srcHash = await computeFileSha256(src.path);
      await copyFile(src.path, dest.path, fsConstants.COPYFILE_EXCL);
      const destHash = await computeFileSha256(dest.path);
      if (srcHash !== destHash) {
        await unlink(dest.path).catch(() => {});
        throw new ToolError('OPERATION_FAILED', 'Cross-volume move checksum verification failed.');
      }
      await unlink(src.path);
    } else {
      throw err;
    }
  }

  await safeUpdateIndex(files, { removePath: src.path, upsertPath: dest.path });
  const roots = await files.guard.folders(targetFolder);
  const destRootId = roots[0]?.id || targetFolder;
  const relativeTarget = subFolder ? `${destRootId}/${subFolder}` : destRootId;

  return {
    publicResult: {
      status: 'moved',
      fileName: item.name,
      sourceRootId: item.rootId,
      targetRootId: destRootId,
      subFolder: subFolder || '',
      verified: true
    },
    undoRecord: {
      actionType: 'move_file',
      undoAvailable: true,
      summary: `Moved "${item.name}" from ${item.rootId} to ${relativeTarget}`,
      payload: {
        fromPath: src.path,
        toPath: dest.path,
        fileName: item.name,
        sourceRootId: item.rootId,
        targetRootId: destRootId,
        subFolder: subFolder || ''
      }
    }
  };
}

export async function executeCopyFile(files, session, srcCap, destCap, { resultId, targetFolder, subFolder, newName }) {
  const item = files.results.get(session, resultId);
  const src = await files.guard.revalidate(srcCap, { opening: false, directory: false });
  assertItemUnchanged(item, src.stat);
  const dest = await files.guard.revalidate(destCap);
  await mkdir(path.dirname(dest.path), { recursive: true });
  await ensureNotExists(dest.path);

  await copyFile(src.path, dest.path, fsConstants.COPYFILE_EXCL);
  const sha256 = await computeFileSha256(dest.path);
  const destInfo = await lstat(dest.path);
  await safeUpdateIndex(files, { upsertPath: dest.path });

  const roots = await files.guard.folders(targetFolder);
  const destRootId = roots[0]?.id || targetFolder;
  const finalName = newName || item.name;
  const relativeTarget = subFolder ? `${destRootId}/${subFolder}/${finalName}` : `${destRootId}/${finalName}`;

  return {
    publicResult: {
      status: 'copied',
      fileName: finalName,
      targetRootId: destRootId,
      sizeBytes: destInfo.size,
      verified: true
    },
    undoRecord: {
      actionType: 'copy_file',
      undoAvailable: true,
      summary: `Copied "${item.name}" to ${relativeTarget}`,
      payload: {
        fromPath: src.path,
        toPath: dest.path,
        sha256,
        fileName: finalName,
        targetRootId: destRootId
      }
    }
  };
}

export async function executeRecycleFile(files, session, srcCap, { resultId, sendToRecycleBin }) {
  const item = files.results.get(session, resultId);
  const src = await files.guard.revalidate(srcCap, { opening: false, directory: false });
  assertItemUnchanged(item, src.stat);
  await sendToRecycleBin(src.path);
  await safeUpdateIndex(files, { removePath: src.path });

  return {
    publicResult: {
      status: 'recycled',
      fileName: item.name,
      rootId: item.rootId,
      undoAvailable: false,
      message: `Moved "${item.name}" to the Windows Recycle Bin. Restore it from File Explorer Recycle Bin if needed.`
    },
    undoRecord: {
      actionType: 'recycle_file',
      undoAvailable: false,
      status: 'not_undoable',
      summary: `Moved "${item.name}" in ${item.rootId} to Windows Recycle Bin`,
      payload: {
        fromPath: src.path,
        fileName: item.name,
        rootId: item.rootId
      }
    }
  };
}

export async function executeUndoAction(files, record) {
  if (!record) {
    throw new ToolError('ACTION_NOT_FOUND', 'Reversible action record not found.');
  }
  if (record.status === 'undone') {
    throw new ToolError('UNDO_PRECONDITION_FAILED', 'This action was already undone.');
  }
  if (!record.undoAvailable || record.actionType === 'recycle_file') {
    throw new ToolError('NOT_UNDOABLE', 'Items moved to the Windows Recycle Bin must be restored from File Explorer Recycle Bin.');
  }

  const p = record.payload || {};
  if (record.actionType === 'create_directory') {
    const dirCap = await files.guard.inspect(p.path, { directory: true });
    const contents = await readdir(dirCap.path);
    if (contents.length > 0) {
      throw new ToolError('UNDO_PRECONDITION_FAILED', 'Cannot undo folder creation because the folder is no longer empty.');
    }
    await rmdir(dirCap.path);
    await safeUpdateIndex(files, { removePath: dirCap.path });
    return { status: 'undone', actionId: record.id, actionType: record.actionType, summary: `Removed empty folder "${p.directoryName}" from ${p.rootId}.` };
  }

  if (record.actionType === 'rename_file' || record.actionType === 'move_file') {
    const currentCap = await files.guard.inspect(p.toPath, { opening: false, directory: false });
    let destCap;
    try {
      destCap = await files.guard.destination(p.fromPath);
    } catch (err) {
      if (err.code === 'INVALID_FILE') {
        throw new ToolError('FILE_EXISTS', 'A file already exists at the original path.');
      }
      throw err;
    }
    await ensureNotExists(destCap.path);
    await rename(currentCap.path, destCap.path);
    await safeUpdateIndex(files, { removePath: currentCap.path, upsertPath: destCap.path });
    return {
      status: 'undone',
      actionId: record.id,
      actionType: record.actionType,
      summary: `Restored "${p.originalName || p.fileName}" back to its original location.`
    };
  }

  if (record.actionType === 'copy_file') {
    const copyCap = await files.guard.inspect(p.toPath, { opening: false, directory: false });
    const currentHash = await computeFileSha256(copyCap.path);
    if (currentHash !== p.sha256) {
      throw new ToolError('UNDO_PRECONDITION_FAILED', 'Cannot undo copy because the copied file has been modified since creation.');
    }
    await unlink(copyCap.path);
    await safeUpdateIndex(files, { removePath: copyCap.path });
    return {
      status: 'undone',
      actionId: record.id,
      actionType: record.actionType,
      summary: `Removed unmodified copy "${p.fileName}" from ${p.targetRootId}.`
    };
  }

  throw new ToolError('NOT_UNDOABLE', `Undo is not supported for action type "${record.actionType}".`);
}
