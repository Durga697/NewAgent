import {PathGuard} from './pathGuard.mjs';
import {FileIndex} from './fileIndex.mjs';
import {ResultStore} from './results.mjs';
import {ToolError} from './errors.mjs';
import {launchFile} from './windows.mjs';
import {hasActionConsent} from './intent.mjs';
import {requirePermit} from '../safety/policy.mjs';
export class FileService {
  constructor(config,{launch=launchFile,now}={}){this.config=config;this.guard=new PathGuard(config.roots,config.blockedExtensions,config.security);this.guard.storageRoots=[config.indexing.directory];this.index=new FileIndex(config,this.guard);this.results=new ResultStore(config,now);this.launch=launch;}
  requireEnabled(){if(!this.config.enabled)throw new ToolError('FILES_DISABLED','Local file tools are disabled in this configuration.');}
  async start(){await this.index.start();}
  async inspectRoots(){for(const root of this.config.roots){try{const checked=await this.guard.inspect(root.path,{directory:true});root.path=checked.path;this.index.status.set(root.id,{available:true});}catch(e){this.index.status.set(root.id,{available:false,error:{code:e.code||'PATH_DENIED',message:'This configured folder is unavailable or blocked.'}});}}}
  async ensureStarted(){await this.index.ensureStarted();}
  async validateToolPaths(name,args,session){
    if(['open_file','reveal_in_folder','open_folder','get_file_metadata'].includes(name)){const item=this.results.get(session,args.resultId);return [await this.guard.inspect(item.path,{opening:name!=='get_file_metadata',directory:item.isDirectory})];}
    if(name==='search_files'){const roots=await this.guard.folders(args.folder||args.parentFolder);return roots;}
    throw new ToolError('PATH_DENIED','This tool has no approved path resolver.');
  }
  async act(context,action,resultId){
    requirePermit(context.execution,context.session,action==='open'?'open_file':action==='folder'?'open_folder':'reveal_in_folder');
    this.requireEnabled();
    const item=this.results.get(context.session,resultId);
    const checked=await this.guard.inspect(item.path,{opening:true,directory:item.isDirectory});
    if(context.isCancelled?.())throw new ToolError('CANCELLED','That file action was cancelled.');
    if(checked.stat.mtimeMs!==item.mtimeMs||(!item.isDirectory&&checked.stat.size!==item.size)||checked.stat.ino!==item.ino||checked.stat.dev!==item.dev)throw new ToolError('FILE_CHANGED','That file changed since the search. Search again before opening it.');
    if(!hasActionConsent(this.results,context.session,item,action,context.source)){
      const request={status:'confirmation_required',action,...this.results.public(item),message:`${action==='open'?'Open':'Show in folder'} ${item.name}? Choose this file by voice or use its button.`};
      this.results.state(context.session).pending=request;context.publish?.('fileAction',request);return request;
    }
    const target=action==='folder'&&!item.isDirectory?await this.guard.inspect(item.folder,{directory:true}):checked;
    await this.launch(action,target.path,{capability:target,permit:context.execution,session:context.session,security:this.config.security});
    this.results.select(context.session,resultId,action);
    context.session.fileUserSpeech='';context.session.fileSpeechAt=0;
    this.results.state(context.session).pending=null;
    const result={status:'launched',action,name:item.name,resultId,message:action==='open'?'The open request was handed to Windows.':'The show-in-folder request was handed to Windows Explorer.'};
    context.publish?.('fileAction',result);return result;
  }
  close(){return this.index.close();}
}
