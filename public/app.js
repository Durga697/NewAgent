const $=id=>document.getElementById(id);
let state,selectedTime=null,draft=null,voiceSocket=null,audioContext=null,capture=null,source=null,stream=null,active=false,starting=false,ending=false,muted=false,generation=0,lastSpeaker=null,lastCaption=null,lastEnd=0;
let nextPlayback=0;const playbackSources=new Set();
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const timeLabel=t=>new Intl.DateTimeFormat(state.business.locale,{hour:'numeric',minute:'2-digit',timeZone:'UTC'}).format(new Date(`2000-01-01T${t}:00Z`));
const dateLabel=d=>new Intl.DateTimeFormat(state.business.locale,{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${d}T12:00:00Z`));
const price=(n,currency=state.business.currency)=>new Intl.NumberFormat(state.business.locale,{style:'currency',currency,maximumFractionDigits:2}).format(n);
function renderBusiness(){
  const b=state.business;document.documentElement.lang=b.locale;
  document.querySelectorAll('[data-business-name]').forEach(el=>el.textContent=b.name);
  document.querySelectorAll('[data-business-initial]').forEach(el=>el.textContent=Array.from(b.name)[0]);
  document.querySelectorAll('[data-business-initials]').forEach(el=>el.textContent=b.name.split(/\s+/).map(w=>Array.from(w)[0]).slice(0,2).join(''));
  $('businessTagline').textContent=b.tagline;$('businessAddress').textContent=b.address;$('businessTimezone').textContent=b.timezone;
  const days=b.calendar.openWeekdays.map(day=>new Intl.DateTimeFormat(b.locale,{weekday:'short',timeZone:'UTC'}).format(new Date(Date.UTC(2024,0,7+day))));
  $('businessHours').textContent=`${days.join(', ')} · ${timeLabel(b.calendar.opensAt)}–${timeLabel(b.calendar.closesAt)} (${b.timezone})`;
  $('exampleRequest').textContent=`Try “I'd like to book ${b.services[0].name.toLowerCase()} tomorrow.”`;
}
async function request(url,options={}){const r=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const body=await r.json();if(!r.ok)throw new Error(body.error||'Something went wrong. Please try again.');return body;}
function notice(text){$('notice').textContent=text;$('notice').classList.toggle('hidden',!text);}
function status(text,live=false){$('status').textContent=text;$('status').classList.toggle('live',live);}
function controls(){ $('start').classList.toggle('hidden',active||starting);$('start').disabled=starting||ending;$('callControls').classList.toggle('hidden',!active&&!starting);$('finish').disabled=ending;$('mute').disabled=ending||!active;$('orbWrap').classList.toggle('listening',active&&!muted&&!ending);$('voiceTitle').textContent=active?'Go ahead. We’re listening.':'Let’s find your perfect time.';$('voiceHint').innerHTML=active?'Take your time. You can interrupt,<br>or change your preferences anytime.':'A friendly voice. A few simple questions.<br>One less thing on your to-do list.'; }
let availabilityVersion=0;
async function availability(){const version=++availabilityVersion;selectedTime=null;$('review').disabled=true;$('slots').textContent='Checking the calendar…';try{const r=await request(`/api/availability?serviceId=${encodeURIComponent($('service').value)}&date=${encodeURIComponent($('date').value)}`);if(version!==availabilityVersion)return;renderSlots(r.times);}catch(e){if(version===availabilityVersion){$('slots').textContent=e.message;$('slotCount').textContent='';}}}
function renderSlots(times){selectedTime=null;$('review').disabled=true;$('slots').replaceChildren();$('slotCount').textContent=`${times.length} open`;if(!times.length){$('slots').textContent='No open times. Try another day.';return;}for(const time of times){const b=document.createElement('button');b.className='slot';b.textContent=timeLabel(time);b.setAttribute('aria-pressed','false');b.onclick=async()=>{selectedTime=time;document.querySelectorAll('.slot').forEach(x=>{x.classList.remove('selected');x.setAttribute('aria-pressed','false');});b.classList.add('selected');b.setAttribute('aria-pressed','true');$('review').disabled=false;await invalidateDraft();};$('slots').append(b);}}
async function invalidateDraft(){renderDraft(null);try{await request('/api/draft',{method:'DELETE'});}catch(e){notice(e.message);}}
for(const id of ['service','date']) $(id).addEventListener('change',async()=>{await invalidateDraft();availability();});
$('name').addEventListener('input',()=>{if(draft)invalidateDraft();});
$('review').onclick=async()=>{notice('');if(!$('name').value.trim()){$('name').focus();notice('Add your name so we can prepare your appointment.');return;}$('review').disabled=true;try{const r=await request('/api/draft',{method:'POST',body:JSON.stringify({serviceId:$('service').value,date:$('date').value,time:selectedTime,name:$('name').value})});renderDraft(r.details);$('reviewCard').scrollIntoView({behavior:'smooth',block:'center'});}catch(e){notice(e.message);}finally{$('review').disabled=!selectedTime;}};
function renderDraft(value){draft=value;$('reviewCard').classList.toggle('hidden',!value);if(!value){$('reviewCard').replaceChildren();return;}const d=value;$('reviewCard').innerHTML=`<div class="eyebrow">ONE LAST LOOK</div><h2>Does everything look right?</h2><p>Your appointment is ready to review. Confirm these details to save it.</p><div class="review-details"><div><small>SERVICE</small>${esc(d.service)} · ${d.minutes} min</div><div><small>WHEN</small>${esc(dateLabel(d.date))} · ${esc(timeLabel(d.time))} ${esc(d.timezone)}</div><div><small>FOR</small>${esc(d.name)}</div><div><small>TOTAL</small>${price(d.price,d.currency)}</div></div><div class="review-actions"><button id="confirm" class="primary">Confirm booking <span>✓</span></button><button id="edit" class="secondary">Change details</button></div>`;
  $('confirm').onclick=async()=>{const id=d.id;$('confirm').disabled=true;try{await request('/api/confirm',{method:'POST',body:JSON.stringify({draftId:id})});renderDraft(null);notice('You’re booked! Your appointment is saved in the demo calendar.');await availability();}catch(e){notice(e.message);renderDraft(null);await availability();}};
  $('edit').onclick=()=>{invalidateDraft();$('service').focus();};
}
function renderBookings(){const all=state.bookings;$('bookingCount').textContent=all.length;if(!all.length)return;$('bookings').innerHTML=all.map(b=>`<article class="booking"><div><h3>${esc(b.service)}</h3><p>${esc(dateLabel(b.date))} · ${esc(timeLabel(b.time))} ${esc(b.timezone)} · ${b.minutes} min</p></div><div><h3>${esc(b.name)}</h3><p>${price(b.price,b.currency)} · ${esc(b.businessName||state.business.name)}</p></div><span class="confirmed">✓ Confirmed</span></article>`).join('');}
function caption(e,speaker){if(document.querySelector('.caption-empty'))$('transcript').replaceChildren();if(lastSpeaker!==speaker || !lastCaption || e.start_ms-lastEnd>2000){const row=document.createElement('div');row.className='caption-line';const label=document.createElement('strong');label.textContent=speaker;lastCaption=document.createElement('span');row.append(label,lastCaption);$('transcript').append(row);}lastCaption.textContent+=e.delta;lastSpeaker=speaker;lastEnd=e.end_ms;$('transcript').scrollTop=$('transcript').scrollHeight;}
function stopPlayback(){for(const node of playbackSources){try{node.stop();}catch{}}playbackSources.clear();nextPlayback=0;}
function playAudio(data,mimeType){
  if(!audioContext || ending)return;
  if(audioContext.state==='suspended'){$('resumeAudio').classList.remove('hidden');return;}
  const binary=atob(data),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  const rate=Number(/rate=(\d+)/.exec(mimeType||'')?.[1]||24000);
  const view=new DataView(bytes.buffer),buffer=audioContext.createBuffer(1,Math.floor(bytes.length/2),rate),channel=buffer.getChannelData(0);
  for(let i=0;i<channel.length;i++)channel[i]=view.getInt16(i*2,true)/32768;
  if(nextPlayback>audioContext.currentTime+12){stopPlayback();notice('Audio playback fell behind. Please repeat your last request.');return;}
  const node=audioContext.createBufferSource();node.buffer=buffer;node.connect(audioContext.destination);playbackSources.add(node);node.onended=()=>playbackSources.delete(node);
  nextPlayback=Math.max(nextPlayback,audioContext.currentTime+.025);node.start(nextPlayback);nextPlayback+=buffer.duration;
}
function release(){
  stream?.getTracks().forEach(t=>t.stop());stream=null;capture?.disconnect();source?.disconnect();capture=null;source=null;
  stopPlayback();voiceSocket?.close();voiceSocket=null;audioContext?.close().catch(()=>{});audioContext=null;$('resumeAudio').classList.add('hidden');
  active=false;starting=false;ending=false;muted=false;$('mute').textContent='Mute mic';controls();
}
async function end(){if(ending)return;generation++;ending=true;controls();status('Finishing…');stream?.getTracks().forEach(t=>t.stop());stopPlayback();try{const result=await request('/api/session/close',{method:'POST',body:'{}'});if(!result.closed)notice('Microphone is off. Voice finalization could not be confirmed.');}catch{notice('Microphone is off. The server could not confirm session finalization.');}finally{release();status('Conversation finished');}}
$('start').onclick=async()=>{
  if(starting||active||ending)return;const run=++generation;starting=true;controls();notice('');status('Waiting for microphone…');lastSpeaker=null;lastCaption=null;
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone access needs localhost or HTTPS and a supported browser. You can use the calendar below.');
    const ctx=new AudioContext();audioContext=ctx;await ctx.resume();
    const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,channelCount:1}});
    if(run!==generation){media.getTracks().forEach(t=>t.stop());await ctx.close().catch(()=>{});return;}stream=media;
    await ctx.audioWorklet.addModule('/pcm-capture.js');
    if(run!==generation)return;
    source=ctx.createMediaStreamSource(stream);capture=new AudioWorkletNode(ctx,'pcm-capture');
    source.connect(capture);capture.connect(ctx.destination);
    status('Connecting to Gemini…');
    const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/voice`);voiceSocket=ws;
    capture.port.onmessage=e=>{if(active&&!muted&&ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<128*1024)ws.send(e.data);};
    const startupTimer=setTimeout(()=>{if(run===generation&&starting){notice('Gemini did not become ready. Please try again.');end();}},25000);
    ws.onmessage=message=>{
      if(run!==generation)return;
      let e;try{e=JSON.parse(message.data);}catch{return;}
      if(e.type==='ready'){clearTimeout(startupTimer);active=true;starting=false;controls();status('Connected · listening',true);}
      if(e.type==='transcript')caption({delta:e.delta,start_ms:0,end_ms:0},e.speaker);
      if(e.type==='audio')playAudio(e.data,e.mimeType);
      if(e.type==='interrupted'){stopPlayback();lastSpeaker=null;lastCaption=null;}
      if(e.type==='turnComplete'){lastSpeaker=null;lastCaption=null;}
      if(e.type==='working')$('workStatus').textContent=e.active?'Checking with the calendar…':'Calendar checked';
      if(e.type==='error'){clearTimeout(startupTimer);notice(e.message);end();}
      if(e.type==='closed'&&!ending){clearTimeout(startupTimer);release();status('Conversation finished');}
    };
    ws.onerror=()=>{if(run===generation){clearTimeout(startupTimer);notice('Could not connect to the voice server. Please try again.');end();}};
    ws.onclose=()=>{clearTimeout(startupTimer);if(run===generation&&!ending){notice('Voice connection ended. You can start a new conversation.');release();status('Conversation finished');}};
  }catch(e){if(run!==generation)return;const message=e.name==='NotAllowedError'?'Microphone permission was denied. Allow microphone access in your browser’s site settings and try again. You can also use the calendar.':e.name==='NotFoundError'?'No microphone was found. Connect one, or use the calendar.':e.message;notice(message);await request('/api/session/close',{method:'POST',body:'{}'}).catch(()=>{});release();status('Ready when you are');}
};
$('finish').onclick=end;
$('resumeAudio').onclick=async()=>{try{await audioContext?.resume();$('resumeAudio').classList.add('hidden');notice('');}catch{notice('Your browser is still blocking audio playback.');}};
$('mute').onclick=()=>{muted=!muted;stream?.getAudioTracks().forEach(t=>t.enabled=!muted);if(muted&&voiceSocket?.readyState===WebSocket.OPEN)voiceSocket.send(JSON.stringify({type:'mute'}));$('mute').textContent=muted?'Unmute mic':'Mute mic';status(muted?'Microphone muted':'Connected · listening',!muted);controls();};
$('navBookings').onclick=()=>$('appointments').scrollIntoView({behavior:'smooth'});
$('navDesk').onclick=()=>window.scrollTo({top:0,behavior:'smooth'});
window.addEventListener('pagehide',()=>{if(active||starting||ending){navigator.sendBeacon('/api/session/close',new Blob(['{}'],{type:'application/json'}));stream?.getTracks().forEach(t=>t.stop());voiceSocket?.close();stopPlayback();audioContext?.close().catch(()=>{});}});

async function init(){try{state=await request('/api/state');renderBusiness();$('service').innerHTML=state.business.services.map(s=>`<option value="${esc(s.id)}">${esc(s.name)} · ${s.minutes} min · ${price(s.price)}</option>`).join('');$('date').min=state.today;$('date').max=state.maxDate;const tomorrow=new Date(`${state.today}T12:00:00Z`);tomorrow.setUTCDate(tomorrow.getUTCDate()+1);$('date').value=tomorrow.toISOString().slice(0,10);renderBookings();renderDraft(state.draft);await availability();if(!state.hasKey)notice('The demo calendar is ready. Voice needs a Gemini API key configured on the server.');
  const events=new EventSource('/api/events');events.addEventListener('availability',e=>{const data=JSON.parse(e.data);availabilityVersion++;$('service').value=data.serviceId;$('date').value=data.date;renderSlots(data.times);});events.addEventListener('draft',e=>{const d=JSON.parse(e.data);renderDraft(d);if(d){$('name').value=d.name;$('reviewCard').scrollIntoView({behavior:'smooth',block:'center'});}});events.addEventListener('booking',e=>{const b=JSON.parse(e.data);if(!state.bookings.some(x=>x.id===b.id))state.bookings.push(b);renderBookings();availability();});events.addEventListener('voiceError',e=>{notice(JSON.parse(e.data).message);if(active||starting)end();});events.addEventListener('closed',()=>{if(!ending){release();status('Conversation finished');}});
}catch(e){notice(`Could not load the calendar: ${e.message}`);$('start').disabled=true;}}
init();
