import { ToolError } from '../../tools/errors.mjs';

function extractMarkdownTables(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  let i = 0;
  while (i < lines.length - 1) {
    const headerLine = lines[i].trim();
    const sepLine = lines[i + 1].trim();
    if (
      headerLine.includes('|') &&
      /^\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/.test(sepLine)
    ) {
      const splitCells = (row) =>
        row
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = splitCells(headerLine);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().includes('|')) {
        const row = splitCells(lines[j].trim());
        while (row.length < headers.length) row.push('');
        rows.push(row.slice(0, headers.length));
        j += 1;
      }
      if (headers.length >= 2 && rows.length >= 1) {
        tables.push({ title: `Markdown Table ${tables.length + 1}`, headers, rows });
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return tables;
}

function flattenJsonToLines(value, prefix = '', out = []) {
  if (out.length > 5000) return out;
  if (value === null || typeof value !== 'object') {
    out.push(prefix ? `${prefix}: ${String(value)}` : String(value));
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => flattenJsonToLines(item, `${prefix}[${idx}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    flattenJsonToLines(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function extractJsonTables(value, name = 'JSON Table', out = []) {
  if (Array.isArray(value) && value.length > 0 && value.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    const headers = [...new Set(value.flatMap((r) => Object.keys(r)))].slice(0, 25);
    if (headers.length >= 2) {
      const rows = value.slice(0, 500).map((item) =>
        headers.map((h) => {
          const v = item[h];
          return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        })
      );
      out.push({ title: name, headers, rows });
    }
    return out;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      extractJsonTables(v, k, out);
    }
  }
  return out;
}

export async function parseTextDocument({ buffer, extension }) {
  if (buffer.includes(0x00)) {
    throw new ToolError('INVALID_DOCUMENT', 'Binary null bytes found inside plain-text file.');
  }
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const warnings = [];
  let tables = [];

  if (extension === '.md') {
    tables = extractMarkdownTables(text);
  } else if (extension === '.json') {
    try {
      const parsed = JSON.parse(text);
      tables = extractJsonTables(parsed);
      text = flattenJsonToLines(parsed).join('\n');
    } catch {
      warnings.push('JSON syntax invalid; indexed raw text lines instead.');
    }
  }

  return {
    parser: extension === '.json' ? 'json' : extension === '.md' ? 'markdown' : 'text',
    text,
    tables,
    warnings
  };
}
