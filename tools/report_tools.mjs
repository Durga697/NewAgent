import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from './errors.mjs';
import { requirePermit } from '../safety/policy.mjs';

export const LOCAL_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.log']);
const MAX_READ_BYTES = 512 * 1024;

export const readLocalText = {
  id: 'files.read_local_text',
  name: 'read_local_text',
  description: 'Read bounded UTF-8 text from an authorized local plain-text resultId (.txt, .md, .csv, .json, .log) for local Agent Core summarization. Content stays on the local machine.',
  parameters: {
    type: 'object',
    properties: {
      resultId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      maxChars: { type: 'integer', minimum: 200, maximum: 24000 }
    },
    required: ['resultId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      resultId: { type: 'string' },
      name: { type: 'string' },
      extension: { type: 'string' },
      charCount: { type: 'integer', minimum: 0 },
      truncated: { type: 'boolean' },
      excerpt: { type: 'string' },
      localOnly: { type: 'boolean' }
    },
    required: ['resultId', 'name', 'extension', 'charCount', 'truncated', 'excerpt', 'localOnly'],
    additionalProperties: false
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'read_local_text');
    context.files.requireEnabled();
    const item = context.files.results.get(context.session, args.resultId);
    if (item.isDirectory) {
      throw new ToolError('INVALID_ARGUMENTS', 'Choose a text file, not a folder.');
    }
    const checked = context.validatedPaths?.[0] || await context.files.guard.inspect(item.path, { opening: true, directory: false });
    const ext = path.extname(checked.path).toLowerCase();
    if (!LOCAL_TEXT_EXTENSIONS.has(ext)) {
      throw new ToolError('BLOCKED_EXTENSION', 'Local text reading supports .txt, .md, .csv, .json, and .log files only.');
    }
    if (checked.stat.size > MAX_READ_BYTES) {
      throw new ToolError('RESOURCE_LIMIT', 'That file exceeds the 512 KB local text reading limit.');
    }
    const raw = await readFile(checked.path, 'utf8');
    const limit = args.maxChars || 8000;
    const truncated = raw.length > limit;
    const excerpt = raw.slice(0, limit);
    return {
      resultId: item.resultId,
      name: item.name,
      extension: ext,
      charCount: excerpt.length,
      truncated,
      excerpt,
      localOnly: true
    };
  }
};

export const saveReport = {
  id: 'files.save_report',
  name: 'save_report',
  description: 'Create a new Markdown, text, or JSON report inside an authorized local folder after explicit user confirmation. Never overwrites existing files.',
  parameters: {
    type: 'object',
    properties: {
      folder: { type: 'string', minLength: 1, maxLength: 120 },
      fileName: { type: 'string', pattern: '^[A-Za-z0-9._ -]{1,120}\\.(?:md|txt|json)$' },
      content: { type: 'string', minLength: 1, maxLength: 102400 }
    },
    required: ['folder', 'fileName', 'content'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', const: 'saved' },
      rootId: { type: 'string' },
      fileName: { type: 'string' },
      sizeBytes: { type: 'integer', minimum: 1 },
      verified: { type: 'boolean', const: true },
      createdAt: { type: 'string' }
    },
    required: ['status', 'rootId', 'fileName', 'sizeBytes', 'verified', 'createdAt'],
    additionalProperties: false
  },
  targetIds(args) {
    return [`${args.folder}/${args.fileName}`];
  },
  preview(args) {
    const bytes = Buffer.byteLength(String(args.content || ''), 'utf8');
    return `Create new report "${args.fileName}" in authorized folder "${args.folder}" (${bytes} bytes). Existing files will not be overwritten.`;
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'save_report');
    context.files.requireEnabled();
    if (typeof args.fileName !== 'string' || /[\\/]/.test(args.fileName) || args.fileName.includes('..') || args.fileName.endsWith('.')) {
      throw new ToolError('INVALID_PATH', 'Use a simple report filename without folder separators.');
    }
    const dest = context.validatedPaths?.[0];
    if (!dest) {
      throw new ToolError('PATH_DENIED', 'A validated destination path is required.');
    }
    const revalidated = await context.files.guard.revalidate(dest);
    try {
      await writeFile(revalidated.path, args.content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new ToolError('FILE_EXISTS', 'A file with that name already exists. Choose a new report filename.');
      }
      throw error;
    }
    const info = await stat(revalidated.path);
    const roots = await context.files.guard.folders(args.folder);
    const rootId = roots[0]?.id || args.folder;
    try {
      if (context.files.index?.initialized) {
        await context.files.index.upsert(revalidated.path);
      }
    } catch {}
    return {
      status: 'saved',
      rootId,
      fileName: args.fileName,
      sizeBytes: info.size,
      verified: info.isFile() && info.size > 0,
      createdAt: new Date().toISOString()
    };
  }
};

export const reportTools = [readLocalText, saveReport];
