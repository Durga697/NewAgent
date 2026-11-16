import Ajv from 'ajv';
import {ToolError,toolFailure} from './errors.mjs';
import {listAllowedFolders} from './list_allowed_folders.mjs';
import {searchFiles} from './search_files.mjs';
import {openFile} from './open_file.mjs';
import {revealInFolder} from './reveal_in_folder.mjs';
import {toolSecurity} from '../safety/permissions.mjs';
import {intelligenceTools} from './intelligence.mjs';
export const fileTools=[listAllowedFolders,searchFiles,openFile,revealInFolder,...intelligenceTools];
export class ToolRegistry {
  constructor(definitions,audit,{policy,confirmations}={}){
    const ajv=new Ajv({allErrors:true});this.audit=audit;this.policy=policy;this.confirmations=confirmations;this.tools=new Map();
    for(const raw of definitions){const tool={...toolSecurity[raw.name],...raw};if(this.tools.has(tool.name))throw new Error(`Duplicate tool ${tool.name}`);this.tools.set(tool.name,{...tool,validate:ajv.compile(tool.parameters),validateOutput:tool.outputSchema?ajv.compile(tool.outputSchema):null});}
  }
  declarations(){return [...this.tools.values()].map(({name,description,parameters})=>({name,description,parametersJsonSchema:parameters,behavior:'NON_BLOCKING'}));}
  async call(name,args,context){
    const started=Date.now(),tool=this.tools.get(name),requestId=context.authorization?.requestId;
    const base={tool:tool?name:'UNKNOWN_TOOL',args,sessionId:context.session?.id,requestId,riskLevel:tool?.riskLevel};
    try{await this.audit({...base,event:'TOOL_REQUESTED',outcome:'started',resultCount:0});}
    catch(error){return toolFailure(error);}
    let output;
    try{
      if(!tool)throw new ToolError('TOOL_NOT_FOUND','That tool is not available.');
      if(!tool.validate(args))throw new ToolError('INVALID_ARGUMENTS',`Invalid arguments for ${name}. ${tool.validate.errors.map(e=>`${e.instancePath||'/'} ${e.message}`).join('; ')}`);
      if(!this.policy)throw new ToolError('AUTH_DENIED','A central authorization policy is required.');
      const decision=this.policy.evaluate(tool,args,context);
      if(decision.decision==='DENY')throw new ToolError(decision.reasonCode,'That operation is forbidden by security policy.');
      if(decision.riskLevel==='REVERSIBLE')throw new ToolError('UNSUPPORTED_OPERATION','File mutations and undo execution are deferred to Phase 4.');
      if(decision.decision==='NEEDS_CONFIRMATION'){
        if(!this.confirmations)throw new ToolError('CONFIRMATION_REQUIRED','An exact-operation confirmation is required.');
        const operation={toolName:name,targetIds:args.targetIds||[args.resultId].filter(Boolean),parameters:args};
        const preview=await this.confirmations.create(context,operation,`Preview ${name} for ${operation.targetIds.length} exact target(s). No operation has run.`);
        context.publish?.('securityConfirmation',preview);
        output={status:'confirmation_required',operationId:preview.operationId,preview:preview.preview,expiresAt:preview.expiresAt};
      }else{
        const validated=tool.requiresPathValidation?await context.files?.validateToolPaths(name,args,context.session):[];
        if(tool.requiresPathValidation&&!validated)throw new ToolError('PATH_DENIED','Path validation is required.');
        const execution=this.policy.permit(decision,context);
        await this.audit({...base,event:'TOOL_ALLOWED',policyDecision:'ALLOW',outcome:'authorized',resultCount:0});
        output=await tool.run({...context,execution,validatedPaths:validated},args);
        if(tool.validateOutput&&!tool.validateOutput(output))throw new ToolError('OPERATION_FAILED','The tool returned an invalid result.');
      }
    }catch(error){output=toolFailure(error);}
    try{await this.audit({...base,event:output.error?'TOOL_DENIED':output.status==='confirmation_required'?'CONFIRMATION_REQUIRED':'OPERATION_SUCCEEDED',policyDecision:output.error?'DENY':output.status==='confirmation_required'?'NEEDS_CONFIRMATION':'ALLOW',outcome:output.error?.code||output.status||'success',errorCode:output.error?.code,durationMs:Date.now()-started,resultCount:output.results?.length||output.times?.length||output.folders?.length||0});}
    catch(error){return toolFailure(error);}
    return output;
  }
}
