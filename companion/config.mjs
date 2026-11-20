import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import Ajv from 'ajv';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { ToolError } from '../tools/errors.mjs';

export const FORBIDDEN_APP_EXECUTABLES = Object.freeze(new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'regedit.exe',
  'rundll32.exe',
  'regsvr32.exe',
  'certutil.exe',
  'bitsadmin.exe',
  'msiexec.exe',
  'bash.exe',
  'wsl.exe',
  'schtasks.exe',
  'net.exe',
  'sc.exe'
]));

const ajv = new Ajv({ allErrors: true });

const companionSchema = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'enabled', 'approvedApps'],
  properties: {
    version: { type: 'integer', const: 1 },
    enabled: { type: 'boolean' },
    deviceName: { type: 'string', maxLength: 80 },
    largeFileMinBytes: { type: 'integer', minimum: 1024, maximum: 1073741824 },
    duplicateMaxFiles: { type: 'integer', minimum: 10, maximum: 5000 },
    duplicateMaxFileBytes: { type: 'integer', minimum: 1024, maximum: 1073741824 },
    maxScanEntries: { type: 'integer', minimum: 50, maximum: 50000 },
    approvedApps: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['appId', 'displayName', 'category', 'enabled', 'candidates'],
        properties: {
          appId: { type: 'string', pattern: '^[a-z0-9_-]{2,40}$' },
          displayName: { type: 'string', minLength: 1, maxLength: 80 },
          category: { type: 'string', minLength: 1, maxLength: 40 },
          enabled: { type: 'boolean' },
          candidates: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: { type: 'string', minLength: 4, maxLength: 400 }
          }
        }
      }
    }
  }
});

/**
 * Expand only fixed trusted Windows directory tokens in an approved app candidate template.
 */
export function expandTrustedAppPath(template, env = process.env) {
  if (typeof template !== 'string' || !template.trim()) {
    throw new ToolError('CONFIG_INVALID', 'Approved application path template cannot be empty.');
  }
  const tokens = {
    '${localAppData}': env.LOCALAPPDATA || path.win32.join(homedir(), 'AppData', 'Local'),
    '${programFiles}': env.ProgramFiles || 'C:\\Program Files',
    '${programFilesX86}': env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    '${systemRoot}': env.SystemRoot || env.windir || 'C:\\Windows',
    '${userProfile}': env.USERPROFILE || homedir()
  };

  let expanded = template.trim();
  for (const [token, base] of Object.entries(tokens)) {
    expanded = expanded.replaceAll(token, base);
  }
  if (/\$\{[^}]+\}/.test(expanded)) {
    throw new ToolError('CONFIG_INVALID', 'Approved application candidate uses an unsupported path variable.');
  }
  if (/^[\\/]{2}/.test(expanded)) {
    throw new ToolError('CONFIG_INVALID', 'UNC paths are forbidden for approved applications.');
  }
  if (expanded.split(/[\\/]/).includes('..')) {
    throw new ToolError('CONFIG_INVALID', 'Path traversal is forbidden in approved application paths.');
  }
  if (/[\x00-\x1f<>"|?*]/.test(expanded)) {
    throw new ToolError('CONFIG_INVALID', 'Invalid characters in approved application path.');
  }
  const normalized = path.win32.resolve(expanded);
  if (!path.win32.isAbsolute(normalized) || !normalized.toLowerCase().endsWith('.exe')) {
    throw new ToolError('CONFIG_INVALID', 'Approved application paths must resolve to an absolute .exe executable.');
  }
  const baseName = path.win32.basename(normalized).toLowerCase();
  if (FORBIDDEN_APP_EXECUTABLES.has(baseName)) {
    throw new ToolError('CONFIG_INVALID', `Shell or administrative executable "${baseName}" is forbidden in approvedApps.`);
  }
  return normalized;
}

/**
 * Load and validate EDITH Windows Companion configuration.
 */
export async function loadCompanionConfig(
  filename = process.env.EDITH_COMPANION_CONFIG || new URL('../config/companion.jsonc', import.meta.url),
  env = process.env
) {
  let raw;
  try {
    raw = await readFile(filename, 'utf8');
  } catch (err) {
    throw new ToolError('CONFIG_INVALID', `Unable to read companion configuration: ${err.message}`);
  }
  const errors = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new ToolError('CONFIG_INVALID', `Invalid companion configuration: ${printParseErrorCode(errors[0].error)}`);
  }
  if (!companionSchema(parsed)) {
    throw new ToolError(
      'CONFIG_INVALID',
      `Invalid companion configuration: ${companionSchema.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`
    );
  }

  const seenIds = new Set();
  const approvedApps = parsed.approvedApps.map((app) => {
    const idLower = app.appId.toLowerCase();
    if (seenIds.has(idLower)) {
      throw new ToolError('CONFIG_INVALID', `Duplicate approved application ID "${app.appId}".`);
    }
    seenIds.add(idLower);
    const resolvedCandidates = app.candidates.map((cand) => expandTrustedAppPath(cand, env));
    return {
      appId: app.appId,
      displayName: app.displayName,
      category: app.category,
      enabled: app.enabled,
      candidates: resolvedCandidates
    };
  });

  return {
    version: parsed.version,
    enabled: parsed.enabled,
    deviceName: parsed.deviceName || '',
    largeFileMinBytes: parsed.largeFileMinBytes ?? 5242880,
    duplicateMaxFiles: parsed.duplicateMaxFiles ?? 500,
    duplicateMaxFileBytes: parsed.duplicateMaxFileBytes ?? 104857600,
    maxScanEntries: parsed.maxScanEntries ?? 5000,
    approvedApps
  };
}
