import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { WebSocketServer, WebSocket } from 'ws';
import { disposable, removeDisposable } from './helpers/fixtures.mjs';
import { loadFileConfig } from '../tools/config.mjs';
import { loadSecurityConfig } from '../safety/config.mjs';

function buildFlatePdf(lines) {
  const esc = (s) => s.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const ops = ['BT', '/F1 11 Tf', '40 740 Td'];
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) ops.push('0 -16 Td');
    ops.push(`(${esc(lines[i])}) Tj`);
  }
  ops.push('ET');
  const streamBytes = deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
  const header = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Filter /FlateDecode /Length ${streamBytes.length} >>\nstream\n`;
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n' + header, 'latin1'),
    streamBytes,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')
  ]);
}

function buildMockOcrPng(text) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const makeChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const tData = Buffer.concat([Buffer.from('EDITH_OCR_TEXT', 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf8')]);
  return Buffer.concat([sig, makeChunk('IHDR', ihdr), makeChunk('tEXt', tData), makeChunk('IEND', Buffer.alloc(0))]);
}

const dir = await disposable('knowledge-e2e-');
const downloads = path.join(dir, 'Downloads');
const documents = path.join(dir, 'Documents');
await mkdir(downloads, { recursive: true });
await mkdir(documents, { recursive: true });

await writeFile(
  path.join(downloads, 'freight-mahindra.pdf'),
  buildFlatePdf([
    'Mahindra Logistics Service Schedule',
    'Route   Rate   SLA',
    'BLR-BOM   INR 14,850   24h',
    'BLR-DEL   INR 19,200   48h'
  ])
);
const localTxtPath = path.join(downloads, 'local-vendor-note.txt');
await writeFile(localTxtPath, 'Mahindra Logistics regional contract addendum.', 'utf8');

const fileConfig = {
  ...await loadFileConfig(),
  enabled: true,
  roots: [
    { id: 'Downloads', path: downloads },
    { id: 'Documents', path: documents }
  ],
  auditFile: path.join(dir, 'legacy-audit.jsonl')
};
fileConfig.indexing = { ...fileConfig.indexing, directory: path.join(dir, 'index-store') };
const fileConfigPath = path.join(dir, 'file-tools.json');
await writeFile(fileConfigPath, JSON.stringify(fileConfig));

const security = structuredClone(await loadSecurityConfig());
security.filesystem.includedRoots = [downloads, documents];
security.logging.directory = path.join(dir, 'audit');
const securityPath = path.join(dir, 'security.json');
await writeFile(securityPath, JSON.stringify(security));

const agentDbPath = path.join(dir, 'agent-state', 'agent.sqlite');

const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((r) => provider.once('listening', r));

const setups = [];
const replies = [];
const sockets = [];
provider.on('connection', (ws) => {
  sockets.push(ws);
  ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.setup) {
      setups.push(e.setup);
      ws.send(JSON.stringify({ setupComplete: {} }));
    }
    if (e.toolResponse) {
      replies.push(...e.toolResponse.functionResponses);
    }
  });
});

const port = 3021;
const base = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    CALENDAR_FILE: ':memory:',
    USERS_FILE: ':memory:',
    FILE_TOOLS_CONFIG: fileConfigPath,
    EDITH_SECURITY_CONFIG: securityPath,
    EDITH_AGENT_DB: agentDbPath,
    EDITH_KNOWLEDGE_MOCK_OCR: '1',
    GEMINI_API_KEY: 'test-only-kb-key',
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${provider.address().port}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverStderr = '';
server.stderr.on('data', (d) => {
  serverStderr += d.toString();
});

async function wait(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Condition timed out in checks/knowledge.mjs');
}

let browser;
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Knowledge check server timeout: ${serverStderr}`)), 15000);
    server.stdout.on('data', (d) => {
      if (d.toString().includes('ready')) {
        clearTimeout(t);
        resolve();
      }
    });
    server.once('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`Server exited ${code}: ${serverStderr}`));
    });
  });

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${base}/app/knowledge`);
  await page.getByText('Private Knowledge & Document Intelligence').waitFor();

  // 1. Create collection with opt-in OCR
  await page.getByLabel('Collection name').fill('Finance & HR');
  await page.getByLabel('Enable opt-in local OCR for images').check();
  await page.getByRole('button', { name: 'Create collection' }).click();
  await page.getByText('Created collection "Finance & HR".').waitFor();

  // 2. Upload PDF, CSV, and PNG (OCR)
  const offerPdf = buildFlatePdf([
    'Confidential Employment Offer',
    'Relocation Bonus: INR 1,25,000 payable upon joining'
  ]);
  await page.locator('#kb-upload-file').setInputFiles({
    name: 'offer-relocation.pdf',
    mimeType: 'application/pdf',
    buffer: offerPdf
  });
  await page.getByRole('button', { name: 'Upload & Index' }).click();
  await page.getByText(/Indexed "offer-relocation\.pdf"/).waitFor();

  await page.locator('#kb-upload-file').setInputFiles({
    name: 'receipt-scan.png',
    mimeType: 'image/png',
    buffer: buildMockOcrPng('Receipt #ML-505 Total INR 4,200')
  });
  await page.getByRole('button', { name: 'Upload & Index' }).click();
  await page.getByText(/Indexed "receipt-scan\.png"/).waitFor();

  // 3. Index local authorized Downloads folder
  await page.getByRole('button', { name: 'Index folder' }).first().click();
  await page.getByText(/Indexed "Downloads":/).waitFor();
  await page.getByText('freight-mahindra.pdf (v1)').waitFor();
  await page.getByText('local-vendor-note.txt (v1)').waitFor();

  // 4. WCAG 2.0/2.1 A/AA & mobile 390px overflow checks on /app/knowledge
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const violations = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
        .violations.map((v) => [v.id, v.nodes.map((n) => n.target)])
    );
    assert.deepEqual(violations, [], `/app/knowledge ${width}px accessibility: ${JSON.stringify(violations)}`);
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${width}px horizontal overflow on /app/knowledge`
    );
  }
  await page.setViewportSize({ width: 1440, height: 960 });

  // 5. Semantic search
  await page.getByLabel('Semantic & keyword search').fill('Mahindra Logistics');
  await page.getByRole('button', { name: 'Search knowledge' }).click();
  await page.getByText(/Search hits for "Mahindra Logistics"/).waitFor();

  // 6. Selected-document scoped Q&A + citation highlight in preview
  const offerRow = page.locator('.kb-doc-row', { hasText: 'offer-relocation.pdf' });
  await offerRow.getByLabel('Select').check();
  await page.getByLabel('Ask Private Knowledge').fill('What is the relocation bonus?');
  await page.getByRole('button', { name: 'Run local analysis' }).click();
  await page.locator('.kb-answer').getByText(/1,25,000/).waitFor();
  await page.locator('.kb-cite-chip', { hasText: /offer-relocation\.pdf/ }).first().click();
  await page.getByText('Preview: offer-relocation.pdf (v1)').waitFor();
  await page.locator('.kb-cite-mark').waitFor();

  // 7. Extract tables on Downloads PDF
  await offerRow.getByLabel('Select').uncheck();
  const mahindraRow = page.locator('.kb-doc-row', { hasText: 'freight-mahindra.pdf' });
  await mahindraRow.getByLabel('Select').check();
  await page.getByLabel('Analysis mode').selectOption('tables');
  await page.getByRole('button', { name: 'Run local analysis' }).click();
  await page.locator('.kb-answer table').getByText('BLR-BOM').waitFor();

  // 8. Delete local-vendor-note.txt from Knowledge index -> original disk file must remain intact
  const localRow = page.locator('.kb-doc-row', { hasText: 'local-vendor-note.txt' });
  await localRow.getByRole('button', { name: 'Remove' }).click();
  await page.getByText(/Removed document from Knowledge index/).waitFor();
  await access(localTxtPath);

  // 9. Voice & Text WebSocket parity + CloudGate redaction of Private Knowledge content
  const cookies = await context.cookies();
  const fdCookie = cookies.find((c) => c.name === 'frontdesk');
  assert(fdCookie);
  const cookieHeader = `frontdesk=${fdCookie.value}`;

  const textWs = new WebSocket(`ws://localhost:${port}/api/assistant/text`, {
    headers: { Origin: base, Cookie: cookieHeader }
  });
  await new Promise((resolve, reject) => {
    textWs.on('message', (raw) => {
      if (JSON.parse(raw).type === 'ready') resolve();
    });
    textWs.once('error', reject);
  });
  assert.equal(setups.length, 1);
  const textTools = setups[0].tools?.[0]?.functionDeclarations?.map((t) => t.name) || [];
  assert(textTools.includes('knowledge_search'));
  assert(textTools.includes('knowledge_answer'));
  assert(textTools.includes('knowledge_compare'));

  textWs.send(JSON.stringify({ type: 'text', text: 'What is the relocation bonus in the offer letter?' }));
  await new Promise((r) => setTimeout(r, 80));
  sockets[0].send(JSON.stringify({
    toolCall: { functionCalls: [{ id: 'kb-qa-1', name: 'knowledge_answer', args: { question: 'What is the relocation bonus?' } }] }
  }));
  await wait(() => replies.some((r) => r.id === 'kb-qa-1'));
  const kbReply = replies.find((r) => r.id === 'kb-qa-1').response;
  assert.equal(kbReply.localOnly, true);
  assert.equal(kbReply.answer, undefined);
  assert(!JSON.stringify(kbReply).includes('1,25,000'));
  assert(!JSON.stringify(kbReply).includes(downloads.replaceAll('\\', '\\\\')));
  textWs.close();
  await wait(() => textWs.readyState === WebSocket.CLOSED);

  const voiceWs = new WebSocket(`ws://localhost:${port}/api/assistant/voice`, {
    headers: { Origin: base, Cookie: cookieHeader }
  });
  await new Promise((resolve, reject) => {
    voiceWs.on('message', (raw) => {
      if (JSON.parse(raw).type === 'ready') resolve();
    });
    voiceWs.once('error', reject);
  });
  assert.equal(setups.length, 2);
  const voiceTools = setups[1].tools?.[0]?.functionDeclarations?.map((t) => t.name) || [];
  assert.deepEqual(voiceTools, textTools, 'Knowledge tools must expose identical parity across voice and text');
  voiceWs.close();
  await wait(() => voiceWs.readyState === WebSocket.CLOSED);

  assert.deepEqual(errors, []);
  console.log('PASS: Knowledge collections, PDF/OCR/local folder indexing, WCAG A/AA, 390px layout, semantic search, selected-doc Q&A citations, table extraction, disk-safe deletion, voice/text parity, and CloudGate content isolation.');
} finally {
  await browser?.close();
  server.kill();
  await new Promise((r) => {
    if (server.exitCode !== null) return r();
    server.once('exit', r);
  });
  for (const ws of provider.clients) ws.terminate();
  await new Promise((r) => provider.close(r));
  await removeDisposable(dir);
}
