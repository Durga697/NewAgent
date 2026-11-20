export function chunkDocumentText(text, { chunkSize = 650, overlap = 120, maxChunks = 250 } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return [];

  const chunks = [];
  const paragraphs = clean.split(/\n{2,}/);
  let activeSection = 'Overview';
  let currentBuf = '';
  let charStart = 0;

  const pushChunk = (content, sectionLabel, startOffset, endOffset) => {
    const trimmed = content.trim();
    if (!trimmed || chunks.length >= maxChunks) return;
    chunks.push({
      chunkIndex: chunks.length,
      section: sectionLabel,
      content: trimmed,
      charStart: startOffset,
      charEnd: endOffset
    });
  };

  for (const rawPara of paragraphs) {
    if (chunks.length >= maxChunks) break;
    const para = rawPara.trim();
    if (!para) continue;

    // Update section tracking on Markdown headings or bracketed sheet headers
    const firstLine = para.split('\n')[0].trim();
    if (/^#{1,4}\s+/.test(firstLine)) {
      activeSection = firstLine.replace(/^#{1,4}\s+/, '').slice(0, 72);
    } else if (/^\[Sheet:\s*([^\]]+)\]/i.test(firstLine)) {
      activeSection = firstLine.replace(/^\[Sheet:\s*|\]$/gi, '').slice(0, 72);
    }

    if (para.length > chunkSize) {
      if (currentBuf) {
        pushChunk(currentBuf, activeSection, charStart, charStart + currentBuf.length);
        currentBuf = '';
      }
      // Split large block cleanly on sentence boundaries or fixed slices with overlap
      let pos = 0;
      while (pos < para.length && chunks.length < maxChunks) {
        let sliceEnd = Math.min(para.length, pos + chunkSize);
        if (sliceEnd < para.length) {
          const breakIdx = Math.max(
            para.lastIndexOf('\n', sliceEnd),
            para.lastIndexOf('. ', sliceEnd),
            para.lastIndexOf(' ', sliceEnd)
          );
          if (breakIdx > pos + Math.floor(chunkSize * 0.4)) {
            sliceEnd = breakIdx + 1;
          }
        }
        const piece = para.slice(pos, sliceEnd).trim();
        pushChunk(piece, activeSection, charStart + pos, charStart + sliceEnd);
        if (sliceEnd >= para.length) break;
        pos = Math.max(pos + 1, sliceEnd - overlap);
      }
      charStart += para.length + 2;
      continue;
    }

    if (currentBuf.length + para.length + 2 > chunkSize && currentBuf.length > 0) {
      pushChunk(currentBuf, activeSection, charStart, charStart + currentBuf.length);
      const tail = overlap > 0 && currentBuf.length > overlap ? currentBuf.slice(-overlap).trim() : '';
      charStart += Math.max(0, currentBuf.length - tail.length);
      currentBuf = tail ? `${tail}\n\n${para}` : para;
    } else {
      currentBuf = currentBuf ? `${currentBuf}\n\n${para}` : para;
    }
  }

  if (currentBuf.trim() && chunks.length < maxChunks) {
    pushChunk(currentBuf, activeSection, charStart, charStart + currentBuf.length);
  }

  return chunks;
}
