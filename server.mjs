import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({path:'.env.local'});
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, Behavior, FunctionResponseScheduling } from '@google/genai';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Calendar,business,today,datePlus } from './calendar.mjs';
import {voice} from './config.mjs';
import {resolve} from 'node:path';

const app=express(), port=Number(process.env.PORT||3000);
const calendar=new Calendar(process.env.CALENDAR_FILE === ':memory:' ? null : (process.env.CALENDAR_FILE?resolve(process.env.CALENDAR_FILE):fileURLToPath(new URL('./data/bookings.json',import.meta.url))));
const sessions=new Map();
app.use(express.json({limit:'96kb'}));
app.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','same-origin');
  res.set('Permissions-Policy','microphone=(self)');
  if(req.method!=='GET' && req.headers.origin!==`http://${req.headers.host}`) return res.status(403).json({error:'Unexpected request origin.'});
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('frontdesk='))?.slice(10);
  let state=sessions.get(cookie);
  if(!state) { const id=randomUUID(); state={id,draft:null,bookings:[],events:new Set(),live:null,seen:new Set(),closing:false}; sessions.set(id,state); res.cookie('frontdesk',id,{httpOnly:true,sameSite:'strict',maxAge:86400000}); }
  req.state=state; next();
});
function publish(state,type,data) { for(const r of state.events) r.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
function send(state,event) { if(state.live && !state.closing) { try {state.live.sendClientContent({turns:[{role:'user',parts:[{text:event.content}]}],turnComplete:true});} catch {} } }
function clearDraft(s) { if(s.draft){s.draft=null;publish(s,'draft',null);} }
const tools=[
  {type:'function',name:'check_availability',description:`Check open appointment times in ${business.name} local time. Call again when preferences change.`,parameters:{type:'object',properties:{serviceId:{type:'string',enum:business.services.map(s=>s.id)},date:{type:'string',description:`YYYY-MM-DD in ${business.timezone}`}},required:['serviceId','date'],additionalProperties:false},strict:true},
  {type:'function',name:'prepare_booking',description:'Prepare a review card with the exact chosen details. This does NOT save a booking. User must press Confirm booking in the app.',parameters:{type:'object',properties:{serviceId:{type:'string',enum:business.services.map(s=>s.id)},date:{type:'string'},time:{type:'string',description:'24-hour HH:mm'},name:{type:'string'}},required:['serviceId','date','time','name'],additionalProperties:false},strict:true}
];
function execute(s,name,args) {
  if(name==='check_availability') {clearDraft(s); const times=calendar.availability(args.serviceId,args.date);publish(s,'availability',{serviceId:args.serviceId,date:args.date,times}); return {date:args.date,timezone:business.timezone,times};}
  if(name==='prepare_booking') { s.draft=calendar.draft(args.serviceId,args.date,args.time,args.name);publish(s,'draft',s.draft);return {status:'awaiting_user_confirmation',details:s.draft,instruction:'Read the final details, then ask the user to press Confirm booking. Nothing has been saved yet.'}; }
  throw new Error('Unknown calendar tool.');
}
app.get('/api/state',(req,res)=>res.json({business,today:today(),maxDate:datePlus(business.calendar.bookingWindowDays),hasKey:!!process.env.GEMINI_API_KEY,bookings:req.state.bookings,draft:req.state.draft,provider:'gemini'}));
app.get('/api/events',(req,res)=>{res.set({'Content-Type':'text/event-stream',Connection:'keep-alive'});res.flushHeaders();req.state.events.add(res);res.write(': connected\n\n');const timer=setInterval(()=>res.write(': heartbeat\n\n'),20000);req.on('close',()=>{clearInterval(timer);req.state.events.delete(res);});});
app.get('/api/availability',(req,res)=>{try{res.json({times:calendar.availability(req.query.serviceId,req.query.date)});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/draft',(req,res)=>{try{const b=req.body;res.json(execute(req.state,'prepare_booking',b));}catch(e){res.status(400).json({error:e.message});}});
app.delete('/api/draft',(req,res)=>{clearDraft(req.state);res.json({ok:true});});
app.post('/api/confirm',(req,res)=>{
  const s=req.state;
  if(!s.draft || req.body.draftId!==s.draft.id) return res.status(409).json({error:'These details changed. Please review the latest appointment.'});
  try {const booking=calendar.confirm(s.draft);s.bookings.push(booking);clearDraft(s);publish(s,'booking',booking);send(s,{type:'session.instructions.append',delegation_id:null,content:'The user pressed Confirm booking. The booking is now saved successfully. Briefly acknowledge and ask if they are finished.'});res.json(booking);}
  catch(e){clearDraft(s);res.status(409).json({error:e.message});}
});
// Gemini credentials and tool execution remain exclusively on the application server.
app.post('/api/session/close',async(req,res)=>{await closeVoice(req.state);res.json({closed:true});});
app.use(express.static(fileURLToPath(new URL('./public',import.meta.url))));
app.use((err,req,res,next)=>res.status(400).json({error:'Invalid request.'}));
const server=app.listen(port,'127.0.0.1',()=>console.log(`Front Desk is ready at http://localhost:${port}`));
const voiceSockets=new WebSocketServer({noServer:true,maxPayload:64*1024});
server.on('upgrade',(req,socket,head)=>{
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('frontdesk='))?.slice(10);
  const state=sessions.get(cookie);
  if(req.url!=='/api/voice' || req.headers.origin!==`http://${req.headers.host}` || !state) {socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
  if(state.live || state.starting || state.socket) {socket.write('HTTP/1.1 409 Conflict\r\n\r\n');socket.destroy();return;}
  voiceSockets.handleUpgrade(req,socket,head,ws=>voiceSockets.emit('connection',ws,state));
});
async function closeVoice(s) {
  s.closing=true;
  const live=s.live, socket=s.socket;
  s.live=null;s.socket=null;s.starting=false;
  clearTimeout(s.voiceTimer);
  try{live?.close();}catch{}
  if(socket?.readyState===WebSocket.OPEN){socket.send(JSON.stringify({type:'closed'}));socket.close(1000,'Conversation finished');}
}
function voiceError(error) {
  const message=String(error?.message||error||'');
  if(/API.?key|UNAUTHENTICATED|401|403|PERMISSION_DENIED/i.test(message)) return 'Gemini rejected the server credential or model access. Check the Gemini API key and project permissions.';
  if(/429|RESOURCE_EXHAUSTED|quota/i.test(message))return 'Gemini usage or rate limit reached. Please try again later.';
  if(/404|not found|not supported/i.test(message))return 'The configured Gemini Live model is unavailable for this project.';
  return 'The Gemini voice service could not connect. Please retry or use the demo calendar.';
}
voiceSockets.on('connection',async(socket,s)=>{
  s.socket=socket;s.starting=true;s.closing=false;s.seen.clear();
  const cancelled=new Set();
  let ready=false,setup=false,started=false;
  const emit=value=>{if(socket.readyState===WebSocket.OPEN){if(socket.bufferedAmount>512*1024){closeVoice(s);return;}socket.send(JSON.stringify(value));}};
  const fail=error=>{if(s.closing)return;emit({type:'error',message:voiceError(error)});closeVoice(s);};
  const begin=()=>{if(!setup || !s.live || s.closing || started)return;started=true;ready=true;s.starting=false;emit({type:'ready'});s.live.sendClientContent({turns:[{role:'user',parts:[{text:`Please greet me as the ${business.name} AI receptionist and ask what I would like to book.`}]}],turnComplete:true});};
  socket.on('message',(raw,binary)=>{
    if(!ready || !s.live || s.closing)return;
    try{
      if(binary){if(raw.length>16000 || raw.length%2)return; s.live.sendRealtimeInput({audio:{data:raw.toString('base64'),mimeType:'audio/pcm;rate=16000'}});}
      else {const event=JSON.parse(raw.toString());if(event.type==='mute')s.live.sendRealtimeInput({audioStreamEnd:true});}
    }catch(error){fail(error);}
  });
  socket.on('close',()=>{if(s.socket===socket)closeVoice(s);});
  socket.on('error',()=>closeVoice(s));
  if(!process.env.GEMINI_API_KEY){emit({type:'error',message:'Voice needs a Gemini API key on the server. You can still use the demo calendar.'});await closeVoice(s);return;}
  s.voiceTimer=setTimeout(()=>{emit({type:'error',message:`This demo conversation reached its ${voice.maxMinutes}-minute limit. Start again to continue.`});closeVoice(s);},voice.maxMinutes*60*1000);
  const startupTimer=setTimeout(()=>fail(new Error('Startup timeout')),20000);
  try {
    const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
    const live=await ai.live.connect({
      model:voice.model,
      config:{
        responseModalities:[Modality.AUDIO],inputAudioTranscription:{},outputAudioTranscription:{},
        speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voice.name}}},
        realtimeInputConfig:{automaticActivityDetection:{disabled:false},activityHandling:'START_OF_ACTIVITY_INTERRUPTS'},
        contextWindowCompression:{slidingWindow:{}},
        systemInstruction:`You are the warm, concise AI voice receptionist at ${business.name}. Ask one question at a time. Let users interrupt, change preferences, and correct details. Keep talking naturally while asynchronous calendar tools run. Business: ${JSON.stringify(business)}. Today is ${today()} in ${business.timezone}. Accept dates through ${datePlus(business.calendar.bookingWindowDays)}. Prices are ${business.currency}. Always call check_availability before offering times. Never invent availability. Collect service, date, time and name before prepare_booking. Before booking, read the service, date, time in ${business.timezone}, name and price aloud and ask the user to press Confirm booking on the review card. A draft is NOT a booking. There is no save tool. Only the app can confirm success after the user presses the confirmation button. Whenever preferences change, check again and prepare a fresh draft. If a function call was canceled, discard it. When users are finished, direct them to Finish conversation.`,
        tools:[{functionDeclarations:tools.map(({name,description,parameters})=>({name,description,parametersJsonSchema:parameters,behavior:Behavior.NON_BLOCKING}))}]
      },
      callbacks:{
        onmessage:message=>{
          if(s.closing)return;
          if(message.setupComplete){setup=true;clearTimeout(startupTimer);begin();}
          const content=message.serverContent;
          if(content?.interrupted){clearDraft(s);emit({type:'interrupted'});}
          if(content?.inputTranscription?.text){clearDraft(s);emit({type:'transcript',speaker:'You',delta:content.inputTranscription.text});}
          if(content?.outputTranscription?.text)emit({type:'transcript',speaker:business.name,delta:content.outputTranscription.text});
          for(const part of content?.modelTurn?.parts||[])if(part.inlineData?.data)emit({type:'audio',data:part.inlineData.data,mimeType:part.inlineData.mimeType});
          if(content?.turnComplete)emit({type:'turnComplete'});
          for(const id of message.toolCallCancellation?.ids||[])cancelled.add(id);
          for(const call of message.toolCall?.functionCalls||[]){
            if(s.seen.has(call.id))continue;
            s.seen.add(call.id);
            // Yield tool work so new audio/events can continue through the Live connection.
            setImmediate(()=>{
              if(cancelled.has(call.id)||s.closing||s.live!==live)return;
              emit({type:'working',active:true});
              let result;try{result=execute(s,call.name,call.args||{});}catch(error){result={error:error.message};}
              if(!cancelled.has(call.id)&&!s.closing)try{live.sendToolResponse({functionResponses:[{id:call.id,name:call.name,response:result,scheduling:FunctionResponseScheduling.WHEN_IDLE}]});}catch(error){fail(error);}
              emit({type:'working',active:false});
            });
          }
          if(message.goAway){emit({type:'error',message:'Gemini is ending this connection. Finish and start a new conversation to continue.'});closeVoice(s);}
        },
        onerror:fail,
        onclose:event=>{clearTimeout(startupTimer);if(!s.closing)fail(new Error(event.reason||'Gemini ended the voice connection.'));}
      }
    });
    if(s.closing || socket.readyState!==WebSocket.OPEN){live.close();return;}
    s.live=live;begin();
  }catch(error){clearTimeout(startupTimer);fail(error);}
});
