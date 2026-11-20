import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

import {business,minuteOfDay} from './config.mjs';
import {dateInZone,addDays,localInstant} from './dates.mjs';
export {business};
export function today(tz=business.timezone){return dateInZone(new Date(),tz);}
export function datePlus(days,tz=business.timezone){return addDays(today(tz),days);}
export class Calendar {
  constructor(file, config=business, now=()=>Date.now(), initialBookings=null) {
    this.business=config;this.now=now;
    this.file = file;
    this.bookings = Array.isArray(initialBookings) ? [...initialBookings] : (file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
  }
  service(id) { const s = this.business.services.find(s=>s.id===id); if(!s) throw new Error('Choose a valid service.'); return s; }
  effectiveContact(service) {
    const hasDetails = c => c && (c.name || c.phone || c.email);
    if (hasDetails(service?.contact)) return { ...service.contact };
    if (hasDetails(this.business.contact)) return { ...this.business.contact };
    return null;
  }
  availability(serviceId, date) {
    const service = this.service(serviceId);
    const {calendar:rules,timezone}=this.business;
    const current=dateInZone(new Date(this.now()),timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || date < current || date > addDays(current,rules.bookingWindowDays)) throw new Error(`Choose a date in the next ${rules.bookingWindowDays} days.`);
    const slots=[];
    if(!rules.openWeekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay()))return slots;
    for(let m=minuteOfDay(rules.opensAt);m+service.minutes<=minuteOfDay(rules.closesAt);m+=rules.slotMinutes) {
      const time=`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
      const start=localInstant(date,time,timezone);
      // Seeded demo appointments are fixed blocks, not customer records.
      const blocks=[...rules.blockedTimes.map(t=>({date,start:minuteOfDay(t.start),end:minuteOfDay(t.end)})),...this.bookings.map(b=>({date:b.date,start:b.minute,end:b.minute+b.minutes}))];
      if(start>this.now() && !blocks.some(b=>b.date===date && m<b.end && m+service.minutes>b.start)) slots.push(time);
    }
    return slots;
  }
  draft(serviceId,date,time,name) {
    const service=this.service(serviceId);
    if(typeof name!=='string' || !name.trim() || name.trim().length>80) throw new Error('Please provide a name (up to 80 characters).');
    if(!this.availability(serviceId,date).includes(time)) throw new Error('That time is no longer available. Please choose another.');
    return {id:randomUUID(),serviceId,service:service.name,date,time,name:name.trim(),minutes:service.minutes,price:service.price,timezone:this.business.timezone,currency:this.business.currency,businessName:this.business.name,businessAddress:this.business.address,contact:this.effectiveContact(service)};
  }
  confirm(draft) {
    // Synchronous check + write prevents concurrent double bookings in this single-process demo.
    const checked=this.draft(draft.serviceId,draft.date,draft.time,draft.name);
    const booking={...checked,id:draft.id,minute:Number(draft.time.slice(0,2))*60+Number(draft.time.slice(3)),createdAt:new Date().toISOString()};
    const next=[...this.bookings,booking];
    if(this.file) { mkdirSync(dirname(this.file),{recursive:true}); writeFileSync(`${this.file}.tmp`,JSON.stringify(next,null,2)); renameSync(`${this.file}.tmp`,this.file); }
    this.bookings=next;
    return booking;
  }
}
