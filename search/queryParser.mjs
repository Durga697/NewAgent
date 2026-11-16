import {ToolError} from '../tools/errors.mjs';
import {normalizeName,fileTypes} from './ranking.mjs';
const day=86400000;
function calendarDate(time,timezone){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(time).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;}
function add(date,n){return new Date(Date.parse(date+'T12:00:00Z')+n*day).toISOString().slice(0,10);}
export function localTime(date,timezone,hour=0){let value=Date.parse(`${date}T${String(hour).padStart(2,'0')}:00:00Z`);for(let i=0;i<4;i++){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(value).map(x=>[x.type,x.value]));const represented=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);const delta=Date.parse(`${date}T${String(hour).padStart(2,'0')}:00:00Z`)-represented;if(!delta)break;value+=delta;}return value;}
function boundary(input,timezone,end=false){if(input===undefined)return undefined;if(typeof input!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(input)||!Number.isFinite(Date.parse(input))||new Date(Date.parse(input.slice(0,10))).toISOString().slice(0,10)!==input.slice(0,10))throw new ToolError('INVALID_DATE','Use an unambiguous valid ISO date.');return input.length===10?(end?localTime(add(input,1),timezone)-1:localTime(input,timezone)):Date.parse(input);}
export function parseSearch(args,{timezone='Asia/Kolkata',roots=[]}={},now=Date.now()){
  let phrase=String(args.query||'').trim();if(phrase.length>250||/[\\/]/.test(phrase)||/\b\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?\b/.test(phrase))throw new ToolError('INVALID_QUERY','Use filename words and unambiguous dates, not paths or numeric date shorthand.');
  const parsed={...args},today=calendarDate(now,timezone);let lower=phrase.toLowerCase();
  const category=[[/\bdocuments?\b/g,'documents'],[/\bpdfs?\b/g,'pdfs'],[/\b(?:excel|spreadsheets?)\b/g,'spreadsheets'],[/\b(?:powerpoint|presentations?)\b/g,'presentations'],[/\b(?:photos?|images?|pictures?)\b/g,'images'],[/\bvideos?\b/g,'videos'],[/\baudio\b/g,'audio'],[/\barchives?\b/g,'archives']];
  for(const [regex,type] of category)if(regex.test(lower)){parsed.fileType??=type;lower=lower.replace(regex,' ');}
  for(const [word,extensions] of [['python',['py','ipynb']],['power bi',['pbix']]])if(lower.includes(word)){parsed.extensions??=extensions;lower=lower.replaceAll(word,' ');}
  const drive=lower.match(/\b(?:on |in )?(?:my )?([a-z])(?::)?\s+drive\b/);if(drive){parsed.drive??=drive[1].toUpperCase()+':';lower=lower.replace(drive[0],' ');}
  for(const root of roots){const alias=root.id.toLowerCase();if(lower.includes('in '+alias)||lower.includes('from '+alias)){parsed.folder??=root.id;lower=lower.replaceAll('in '+alias,' ').replaceAll('from '+alias,' ');}}
  const size=lower.match(/\b(?:larger|bigger|over|smaller|under|less)\s+(?:than\s+)?(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|bytes?)\b/);if(size){const multiplier={kb:1024,mb:1024**2,gb:1024**3,tb:1024**4,byte:1,bytes:1}[size[2]];parsed[/larger|bigger|over/.test(size[0])?'minSize':'maxSize']??=Math.round(Number(size[1])*multiplier);lower=lower.replace(size[0],' ');}
  if(/\b(?:latest|newest|recently)\b/.test(lower))parsed.sortBy??=/created/.test(lower)?'createdDesc':'modifiedDesc';
  if(/\boldest\b/.test(lower))parsed.sortBy??='modifiedAsc';if(/\b(?:biggest|largest)\b/.test(lower))parsed.sortBy??='sizeDesc';if(/\bsmallest\b/.test(lower))parsed.sortBy??='sizeAsc';
  let from,to,expression;
  const weekday=new Date(today+'T12:00:00Z').getUTCDay(),monday=add(today,-((weekday+6)%7));
  const ranges={'today':[today,add(today,1)],'yesterday':[add(today,-1),today],'this week':[monday,add(monday,7)],'last week':[add(monday,-7),monday],'this month':[today.slice(0,8)+'01',add(today.slice(0,8)+'01',32).slice(0,8)+'01'],'last month':[add(today.slice(0,8)+'01',-1).slice(0,8)+'01',today.slice(0,8)+'01']};
  for(const [key,range] of Object.entries(ranges))if(lower.includes(key)){[from,to]=range;expression=key;break;}
  if(lower.includes('this morning')){from=today;to=today;expression='this morning';}
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const month=lower.match(new RegExp(`\\b(${months.join('|')})\\s+(20\\d{2})\\b`));if(month){const n=months.indexOf(month[1])+1;from=`${month[2]}-${String(n).padStart(2,'0')}-01`;to=n===12?`${Number(month[2])+1}-01-01`:`${month[2]}-${String(n+1).padStart(2,'0')}-01`;expression=month[0];}
  const lastDay=lower.match(/\blast (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);if(lastDay){const n=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(lastDay[1]);from=add(today,-((weekday-n+7)%7||7));to=add(from,1);expression=lastDay[0];}
  if(from){const kind=/\bcreated\b/.test(lower)?'created':'modified';parsed[kind+'After']??=new Date(localTime(from,timezone)).toISOString();parsed[kind+'Before']??=new Date(localTime(to,timezone,expression==='this morning'?12:0)-1).toISOString();lower=lower.replace(expression,' ');}
  lower=lower.replace(/\b(?:edith|please|find|search|locate|show|me|my|the|a|an|all|for|with|in|from|on|of|and|files?|folders?|named|name|containing|edited|modified|created|downloaded|saved|latest|newest|oldest|biggest|largest|smallest|recently|last|worked|work|what|did|i|where|save|every|drive)\b/g,' ');
  if(parsed.extensions?.includes('py'))lower=lower.replace(/\bprojects?\b/g,' ');
  if(args.isDirectory===true||/\bfolders?\b/.test(phrase))parsed.isDirectory=true;
  parsed.tokens=normalizeName(lower).split(' ').filter(Boolean).slice(0,12);parsed.normalizedQuery=parsed.tokens.join(' ');
  if(parsed.fileType&&!fileTypes.includes(parsed.fileType))throw new ToolError('INVALID_FILTER','Unknown file type category.');
  for(const field of ['minSize','maxSize'])if(parsed[field]!==undefined&&(!Number.isSafeInteger(parsed[field])||parsed[field]<0))throw new ToolError('INVALID_FILTER','File sizes must be non-negative integer bytes.');
  if(parsed.minSize!==undefined&&parsed.maxSize!==undefined&&parsed.minSize>parsed.maxSize)throw new ToolError('INVALID_FILTER','Minimum size must not exceed maximum size.');
  for(const kind of ['created','modified']){parsed[kind+'AfterMs']=boundary(parsed[kind+'After'],timezone);parsed[kind+'BeforeMs']=boundary(parsed[kind+'Before'],timezone,true);if(parsed[kind+'AfterMs']>parsed[kind+'BeforeMs'])throw new ToolError('INVALID_FILTER','The date range is reversed.');}
  parsed.sortBy??=parsed.tokens.length?'relevance':'modifiedDesc';return parsed;
}
