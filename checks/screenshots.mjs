import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
const output=new URL('../docs/screenshots/',import.meta.url);
await mkdir(output,{recursive:true});
const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,NODE_ENV:'test',PORT:'3004',CALENDAR_FILE:':memory:'},stdio:['ignore','pipe','pipe']});
let browser;
try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Screenshot server did not start')),10000);server.once('error',reject);server.stdout.on('data',d=>{if(d.toString().includes('ready')){clearTimeout(timer);resolve();}});});
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
  await page.goto('http://localhost:3004');await page.locator('.slot').first().waitFor();await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:fileURLToPath(new URL('desktop.png',output)),fullPage:true});
  await page.locator('.slot').first().click();await page.getByLabel('YOUR NAME').fill('Alex Morgan');await page.getByRole('button',{name:'Review appointment'}).click();await page.getByRole('button',{name:'Confirm booking'}).waitFor();
  await page.locator('#reviewCard').screenshot({path:fileURLToPath(new URL('review.png',output))});
  await page.getByRole('button',{name:'Confirm booking'}).click();await page.locator('.confirmed').waitFor();
  await page.locator('#appointments').screenshot({path:fileURLToPath(new URL('confirmed.png',output))});
  await page.setViewportSize({width:390,height:844});await page.reload();await page.locator('.slot').first().waitFor();await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:fileURLToPath(new URL('mobile.png',output)),fullPage:true});
  console.log('Saved four real application screenshots. Demo data only; no voice API calls.');
}finally{await browser?.close();server.kill();}
