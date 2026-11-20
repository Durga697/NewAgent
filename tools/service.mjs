import path from 'node:path';
import {PathGuard} from './pathGuard.mjs';
import {FileIndex} from './fileIndex.mjs';
import {ResultStore} from './results.mjs';
import {ToolError} from './errors.mjs';
import {launchFile} from './windows.mjs';
import {hasActionConsent} from './intent.mjs';
import {requirePermit} from '../safety/policy.mjs';
import {assertSafeSimpleName, assertSafeSubFolder} from '../companion/fileOps.mjs';
export class FileService {
  constructor(config,{launch=launchFile,now}={}){this.config=config;this.guard=new PathGuard(config.roots,config.blockedExtensions,config.security);this.guard.storageRoots=[config.indexing.directory];this.index=new FileIndex(config,this.guard);this.results=new ResultStore(config,now);this.launch=launch;}
  requireEnabled(){if(!this.config.enabled)throw new ToolError('FILES_DISABLED','Local file tools are disabled in this configuration.');}
  async start(){await this.index.start();}
  async inspectRoots(){for(const root of this.config.roots){try{const checked=await this.guard.inspect(root.path,{directory:true});root.path=checked.path;this.index.status.set(root.id,{available:true});}catch(e){this.index.status.set(root.id,{available:false,error:{code:e.code||'PATH_DENIED',message:'This configured folder is unavailable or blocked.'}});}}}
  async ensureStarted(){await this.index.ensureStarted();}
  async validateToolPaths(name,args,session){
    if(['open_file','reveal_in_folder','open_folder','get_file_metadata','read_local_text'].includes(name)){const item=this.results.get(session,args.resultId);return [await this.guard.inspect(item.path,{opening:name!=='get_file_metadata',directory:item.isDirectory})];}
    if(['search_files','find_large_files','find_duplicate_files'].includes(name)){const roots=await this.guard.folders(args.folder||args.parentFolder);return roots;}
    if(name==='knowledge_ingest_folder'){const roots=await this.guard.folders(args.folder);if(roots.length!==1)throw new ToolError('OUTSIDE_ALLOWLIST','Choose one authorized folder for Knowledge indexing.');return roots;}
    if(name==='save_report'){if(typeof args.fileName!=='string'||/[\\/]/.test(args.fileName)||args.fileName.includes('..')||args.fileName.endsWith('.'))throw new ToolError('INVALID_PATH','Use a simple report filename without folder separators.');const roots=await this.guard.folders(args.folder);if(roots.length!==1)throw new ToolError('OUTSIDE_ALLOWLIST','Choose one authorized folder for saving the report.');try{return [await this.guard.destination(path.join(roots[0].path,args.fileName))];}catch(e){if(e.code==='INVALID_FILE')throw new ToolError('FILE_EXISTS','A file with that name already exists. Choose a new report filename.');throw e;}}
    if(name==='create_directory'){const cleanDir=assertSafeSimpleName(args.directoryName,this.guard.blocked,{allowExtensionless:true});const roots=await this.guard.folders(args.folder);if(roots.length!==1)throw new ToolError('OUTSIDE_ALLOWLIST','Choose one authorized folder.');try{return [await this.guard.destination(path.join(roots[0].path,cleanDir))];}catch(e){if(e.code==='INVALID_FILE')throw new ToolError('FILE_EXISTS','A file or folder with that name already exists.');throw e;}}
    if(name==='rename_file'){const item=this.results.get(session,args.resultId);if(item.isDirectory)throw new ToolError('INVALID_ARGUMENTS','Select a file result to rename.');const cleanName=assertSafeSimpleName(args.newName,this.guard.blocked);const srcCap=await this.guard.inspect(item.path,{opening:false,directory:false});try{const destCap=await this.guard.destination(path.join(path.dirname(srcCap.path),cleanName));return [srcCap,destCap];}catch(e){if(e.code==='INVALID_FILE')throw new ToolError('FILE_EXISTS','A file with that name already exists.');throw e;}}
    if(name==='move_file'||name==='copy_file'){const item=this.results.get(session,args.resultId);if(item.isDirectory)throw new ToolError('INVALID_ARGUMENTS','Select a file result.');const srcCap=await this.guard.inspect(item.path,{opening:false,directory:false});const subParts=assertSafeSubFolder(args.subFolder,this.guard.blocked);const finalName=name==='copy_file'&&args.newName?assertSafeSimpleName(args.newName,this.guard.blocked):path.basename(srcCap.path);const roots=await this.guard.folders(args.targetFolder);if(roots.length!==1)throw new ToolError('OUTSIDE_ALLOWLIST','Choose one authorized target folder.');try{const destCap=await this.guard.destination(path.join(roots[0].path,...subParts,finalName));return [srcCap,destCap];}catch(e){if(e.code==='INVALID_FILE')throw new ToolError('FILE_EXISTS','A file with that name already exists at the destination.');throw e;}}
    if(name==='recycle_file'){const item=this.results.get(session,args.resultId);if(item.isDirectory)throw new ToolError('INVALID_ARGUMENTS','Select a file result to move to Recycle Bin.');return [await this.guard.inspect(item.path,{opening:false,directory:false})];}
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
