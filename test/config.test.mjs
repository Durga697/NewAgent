import {test} from 'node:test';
import assert from 'node:assert/strict';
import {business,validateBusiness} from '../config.mjs';
import {Calendar} from '../calendar.mjs';
import {localInstant,dateInZone} from '../dates.mjs';

test('another business controls services, schedule, prices, limits and timezone',()=>{
  const config=structuredClone(business);
  Object.assign(config,{name:'Harbour Clinic',timezone:'America/New_York',locale:'en-US',currency:'USD',services:[{id:'assessment',name:'Assessment',minutes:40,price:75}]});
  config.calendar={opensAt:'10:00',closesAt:'16:00',slotMinutes:20,bookingWindowDays:7,openWeekdays:[1,2,3,4,5],blockedTimes:[{start:'12:00',end:'13:00'}]};
  validateBusiness(config);
  const c=new Calendar(null,config,()=>Date.parse('2030-01-07T13:00:00Z'));
  const slots=c.availability('assessment','2030-01-07');
  assert.equal(slots[0],'10:00');assert.equal(slots.at(-1),'15:20');assert(!slots.includes('11:40'));
  assert.deepEqual(c.availability('assessment','2030-01-12'),[]);
  assert.throws(()=>c.availability('assessment','2030-01-15'),/7 days/);
  const d=c.draft('assessment','2030-01-07','10:00','Alex');assert.equal(d.currency,'USD');assert.equal(d.price,75);assert.equal(d.businessName,'Harbour Clinic');
  assert.throws(()=>c.service('cut'));
});
test('timezone conversion follows DST and rejects nonexistent times',()=>{
  assert.equal(localInstant('2030-01-07','10:00','America/New_York'),Date.parse('2030-01-07T15:00:00Z'));
  assert.equal(localInstant('2030-07-08','10:00','America/New_York'),Date.parse('2030-07-08T14:00:00Z'));
  assert(Number.isNaN(localInstant('2024-03-10','02:30','America/New_York')));
  assert.equal(localInstant('2024-11-03','01:30','America/New_York'),Date.parse('2024-11-03T05:30:00Z'));
  assert.equal(dateInZone(new Date('2030-01-07T01:00:00Z'),'America/New_York'),'2030-01-06');
});
test('invalid business configuration fails before serving bookings',()=>{
  for(const mutate of [b=>b.timezone='invalid',b=>b.calendar.slotMinutes=0,b=>b.services.push(b.services[0]),b=>b.calendar.closesAt='08:00']){
    const config=structuredClone(business);mutate(config);assert.throws(()=>validateBusiness(config));
  }
});
