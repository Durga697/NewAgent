// Exercise the actual Gemini SDK and browser audio path against a local provider double.
import {WebSocketServer} from 'ws';
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {datePlus} from '../calendar.mjs';
const provider=new WebSocketServer({port:0,host:'127.0.0.1'});
await new Promise(resolve=>provider.once('listening',resolve));
let upstream,setup,audioFrames=0,closed=false;const replies=[];
provider.on('connection',ws=>{upstream=ws;ws.on('close',()=>closed=true);ws.on('message',raw=>{const e=JSON.parse(raw.toString());
  if(e.setup){setup=e.setup;ws.send(JSON.stringify({setupComplete:{}}));}
  if(e.realtimeInput?.audio||e.realtimeInput?.mediaChunks)audioFrames++;
  if(e.toolResponse)replies.push(...e.toolResponse.functionResponses);
});});
const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,NODE_ENV:'test',PORT:'3002',CALENDAR_FILE:':memory:',GEMINI_API_KEY:'local-test-credential',GOOGLE_GEMINI_BASE_URL:`http://127.0.0.1:${provider.address().port}`},stdio:['ignore','pipe','pipe']});
let browser;
const wait=async condition=>{for(let n=0;n<100;n++){if(condition())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out waiting for mock voice event');};
try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timeout')),10000);server.stdout.on('data',d=>{if(d.toString().includes('ready')){clearTimeout(timer);resolve();}});});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  const context=await browser.newContext({permissions:['microphone']});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:3002');await page.locator('.slot').first().waitFor();
  await page.getByRole('button',{name:'Start a conversation'}).click();await page.getByText('Connected · listening').waitFor();
  assert.equal(setup.model,'models/gemini-3.8-live');assert(setup.systemInstruction.parts.some(p=>p.text?.includes('Indian English')));assert(setup.systemInstruction.parts.some(p=>p.text?.includes('Edith')));assert(setup.tools[0].functionDeclarations.every(f=>f.behavior==='NON_BLOCKING'));
  await wait(()=>audioFrames>0);
  const call=(id,name,args)=>upstream.send(JSON.stringify({toolCall:{functionCalls:[{id,name,args}]}}));
  call('availability','check_availability',{serviceId:'consult',date:datePlus(1)});await wait(()=>replies.some(r=>r.id==='availability'));
  assert(replies.find(r=>r.id==='availability').response.times.includes('09:00'));
  call('draft','prepare_booking',{serviceId:'consult',date:datePlus(1),time:'09:00',name:'Voice Guest'});await page.getByRole('button',{name:'Confirm booking'}).waitFor();
  let state=await(await context.request.get('http://localhost:3002/api/state')).json();assert.equal(state.bookings.length,0);
  const pcm=Buffer.alloc(4800);upstream.send(JSON.stringify({serverContent:{modelTurn:{role:'model',parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:pcm.toString('base64')}}]},outputTranscription:{text:'Shall we try another time?'}}}));
  await page.getByText('Shall we try another time?').waitFor();
  upstream.send(JSON.stringify({serverContent:{interrupted:true,inputTranscription:{text:'Make that tomorrow morning.'}}}));await page.getByText('Make that tomorrow morning.').waitFor();await page.getByRole('button',{name:'Confirm booking'}).waitFor({state:'hidden'});
  upstream.send(JSON.stringify({toolCallCancellation:{ids:['cancelled']},toolCall:{functionCalls:[{id:'cancelled',name:'prepare_booking',args:{serviceId:'consult',date:datePlus(1),time:'09:00',name:'Cancelled'}}]}}));
  await new Promise(r=>setTimeout(r,100));assert(!replies.some(r=>r.id==='cancelled'));
  await page.getByRole('button',{name:'Mute mic',exact:true}).click();await page.getByText('Microphone muted').waitFor();await page.getByRole('button',{name:'Unmute mic',exact:true}).click();
  await page.getByRole('button',{name:'Finish conversation'}).click();await page.getByRole('button',{name:'Start a conversation'}).waitFor();await wait(()=>closed);
  assert.deepEqual(errors,[]);
  console.log('PASS: Gemini SDK setup, non-blocking tools, real browser PCM capture, captions/audio playback, draft-only tool, interruption invalidation, cancelled calls, mute/unmute, upstream shutdown. (Local provider double; no paid API calls.)');
}finally{await browser?.close();server.kill();for(const ws of provider.clients)ws.terminate();await new Promise(resolve=>provider.close(resolve));}
