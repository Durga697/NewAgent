import {loadEnvironment} from './environment.mjs';
import {readFileSync} from 'node:fs';
loadEnvironment();

export function minuteOfDay(time) {
  if(typeof time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Times must use HH:mm (00:00–23:59).');
  const [h,m]=time.split(':').map(Number);return h*60+m;
}
export function validateBusiness(b) {
  if(!b || ['name','address','tagline','timezone','locale','currency'].some(k=>typeof b[k]!=='string'||!b[k].trim()))throw new Error('Business text, timezone, locale and currency are required.');
  if(b.voiceStyle!==undefined && (typeof b.voiceStyle!=='string'||b.voiceStyle.length>2000))throw new Error('voiceStyle must be text up to 2000 characters.');
  new Intl.DateTimeFormat(b.locale,{timeZone:b.timezone});
  new Intl.NumberFormat(b.locale,{style:'currency',currency:b.currency});
  const c=b.calendar;
  if(!c||minuteOfDay(c.opensAt)>=minuteOfDay(c.closesAt))throw new Error('Opening time must be before closing time.');
  for(const k of ['slotMinutes','bookingWindowDays'])if(!Number.isInteger(c[k])||c[k]<1||c[k]>(k==='slotMinutes'?1440:365))throw new Error(`Invalid calendar.${k}.`);
  if(!Array.isArray(c.openWeekdays)||!c.openWeekdays.length||c.openWeekdays.some(d=>!Number.isInteger(d)||d<0||d>6))throw new Error('openWeekdays must contain weekday numbers 0–6.');
  if(!Array.isArray(c.blockedTimes)||c.blockedTimes.some(t=>minuteOfDay(t.start)>=minuteOfDay(t.end)))throw new Error('Each blocked time must end after it starts.');
  if(!Array.isArray(b.services)||!b.services.length||new Set(b.services.map(s=>s.id)).size!==b.services.length)throw new Error('Provide services with unique IDs.');
  for(const s of b.services)if(typeof s.id!=='string'||!s.id.trim()||typeof s.name!=='string'||!s.name.trim()||!Number.isInteger(s.minutes)||s.minutes<1||s.minutes>1440||!Number.isFinite(s.price)||s.price<0)throw new Error('Each service needs an ID, name, positive duration and nonnegative price.');
  return b;
}
export const business=validateBusiness(JSON.parse(readFileSync(process.env.BUSINESS_CONFIG||new URL('./config/business.json',import.meta.url),'utf8')));
function positiveSetting(name,fallback){const n=Number(process.env[name]??fallback);if(!Number.isInteger(n)||n<1)throw new Error(`Invalid ${name}.`);return n;}
export const voice={model:process.env.GEMINI_LIVE_MODEL||'gemini-3.8-live',name:process.env.GEMINI_VOICE||'Kore',maxMinutes:positiveSetting('VOICE_MAX_MINUTES',10)};
