import Ajv from 'ajv';
import {ToolError,toolFailure} from './errors.mjs';
import {listAllowedFolders} from './list_allowed_folders.mjs';
import {searchFiles} from './search_files.mjs';
import {openFile} from './open_file.mjs';
import {revealInFolder} from './reveal_in_folder.mjs';
export const fileTools=[listAllowedFolders,searchFiles,openFile,revealInFolder];
export class ToolRegistry {
  constructor(definitions,audit){
    const ajv=new Ajv({allErrors:true});this.audit=audit;this.tools=new Map();
    for(const tool of definitions){if(this.tools.has(tool.name))throw new Error(`Duplicate tool ${tool.name}`);this.tools.set(tool.name,{...tool,validate:ajv.compile(tool.parameters)});}
  }
  declarations(){return [...this.tools.values()].map(({name,description,parameters})=>({name,description,parametersJsonSchema:parameters,behavior:'NON_BLOCKING'}));}
  async call(name,args,context){
    // Write BEFORE any action; if audit storage fails no tool can run.
    try{this.audit({tool:name,args,sessionId:context.session.id,source:context.source,outcome:'started',resultCount:0});}
    catch(error){return toolFailure(error);}
    let output;
    try{
      const tool=this.tools.get(name);
      if(!tool)throw new ToolError('UNKNOWN_TOOL','That tool is not available.');
      if(!tool.validate(args))throw new ToolError('INVALID_ARGUMENTS',`Invalid arguments for ${name}. ${tool.validate.errors.map(e=>`${e.instancePath||'/'} ${e.message}`).join('; ')}`);
      output=await tool.run(context,args);
    }catch(error){output=toolFailure(error);}
    try{this.audit({tool:name,args,sessionId:context.session.id,source:context.source,outcome:output.error?.code||output.status||'success',resultCount:output.results?.length||output.times?.length||output.folders?.length||0});}
    catch(error){return toolFailure(error);}
    return output;
  }
}
