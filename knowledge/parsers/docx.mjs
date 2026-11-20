import { readZipEntries } from './zip.mjs';
import { ToolError } from '../../tools/errors.mjs';

export function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function extractParagraphText(xmlFragment) {
  let out = '';
  const tokenRegex = /<w:(?:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>|(tab|br|cr)(?:\s+[^>]*)?\/>)/g;
  let match;
  while ((match = tokenRegex.exec(xmlFragment)) !== null) {
    if (match[1] !== undefined) {
      out += decodeXmlEntities(match[1]);
    } else if (match[2] === 'tab') {
      out += '\t';
    } else if (match[2] === 'br' || match[2] === 'cr') {
      out += '\n';
    }
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

export async function parseDocxDocument({ buffer }) {
  const entries = readZipEntries(buffer);
  const docBuf = entries.get('word/document.xml');
  if (!docBuf) {
    throw new ToolError('INVALID_DOCUMENT', 'DOCX file is missing word/document.xml.');
  }

  const xmlNames = ['word/document.xml', ...[...entries.keys()].filter((k) => /^word\/(?:header|footer)\d+\.xml$/.test(k))];
  const tables = [];
  const paragraphs = [];

  for (const name of xmlNames) {
    const xml = entries.get(name).toString('utf8');

    // Extract structured tables cleanly
    const tblRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g;
    let tblMatch;
    while ((tblMatch = tblRegex.exec(xml)) !== null) {
      const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      const allRows = [];
      let trMatch;
      while ((trMatch = trRegex.exec(tblMatch[1])) !== null) {
        const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        const cells = [];
        let tcMatch;
        while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
          const cellParagraphs = [];
          const pInCell = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
          let pm;
          while ((pm = pInCell.exec(tcMatch[1])) !== null) {
            const pt = extractParagraphText(pm[1]);
            if (pt) cellParagraphs.push(pt);
          }
          cells.push(cellParagraphs.join(' ').trim());
        }
        if (cells.length) allRows.push(cells);
      }
      if (allRows.length >= 2) {
        const width = Math.max(...allRows.map((r) => r.length));
        const headers = allRows[0].slice();
        while (headers.length < width) headers.push(`Col ${headers.length + 1}`);
        const rows = allRows.slice(1).map((r) => {
          const copy = r.slice();
          while (copy.length < width) copy.push('');
          return copy.slice(0, width);
        });
        tables.push({ title: `DOCX Table ${tables.length + 1}`, headers, rows });
      }
    }

    // Extract top-level and table paragraphs in reading order
    const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
    let pMatch;
    while ((pMatch = pRegex.exec(xml)) !== null) {
      const line = extractParagraphText(pMatch[1]);
      if (line) paragraphs.push(line);
    }
  }

  return {
    parser: 'docx',
    text: paragraphs.join('\n'),
    tables,
    warnings: paragraphs.length ? [] : ['DOCX archive parsed but contained no readable text.']
  };
}
