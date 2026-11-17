import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,NODE_ENV:'test',PORT:'3001',CALENDAR_FILE:':memory:'},stdio:['ignore','pipe','pipe']});
let browser;
try {
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Test server startup timed out')),10000);server.stdout.on('data',d=>{if(d.toString().includes('ready')){clearTimeout(t);resolve();}});server.on('error',reject);});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Test permission denied','NotAllowedError');};});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:3001/demo');await page.locator('.slot').first().waitFor();
  assert.equal(await page.title(),'Front Desk — A conversation away');
  await page.locator('.slot').first().click();await page.getByLabel('YOUR NAME').fill('Demo Guest');await page.getByRole('button',{name:'Review appointment'}).click();
  await page.getByRole('button',{name:'Confirm booking'}).waitFor();
  let state=await (await context.request.get('http://localhost:3001/api/state')).json();assert.equal(state.bookings.length,0);assert(state.draft);
  const oldDraft=state.draft.id,csrf=state.csrfToken;
  await page.getByRole('button',{name:'Change details'}).click();await page.getByRole('button',{name:'Review appointment'}).click();await page.getByRole('button',{name:'Confirm booking'}).waitFor();
  const stale=await context.request.post('http://localhost:3001/api/confirm',{headers:{Origin:'http://localhost:3001','X-Edith-CSRF':csrf},data:{draftId:oldDraft}});assert.equal(stale.status(),409);
  await page.getByRole('button',{name:'Confirm booking'}).click();await page.locator('.confirmed').waitFor();
  state=await (await context.request.get('http://localhost:3001/api/state')).json();assert.equal(state.bookings.length,1);assert.equal(state.draft,null);
  const times=await (await context.request.get(`http://localhost:3001/api/availability?serviceId=cut&date=${state.bookings[0].date}`)).json();assert(!times.times.includes(state.bookings[0].time));
  const repeated=await context.request.post('http://localhost:3001/api/confirm',{headers:{Origin:'http://localhost:3001','X-Edith-CSRF':csrf},data:{draftId:oldDraft}});assert.equal(repeated.status(),409);
  const forbidden=await context.request.post('http://localhost:3001/api/confirm',{headers:{Origin:'https://untrusted.example','X-Edith-CSRF':csrf},data:{draftId:oldDraft}});assert.equal(forbidden.status(),403);
  await page.getByRole('button',{name:'Start a conversation'}).click();await page.getByText(/Microphone permission was denied/).waitFor();assert(await page.getByRole('button',{name:'Start a conversation'}).isEnabled());
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);
  console.log('PASS: browser render, review before save, stale draft rejection, confirmation, conflict refresh, duplicate rejection, origin guard, microphone denial cleanup, mobile layout, no browser errors.');
}finally{await browser?.close();server.kill();}
