import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3003',CALENDAR_FILE:':memory:',BUSINESS_CONFIG:'config/examples/clinic.json'},stdio:['ignore','pipe','pipe']});
let browser;
try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Server startup timeout')),10000);server.stdout.on('data',d=>{if(d.toString().includes('ready')){clearTimeout(t);resolve();}});});
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();
  await page.goto('http://localhost:3003');await page.locator('#businessTagline').getByText('Time for your wellbeing.').waitFor();
  assert.equal(await page.locator('.business-card h2').textContent(),'Harbour Clinic');
  assert.equal(await page.locator('#businessTimezone').textContent(),'Europe/London');
  assert.equal(await page.locator('#service option').count(),2);
  assert((await page.locator('#service option').first().textContent()).includes('£75'));
  assert(!(await page.locator('body').textContent()).includes('Juniper'));
  const state=await(await page.request.get('http://localhost:3003/api/state')).json();
  assert.equal(state.business.calendar.bookingWindowDays,14);
  console.log('PASS: alternate clinic config updates browser branding, services, currency, timezone and booking limits without application edits.');
}finally{await browser?.close();server.kill();}
