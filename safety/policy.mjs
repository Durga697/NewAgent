import {randomUUID} from 'node:crypto';
import {SecurityError} from './errors.mjs';
export const Risk=Object.freeze({READ_ONLY:'READ_ONLY',REVERSIBLE:'REVERSIBLE',DESTRUCTIVE_OR_BULK:'DESTRUCTIVE_OR_BULK',FORBIDDEN:'FORBIDDEN'});
const permits=new WeakMap();
const decisions=new WeakMap();
const forbidden=/^(?:permanent_delete|format_drive|execute_arbitrary_command|execute_discovered_program|run_untrusted_script|access_credential_store|modify_windows_system_files|bypass_security_policy|unauthorized_cloud_upload)$/;
export class PolicyEngine {
  constructor(config,authority){this.config=config;this.authority=authority;}
  evaluate(tool,args,context){
    const requestId=context.authorization?.requestId||randomUUID();
    let riskLevel=tool.riskLevel;
    if(forbidden.test(tool.name)||riskLevel===Risk.FORBIDDEN)return {requestId,toolName:tool.name,riskLevel:Risk.FORBIDDEN,decision:'DENY',reasonCode:'FORBIDDEN',sanitizedMetadata:{}};
    if(!Object.values(Risk).includes(riskLevel)||!Array.isArray(tool.requiredPermissions)||!tool.requiredPermissions.length)throw new SecurityError('INVALID_ARGUMENTS','The tool security declaration is incomplete.');
    for(const permission of tool.requiredPermissions)this.authority.verify(context.authorization,context.session,permission);
    const count=Array.isArray(args.targetIds)?args.targetIds.length:1;
    if(count>this.config.policy.bulkActionThreshold||/delete|overwrite/.test(tool.name))riskLevel=Risk.DESTRUCTIVE_OR_BULK;
    const confirmation=tool.requiresConfirmation||riskLevel===Risk.DESTRUCTIVE_OR_BULK;
    const decision={requestId,toolName:tool.name,riskLevel,decision:confirmation?'NEEDS_CONFIRMATION':'ALLOW',reasonCode:confirmation?'CONFIRMATION_REQUIRED':'AUTHORIZED',sanitizedMetadata:{targetCount:count}};decisions.set(decision,{engine:this,authorization:context.authorization,session:context.session,permissions:tool.requiredPermissions});return Object.freeze(decision);
  }
  permit(decision,context){const record=decisions.get(decision);if(decision.decision!=='ALLOW'||record?.engine!==this||record.authorization!==context.authorization||record.session!==context.session)throw new SecurityError('AUTH_DENIED','The operation has not been authorized.');for(const p of record.permissions)this.authority.verify(context.authorization,context.session,p);const permit=Object.freeze({requestId:decision.requestId});permits.set(permit,{session:context.session,toolName:decision.toolName,authority:this.authority,authorization:context.authorization,permissions:record.permissions});return permit;}
}
export function requirePermit(permit,session,toolName){const record=permits.get(permit);if(!record||record.session!==session||record.toolName!==toolName)throw new SecurityError('AUTH_DENIED','A policy-authorized operation is required.');for(const p of record.permissions)record.authority.verify(record.authorization,session,p);}
