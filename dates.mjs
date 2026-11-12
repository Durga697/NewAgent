// Date-only arithmetic deliberately uses UTC; appointment instants use the configured IANA zone.
export function dateInZone(now,timezone){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(date,days){const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function localInstant(date,time,timezone){
  const wanted=Date.parse(`${date}T${time}:00Z`);
  const fmt=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const localEpoch=instant=>{const p=Object.fromEntries(fmt.formatToParts(instant).map(p=>[p.type,p.value]));return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);};
  // Compare offsets on both sides of a transition. Reject nonexistent DST times;
  // for repeated wall-clock times, offer only the first occurrence.
  const candidates=[-86400000,0,86400000].map(delta=>{const sample=wanted+delta;return wanted-(localEpoch(sample)-sample);});
  return candidates.filter(t=>localEpoch(t)===wanted).sort((a,b)=>a-b)[0]??NaN;
}
