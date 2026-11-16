import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {SecurityError} from './errors.mjs';
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export const digestOperation=operation=>createHash('sha256').update(JSON.stringify(canonical(operation))).digest('hex');
export class ConfirmationManager {
  constructor(config,authority,{now=()=>Date.now(),audit=async()=>{}}={}){this.config=config;this.authority=authority;this.now=now;this.audit=audit;this.sessions=new WeakMap();}
  state(session){let map=this.sessions.get(session);if(!map){map=new Map();this.sessions.set(session,map);}return map;}
  async create(context,operation,preview){
    this.authority.verify(context.authorization,context.session,'confirmation.create');
    if(!operation||typeof operation!=='object'||!Array.isArray(operation.targetIds)||!operation.targetIds.length||operation.targetIds.length>1000||!operation.targetIds.every(id=>typeof id==='string'&&id.length>0)||typeof preview!=='string'||!preview||preview.length>2000)throw new SecurityError('INVALID_ARGUMENTS','An exact target list and dry-run preview are required.');
    const map=this.state(context.session);for(const [id,r] of map)if(r.expiresAt<=this.now()||r.state!=='PENDING')map.delete(id);
    if(map.size>=this.config.maxPendingPerSession)throw new SecurityError('CONFIRMATION_REQUIRED','Too many pending operations; finish or cancel an earlier preview.');
    let snapshot;try{const serialized=JSON.stringify(operation);if(Buffer.byteLength(serialized)>32768)throw new Error();snapshot=JSON.parse(serialized);}catch{throw new SecurityError('INVALID_ARGUMENTS','The proposed operation is invalid or too large.');}
    const operationId=randomUUID(),token=randomBytes(32).toString('hex');
    const record={operationId,requestId:context.authorization.requestId,session:context.session,operation:snapshot,digest:digestOperation(snapshot),tokenHash:createHash('sha256').update(token).digest(),preview,expiresAt:this.now()+this.config.ttlSeconds*1000,state:'PENDING'};
    map.set(operationId,record);
    try{await this.audit({event:'CONFIRMATION_REQUIRED',sessionId:context.session.id,requestId:record.requestId,tool:operation.toolName,confirmationReference:operationId,policyDecision:'NEEDS_CONFIRMATION',outcome:'pending'});}catch(e){map.delete(operationId);throw e;}
    return {operationId,requestId:record.requestId,token,preview,expiresAt:record.expiresAt,state:'PENDING'};
  }
  async consume(context,{operationId,token,requestId,operation}={}){
    const approval=this.authority.verify(context.authorization,context.session,'confirmation.approve');
    const record=this.state(context.session).get(operationId);
    const reject=async(code,message)=>{await this.audit({event:'CONFIRMATION_REJECTED',sessionId:context.session.id,requestId:context.authorization.requestId,tool:'confirmation',confirmationReference:operationId,policyDecision:'DENY',outcome:'rejected',errorCode:code});throw new SecurityError(code,message);};
    if(approval.source==='voice'&&!/^(?:yes|yes please|confirm|confirm it|approve|go ahead)[.! ]*$/i.test(approval.text.trim()))return reject('CONFIRMATION_REJECTED','A spoken confirmation must explicitly approve the pending preview.');
    if(!record)return reject('CONFIRMATION_MISMATCH','That confirmation does not belong to this session.');
    if(record.state!=='PENDING')return reject('CONFIRMATION_REJECTED','That confirmation was already used or rejected.');
    if(record.expiresAt<=this.now()){record.state='EXPIRED';return reject('CONFIRMATION_EXPIRED','That preview expired. Request a new preview.');}
    const candidate=createHash('sha256').update(typeof token==='string'?token:'').digest();
    let suppliedDigest;try{suppliedDigest=digestOperation(operation);}catch{return reject('CONFIRMATION_MISMATCH','A valid exact operation is required.');}
    if(record.requestId!==requestId||record.digest!==suppliedDigest||!timingSafeEqual(record.tokenHash,candidate)){record.state='REJECTED';return reject('CONFIRMATION_MISMATCH','The target, parameters or user request changed. Request a new preview.');}
    record.state='APPROVING';
    try{await this.audit({event:'CONFIRMATION_APPROVED',sessionId:context.session.id,requestId:context.authorization.requestId,tool:'confirmation',confirmationReference:operationId,policyDecision:'ALLOW',outcome:'approved'});}catch(e){record.state='REJECTED';throw e;}
    try{this.authority.verify(context.authorization,context.session,'confirmation.approve');}catch(e){record.state='REJECTED';throw e;}
    record.state='APPROVED';return {operationId,requestId,state:'APPROVED',operationDigest:record.digest};
  }
  invalidate(session){this.sessions.delete(session);}
}
