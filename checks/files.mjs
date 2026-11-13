import {chromium} from '@playwright/test';
import {WebSocketServer} from 'ws';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,utimes,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadFileConfig} from '../tools/config.mjs';
const temp=await mkdtemp(path.join(tmpdir(),'edith-files-integration-')),root=path.join(temp,'Downloads');await mkdir(root);
const config={...await loadFileConfig(),enabled:true,roots:[{id:'Downloads',path:root}],auditFile:path.join(temp,'audit.jsonl')};
const configPath=path.join(temp,'files.json');await writeFile(configPath,JSON.stringify(config));
for(const [name,date] of [['electricity bill January.pdf','2026-01-02'],['electricity bill February.pdf','2026-02-02'],['unsafe.js','2026-02-01']]){const file=path.join(root,name);await writeFile(file,'Fictional test document, not sent to Gemini.');await utimes(file,new Date(date),new Date(date));}
const provider=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>provider.once('listening',r));
let upstream;const replies=[];
provider.on('connection',ws=>{upstream=ws;ws.on('message',raw=>{const e=JSON.parse(raw);if(e.setup){assert(e.setup.tools[0].functionDeclarations.some(t=>t.name==='search_files'));ws.send(JSON.stringify({setupComplete:{}}));}if(e.toolResponse)replies.push(...e.toolResponse.functionResponses);});});
const launchLog=path.join(temp,'launch.jsonl');
const server=spawn(process.execPath,['--import','./checks/helpers/mock-explorer.mjs','server.mjs'],{env:{...process.env,NODE_ENV:'test',PORT:'3005',CALENDAR_FILE:':memory:',FILE_TOOLS_CONFIG:configPath,GEMINI_API_KEY:'local-test-key',GOOGLE_GEMINI_BASE_URL:`http://127.0.0.1:${provider.address().port}`,EDITH_TEST_LAUNCH_LOG:launchLog},stdio:['ignore','pipe','pipe']});
let browser;
async function wait(check){for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Integration condition timed out.');}
try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('File test server startup timeout')),12000);server.stdout.on('data',d=>{if(d.toString().includes('ready')){clearTimeout(t);resolve();}});server.once('error',reject);});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});const context=await browser.newContext({permissions:['microphone']});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:3005');await page.getByRole('button',{name:'Search files',exact:true}).waitFor();
  await page.getByRole('button',{name:'Start a conversation'}).click();await page.getByText('Connected · listening').waitFor();
  const call=async(id,name,args)=>{upstream.send(JSON.stringify({toolCall:{functionCalls:[{id,name,args}]}}));await wait(()=>replies.some(r=>r.id===id));return replies.find(r=>r.id===id).response;};
  const speech=text=>upstream.send(JSON.stringify({serverContent:{inputTranscription:{text},turnComplete:true}}));
  speech('Find my latest electricity bill in Downloads');const found=await call('search','search_files',{query:'electrcity bill',folder:'Downloads',extensions:['pdf'],sortBy:'modifiedDesc'});
  assert.equal(found.results.length,2);assert.equal(found.results[0].name,'electricity bill February.pdf');await page.getByText('2. electricity bill January.pdf',{exact:true}).waitFor();
  assert.equal((await call('unrequested','open_file',{resultId:found.results[0].resultId})).status,'confirmation_required');
  speech('Open the second one');assert.equal((await call('open-second','open_file',{resultId:found.results[1].resultId})).status,'launched');
  let launched=(await readFile(launchLog,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(launched.length,1);assert.equal(launched[0].args[0],await realpath(path.join(root,'electricity bill January.pdf')));assert.equal(launched[0].shell,false);
  await page.getByRole('button',{name:'Show in folder: electricity bill February.pdf',exact:true}).click();await page.getByText('The show-in-folder request was handed to Windows Explorer.').waitFor();
  launched=(await readFile(launchLog,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(launched[1].args[0],'/select,');
  const forbidden=await context.request.post('http://localhost:3005/api/file-tools/search_files',{headers:{Origin:'http://localhost:3005'},data:{query:'secret',folder:temp}});assert.equal(forbidden.status(),400);assert.equal((await forbidden.json()).error.code,'OUTSIDE_ALLOWLIST');
  const blocked=await call('search-script','search_files',{query:'unsafe'});assert.equal((await call('open-script','open_file',{resultId:blocked.results[0].resultId})).error.code,'BLOCKED_EXTENSION');
  await page.getByLabel('FILENAME WORDS').fill('electricity bill');await page.getByRole('button',{name:'Search files',exact:true}).click();await page.getByText('2 matching files.',{exact:true}).waitFor();
  await mkdir('data',{recursive:true});await page.locator('#localFiles').screenshot({path:'data/file-panel-preview.png'});
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'Finish conversation'}).click();await page.getByRole('button',{name:'Start a conversation'}).waitFor();
  const audit=await readFile(config.auditFile,'utf8');assert(audit.includes('OUTSIDE_ALLOWLIST'));assert(audit.includes('BLOCKED_EXTENSION'));
  console.log('PASS: voice search -> Gemini tool -> server -> SSE results; latest-first; voice opens second result; click reveals correct file; blocked/outside paths refused and audited; manual search; mobile. Windows launch was intercepted by a test-only preload. No personal files or paid AI calls.');
}finally{
  await browser?.close();server.kill();await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.once('exit',resolve);});for(const ws of provider.clients)ws.terminate();await new Promise(resolve=>provider.close(resolve));
  const target=path.resolve(temp);assert(target.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(target).startsWith('edith-files-integration-'));await rm(target,{recursive:true,force:true});
}
