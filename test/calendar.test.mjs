import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calendar,datePlus } from '../calendar.mjs';
test('availability respects duration and seeded appointments',()=>{const c=new Calendar();const slots=c.availability('treatment',datePlus(1));assert(slots.includes('09:00'));assert(!slots.includes('10:00'));assert(!slots.includes('17:00'));});
test('draft does not save, confirmation saves and blocks overlapping services',()=>{const c=new Calendar();const d=c.draft('cut',datePlus(1),'09:00','Sam');assert.equal(c.bookings.length,0);c.confirm(d);assert.equal(c.bookings.length,1);assert(!c.availability('consult',datePlus(1)).includes('09:30'));assert.throws(()=>c.confirm(d),/no longer available/);});
test('reject invalid service, date, name, time',()=>{const c=new Calendar();assert.throws(()=>c.availability('bad',datePlus(1)));assert.throws(()=>c.availability('cut','2026-02-30'));assert.throws(()=>c.availability('cut',datePlus(31)));assert.throws(()=>c.draft('cut',datePlus(1),'09:00',''));assert.throws(()=>c.draft('cut',datePlus(1),'11:00','Sam'));});
