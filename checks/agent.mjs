import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { WebSocketServer, WebSocket } from 'ws';
import { disposable, removeDisposable } from './helpers/fixtures.mjs';
import { loadFileConfig } from '../tools/config.mjs';
import { loadSecurityConfig } from '../safety/config.mjs';

const dir = await disposable('agent-e2e-');
const downloads = path.join(dir, 'Downloads');
const documents = path.join(dir, 'Documents');
await mkdir(downloads, { recursive: true });
await mkdir(documents, { recursive: true });

await writeFile(
  path.join(downloads, 'invoice-october-alpha.txt'),
  'Alpha Freight Invoice\nDate: 2026-10-05\nTotal Amount: INR 8,500\n',
  'utf8'
);
await writeFile(
  path.join(downloads, 'invoice-october-omega.txt'),
  'Omega Cloud Invoice\nDate: 2026-10-21\nAmount Due: INR 3,250\n',
  'utf8'
);

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

const port = 3019;
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
    GEMINI_API_KEY: 'test-only-agent-key',
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
  throw new Error('Condition timed out in checks/agent.mjs');
}

let browser;
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Agent check server timeout')), 15000);
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

  // 1. Verify Voice vs Text tool parity via WebSocket transport
  const stateRes = await fetch(`${base}/api/state`);
  const cookie = stateRes.headers.get('set-cookie').split(';')[0];

  const textWs = new WebSocket(`ws://localhost:${port}/api/assistant/text`, {
    headers: { Origin: base, Cookie: cookie }
  });
  await new Promise((resolve, reject) => {
    textWs.on('message', (raw) => {
      if (JSON.parse(raw).type === 'ready') resolve();
    });
    textWs.once('error', reject);
  });
  assert.equal(setups.length, 1);
  const textTools = setups[0].tools?.[0]?.functionDeclarations?.map((t) => t.name) || [];
  assert(textTools.includes('search_files'), 'Typed session must expose search_files');
  assert(textTools.includes('save_report'), 'Typed session must expose save_report');
  assert(!textTools.includes('read_local_text'), 'Cloud session must not expose raw local reader directly');

  textWs.send(JSON.stringify({ type: 'text', text: 'Find my october invoices' }));
  await new Promise((r) => setTimeout(r, 80));
  sockets[0].send(JSON.stringify({
    toolCall: { functionCalls: [{ id: 'typed-search-1', name: 'search_files', args: { query: 'invoice' } }] }
  }));
  await wait(() => replies.some((r) => r.id === 'typed-search-1'));
  const typedReply = replies.find((r) => r.id === 'typed-search-1').response;
  assert.equal(typedReply.results.length, 2);
  assert(!JSON.stringify(typedReply).includes(downloads.replaceAll('\\', '\\\\')));
  textWs.close();
  await wait(() => textWs.readyState === WebSocket.CLOSED);

  const voiceWs = new WebSocket(`ws://localhost:${port}/api/assistant/voice`, {
    headers: { Origin: base, Cookie: cookie }
  });
  await new Promise((resolve, reject) => {
    voiceWs.on('message', (raw) => {
      if (JSON.parse(raw).type === 'ready') resolve();
    });
    voiceWs.once('error', reject);
  });
  assert.equal(setups.length, 2);
  const voiceTools = setups[1].tools?.[0]?.functionDeclarations?.map((t) => t.name) || [];
  assert.deepEqual(voiceTools, textTools, 'Voice and text workspace sessions must expose identical tool declarations');
  voiceWs.close();
  await wait(() => voiceWs.readyState === WebSocket.CLOSED);

  // 2. Verify Browser E2E on /app/tasks, /app/permissions, /app/skills + WCAG A/AA
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${base}/app/tasks`);
  await page.getByLabel('Task request').fill(
    'EDITH, find all invoices from October, create a summary report, and save the report in my Documents folder.'
  );
  await page.getByRole('button', { name: 'Run task' }).click();

  await page.locator('.agent-badge-awaiting_approval').first().waitFor();
  await page.getByText(/INR 8,500/).waitFor();
  await page.getByText(/INR 3,250/).waitFor();

  // Report file must NOT exist on disk before approval
  const tasksApi = await (await context.request.get(`${base}/api/agent/tasks`)).json();
  assert.equal(tasksApi.tasks.length, 1);
  const reportFileName = tasksApi.tasks[0].result.reportFileName;
  const expectedPath = path.join(documents, reportFileName);
  await assert.rejects(() => access(expectedPath));

  // Verify axe-core WCAG A/AA on /app/tasks and /app/permissions
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const violations = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
        .violations.map((v) => [v.id, v.nodes.map((n) => n.target)])
    );
    assert.deepEqual(violations, [], `/app/tasks ${width}px accessibility: ${JSON.stringify(violations)}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px overflow on /app/tasks`);
  }

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#side-nav').getByRole('link', { name: 'Permissions' }).click();
  await page.getByText(/Pending approval: save_report/).waitFor();
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const violations = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
        .violations.map((v) => [v.id, v.nodes.map((n) => n.target)])
    );
    assert.deepEqual(violations, [], `/app/permissions ${width}px accessibility: ${JSON.stringify(violations)}`);
  }

  // Approve from /app/permissions and verify task completes & file lands on disk
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('No pending agent approvals').waitFor();

  const savedContent = await readFile(expectedPath, 'utf8');
  assert(savedContent.includes('INR 8,500'));
  assert(savedContent.includes('invoice-october-omega.txt'));

  await page.locator('#side-nav').getByRole('link', { name: 'Task Center' }).click();
  await page.locator('.agent-badge-completed').first().waitFor();
  await page.getByText(new RegExp(`Verified: Documents/${reportFileName}`)).first().waitFor();

  // Reload to confirm SQLite task persistence
  await page.reload();
  await page.getByText(new RegExp(`Verified: Documents/${reportFileName}`)).first().waitFor();

  // Check /app/skills tool catalog
  await page.locator('#side-nav').getByRole('link', { name: 'Skills' }).click();
  await page.getByText(/Registered agent tools/).waitFor();
  await page.getByText(/save_report \(files\.save_report\)/).waitFor();

  assert.deepEqual(errors, []);
  console.log('PASS: voice/text tool parity, multi-step October invoice task, approval gate, verified disk report, SQLite reload persistence, tool catalog, WCAG A/AA, and mobile layout.');
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
