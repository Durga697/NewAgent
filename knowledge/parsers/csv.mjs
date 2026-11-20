import { ToolError } from '../../tools/errors.mjs';

const MAX_CSV_ROWS = 2000;

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field.trim());
      if (row.some((c) => c !== '')) {
        rows.push(row);
        if (rows.length >= MAX_CSV_ROWS) break;
      }
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if ((field.length > 0 || row.length > 0) && rows.length < MAX_CSV_ROWS) {
    row.push(field.trim());
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}

export async function parseCsvDocument({ buffer }) {
  if (buffer.includes(0x00)) {
    throw new ToolError('INVALID_DOCUMENT', 'Binary null bytes found inside CSV file.');
  }
  let raw = buffer.toString('utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const parsed = parseCsvRows(raw);
  if (!parsed.length) {
    return { parser: 'csv', text: '', tables: [], warnings: ['CSV file contained no rows.'] };
  }
  const width = Math.max(...parsed.map((r) => r.length));
  const headers = parsed[0].slice();
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  const dataRows = parsed.slice(1).map((r) => {
    const padded = r.slice();
    while (padded.length < width) padded.push('');
    return padded.slice(0, width);
  });

  const lines = [
    headers.join(' | '),
    ...dataRows.map((r) => headers.map((h, idx) => `${h}: ${r[idx]}`).join(', '))
  ];

  return {
    parser: 'csv',
    text: lines.join('\n'),
    tables: [{ title: 'CSV Table', headers, rows: dataRows }],
    warnings: parsed.length >= MAX_CSV_ROWS ? [`Truncated CSV table to ${MAX_CSV_ROWS} rows.`] : []
  };
}
