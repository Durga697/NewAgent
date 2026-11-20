const DIMS = 256;

const SYNONYMS = new Map([
  ['salary', ['compensation', 'ctc', 'pay', 'package', 'remuneration']],
  ['compensation', ['salary', 'ctc', 'pay', 'package']],
  ['ctc', ['salary', 'compensation', 'package']],
  ['offer', ['employment', 'appointment', 'joining', 'offer']],
  ['invoice', ['bill', 'statement', 'receipt', 'charges']],
  ['bill', ['invoice', 'utility', 'electricity', 'statement', 'charges']],
  ['electricity', ['power', 'kwh', 'utility', 'meter', 'tariff']],
  ['amount', ['total', 'due', 'balance', 'subtotal', 'Rs', 'INR']],
  ['total', ['amount', 'due', 'grand', 'sum']],
  ['table', ['schedule', 'rows', 'columns', 'sheet', 'lineitems']],
  ['bonus', ['incentive', 'variable', 'performance']],
  ['notice', ['probation', 'termination', 'resignation']]
]);

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'by', 'is', 'are', 'was', 'were',
  'what', 'which', 'show', 'me', 'my', 'this', 'that', 'these', 'those', 'from', 'about', 'using', 'only',
  'edith', 'please', 'find', 'answer', 'question', 'documents', 'document', 'files', 'file', 'mentioning', 'containing'
]);

function fnv1aHash(str, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function normalizeTokens(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return words.map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

export function extractCurrencyNumbers(text) {
  const matches = String(text || '').match(/\b\d[\d,]*(?:\.\d{1,2})?\b/g) || [];
  return [...new Set(matches.map((m) => m.replace(/,/g, '').replace(/\.00$/, '')))];
}

function addHashedFeature(vec, feature, weight) {
  const h = fnv1aHash(feature);
  const idx = h % DIMS;
  const sign = (fnv1aHash(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1;
  vec[idx] += sign * weight;
}

/**
 * Deterministic 256-dim L2-normalized local semantic vector embedding.
 * Executes completely offline on local hardware with zero cloud transmission.
 */
export function embedText(text) {
  const vec = new Float32Array(DIMS);
  const tokens = normalizeTokens(text);

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    addHashedFeature(vec, `t:${tok}`, 2.0);

    const syns = SYNONYMS.get(tok);
    if (syns) {
      for (const s of syns) {
        addHashedFeature(vec, `t:${s}`, 0.75);
      }
    }

    if (i + 1 < tokens.length) {
      addHashedFeature(vec, `b:${tok}_${tokens[i + 1]}`, 1.4);
    }

    if (tok.length >= 4 && !/^\d+$/.test(tok)) {
      for (let k = 0; k <= tok.length - 3; k += 1) {
        addHashedFeature(vec, `g:${tok.slice(k, k + 3)}`, 0.35);
      }
    }
  }

  for (const num of extractCurrencyNumbers(text)) {
    addHashedFeature(vec, `n:${num}`, 2.5);
  }

  let normSq = 0;
  for (let i = 0; i < DIMS; i += 1) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let i = 0; i < DIMS; i += 1) {
      vec[i] = Math.round((vec[i] / norm) * 100000) / 100000;
    }
  }
  return Array.from(vec);
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return Math.max(0, Math.min(1, dot));
}

export function scoreChunk(query, chunkContent, queryVec, chunkVec) {
  const cos = cosineSimilarity(queryVec, chunkVec);
  const qTokens = normalizeTokens(query);
  const contentLower = String(chunkContent || '').toLowerCase();
  const cTokenSet = new Set(normalizeTokens(chunkContent));

  let lexicalHits = 0;
  for (const qt of qTokens) {
    if (cTokenSet.has(qt) || contentLower.includes(qt)) {
      lexicalHits += 1;
    } else {
      const syns = SYNONYMS.get(qt) || [];
      if (syns.some((s) => cTokenSet.has(s) || contentLower.includes(s))) {
        lexicalHits += 0.65;
      }
    }
  }
  const lexicalScore = qTokens.length ? lexicalHits / qTokens.length : 0;

  const qNums = extractCurrencyNumbers(query);
  const cNums = new Set(extractCurrencyNumbers(chunkContent));
  let numBonus = 0;
  for (const n of qNums) {
    if (cNums.has(n)) numBonus += 0.45;
  }

  // Extract clean multi-word entity phrase match bonus (e.g. "Mahindra Logistics")
  const trimmedQ = String(query || '').trim().toLowerCase();
  const quotedPhrase = trimmedQ.match(/"([^"]{3,60})"/i)?.[1];
  const phraseCandidate = quotedPhrase || (qTokens.length >= 2 && qTokens.length <= 5 ? qTokens.join(' ') : '');
  const phraseBonus = phraseCandidate && contentLower.includes(phraseCandidate) ? 0.3 : 0;

  const total = cos * 0.45 + lexicalScore * 0.5 + numBonus + phraseBonus;
  return {
    score: Math.round(total * 1000) / 1000,
    cosine: Math.round(cos * 1000) / 1000,
    lexicalHits,
    matchedNumber: numBonus > 0
  };
}
