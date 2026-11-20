import path from 'node:path';
import { ToolError } from '../../tools/errors.mjs';
import { parseTextDocument } from './text.mjs';
import { parseCsvDocument } from './csv.mjs';
import { parseDocxDocument } from './docx.mjs';
import { parseXlsxDocument } from './xlsx.mjs';
import { parsePdfDocument } from './pdf.mjs';
import { parseImageOcrDocument } from './ocr.mjs';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const IMAGE_OCR_EXTENSIONS = Object.freeze(new Set(['.png', '.jpg', '.jpeg']));

const registry = new Map([
  ['.txt', parseTextDocument],
  ['.md', parseTextDocument],
  ['.json', parseTextDocument],
  ['.log', parseTextDocument],
  ['.csv', parseCsvDocument],
  ['.docx', parseDocxDocument],
  ['.xlsx', parseXlsxDocument],
  ['.pdf', parsePdfDocument],
  ['.png', parseImageOcrDocument],
  ['.jpg', parseImageOcrDocument],
  ['.jpeg', parseImageOcrDocument]
]);

export const SUPPORTED_EXTENSIONS = Object.freeze([...registry.keys()]);

export function registerParser(extension, parserFn) {
  const clean = String(extension || '').trim().toLowerCase();
  if (!clean.startsWith('.') || typeof parserFn !== 'function') {
    throw new ToolError('INVALID_ARGUMENTS', 'Parser registration requires a dotted extension and parser function.');
  }
  registry.set(clean, parserFn);
}

function normalizeExtractedText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDocumentMetadata(text, tables) {
  const amounts = [...new Set(text.match(/(?:INR|USD|EUR|GBP|Rs\.?|[$₹£€])\s*\d[\d,]*(?:\.\d{1,2})?/gi) || [])].slice(0, 30);
  const dates = [
    ...new Set(
      text.match(
        /\b(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})\b/gi
      ) || []
    )
  ].slice(0, 30);
  const lines = text ? text.split('\n').filter(Boolean) : [];
  const headings = lines
    .filter((l) => l.startsWith('#') || (l.length >= 4 && l.length <= 72 && !/[.;,]$/.test(l) && /^[A-Z0-9#]/.test(l)))
    .slice(0, 20);
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;

  return {
    charCount: text.length,
    wordCount: words,
    lineCount: lines.length,
    tableCount: tables.length,
    amounts,
    dates,
    headings
  };
}

export async function parseDocument({ buffer, filePath = null, fileName = '', extension = '', ocrEnabled = false }) {
  if (!Buffer.isBuffer(buffer)) {
    throw new ToolError('INVALID_DOCUMENT', 'Document bytes are required for parsing.');
  }
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new ToolError('FILE_TOO_LARGE', `Document exceeds the ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB Knowledge limit.`);
  }
  const ext = (extension || path.extname(fileName || filePath || '')).toLowerCase();
  const parserFn = registry.get(ext);
  if (!parserFn) {
    throw new ToolError('EXTRACTION_UNSUPPORTED', `File extension "${ext || 'none'}" is not supported by EDITH Document Intelligence.`);
  }

  const parsed = await parserFn({ buffer, filePath, fileName, extension: ext, ocrEnabled });
  const normalizedText = normalizeExtractedText(parsed.text || '');
  const tables = Array.isArray(parsed.tables) ? parsed.tables : [];
  const metadata = extractDocumentMetadata(normalizedText, tables);

  return {
    parser: parsed.parser || ext.slice(1),
    skipped: Boolean(parsed.skipped),
    text: normalizedText,
    tables,
    metadata,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
  };
}
