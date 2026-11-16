import {randomBytes,timingSafeEqual} from 'node:crypto';
import {SecurityError} from './errors.mjs';
const secret=()=>randomBytes(32).toString('hex');
export class LocalSessions {
  constructor(config,{now=()=>Date.now(),onExpire=()=>{}}={}){this.config=config;this.now=now;this.onExpire=onExpire;this.entries=new Map();}
  create(){this.sweep();if(this.entries.size>=this.config.maxSessions)throw new SecurityError('AUTH_DENIED','Too many local sessions. Close an older session or restart the app.');const s={id:secret(),csrf:secret(),createdAt:this.now(),lastSeen:this.now(),draft:null,bookings:[],events:new Set(),live:null,seen:new Set(),closing:false};this.entries.set(s.id,s);return s;}
  valid(session){return !!session&&this.entries.get(session.id)===session&&this.now()-session.lastSeen<this.config.idleSeconds*1000&&this.now()-session.createdAt<this.config.absoluteSeconds*1000;}
  get(cookie){const id=cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('frontdesk='))?.slice(10);const s=this.entries.get(id);if(!this.valid(s)){if(s)this.invalidate(s);return null;}s.lastSeen=this.now();return s;}
  checkCsrf(session,candidate){if(!this.valid(session)||typeof candidate!=='string'||!/^[a-f0-9]{64}$/.test(candidate)||!timingSafeEqual(Buffer.from(candidate),Buffer.from(session.csrf)))throw new SecurityError('AUTH_DENIED','A valid local session and CSRF header are required.');}
  invalidate(session){this.entries.delete(session.id);try{this.onExpire(session);}catch{}}
  rotate(session){if(!this.valid(session))throw new SecurityError('AUTH_DENIED','The session expired. Reload the page.');const bookings=session.bookings;this.invalidate(session);const next=this.create();next.bookings=bookings;return next;}
  sweep(){for(const s of this.entries.values())if(!this.valid(s))this.invalidate(s);}
}
export function verifyLocalRequest(headers,port,{mutation=false,websocket=false}={}){
  const host=headers.host;
  if(![`localhost:${port}`,`127.0.0.1:${port}`].includes(host))throw new SecurityError('ORIGIN_DENIED','Unexpected local host.');
  if(headers['sec-fetch-site']==='cross-site')throw new SecurityError('ORIGIN_DENIED','Cross-site requests are not allowed.');
  if((mutation||websocket||headers.origin)&&headers.origin!==`http://${host}`)throw new SecurityError('ORIGIN_DENIED','Unexpected request origin.');
}
