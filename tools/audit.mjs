import {appendFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {ToolError} from './errors.mjs';
export function auditLogger(filename){
  return record=>{try{mkdirSync(dirname(filename),{recursive:true});appendFileSync(filename,JSON.stringify({timestamp:new Date().toISOString(),...record})+'\n');}catch{throw new ToolError('AUDIT_UNAVAILABLE','The local audit log is unavailable. Tools are disabled until logging is restored.');}};
}
