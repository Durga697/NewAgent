import { readZipEntries } from './zip.mjs';
import { decodeXmlEntities } from './docx.mjs';
import { ToolError } from '../../tools/errors.mjs';

function colLettersToIndex(letters) {
  let idx = 0;
  for (const ch of letters.toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const items = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRegex.exec(xml)) !== null) {
    let text = '';
    const tRegex = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRegex.exec(m[1])) !== null) {
      text += decodeXmlEntities(tm[1]);
    }
    items.push(text);
  }
  return items;
}

function resolveSheetTargets(entries) {
  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8') || '';
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';

  const relMap = new Map();
  const relRegex = /<Relationship\b([^>]+)\/?>/g;
  let rm;
  while ((rm = relRegex.exec(relsXml)) !== null) {
    const attrs = rm[1];
    const id = attrs.match(/\bId="([^"]+)"/)?.[1];
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) {
      const norm = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      relMap.set(id, norm);
    }
  }

  const sheets = [];
  const sheetRegex = /<sheet\b([^>]+)\/?>/g;
  let sm;
  while ((sm = sheetRegex.exec(workbookXml)) !== null) {
    const attrs = sm[1];
    const name = decodeXmlEntities(attrs.match(/\bname="([^"]+)"/)?.[1] || `Sheet${sheets.length + 1}`);
    const rId = attrs.match(/\br:id="([^"]+)"/)?.[1];
    const pathTarget = rId ? relMap.get(rId) : null;
    if (pathTarget && entries.has(pathTarget)) {
      sheets.push({ name, entryKey: pathTarget });
    }
  }

  if (!sheets.length) {
    for (const key of [...entries.keys()].sort()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(key)) {
        sheets.push({ name: key.split('/').pop().replace('.xml', ''), entryKey: key });
      }
    }
  }
  return sheets;
}

export async function parseXlsxDocument({ buffer }) {
  const entries = readZipEntries(buffer);
  if (!entries.has('xl/workbook.xml') && ![...entries.keys()].some((k) => k.startsWith('xl/worksheets/'))) {
    throw new ToolError('INVALID_DOCUMENT', 'XLSX file is missing workbook/worksheet XML.');
  }

  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheets = resolveSheetTargets(entries);
  if (!sheets.length) {
    throw new ToolError('INVALID_DOCUMENT', 'No worksheets found inside XLSX file.');
  }

  const tables = [];
  const textSections = [];

  for (const sheet of sheets) {
    const xml = entries.get(sheet.entryKey).toString('utf8');
    const rowMap = new Map();
    let maxCol = 0;

    const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    let rMatch;
    while ((rMatch = rowRegex.exec(xml)) !== null) {
      const rIdxAttr = rMatch[1].match(/\br="(\d+)"/)?.[1];
      const rowNum = rIdxAttr ? Number(rIdxAttr) - 1 : rowMap.size;
      const cells = [];

      const cellRegex = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cMatch;
      let fallbackCol = 0;
      while ((cMatch = cellRegex.exec(rMatch[2])) !== null) {
        const attrs = cMatch[1];
        const inner = cMatch[2] || '';
        const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1];
        const colIdx = ref ? colLettersToIndex(ref) : fallbackCol;
        fallbackCol = colIdx + 1;
        if (colIdx > maxCol) maxCol = colIdx;

        const cellType = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
        let val = '';
        if (cellType === 'inlineStr') {
          const parts = [];
          const tRe = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g;
          let tm;
          while ((tm = tRe.exec(inner)) !== null) parts.push(decodeXmlEntities(tm[1]));
          val = parts.join('');
        } else {
          const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
          const rawVal = vMatch ? decodeXmlEntities(vMatch[1]) : '';
          if (cellType === 's') {
            val = sharedStrings[Number(rawVal)] ?? rawVal;
          } else if (cellType === 'b') {
            val = rawVal === '1' ? 'TRUE' : 'FALSE';
          } else {
            val = rawVal;
          }
        }
        cells[colIdx] = String(val).trim();
      }
      if (cells.some((c) => c !== undefined && c !== '')) {
        rowMap.set(rowNum, cells);
      }
    }

    const sortedRows = [...rowMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, 2000)
      .map(([, cells]) => {
        const out = [];
        for (let c = 0; c <= Math.min(maxCol, 40); c += 1) {
          out.push(cells[c] || '');
        }
        return out;
      });

    if (sortedRows.length) {
      textSections.push(`[Sheet: ${sheet.name}]`);
      for (const r of sortedRows) {
        textSections.push(r.filter(Boolean).join(' | '));
      }
      if (sortedRows.length >= 2 || sortedRows[0].length >= 2) {
        const headers = sortedRows[0].map((h, i) => h || `Column ${i + 1}`);
        const rows = sortedRows.slice(1);
        tables.push({ title: sheet.name, headers, rows });
      }
    }
  }

  return {
    parser: 'xlsx',
    text: textSections.join('\n'),
    tables,
    warnings: textSections.length ? [] : ['XLSX workbook contained no non-empty cells.']
  };
}
