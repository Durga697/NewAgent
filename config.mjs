import {loadEnvironment} from './environment.mjs';
import {readFileSync} from 'node:fs';
loadEnvironment();

const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function minuteOfDay(time) {
  if(typeof time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Times must use HH:mm (00:00–23:59).');
  const [h,m]=time.split(':').map(Number);return h*60+m;
}

export function normalizeContact(raw,{allowRole=false}={}) {
  if(raw===undefined||raw===null) return undefined;
  if(typeof raw!=='object'||Array.isArray(raw)) throw new Error('Contact details must be an object.');
  const fields=allowRole?['name','role','phone','email']:['name','phone','email'];
  const limits={name:120,role:80,phone:40,email:160};
  const out={};
  for(const key of fields) {
    const val=raw[key];
    if(val===undefined||val===null) continue;
    if(typeof val!=='string') throw new Error(`Contact ${key} must be text.`);
    const trimmed=val.trim();
    if(!trimmed) continue;
    if(trimmed.length>limits[key]) throw new Error(`Contact ${key} must be at most ${limits[key]} characters.`);
    if(key==='email'&&!EMAIL_RE.test(trimmed)) throw new Error('Enter a valid contact email address.');
    out[key]=trimmed;
  }
  return Object.keys(out).length?out:undefined;
}

export function validateBusiness(b) {
  if(!b || ['name','address','tagline','timezone','locale','currency'].some(k=>typeof b[k]!=='string'||!b[k].trim()))throw new Error('Business text, timezone, locale and currency are required.');
  if(b.name.trim().length>120)throw new Error('Company name must be at most 120 characters.');
  if(b.tagline.trim().length>200)throw new Error('Tagline must be at most 200 characters.');
  if(b.address.trim().length>300)throw new Error('Company address must be at most 300 characters.');
  if(b.voiceStyle!==undefined && (typeof b.voiceStyle!=='string'||b.voiceStyle.length>2000))throw new Error('voiceStyle must be text up to 2000 characters.');
  if(b.contact!==undefined && b.contact!==null) normalizeContact(b.contact);
  new Intl.DateTimeFormat(b.locale,{timeZone:b.timezone});
  new Intl.NumberFormat(b.locale,{style:'currency',currency:b.currency});
  const c=b.calendar;
  if(!c||minuteOfDay(c.opensAt)>=minuteOfDay(c.closesAt))throw new Error('Opening time must be before closing time.');
  for(const k of ['slotMinutes','bookingWindowDays'])if(!Number.isInteger(c[k])||c[k]<1||c[k]>(k==='slotMinutes'?1440:365))throw new Error(`Invalid calendar.${k}.`);
  if(!Array.isArray(c.openWeekdays)||!c.openWeekdays.length||c.openWeekdays.some(d=>!Number.isInteger(d)||d<0||d>6))throw new Error('openWeekdays must contain weekday numbers 0–6.');
  if(!Array.isArray(c.blockedTimes)||c.blockedTimes.some(t=>minuteOfDay(t.start)>=minuteOfDay(t.end)))throw new Error('Each blocked time must end after it starts.');
  if(!Array.isArray(b.services)||!b.services.length||b.services.length>50||new Set(b.services.map(s=>s.id)).size!==b.services.length)throw new Error('Provide 1 to 50 services with unique IDs.');
  for(const s of b.services) {
    if(!s||typeof s.id!=='string'||!s.id.trim()||s.id.trim().length>80||typeof s.name!=='string'||!s.name.trim()||s.name.trim().length>120||!Number.isInteger(s.minutes)||s.minutes<1||s.minutes>1440||!Number.isFinite(s.price)||s.price<0)throw new Error('Each service needs an ID, name, positive duration and nonnegative price.');
    if(s.description!==undefined && s.description!==null && (typeof s.description!=='string'||s.description.trim().length>300))throw new Error('Service description must be text up to 300 characters.');
    if(s.contact!==undefined && s.contact!==null) normalizeContact(s.contact,{allowRole:true});
  }
  return b;
}

export function normalizeBusinessInput(raw,fallback=business) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Company details must be an object.');
  const base=fallback||business;
  const calIn=raw.calendar&&typeof raw.calendar==='object'&&!Array.isArray(raw.calendar)?raw.calendar:{};
  const baseCal=base.calendar;
  const openWeekdays=Array.isArray(calIn.openWeekdays)?calIn.openWeekdays.map(Number):[...baseCal.openWeekdays];
  const blockedTimes=Array.isArray(calIn.blockedTimes)?calIn.blockedTimes.map(t=>({start:String(t?.start||'').trim(),end:String(t?.end||'').trim()})):baseCal.blockedTimes.map(t=>({...t}));
  if(!Array.isArray(raw.services)||!raw.services.length)throw new Error('Add at least one service with a price.');
  if(raw.services.length>50)throw new Error('You can configure up to 50 services.');
  const usedIds=new Set();
  const services=raw.services.map(s=>{
    if(!s||typeof s!=='object'||Array.isArray(s))throw new Error('Each service must be an object.');
    const name=typeof s.name==='string'?s.name.trim():'';
    const seed=(typeof s.id==='string'&&s.id.trim()?s.id.trim():name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'service';
    let id=seed,n=2;
    while(usedIds.has(id)){id=`${seed.slice(0,55)}-${n++}`;}
    usedIds.add(id);
    const out={
      id,
      name,
      minutes:s.minutes===undefined||s.minutes===''?30:Number(s.minutes),
      price:s.price===undefined||s.price===''?0:Number(s.price)
    };
    const desc=typeof s.description==='string'?s.description.trim():'';
    if(desc)out.description=desc;
    const contact=normalizeContact(s.contact,{allowRole:true});
    if(contact)out.contact=contact;
    return out;
  });
  const normalized={
    name:typeof raw.name==='string'?raw.name.trim():'',
    tagline:typeof raw.tagline==='string'&&raw.tagline.trim()?raw.tagline.trim():(base.tagline||'Personal services & appointments'),
    address:typeof raw.address==='string'?raw.address.trim():'',
    timezone:typeof raw.timezone==='string'&&raw.timezone.trim()?raw.timezone.trim():base.timezone,
    locale:typeof raw.locale==='string'&&raw.locale.trim()?raw.locale.trim():base.locale,
    currency:typeof raw.currency==='string'&&raw.currency.trim()?raw.currency.trim().toUpperCase():base.currency,
    calendar:{
      opensAt:typeof calIn.opensAt==='string'&&calIn.opensAt.trim()?calIn.opensAt.trim():baseCal.opensAt,
      closesAt:typeof calIn.closesAt==='string'&&calIn.closesAt.trim()?calIn.closesAt.trim():baseCal.closesAt,
      slotMinutes:calIn.slotMinutes===undefined||calIn.slotMinutes===''?baseCal.slotMinutes:Number(calIn.slotMinutes),
      bookingWindowDays:calIn.bookingWindowDays===undefined||calIn.bookingWindowDays===''?baseCal.bookingWindowDays:Number(calIn.bookingWindowDays),
      openWeekdays,
      blockedTimes
    },
    services
  };
  const contact=normalizeContact(raw.contact);
  if(contact)normalized.contact=contact;
  if(typeof raw.voiceStyle==='string'&&raw.voiceStyle.trim())normalized.voiceStyle=raw.voiceStyle.trim();
  return validateBusiness(normalized);
}
export const business=validateBusiness(JSON.parse(readFileSync(process.env.BUSINESS_CONFIG||new URL('./config/business.json',import.meta.url),'utf8')));
function positiveSetting(name,fallback){const n=Number(process.env[name]??fallback);if(!Number.isInteger(n)||n<1)throw new Error(`Invalid ${name}.`);return n;}
export const voice={model:process.env.GEMINI_LIVE_MODEL||'gemini-3.8-live',name:process.env.GEMINI_VOICE||'Kore',maxMinutes:positiveSetting('VOICE_MAX_MINUTES',10)};
