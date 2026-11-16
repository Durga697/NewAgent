import {mkdir,appendFile,readFile,open,lstat,stat} from 'node:fs/promises';
import {createHash,randomBytes,createHmac} from 'node:crypto';
import path from 'node:path';
import {SecurityError} from './errors.mjs';
const events=new Set(['TOOL_REQUESTED','TOOL_ALLOWED','TOOL_DENIED','CONFIRMATION_REQUIRED','CONFIRMATION_APPROVED','CONFIRMATION_REJECTED','OPERATION_STARTED','OPERATION_SUCCEEDED','OPERATION_FAILED','AUTH_REJECTED','CONFIG_VALIDATION_FAILED']);
const fields=new Set(['query','folder','extensions','modifiedAfter','modifiedBefore','sortBy','limit','resultId','serviceId','date','time','name','targetIds','operationId','token','requestId']);
const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_:. -]{1,100}$/.test(value)?value:'REDACTED';
export class AuditService {
  constructor(filename,{maxRecordBytes=8192,maxPageSize=100,authority}={}){this.filename=filename;this.maxRecordBytes=maxRecordBytes;this.maxPageSize=maxPageSize;this.authority=authority;this.salt=randomBytes(32);this.sequence=0;this.previous='0'.repeat(64);this.loaded=false;this.queue=Promise.resolve();}
  pseudonym(value){return createHmac('sha256',this.salt).update(String(value||'anonymous')).digest('hex').slice(0,20);}
  append(input){
    const job=this.queue.then(()=>this.#append(input));this.queue=job.catch(()=>{});return job;
  }
  async #append(input){
    if(!input||typeof input!=='object')throw new SecurityError('INVALID_ARGUMENTS','An audit record is required.');
    try{
      if(!this.loaded){await mkdir(path.dirname(this.filename),{recursive:true,mode:0o700});try{if((await lstat(this.filename)).isSymbolicLink())throw new Error();}catch(e){if(e.code!=='ENOENT')throw e;const fd=await open(this.filename,'ax',0o600);await fd.close();}const prior=await this.#readRaw();if(prior.length){this.previous=prior.at(-1).hash;this.sequence=prior.at(-1).sequence;}this.loaded=true;}
      if((await lstat(this.filename)).isSymbolicLink())throw new Error();
      const event=events.has(input.event)?input.event:input.outcome==='started'?'TOOL_REQUESTED':input.outcome==='success'||input.outcome==='launched'?'OPERATION_SUCCEEDED':input.errorCode?'OPERATION_FAILED':'TOOL_DENIED';
      const args=input.args&&typeof input.args==='object'?input.args:{};
      const record={timestamp:new Date().toISOString(),sequence:this.sequence+1,event,requestId:safe(input.requestId),sessionId:this.pseudonym(input.sessionId),tool:safe(input.tool),riskLevel:safe(input.riskLevel),args:{keys:Object.keys(args).map(key=>fields.has(key)?key:'OTHER').slice(0,50),count:Object.keys(args).length},policyDecision:safe(input.policyDecision),outcome:safe(input.outcome),errorCode:input.errorCode?safe(input.errorCode):null,resultCount:Number.isSafeInteger(input.resultCount)?input.resultCount:0,durationMs:Number.isFinite(input.durationMs)?Math.max(0,Math.round(input.durationMs)):0,confirmationReference:input.confirmationReference?this.pseudonym(input.confirmationReference):null,previousHash:this.previous};
      record.hash=createHash('sha256').update(JSON.stringify(record)).digest('hex');const line=JSON.stringify(record)+'\n';
      if(Buffer.byteLength(line)>this.maxRecordBytes)throw new Error();
      await appendFile(this.filename,line,{encoding:'utf8',mode:0o600});this.previous=record.hash;this.sequence=record.sequence;return record;
    }catch(error){this.loaded=false;if(error instanceof SecurityError)throw error;throw new SecurityError('AUDIT_WRITE_FAILED','Security audit storage is unavailable. The operation was denied.');}
  }
  async #readRaw(){
    let info;try{info=await stat(this.filename);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    if(info.size>16*1024*1024)throw new SecurityError('AUDIT_WRITE_FAILED','Audit inspection limit reached; archive the log locally before continuing.');
    let previous='0'.repeat(64),sequence=0;const data=await readFile(this.filename,'utf8');
    if(data&&!data.endsWith('\n'))throw new SecurityError('AUDIT_WRITE_FAILED','An incomplete audit record was detected.');
    return data.split('\n').filter(Boolean).map(line=>{try{const record=JSON.parse(line),{hash,...unsigned}=record;if(record.sequence!==++sequence||record.previousHash!==previous||hash!==createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'))throw new Error();previous=hash;return record;}catch{throw new SecurityError('AUDIT_WRITE_FAILED','Malformed or modified audit records were detected.');}});
  }
  async readPage(context,{after=0,limit=20}={}){
    if(!this.authority)throw new SecurityError('AUTH_DENIED','Authenticated audit access is required.');
    this.authority.verify(context?.authorization,context?.session,'audit.read');
    if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>this.maxPageSize)throw new SecurityError('INVALID_ARGUMENTS','Invalid audit pagination.');
    await this.queue;return (await this.#readRaw()).filter(r=>r.sequence>after).slice(0,limit);
  }
}
