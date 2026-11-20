import { untrustedData } from '../safety/authority.mjs';
import { normalizeTokens, extractCurrencyNumbers } from './embeddings.mjs';

function makeSnippet(text, query) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const qTokens = normalizeTokens(query);
  const qNums = extractCurrencyNumbers(query);

  let bestLine = lines[0] || '';
  let bestScore = -1;
  for (const line of lines) {
    const low = line.toLowerCase();
    const nums = new Set(extractCurrencyNumbers(line));
    let s = 0;
    for (const qt of qTokens) if (low.includes(qt)) s += 2;
    for (const n of qNums) if (nums.has(n)) s += 5;
    if (s > bestScore) {
      bestScore = s;
      bestLine = line;
    }
  }
  return bestLine.slice(0, 220);
}

export function answerFromChunks({ question, rankedChunks, selectedOnly = false }) {
  if (!rankedChunks.length) {
    return {
      answer: selectedOnly
        ? 'No supporting evidence was found in the selected documents for your question.'
        : 'No indexed documents matched your question.',
      citations: [],
      tables: []
    };
  }

  const top = rankedChunks.slice(0, 5);
  const citations = top.map((item, idx) => {
    const wrapped = untrustedData(item.content, 'knowledge_chunk');
    const snippet = makeSnippet(wrapped.value, question);
    return {
      citationNumber: idx + 1,
      documentId: item.documentId,
      fileName: item.fileName,
      chunkId: item.chunkId,
      chunkIndex: item.chunkIndex,
      section: item.section || 'Overview',
      snippet,
      highlightText: snippet.slice(0, 120),
      score: item.score
    };
  });

  const qNums = extractCurrencyNumbers(question);
  const qTokens = normalizeTokens(question);
  const bullets = [];

  for (let i = 0; i < top.length; i += 1) {
    const wrapped = untrustedData(top[i].content, 'knowledge_chunk');
    const candidateLines = wrapped.value
      .split(/\r?\n|(?<=[.!?])\s+/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 4);

    const scored = candidateLines.map((line) => {
      const low = line.toLowerCase();
      const nums = new Set(extractCurrencyNumbers(line));
      let s = 0;
      for (const qt of qTokens) if (low.includes(qt)) s += 2;
      for (const qn of qNums) if (nums.has(qn)) s += 6;
      return { line, s };
    });
    scored.sort((a, b) => b.s - a.s);
    const chosen = (scored[0]?.s > 0 ? scored.slice(0, 2) : scored.slice(0, 1)).map((x) => x.line);
    for (const sentence of chosen) {
      bullets.push(`- ${sentence.slice(0, 240)} [${i + 1}]`);
    }
  }

  const scopeLabel = selectedOnly ? 'Scoped to selected documents only' : 'Local Private Knowledge';
  const answer = [
    `**Grounded Answer** (${scopeLabel}):`,
    '',
    ...bullets,
    '',
    `**Sources:** ${citations.map((c) => `[${c.citationNumber}] ${c.fileName} (${c.section})`).join(' · ')}`
  ].join('\n');

  return { answer, citations, tables: [] };
}

export function summarizeDocuments({ documents, chunks, prompt = '' }) {
  if (!documents.length) {
    return {
      answer: 'No matching indexed documents were found to summarize.',
      citations: [],
      tables: []
    };
  }

  const lines = [`# Document Summary`, ''];
  const citations = [];
  const allTables = [];

  for (const doc of documents.slice(0, 8)) {
    const docChunks = chunks.filter((c) => c.documentId === doc.id);
    const firstChunk = docChunks[0];
    const citeNum = citations.length + 1;
    const textSource = doc.fullText || firstChunk?.content || doc.textPreview || '';
    const wrapped = untrustedData(textSource, 'knowledge_document');
    const snippet = makeSnippet(wrapped.value, prompt || doc.fileName);

    citations.push({
      citationNumber: citeNum,
      documentId: doc.id,
      fileName: doc.fileName,
      chunkId: firstChunk?.id || `${doc.id}:0`,
      chunkIndex: firstChunk?.chunkIndex ?? 0,
      section: firstChunk?.section || 'Overview',
      snippet,
      highlightText: snippet.slice(0, 120),
      score: 1
    });

    const textLines = wrapped.value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const keyLines = textLines.filter((l) =>
      /\b(?:total|amount|due|balance|salary|ctc|offer|date|vendor|account|units|kwh|period|invoice|bill)\b|[$£€₹]/i.test(l)
    );
    const chosen = (keyLines.length ? keyLines : textLines).slice(0, 6);

    lines.push(`## ${doc.fileName} (v${doc.version}) [${citeNum}]`);
    lines.push(`- **Source:** ${doc.sourceType === 'upload' ? 'Uploaded privately' : `${doc.rootId || 'Local folder'}`} · ${doc.metadata?.wordCount || 0} words · ${doc.tables?.length || 0} table(s)`);
    for (const point of chosen) {
      lines.push(`- ${point.slice(0, 220)}`);
    }
    lines.push('');

    for (const tbl of doc.tables || []) {
      allTables.push({ documentId: doc.id, fileName: doc.fileName, ...tbl });
    }
  }

  return {
    answer: lines.join('\n'),
    citations,
    tables: allTables
  };
}

const COMPARE_DIMENSIONS = [
  { label: 'Role / Position', regex: /\b(?:role|title|position|designation)\b/i },
  { label: 'Base Salary / CTC', regex: /\b(?:base\s+salary|annual\s+salary|salary|ctc|compensation|fixed\s+pay|total\s+pay)\b|[$₹£€]/i },
  { label: 'Bonus / Variable / Equity', regex: /\b(?:bonus|variable|equity|stock|rsu|esop|signing)\b/i },
  { label: 'Location / Work Mode', regex: /\b(?:location|office|city|remote|hybrid|onsite)\b/i },
  { label: 'Joining / Effective Date', regex: /\b(?:start\s+date|joining|effective|commencement)\b/i },
  { label: 'Notice / Probation / Terms', regex: /\b(?:notice|probation|benefits|leave|vacation)\b/i }
];

function extractDimensionValue(fullText, regex) {
  const lines = String(fullText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const matches = lines.filter((l) => regex.test(l));
  if (!matches.length) return 'Not stated';
  return matches.slice(0, 2).join(' ; ').slice(0, 140);
}

export function compareDocuments({ documents, chunks = [] }) {
  if (documents.length < 2) {
    return {
      answer: `Need at least 2 indexed documents to compare (currently ${documents.length} matched).`,
      citations: [],
      tables: []
    };
  }

  const targets = documents.slice(0, 4);
  const headers = ['Attribute', ...targets.map((d) => d.fileName)];
  const rows = [];

  for (const dim of COMPARE_DIMENSIONS) {
    const vals = targets.map((d) => extractDimensionValue(d.fullText || d.textPreview || '', dim.regex));
    if (vals.some((v) => v !== 'Not stated')) {
      rows.push([dim.label, ...vals]);
    }
  }
  rows.push(['Word Count', ...targets.map((d) => String(d.metadata?.wordCount || 0))]);
  rows.push([
    'Detected Amounts',
    ...targets.map((d) => (d.metadata?.amounts?.length ? d.metadata.amounts.slice(0, 4).join(', ') : 'None'))
  ]);

  const citations = targets.map((doc, idx) => {
    const firstChunk = chunks.find((c) => c.documentId === doc.id);
    const snippet = makeSnippet(doc.fullText || doc.textPreview || '', 'salary offer role');
    return {
      citationNumber: idx + 1,
      documentId: doc.id,
      fileName: doc.fileName,
      chunkId: firstChunk?.id || `${doc.id}:0`,
      chunkIndex: firstChunk?.chunkIndex ?? 0,
      section: firstChunk?.section || 'Overview',
      snippet,
      highlightText: snippet.slice(0, 120),
      score: 1
    };
  });

  const md = [
    `# Document Comparison (${targets.map((d, i) => `${d.fileName} [${i + 1}]`).join(' vs ')})`,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '/')).join(' | ')} |`)
  ].join('\n');

  return {
    answer: md,
    citations,
    tables: [{ title: 'Document Comparison Matrix', headers, rows }]
  };
}

export function formatExtractedTables({ documents, chunks = [] }) {
  const allTables = [];
  const citations = [];
  const lines = ['# Extracted Document Tables', ''];

  for (const doc of documents) {
    const docTables = Array.isArray(doc.tables) ? doc.tables : [];
    if (!docTables.length) continue;

    const firstChunk = chunks.find((c) => c.documentId === doc.id);
    const citeNum = citations.length + 1;
    const sampleCell = docTables[0]?.headers?.join(' ') || doc.fileName;
    citations.push({
      citationNumber: citeNum,
      documentId: doc.id,
      fileName: doc.fileName,
      chunkId: firstChunk?.id || `${doc.id}:0`,
      chunkIndex: firstChunk?.chunkIndex ?? 0,
      section: firstChunk?.section || 'Tables',
      snippet: sampleCell.slice(0, 220),
      highlightText: (docTables[0]?.headers?.[0] || '').slice(0, 100),
      score: 1
    });

    for (const tbl of docTables) {
      allTables.push({ documentId: doc.id, fileName: doc.fileName, ...tbl });
      lines.push(`## ${doc.fileName} — ${tbl.title || 'Table'} [${citeNum}]`);
      lines.push('');
      if (tbl.headers?.length) {
        lines.push(`| ${tbl.headers.join(' | ')} |`);
        lines.push(`| ${tbl.headers.map(() => '---').join(' | ')} |`);
        for (const r of (tbl.rows || []).slice(0, 50)) {
          lines.push(`| ${r.map((c) => String(c ?? '').replace(/\|/g, '/')).join(' | ')} |`);
        }
        lines.push('');
      }
    }
  }

  if (!allTables.length) {
    return {
      answer: 'No structured tables were detected in the targeted document(s).',
      citations: [],
      tables: []
    };
  }

  return {
    answer: lines.join('\n'),
    citations,
    tables: allTables
  };
}
