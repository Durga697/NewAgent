import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { WebSocketServer, WebSocket } from 'ws';
import { disposable, removeDisposable } from './helpers/fixtures.mjs';
import { loadFileConfig } from '../tools/config.mjs';
import { loadSecurityConfig } from '../safety/config.mjs';

const dir = await disposable('companion-e2e-');
const downloads = path.join(dir, 'Downloads');
const documents = path.join(dir, 'Documents');
const recycleDir = path.join(dir, 'test-recycle-bin');
await mkdir(downloads, { recursive: true });
await mkdir(documents, { recursive: true });
await mkdir(recycleDir, { recursive: true });

const invPdf = path.join(downloads, 'invoice-oct-e2e.pdf');
const shot1 = path.join(downloads, 'screenshot-e2e-1.png');
const shot2 = path.join(downloads, 'screenshot-e2e-2.png');
await writeFile(invPdf, '%PDF-1.4 sample october invoice e2e', 'utf8');
await writeFile(shot1, Buffer.from('IDENTICAL_SCREENSHOT_PNG_E2E_BYTES'));
await writeFile(shot2, Buffer.from('IDENTICAL_SCREENSHOT_PNG_E2E_BYTES'));

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
provider.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.setup) {
      setups.push(e.setup);
      ws.send(JSON.stringify({ setupComplete: {} }));
    }
  });
});

const port = 3020;
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
    EDITH_COMPANION_MOCK_WINDOWS: '1',
    EDITH_COMPANION_TEST_RECYCLE_DIR: recycleDir,
    GEMINI_API_KEY: 'test-only-companion-key',
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${provider.address().port}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

async function wait(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Condition timed out in checks/companion.mjs');
}

let browser;
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Companion check server timeout')), 15000);
    server.stdout.on('data', (d) => {
      if (d.toString().includes('ready')) {
        clearTimeout(t);
        resolve();
      }
    });
    server.once('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`Server exited ${code}`));
    });
  });

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // 1. Open /app/devices and explicitly pair this local Windows computer
  await page.goto(`${base}/app/devices`);
  await page.getByText('Windows Companion Not Paired').waitFor();
  await page.getByRole('button', { name: 'Start pairing' }).click();
  await page.getByText(/One-time pairing code:/).waitFor();
  await page.getByRole('button', { name: 'Confirm & pair this PC' }).click();

  // 2. Verify live Windows telemetry, top processes, and approved apps
  await page.getByText('Paired · Local HMAC').waitFor();
  await page.getByText('28.4%').waitFor();
  await page.getByText(/318 GB free/).first().waitFor();
  await page.getByText('Code', { exact: true }).first().waitFor();
  await page.getByText('Visual Studio Code (development)').waitFor();

  // 3. Verify WCAG A/AA and mobile responsiveness at 390px and 1440px on /app/devices
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const violations = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
        .violations.map((v) => [v.id, v.nodes.map((n) => n.target)])
    );
    assert.deepEqual(violations, [], `/app/devices ${width}px accessibility: ${JSON.stringify(violations)}`);
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${width}px horizontal overflow on /app/devices`
    );
  }
  await page.setViewportSize({ width: 1440, height: 960 });

  // 4. Verify Voice & Text WebSocket companion tool parity for the paired session
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
  assert(textTools.includes('get_system_metrics'));
  assert(textTools.includes('find_duplicate_files'));
  assert(textTools.includes('launch_approved_app'));
  assert(textTools.includes('undo_file_action'));
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
  assert.deepEqual(voiceTools, textTools, 'Paired companion tools must have voice/text parity');
  voiceWs.close();
  await wait(() => voiceWs.readyState === WebSocket.CLOSED);

  // 5. Run read-only duplicate screenshot task on /app/tasks
  await page.locator('#side-nav').getByRole('link', { name: 'Task Center' }).click();
  await page.getByLabel('Task request').fill("EDITH, find duplicate screenshots, but don't delete anything.");
  await page.getByRole('button', { name: 'Run task' }).click();
  await page.getByText(/No files were deleted/).first().waitFor();
  await access(shot1);
  await access(shot2);

  // 6. Run organize PDF invoices workflow with explicit mkdir + move approvals
  await page.getByLabel('Task request').fill('EDITH, organize the PDF invoices in my Downloads folder.');
  await page.getByRole('button', { name: 'Run task' }).click();
  await page.locator('.agent-badge-awaiting_approval').first().waitFor();
  await page.getByRole('button', { name: 'Approve & run' }).first().click();

  // Approve move_file step
  await page.getByRole('button', { name: 'Approve & run' }).first().waitFor();
  await page.getByRole('button', { name: 'Approve & run' }).first().click();
  await page.getByText(/Organized 1 file\(s\) into Downloads\/Invoices/).first().waitFor();

  const organizedPdf = path.join(downloads, 'Invoices', 'invoice-oct-e2e.pdf');
  await access(organizedPdf);
  await assert.rejects(() => access(invPdf));

  // 7. Undo the move from /app/devices
  await page.locator('#side-nav').getByRole('link', { name: 'Devices' }).click();
  await page.getByText(/Moved "invoice-oct-e2e\.pdf"/).first().waitFor();
  await page.getByRole('button', { name: 'Undo action' }).first().click();
  await page.getByRole('button', { name: 'Approve & execute' }).waitFor();
  await page.getByRole('button', { name: 'Approve & execute' }).click();
  await page.getByText(/Restored/i).waitFor();
  await access(invPdf);
  await assert.rejects(() => access(organizedPdf));

  // 8. Trigger Emergency Stop & verify immediate revocation
  await page.getByRole('button', { name: 'Emergency Stop' }).click();
  await page.getByText('Windows Companion Revoked (Emergency Stop)').waitFor();
  const afterStop = await context.request.get(`${base}/api/companion/telemetry`);
  assert.equal(afterStop.status(), 403);

  assert.deepEqual(errors, []);
  console.log('PASS: Windows companion pairing, live telemetry, WCAG A/AA, 390px layout, voice/text tool parity, read-only duplicate scan, confirmed organize + undo, and Emergency Stop.');
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
