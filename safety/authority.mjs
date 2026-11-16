import {randomUUID} from 'node:crypto';
import {SecurityError} from './errors.mjs';

const trustedSources=new Set(['typed','voice']);
export class UserAuthority {
  constructor({isSessionValid=()=>false,now=()=>Date.now(),ttlMs=60000}={}){this.isSessionValid=isSessionValid;this.now=now;this.ttlMs=ttlMs;this.records=new WeakMap();this.latest=new WeakMap();}
  issue(session,{source,text='',permissions=[]}={}){
    if(!this.isSessionValid(session)||!trustedSources.has(source)||typeof text!=='string'||text.length>10000)throw new SecurityError('AUTH_DENIED','An authenticated current user instruction is required.');
    const request=Object.freeze({requestId:randomUUID()});
    this.records.set(request,{session,source,text,permissions:new Set(permissions),issuedAt:this.now()});this.latest.set(session,request);return request;
  }
  current(session){return this.latest.get(session);}
  verify(request,session,permission){const record=this.records.get(request);if(!record||record.session!==session||this.latest.get(session)!==request||!this.isSessionValid(session)||this.now()-record.issuedAt>this.ttlMs||!record.permissions.has(permission))throw new SecurityError('AUTH_DENIED','That tool request does not have current authenticated user authorization.');return {...record,requestId:request.requestId};}
  revoke(session){this.latest.delete(session);}
}
export function untrustedData(value,source='retrieved_content'){return Object.freeze({trust:'untrusted',source,value});}
