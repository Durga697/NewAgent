import path from 'node:path';
import { ToolError } from './errors.mjs';
import { requirePermit } from '../safety/policy.mjs';
import {
  assertSafeSimpleName,
  assertSafeSubFolder,
  scanLargeFiles,
  scanDuplicateFiles,
  executeCreateDirectory,
  executeRenameFile,
  executeMoveFile,
  executeCopyFile,
  executeRecycleFile,
  executeUndoAction
} from '../companion/fileOps.mjs';

function requireCompanion(context, scope = null) {
  if (!context?.companion) {
    throw new ToolError('COMPANION_DISABLED', 'Windows companion service is unavailable in this environment.');
  }
  return context.companion.requirePaired(context.ownerKey, scope);
}

function previewFileLookup(context, resultId) {
  context?.files?.requireEnabled?.();
  return context.files.results.get(context.session, resultId);
}

function previewRootLookup(context, folderName) {
  context?.files?.requireEnabled?.();
  const matched = (context.files.config.roots || []).find(
    (r) => r.id.toLowerCase() === String(folderName || '').trim().toLowerCase()
  );
  if (!matched) {
    throw new ToolError(
      'OUTSIDE_ALLOWLIST',
      `Folder "${folderName}" is not an authorized root. Authorized folders: ${(context.files.config.roots || []).map((r) => r.id).join(', ') || 'none'}.`
    );
  }
  return matched;
}

export const getSystemMetricsTool = {
  id: 'companion.get_system_metrics',
  name: 'get_system_metrics',
  description: 'Read live CPU, RAM, fixed disk storage, and battery status from the paired Windows PC.',
  parameters: {
    type: 'object',
    properties: {
      drive: { type: 'string', pattern: '^[A-Za-z]:?$' }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      collectedAt: { type: 'string' },
      hostname: { type: 'string' },
      platform: { type: 'string' },
      cpu: {
        type: 'object',
        properties: {
          cpuPercent: { type: 'number' },
          cpuCores: { type: 'integer' },
          cpuModel: { type: 'string' }
        },
        required: ['cpuPercent', 'cpuCores', 'cpuModel'],
        additionalProperties: false
      },
      memory: {
        type: 'object',
        properties: {
          totalBytes: { type: 'number' },
          freeBytes: { type: 'number' },
          usedBytes: { type: 'number' },
          usedPercent: { type: 'number' },
          totalGb: { type: 'number' },
          usedGb: { type: 'number' },
          freeGb: { type: 'number' }
        },
        required: ['totalBytes', 'freeBytes', 'usedBytes', 'usedPercent', 'totalGb', 'usedGb', 'freeGb'],
        additionalProperties: false
      },
      drives: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            drive: { type: 'string' },
            label: { type: 'string' },
            totalBytes: { type: 'number' },
            freeBytes: { type: 'number' },
            usedBytes: { type: 'number' },
            totalGb: { type: 'number' },
            freeGb: { type: 'number' },
            usedPercent: { type: 'number' }
          },
          required: ['drive', 'label', 'totalBytes', 'freeBytes', 'usedBytes', 'totalGb', 'freeGb', 'usedPercent'],
          additionalProperties: false
        }
      },
      battery: {
        type: 'object',
        properties: {
          supported: { type: 'boolean' },
          percent: { type: ['number', 'null'] },
          status: { type: 'string' },
          onAC: { type: ['boolean', 'null'] }
        },
        required: ['supported', 'percent', 'status', 'onAC'],
        additionalProperties: false
      }
    },
    required: ['collectedAt', 'hostname', 'platform', 'cpu', 'memory', 'drives', 'battery'],
    additionalProperties: false
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'get_system_metrics');
    requireCompanion(context, 'telemetry');
    const data = await context.companion.getMetrics(context.ownerKey, { drive: args.drive });
    context.companion.recordAction(context.ownerKey, {
      toolName: 'get_system_metrics',
      summary: `Checked system metrics (CPU ${data.cpu.cpuPercent}%, RAM ${data.memory.usedPercent}%${args.drive ? `, ${args.drive.toUpperCase()} drive` : ''}).`
    });
    return data;
  }
};

export const listRunningProcessesTool = {
  id: 'companion.list_running_processes',
  name: 'list_running_processes',
  description: 'List top running Windows applications sorted by RAM usage or CPU time from the paired PC.',
  parameters: {
    type: 'object',
    properties: {
      sortBy: { type: 'string', enum: ['memory', 'cpu'] },
      limit: { type: 'integer', minimum: 1, maximum: 25 }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      collectedAt: { type: 'string' },
      sortBy: { type: 'string' },
      processes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pid: { type: 'integer' },
            name: { type: 'string' },
            memoryMb: { type: 'number' },
            cpuSeconds: { type: 'number' }
          },
          required: ['pid', 'name', 'memoryMb', 'cpuSeconds'],
          additionalProperties: false
        }
      }
    },
    required: ['collectedAt', 'sortBy', 'processes'],
    additionalProperties: false
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'list_running_processes');
    requireCompanion(context, 'telemetry');
    const data = await context.companion.listProcesses(context.ownerKey, {
      sortBy: args.sortBy || 'memory',
      limit: args.limit || 10
    });
    context.companion.recordAction(context.ownerKey, {
      toolName: 'list_running_processes',
      summary: `Listed top ${data.processes.length} processes sorted by ${data.sortBy}.`
    });
    return data;
  }
};

export const listInstalledAppsTool = {
  id: 'companion.list_installed_apps',
  name: 'list_installed_apps',
  description: 'Check installation and permission status for curated approved Windows applications.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      apps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            displayName: { type: 'string' },
            category: { type: 'string' },
            installed: { type: 'boolean' },
            enabled: { type: 'boolean' }
          },
          required: ['appId', 'displayName', 'category', 'installed', 'enabled'],
          additionalProperties: false
        }
      }
    },
    required: ['apps'],
    additionalProperties: false
  },
  async run(context) {
    requirePermit(context.execution, context.session, 'list_installed_apps');
    requireCompanion(context, 'apps');
    const data = await context.companion.listApps(context.ownerKey);
    context.companion.recordAction(context.ownerKey, {
      toolName: 'list_installed_apps',
      summary: `Checked approved Windows applications (${data.apps.filter((a) => a.installed).length} installed).`
    });
    return data;
  }
};

export const launchApprovedAppTool = {
  id: 'companion.launch_approved_app',
  name: 'launch_approved_app',
  description: 'Launch an approved desktop application from the curated allowlist after explicit user confirmation.',
  parameters: {
    type: 'object',
    properties: {
      appId: { type: 'string', minLength: 1, maxLength: 40 }
    },
    required: ['appId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', const: 'launched' },
      appId: { type: 'string' },
      displayName: { type: 'string' },
      pid: { type: 'integer' },
      mock: { type: 'boolean' }
    },
    required: ['status', 'appId', 'displayName', 'mock'],
    additionalProperties: false
  },
  targetIds(args) {
    return [`app:${args.appId}`];
  },
  preview(args, context) {
    const pairing = requireCompanion(context, 'apps');
    const app = context.companion.findConfiguredApp(args.appId);
    if (!app) {
      throw new ToolError('APP_NOT_APPROVED', `Application "${args.appId}" is not in the approved applications catalog.`);
    }
    if ((pairing.disabledApps || []).includes(app.appId) || app.enabled === false) {
      throw new ToolError('APP_DISABLED', `${app.displayName} is disabled in companion permissions.`);
    }
    return `Launch approved application "${app.displayName}" (${app.appId}) on this paired Windows PC without arbitrary shell arguments.`;
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'launch_approved_app');
    requireCompanion(context, 'apps');
    const launched = await context.companion.launchApprovedApp(context.ownerKey, args.appId);
    context.companion.recordAction(context.ownerKey, {
      toolName: 'launch_approved_app',
      summary: `Launched approved application "${launched.displayName}".`
    });
    return {
      status: 'launched',
      appId: launched.appId,
      displayName: launched.displayName,
      ...(Number.isInteger(launched.pid) ? { pid: launched.pid } : {}),
      mock: Boolean(launched.mock)
    };
  }
};

export const findLargeFilesTool = {
  id: 'companion.find_large_files',
  name: 'find_large_files',
  description: 'Find the largest files in authorized local folders (read-only analysis).',
  parameters: {
    type: 'object',
    properties: {
      folder: { type: 'string', minLength: 1, maxLength: 120 },
      minSizeBytes: { type: 'integer', minimum: 1, maximum: 10737418240 },
      limit: { type: 'integer', minimum: 1, maximum: 50 }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      totalScanned: { type: 'integer' },
      truncated: { type: 'boolean' },
      minSizeBytes: { type: 'integer' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            resultId: { type: 'string' },
            ordinal: { type: 'integer' },
            name: { type: 'string' },
            rootId: { type: 'string' },
            relativeFolder: { type: 'string' },
            sizeBytes: { type: 'integer' },
            modifiedAt: { type: 'string' }
          },
          required: ['resultId', 'ordinal', 'name', 'rootId', 'relativeFolder', 'sizeBytes', 'modifiedAt'],
          additionalProperties: false
        }
      }
    },
    required: ['totalScanned', 'truncated', 'minSizeBytes', 'files'],
    additionalProperties: false
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'find_large_files');
    requireCompanion(context, 'fileAnalysis');
    const result = await scanLargeFiles(context.files, context.session, {
      folder: args.folder,
      minSizeBytes: args.minSizeBytes ?? context.companion.config.largeFileMinBytes,
      limit: args.limit ?? 15,
      maxScanEntries: context.companion.config.maxScanEntries
    });
    context.companion.recordAction(context.ownerKey, {
      toolName: 'find_large_files',
      summary: `Scanned ${result.totalScanned} file(s); found ${result.files.length} large file(s).`
    });
    return result;
  }
};

export const findDuplicateFilesTool = {
  id: 'companion.find_duplicate_files',
  name: 'find_duplicate_files',
  description: 'Detect exact duplicate file candidates via SHA-256 hashing inside authorized folders. Strictly read-only; never deletes any file.',
  parameters: {
    type: 'object',
    properties: {
      folder: { type: 'string', minLength: 1, maxLength: 120 },
      nameFilter: { type: 'string', minLength: 1, maxLength: 80 },
      extensions: {
        type: 'array',
        maxItems: 15,
        items: { type: 'string', pattern: '^\\.?[A-Za-z0-9]{1,10}$' }
      },
      minSizeBytes: { type: 'integer', minimum: 1, maximum: 1073741824 }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      readOnly: { type: 'boolean', const: true },
      deletedCount: { type: 'integer', const: 0 },
      totalScanned: { type: 'integer' },
      truncated: { type: 'boolean' },
      groupCount: { type: 'integer' },
      duplicateFileCount: { type: 'integer' },
      totalWastedBytes: { type: 'integer' },
      groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hashPrefix: { type: 'string' },
            sizeBytes: { type: 'integer' },
            wastedBytes: { type: 'integer' },
            count: { type: 'integer' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  resultId: { type: 'string' },
                  name: { type: 'string' },
                  rootId: { type: 'string' },
                  relativeFolder: { type: 'string' },
                  modifiedAt: { type: 'string' }
                },
                required: ['resultId', 'name', 'rootId', 'relativeFolder', 'modifiedAt'],
                additionalProperties: false
              }
            }
          },
          required: ['hashPrefix', 'sizeBytes', 'wastedBytes', 'count', 'files'],
          additionalProperties: false
        }
      }
    },
    required: ['readOnly', 'deletedCount', 'totalScanned', 'truncated', 'groupCount', 'duplicateFileCount', 'totalWastedBytes', 'groups'],
    additionalProperties: false
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'find_duplicate_files');
    requireCompanion(context, 'fileAnalysis');
    const result = await scanDuplicateFiles(context.files, context.session, {
      folder: args.folder,
      nameFilter: args.nameFilter,
      extensions: args.extensions,
      minSizeBytes: args.minSizeBytes ?? 1,
      maxFiles: context.companion.config.duplicateMaxFiles,
      maxFileBytes: context.companion.config.duplicateMaxFileBytes,
      maxScanEntries: context.companion.config.maxScanEntries
    });
    context.companion.recordAction(context.ownerKey, {
      toolName: 'find_duplicate_files',
      summary: `Found ${result.groupCount} duplicate group(s) (${result.duplicateFileCount} files, read-only, 0 deleted).`
    });
    return result;
  }
};

export const createDirectoryTool = {
  id: 'companion.create_directory',
  name: 'create_directory',
  description: 'Create a new directory inside an authorized root folder after user confirmation.',
  parameters: {
    type: 'object',
    properties: {
      folder: { type: 'string', minLength: 1, maxLength: 120 },
      directoryName: { type: 'string', minLength: 1, maxLength: 120 }
    },
    required: ['folder', 'directoryName'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', const: 'created' },
      actionId: { type: 'string' },
      rootId: { type: 'string' },
      directoryName: { type: 'string' },
      verified: { type: 'boolean', const: true },
      undoAvailable: { type: 'boolean', const: true }
    },
    required: ['status', 'actionId', 'rootId', 'directoryName', 'verified', 'undoAvailable'],
    additionalProperties: false
  },
  targetIds(args) {
    return [`${args.folder}/${args.directoryName}`];
  },
  preview(args, context) {
    requireCompanion(context, 'fileMutations');
    const root = previewRootLookup(context, args.folder);
    const cleanDir = assertSafeSimpleName(args.directoryName, context.files.guard.blocked, { allowExtensionless: true });
    return `Create new folder "${cleanDir}" inside authorized root "${root.id}". Reversible while empty.`;
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'create_directory');
    requireCompanion(context, 'fileMutations');
    context.files.requireEnabled();
    const destCap = context.validatedPaths?.[0];
    if (!destCap) throw new ToolError('PATH_DENIED', 'Validated directory destination required.');
    const { publicResult, undoRecord } = await executeCreateDirectory(context.files, destCap, args);
    const saved = context.companion.recordReversibleAction(context.ownerKey, undoRecord);
    context.companion.recordAction(context.ownerKey, {
      toolName: 'create_directory',
      summary: undoRecord.summary
    });
    return { ...publicResult, actionId: saved.id, undoAvailable: true };
  }
};

export const renameFileTool = {
  id: 'companion.rename_file',
  name: 'rename_file',
  description: 'Rename an authorized file result within its current directory after explicit confirmation.',
  parameters: {
    type: 'object',
    properties: {
      resultId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      newName: { type: 'string', minLength: 1, maxLength: 120 }
    },
    required: ['resultId', 'newName'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', const: 'renamed' },
      actionId: { type: 'string' },
      rootId: { type: 'string' },
      oldName: { type: 'string' },
      newName: { type: 'string' },
      verified: { type: 'boolean', const: true },
      undoAvailable: { type: 'boolean', const: true }
    },
    required: ['status', 'actionId', 'rootId', 'oldName', 'newName', 'verified', 'undoAvailable'],
    additionalProperties: false
  },
  targetIds(args) {
    return [args.resultId];
  },
  preview(args, context) {
    requireCompanion(context, 'fileMutations');
    const item = previewFileLookup(context, args.resultId);
    const cleanNew = assertSafeSimpleName(args.newName, context.files.guard.blocked);
    return `Rename "${item.name}" in ${item.rootId} to "${cleanNew}" without overwriting existing files.`;
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'rename_file');
    requireCompanion(context, 'fileMutations');
    context.files.requireEnabled();
    const [srcCap, destCap] = context.validatedPaths || [];
    if (!srcCap || !destCap) throw new ToolError('PATH_DENIED', 'Validated source and destination paths are required.');
    const { publicResult, undoRecord } = await executeRenameFile(context.files, context.session, srcCap, destCap, args);
    const saved = context.companion.recordReversibleAction(context.ownerKey, undoRecord);
    context.companion.recordAction(context.ownerKey, {
      toolName: 'rename_file',
      summary: undoRecord.summary
    });
    return { ...publicResult, actionId: saved.id, undoAvailable: true };
  }
};

export const moveFileTool = {
  id: 'companion.move_file',
  name: 'move_file',
  description: 'Move an authorized file result to another authorized folder (or safe subfolder) after confirmation.',
  parameters: {
    type: 'object',
    properties: {
      resultId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      targetFolder: { type: 'string', minLength: 1, maxLength: 120 },
      subFolder: { type: 'string', maxLength: 160 }
    },
    required: ['resultId', 'targetFolder'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', const: 'moved' },
      actionId: { type: 'string' },
      fileName: { type: 'string' },
      sourceRootId: { type: 'string' },
      targetRootId: { type: 'string' },
      subFolder: { type: 'string' },
      verified: { type: 'boolean', const: true },
      undoAvailable: { type: 'boolean', const: true }
    },
    required: ['status', 'actionId', 'fileName', 'sourceRootId', 'targetRootId', 'subFolder', 'verified', 'undoAvailable'],
    additionalProperties: false
  },
  targetIds(args) {
    return [args.resultId];
  },
  preview(args, context) {
    requireCompanion(context, 'fileMutations');
    const item = previewFileLookup(context, args.resultId);
    const root = previewRootLookup(context, args.targetFolder);
    const subParts = assertSafeSubFolder(args.subFolder, context.files.guard.blocked);
    const destDisplay = subParts.length ? `${root.id}/${subParts.join('/')}` : root.id;
    return `Move "${item.name}" from ${item.rootId} to "${destDisplay}" without overwriting existing files.`;
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'move_file');
    requireCompanion(context, 'fileMutations');
    context.files.requireEnabled();
    const [srcCap, destCap] = context.validatedPaths || [];
    if (!srcCap || !destCap) throw new ToolError('PATH_DENIED', 'Validated source and destination paths are required.');
    const { publicResult, undoRecord } = await executeMoveFile(context.files, context.session, srcCap, destCap, args);
    const saved = context.companion.recordReversibleAction(context.ownerKey, undoRecord);
    context.companion.recordAction(context.ownerKey, {
      toolName: 'move_file',
      summary: undoRecord.summary
    });
    return { ...publicResult, actionId: saved.id, undoAvailable: true };
  }
};

export const copyFileTool = {
  id: 'companion.copy_file',
  name: 'copy_file',
  description: 'Copy an authorized file result into an authorized destination without overwriting existing files.',
  parameters: {
    type: 'object',
    properties: {
      resultId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      targetFolder: { type: 'string', minLength: 1, maxLength: 120 },
      subFolder: { type: 'string', maxLength: 160 },
      newName: { type: 'string', minLength: 1, maxLength: 120 }
    },
    required: ['resultId', 'targetFolder'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', const: 'copied' },
      actionId: { type: 'string' },
      fileName: { type: 'string' },
      targetRootId: { type: 'string' },
      sizeBytes: { type: 'integer' },
      verified: { type: 'boolean', const: true },
      undoAvailable: { type: 'boolean', const: true }
    },
    required: ['status', 'actionId', 'fileName', 'targetRootId', 'sizeBytes', 'verified', 'undoAvailable'],
    additionalProperties: false
  },
  targetIds(args) {
    return [args.resultId];
  },
  preview(args, context) {
    requireCompanion(context, 'fileMutations');
    const item = previewFileLookup(context, args.resultId);
    const root = previewRootLookup(context, args.targetFolder);
    const subParts = assertSafeSubFolder(args.subFolder, context.files.guard.blocked);
    const finalName = args.newName ? assertSafeSimpleName(args.newName, context.files.guard.blocked) : item.name;
    const destDisplay = subParts.length ? `${root.id}/${subParts.join('/')}/${finalName}` : `${root.id}/${finalName}`;
    return `Copy "${item.name}" from ${item.rootId} to "${destDisplay}" without overwriting existing files.`;
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'copy_file');
    requireCompanion(context, 'fileMutations');
    context.files.requireEnabled();
    const [srcCap, destCap] = context.validatedPaths || [];
    if (!srcCap || !destCap) throw new ToolError('PATH_DENIED', 'Validated source and destination paths are required.');
    const { publicResult, undoRecord } = await executeCopyFile(context.files, context.session, srcCap, destCap, args);
    const saved = context.companion.recordReversibleAction(context.ownerKey, undoRecord);
    context.companion.recordAction(context.ownerKey, {
      toolName: 'copy_file',
      summary: undoRecord.summary
    });
    return { ...publicResult, actionId: saved.id, undoAvailable: true };
  }
};

export const recycleFileTool = {
  id: 'companion.recycle_file',
  name: 'recycle_file',
  description: 'Move a single authorized file result to the Windows Recycle Bin after explicit confirmation (never permanently deletes).',
  parameters: {
    type: 'object',
    properties: {
      resultId: { type: 'string', pattern: '^[a-f0-9]{64}$' }
    },
    required: ['resultId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', const: 'recycled' },
      actionId: { type: 'string' },
      fileName: { type: 'string' },
      rootId: { type: 'string' },
      undoAvailable: { type: 'boolean', const: false },
      message: { type: 'string' }
    },
    required: ['status', 'actionId', 'fileName', 'rootId', 'undoAvailable', 'message'],
    additionalProperties: false
  },
  targetIds(args) {
    return [args.resultId];
  },
  preview(args, context) {
    requireCompanion(context, 'fileMutations');
    const item = previewFileLookup(context, args.resultId);
    if (item.isDirectory) {
      throw new ToolError('INVALID_ARGUMENTS', 'Select an individual file to move to the Recycle Bin.');
    }
    return `Move "${item.name}" in ${item.rootId} to the Windows Recycle Bin (permanent deletion is disabled; restore from Recycle Bin if needed).`;
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'recycle_file');
    requireCompanion(context, 'fileMutations');
    context.files.requireEnabled();
    const srcCap = context.validatedPaths?.[0];
    if (!srcCap) throw new ToolError('PATH_DENIED', 'Validated source file path is required.');
    const { publicResult, undoRecord } = await executeRecycleFile(context.files, context.session, srcCap, {
      resultId: args.resultId,
      sendToRecycleBin: (validatedPath) => context.companion.recycleFilePath(context.ownerKey, validatedPath)
    });
    const saved = context.companion.recordReversibleAction(context.ownerKey, undoRecord);
    context.companion.recordAction(context.ownerKey, {
      toolName: 'recycle_file',
      summary: undoRecord.summary
    });
    return { ...publicResult, actionId: saved.id, undoAvailable: false };
  }
};

export const undoFileActionTool = {
  id: 'companion.undo_file_action',
  name: 'undo_file_action',
  description: 'Undo a supported reversible file action (rename, move, copy, or empty directory creation) after confirmation.',
  parameters: {
    type: 'object',
    properties: {
      actionId: { type: 'string', minLength: 8, maxLength: 80 }
    },
    required: ['actionId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', const: 'undone' },
      actionId: { type: 'string' },
      actionType: { type: 'string' },
      summary: { type: 'string' }
    },
    required: ['status', 'actionId', 'actionType', 'summary'],
    additionalProperties: false
  },
  targetIds(args) {
    return [args.actionId];
  },
  preview(args, context) {
    requireCompanion(context, 'fileMutations');
    const record = context.companion.getReversibleAction(context.ownerKey, args.actionId);
    if (!record) {
      throw new ToolError('ACTION_NOT_FOUND', 'Reversible action record was not found for this account.');
    }
    if (record.status === 'undone') {
      throw new ToolError('UNDO_PRECONDITION_FAILED', 'That action was already undone.');
    }
    if (!record.undoAvailable || record.actionType === 'recycle_file') {
      throw new ToolError('NOT_UNDOABLE', 'Items sent to Windows Recycle Bin must be restored from File Explorer Recycle Bin.');
    }
    return `Undo action "${record.summary}".`;
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'undo_file_action');
    requireCompanion(context, 'fileMutations');
    context.files.requireEnabled();
    const record = context.companion.getReversibleAction(context.ownerKey, args.actionId);
    const result = await executeUndoAction(context.files, record);
    context.companion.markActionUndone(context.ownerKey, record.id);
    context.companion.recordAction(context.ownerKey, {
      toolName: 'undo_file_action',
      summary: result.summary
    });
    return result;
  }
};

export const companionTools = [
  getSystemMetricsTool,
  listRunningProcessesTool,
  listInstalledAppsTool,
  launchApprovedAppTool,
  findLargeFilesTool,
  findDuplicateFilesTool,
  createDirectoryTool,
  renameFileTool,
  moveFileTool,
  copyFileTool,
  recycleFileTool,
  undoFileActionTool
];
