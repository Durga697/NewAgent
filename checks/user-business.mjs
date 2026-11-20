import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { disposable, removeDisposable } from './helpers/fixtures.mjs';

const dir = await disposable('user-business-e2e-');
const usersFile = path.join(dir, 'users.json');
const port = 3018;
const base = `http://localhost:${port}`;

const server = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    CALENDAR_FILE: ':memory:',
    USERS_FILE: usersFile
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('User business test server startup timeout')), 15000);
    server.stdout.on('data', (d) => {
      if (d.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited ${code}`));
    });
  });

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(base);
  assert.equal(new URL(page.url()).pathname, '/desk');
  await page.locator('.slot').first().waitFor();

  // Register User A on Front Desk
  const setup = page.locator('#companySetupSection');
  await setup.getByLabel('Your full name').fill('Alice Verma');
  await setup.getByLabel('Account email').fill('alice@verma.example');
  await setup.getByLabel('Password (8+ characters)').fill('alice-pass-1');
  await setup.getByLabel('Company name').fill('Verma Advisory');
  await setup.getByLabel('Company address').fill('14 MG Road, Bengaluru');
  await setup.getByLabel('Primary contact phone (optional)').fill('+91 98111 00001');
  await setup.getByRole('button', { name: 'Create account & continue' }).click();
  await setup.getByRole('button', { name: 'Save company & services' }).waitFor();

  // Configure Service 1 and add Service 2 with personal contacts
  const svc1 = setup.locator('.biz-service-item').nth(0);
  await svc1.getByLabel('Service name').fill('Tax Consultation');
  await svc1.getByLabel(/Price/).fill('1500');
  await svc1.getByLabel('Duration (minutes)').fill('45');
  await svc1.getByLabel('Description (optional)').fill('Annual tax review');
  await svc1.getByLabel('Contact person name').fill('Rohan Mehta');
  await svc1.getByLabel('Role or title (optional)').fill('Senior CA');
  await svc1.getByLabel('Personal phone').fill('+91 98222 11111');
  await svc1.getByLabel('Personal email').fill('rohan@verma.example');

  await setup.getByRole('button', { name: '+ Add service' }).click();
  const svc2 = setup.locator('.biz-service-item').nth(1);
  await svc2.getByLabel('Service name').fill('Audit Review');
  await svc2.getByLabel(/Price/).fill('3000');
  await svc2.getByLabel('Duration (minutes)').fill('60');
  await svc2.getByLabel('Contact person name').fill('Priya Nair');
  await svc2.getByLabel('Personal phone').fill('+91 98222 22222');
  await svc2.getByLabel('Personal email').fill('priya@verma.example');

  await setup.getByRole('button', { name: 'Save company & services' }).click();
  await setup.getByText('Company details, services, prices, and personal contacts saved.').waitFor();

  // Verify Front Desk reflects User A's company, services, prices & contacts
  assert.equal(await page.locator('.business-card h2').textContent(), 'Verma Advisory');
  assert.equal(await page.locator('#businessAddress').textContent(), '14 MG Road, Bengaluru');
  assert((await page.locator('#businessContact').textContent()).includes('+91 98111 00001'));
  await page.locator('#servicesDirectory').getByText('Rohan Mehta').waitFor();
  await page.locator('#servicesDirectory').getByText('Priya Nair').waitFor();
  await page.locator('#serviceContactPreview').getByText(/Rohan Mehta/).waitFor();

  // Book Tax Consultation
  await page.locator('.slot').first().click();
  await page.getByLabel('YOUR NAME').fill('Client One');
  await page.getByRole('button', { name: 'Review appointment' }).click();
  await page.locator('#reviewCard').getByText(/Rohan Mehta/).waitFor();
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await page.locator('.confirmed').waitFor();

  // Reload and verify persistence
  await page.reload();
  await page.locator('.confirmed').waitFor();
  assert.equal(await page.locator('.business-card h2').textContent(), 'Verma Advisory');
  await page.locator('#bookings').getByText('Client One').waitFor();
  await page.locator('#bookings').getByText(/Rohan Mehta/).waitFor();

  // Verify EDITH OS /app/settings and /app/calendar + axe-core WCAG A/AA
  await page.goto(`${base}/app/settings`);
  await page.getByRole('button', { name: 'Save company & services' }).waitFor();
  assert.equal(await page.locator('#page-body').getByLabel('Company name').inputValue(), 'Verma Advisory');
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const violations = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
        .violations.map((v) => [v.id, v.nodes.map((n) => n.target)])
    );
    assert.deepEqual(violations, [], `/app/settings ${width}px accessibility: ${JSON.stringify(violations)}`);
  }

  await page.goto(`${base}/app/calendar`);
  await page.getByText('Verma Advisory — Services & Contacts').waitFor();
  await page.getByText(/Personal contact: Rohan Mehta/).waitFor();
  await page.getByText(/Service contact: Rohan Mehta/).waitFor();
  await page.getByText(/Tax Consultation — Client One/).waitFor();
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const violations = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }))
        .violations.map((v) => [v.id, v.nodes.map((n) => n.target)])
    );
    assert.deepEqual(violations, [], `/app/calendar ${width}px accessibility: ${JSON.stringify(violations)}`);
  }

  // Sign out on /app/settings and create User B on /desk
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/app/settings`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Create account & continue' }).waitFor();

  await page.goto(`${base}/desk`);
  await setup.getByLabel('Your full name').fill('Bob Smith');
  await setup.getByLabel('Account email').fill('bob@smith.example');
  await setup.getByLabel('Password (8+ characters)').fill('bob-pass-2');
  await setup.getByLabel('Company name').fill('Smith Design');
  await setup.getByLabel('Company address').fill('200 Market St, San Francisco');
  await setup.getByRole('button', { name: 'Create account & continue' }).click();
  await setup.getByRole('button', { name: 'Save company & services' }).waitFor();

  const bobSvc = setup.locator('.biz-service-item').nth(0);
  await bobSvc.getByLabel('Service name').fill('Brand Sprint');
  await bobSvc.getByLabel(/Price/).fill('250');
  await bobSvc.getByLabel('Contact person name').fill('Bob Smith');
  await bobSvc.getByLabel('Personal phone').fill('+1 415 555 0100');
  await setup.getByRole('button', { name: 'Save company & services' }).click();
  await setup.getByText('Company details, services, prices, and personal contacts saved.').waitFor();

  assert.equal(await page.locator('.business-card h2').textContent(), 'Smith Design');
  assert.equal(await page.locator('#bookingCount').textContent(), '0');
  assert(!(await page.locator('body').textContent()).includes('Verma Advisory'));

  // Sign out and sign back in as User A
  await setup.getByRole('button', { name: 'Sign out' }).click();
  await setup.getByRole('button', { name: 'Sign in', exact: true }).click();
  await setup.getByLabel('Account email').fill('alice@verma.example');
  await setup.getByLabel('Password').fill('alice-pass-1');
  await setup.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await setup.getByRole('button', { name: 'Save company & services' }).waitFor();

  assert.equal(await page.locator('.business-card h2').textContent(), 'Verma Advisory');
  assert.equal(await page.locator('#bookingCount').textContent(), '1');
  await page.locator('#bookings').getByText('Client One').waitFor();

  // Check mobile layout overflow
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile overflow on /desk');
  assert.deepEqual(errors, []);

  console.log('PASS: multi-user accounts, company details, services, prices, personal contacts, persistence, isolation, /app integration, WCAG A/AA, and mobile layout.');
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', resolve);
  });
  await removeDisposable(dir);
}

