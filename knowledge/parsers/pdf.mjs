import { inflateSync, inflateRawSync } from 'node:zlib';
import { ToolError } from '../../tools/errors.mjs';

const MAX_DECOMPRESSED_STREAM = 8 * 1024 * 1024;
const MAX_TOTAL_DECOMPRESSED = 16 * 1024 * 1024;

function decodeLiteralPdfString(raw, cmap) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= raw.length) break;
    const esc = raw[i];
    if (esc === 'n') out += '\n';
    else if (esc === 'r') out += '\r';
    else if (esc === 't') out += '\t';
    else if (esc === 'b') out += '\b';
    else if (esc === 'f') out += '\f';
    else if (esc === '(' || esc === ')' || esc === '\\') out += esc;
    else if (esc === '\r') {
      if (raw[i + 1] === '\n') i += 1;
    } else if (esc === '\n') {
      // Escaped newline continuation
    } else if (/[0-7]/.test(esc)) {
      let oct = esc;
      if (/[0-7]/.test(raw[i + 1] || '')) {
        oct += raw[i + 1];
        i += 1;
      }
      if (/[0-7]/.test(raw[i + 1] || '')) {
        oct += raw[i + 1];
        i += 1;
      }
      const code = parseInt(oct, 8);
      const hexKey = code.toString(16).toUpperCase().padStart(2, '0');
      out += cmap.get(hexKey) || String.fromCharCode(code);
    } else {
      out += esc;
    }
  }
  return out;
}

function decodeHexPdfString(hexRaw, cmap) {
  const clean = hexRaw.replace(/[^0-9A-Fa-f]/g, '');
  if (!clean.length) return '';
  const padded = clean.length % 2 === 0 ? clean : `${clean}0`;
  if (cmap.size > 0) {
    let mapped = '';
    let matchedAny = false;
    const step = padded.length >= 4 && [...cmap.keys()].some((k) => k.length === 4) ? 4 : 2;
    for (let i = 0; i + step <= padded.length; i += step) {
      const code = padded.slice(i, i + step).toUpperCase();
      if (cmap.has(code)) {
        mapped += cmap.get(code);
        matchedAny = true;
      } else {
        mapped += String.fromCharCode(parseInt(code, 16));
      }
    }
    if (matchedAny) return mapped;
  }

  const buf = Buffer.from(padded, 'hex');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    let utf16 = '';
    for (let i = 2; i + 1 < buf.length; i += 2) {
      utf16 += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
    }
    return utf16;
  }
  return buf.toString('latin1');
}

function parseToUnicodeCmap(streamText, cmap) {
  if (!streamText.includes('beginbfchar') && !streamText.includes('beginbfrange')) return;
  const bfcharRegex = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfcharRegex.exec(streamText)) !== null) {
    const pairRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let pm;
    while ((pm = pairRegex.exec(m[1])) !== null) {
      const src = pm[1].toUpperCase();
      const dstBuf = Buffer.from(pm[2], 'hex');
      let unicode = '';
      for (let i = 0; i + 1 < dstBuf.length; i += 2) {
        unicode += String.fromCharCode((dstBuf[i] << 8) | dstBuf[i + 1]);
      }
      if (!unicode && dstBuf.length === 1) unicode = String.fromCharCode(dstBuf[0]);
      if (unicode) cmap.set(src, unicode);
    }
  }

  const bfrangeRegex = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrangeRegex.exec(streamText)) !== null) {
    const rangeRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let rm;
    while ((rm = rangeRegex.exec(m[1])) !== null) {
      const start = parseInt(rm[1], 16);
      const end = parseInt(rm[2], 16);
      const dstStart = parseInt(rm[3], 16);
      const width = rm[1].length;
      if (end - start <= 256) {
        for (let c = start; c <= end; c += 1) {
          cmap.set(c.toString(16).toUpperCase().padStart(width, '0'), String.fromCodePoint(dstStart + (c - start)));
        }
      }
    }
  }
}

function extractTextFromContentStream(streamText, cmap) {
  const lines = [];
  const btRegex = /\bBT\b([\s\S]*?)\bET\b/g;
  let bt;
  while ((bt = btRegex.exec(streamText)) !== null) {
    const block = bt[1];
    let currentLine = '';
    const tokens = [];

    let i = 0;
    while (i < block.length) {
      const ch = block[i];
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === '(') {
        i += 1;
        let depth = 1;
        const start = i;
        while (i < block.length && depth > 0) {
          if (block[i] === '\\') {
            i += 2;
            continue;
          }
          if (block[i] === '(') depth += 1;
          else if (block[i] === ')') depth -= 1;
          if (depth > 0) i += 1;
        }
        tokens.push({ type: 'str', value: decodeLiteralPdfString(block.slice(start, i), cmap) });
        i += 1;
        continue;
      }
      if (ch === '<' && block[i + 1] !== '<') {
        const close = block.indexOf('>', i + 1);
        if (close === -1) break;
        tokens.push({ type: 'str', value: decodeHexPdfString(block.slice(i + 1, close), cmap) });
        i = close + 1;
        continue;
      }
      if (ch === '[') {
        i += 1;
        const arr = [];
        while (i < block.length && block[i] !== ']') {
          if (/\s/.test(block[i])) {
            i += 1;
          } else if (block[i] === '(') {
            i += 1;
            let depth = 1;
            const s = i;
            while (i < block.length && depth > 0) {
              if (block[i] === '\\') {
                i += 2;
                continue;
              }
              if (block[i] === '(') depth += 1;
              else if (block[i] === ')') depth -= 1;
              if (depth > 0) i += 1;
            }
            arr.push({ type: 'str', value: decodeLiteralPdfString(block.slice(s, i), cmap) });
            i += 1;
          } else if (block[i] === '<') {
            const close = block.indexOf('>', i + 1);
            if (close === -1) break;
            arr.push({ type: 'str', value: decodeHexPdfString(block.slice(i + 1, close), cmap) });
            i = close + 1;
          } else {
            const m = block.slice(i).match(/^[-+]?\d*\.?\d+/);
            if (m) {
              arr.push({ type: 'num', value: Number(m[0]) });
              i += m[0].length;
            } else {
              i += 1;
            }
          }
        }
        tokens.push({ type: 'arr', value: arr });
        i += 1;
        continue;
      }

      const wordMatch = block.slice(i).match(/^[^\s()<>\[\]\/%]+/);
      if (wordMatch) {
        const w = wordMatch[0];
        i += w.length;
        if (w === 'Tj' && tokens.length && tokens.at(-1).type === 'str') {
          currentLine += tokens.pop().value;
        } else if ((w === "'" || w === '"') && tokens.length && tokens.at(-1).type === 'str') {
          if (currentLine.trim()) lines.push(currentLine.trimEnd());
          currentLine = tokens.pop().value;
        } else if (w === 'TJ' && tokens.length && tokens.at(-1).type === 'arr') {
          const arr = tokens.pop().value;
          for (const part of arr) {
            if (part.type === 'str') currentLine += part.value;
            else if (part.type === 'num' && part.value < -380) currentLine += '   ';
            else if (part.type === 'num' && part.value < -120 && !currentLine.endsWith(' ')) currentLine += ' ';
          }
        } else if ((w === 'Td' || w === 'TD') && tokens.length >= 2) {
          const ty = Number(tokens.pop().value);
          const tx = Number(tokens.pop().value);
          if (Math.abs(ty) >= 1) {
            if (currentLine.trim()) lines.push(currentLine.trimEnd());
            currentLine = '';
          } else if (tx >= 20 && currentLine && !currentLine.endsWith('  ')) {
            currentLine += '   ';
          }
        } else if (w === 'T*') {
          if (currentLine.trim()) lines.push(currentLine.trimEnd());
          currentLine = '';
        } else if (w === 'Tm' && tokens.length >= 6) {
          tokens.splice(-6, 6);
          if (currentLine.trim()) lines.push(currentLine.trimEnd());
          currentLine = '';
        } else if (/^[-+]?\d*\.?\d+$/.test(w)) {
          tokens.push({ type: 'num', value: Number(w) });
        } else {
          tokens.push({ type: 'op', value: w });
        }
      } else {
        i += 1;
      }
    }
    if (currentLine.trim()) lines.push(currentLine.trimEnd());
  }
  return lines;
}

function detectPdfTables(lines) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    const parseRow = (line) => {
      if (line.includes('|')) {
        const parts = line.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
        if (parts.length >= 2) return parts;
      }
      if (line.includes('\t')) {
        const parts = line.split(/\t+/).map((s) => s.trim()).filter((s) => s.length > 0);
        if (parts.length >= 2) return parts;
      }
      const cols = line.trim().split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
      return cols.length >= 2 ? cols : null;
    };

    const firstCols = parseRow(lines[i]);
    if (!firstCols) {
      i += 1;
      continue;
    }
    const group = [firstCols];
    let j = i + 1;
    while (j < lines.length) {
      const nextCols = parseRow(lines[j]);
      if (!nextCols || nextCols.length !== firstCols.length) break;
      group.push(nextCols);
      j += 1;
    }
    if (group.length >= 2) {
      tables.push({
        title: `PDF Table ${tables.length + 1}`,
        headers: group[0],
        rows: group.slice(1)
      });
      i = j;
    } else {
      i += 1;
    }
  }
  return tables;
}

export async function parsePdfDocument({ buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    throw new ToolError('INVALID_DOCUMENT', 'Invalid PDF header.');
  }

  const latin = buffer.toString('latin1');
  if (/\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(latin)) {
    throw new ToolError('EXTRACTION_UNSUPPORTED', 'Encrypted PDFs are not supported.');
  }

  const streamInfos = [];
  const warnings = [];
  let totalDecompressed = 0;
  let pos = 0;

  while (pos < latin.length) {
    const streamTokenIdx = latin.indexOf('stream', pos);
    if (streamTokenIdx === -1) break;

    const prevCh = streamTokenIdx > 0 ? latin[streamTokenIdx - 1] : '\n';
    const nextCh = latin[streamTokenIdx + 6];
    if (!/[\r\n>\s]/.test(prevCh) || (nextCh !== '\r' && nextCh !== '\n')) {
      pos = streamTokenIdx + 6;
      continue;
    }

    let dataStart = streamTokenIdx + 6;
    if (latin[dataStart] === '\r' && latin[dataStart + 1] === '\n') dataStart += 2;
    else if (latin[dataStart] === '\n' || latin[dataStart] === '\r') dataStart += 1;

    const endIdx = latin.indexOf('endstream', dataStart);
    if (endIdx === -1) break;

    let dataEnd = endIdx;
    while (dataEnd > dataStart && (latin[dataEnd - 1] === '\n' || latin[dataEnd - 1] === '\r')) {
      dataEnd -= 1;
    }

    const headerContext = latin.slice(Math.max(0, streamTokenIdx - 512), streamTokenIdx);
    const isFlate = /\/Filter\b[^>\n]*\/FlateDecode/.test(headerContext);
    const rawSlice = buffer.subarray(dataStart, dataEnd);

    let decodedBuf = rawSlice;
    if (isFlate) {
      try {
        decodedBuf = inflateSync(rawSlice, { maxOutputLength: MAX_DECOMPRESSED_STREAM });
      } catch {
        try {
          decodedBuf = inflateRawSync(rawSlice, { maxOutputLength: MAX_DECOMPRESSED_STREAM });
        } catch {
          warnings.push('One or more compressed PDF streams could not be decoded.');
          decodedBuf = null;
        }
      }
    }

    if (decodedBuf) {
      totalDecompressed += decodedBuf.length;
      if (totalDecompressed > MAX_TOTAL_DECOMPRESSED) {
        throw new ToolError('FILE_TOO_LARGE', 'Decompressed PDF content exceeds 16 MB safety limit.');
      }
      streamInfos.push(decodedBuf.toString('latin1'));
    }
    pos = endIdx + 9;
  }

  const cmap = new Map();
  for (const s of streamInfos) {
    parseToUnicodeCmap(s, cmap);
  }

  const lines = [];
  for (const s of streamInfos) {
    if (s.includes('BT') && s.includes('ET')) {
      lines.push(...extractTextFromContentStream(s, cmap));
    }
  }

  // Normalize lines while preserving intentional multi-space columns for table detection
  const cleanLines = lines
    .map((l) => l.replace(/\r/g, '').trimEnd())
    .filter((l) => l.trim().length > 0);
  const tables = detectPdfTables(cleanLines);

  const normalizedText = cleanLines
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n');

  if (!normalizedText) {
    warnings.push('PDF contains no embedded text layer (scanned PDFs require image conversion + opt-in OCR).');
  }

  return {
    parser: 'pdf',
    text: normalizedText,
    tables,
    warnings
  };
}
